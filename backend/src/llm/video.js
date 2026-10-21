import { repo } from '../db/index.js';
import { getConfig } from '../settings.js';
import { httpError } from '../errors.js';
import { fetchWithRetry } from './http.js';

// AI videos (a few seconds, 16:9 or 9:16). Like images: the workspace's own provider when it can make
// them, otherwise its Gemini key. Generation takes from ~10 seconds to several minutes, so callers run it
// in the background (see agents/artist.js).

// GEMINI_API_BASE: only to route Gemini through a proxy (or a local stand-in when testing).
const GEMINI = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const POLL_MS = 5000;
const MAX_WAIT_MS = 12 * 60 * 1000;
const MAX_BYTES = 100 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function videoProvider(config) {
  const gemini = { provider: 'gemini', label: 'Gemini', model: config.gemini_video_model, generate: (args) => generateGemini(config, args) };
  if (config.ai_provider === 'gemini' && config.gemini_api_key && config.gemini_video_model) return gemini;
  if (config.ai_provider === 'openai_compat' && config.openai_compat_video_model) {
    return {
      provider: 'openai_compat',
      label: 'OpenAI-compatible',
      model: config.openai_compat_video_model,
      generate: (args) => generateOpenAI(config, args),
    };
  }
  if (config.gemini_api_key && config.gemini_video_model) return gemini;
  return null;
}

export function videoStatus(config) {
  const videos = videoProvider(config);
  if (videos) return { ready: true, label: videos.label, model: videos.model };
  const missing =
    config.ai_provider === 'openai_compat'
      ? 'Add a video model in Settings → AI → Video (e.g. sora-2 on OpenAI), or a Gemini key.'
      : config.ai_provider === 'gemini'
        ? 'Add your Gemini API key in Settings → AI.'
        : "Claude can't make videos. Add a Gemini API key in Settings → AI → Video to make them with Gemini.";
  return { ready: false, missing };
}

// One short video for `prompt` in `aspect` ("16:9" or "9:16"). Returns { buffer, mimeType }.
export async function generateVideo({ prompt, aspect }) {
  const config = await getConfig();
  const videos = videoProvider(config);
  if (!videos) throw httpError(400, videoStatus(config).missing);
  const { buffer, mimeType, usage } = await videos.generate({ prompt, aspect });
  if (buffer.length > MAX_BYTES) throw httpError(502, 'The generated video is larger than 100 MB.');
  await repo.logUsage({ task: 'video', provider: videos.provider, model: videos.model, cost_usd: null, ...usage });
  return { buffer, mimeType };
}

// ---- Gemini Omni Flash, Interactions API ----
// Created in the background and polled, because a single request can outlast HTTP timeouts.

const geminiHeaders = (config) => ({ 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini_api_key });

async function geminiJSON(url, config, options = {}) {
  const res = await fetchWithRetry(url, { ...options, headers: geminiHeaders(config) }, 'Gemini video', options.method === 'POST' ? 0 : 2);
  return res.json();
}

// The video sits in a model_output step; search the steps for it rather than rely on one exact path (the API is in beta).
function findVideo(node) {
  if (!node || typeof node !== 'object') return null;
  if ((node.type === 'video' || /^video\//.test(node.mime_type || '')) && (node.data || node.uri)) return node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findVideo(value);
    if (found) return found;
  }
  return null;
}

async function downloadGeminiFile(config, uri) {
  // files/{id}: wait until it's ACTIVE, then download it. Any other link: fetch it with the key.
  const name = /files\/[\w-]+/.exec(uri)?.[0];
  if (name) {
    for (const started = Date.now(); Date.now() - started < MAX_WAIT_MS; await sleep(POLL_MS)) {
      const file = await geminiJSON(`${GEMINI}/${name}`, config);
      if (file.state === 'FAILED') throw httpError(502, 'Gemini could not finish the video file.');
      if (!file.state || file.state === 'ACTIVE') break;
    }
  }
  const res = await fetch(name ? `${GEMINI}/${name}:download?alt=media` : uri, { headers: { 'x-goog-api-key': config.gemini_api_key } });
  if (!res.ok) throw httpError(502, `Could not download the generated video (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

async function generateGemini(config, { prompt, aspect }) {
  let interaction = await geminiJSON(`${GEMINI}/interactions`, config, {
    method: 'POST',
    body: JSON.stringify({
      model: config.gemini_video_model,
      input: prompt,
      response_format: { type: 'video', aspect_ratio: aspect, resolution: '720p' },
      background: true,
      store: true,
    }),
  });

  for (const started = Date.now(); !['completed', 'failed', 'cancelled', 'incomplete'].includes(interaction.status); ) {
    if (Date.now() - started > MAX_WAIT_MS) throw httpError(504, 'Gemini is taking too long to make the video. Try again later.');
    if (!interaction.id) throw httpError(502, 'Gemini did not start the video.');
    await sleep(POLL_MS);
    interaction = await geminiJSON(`${GEMINI}/interactions/${encodeURIComponent(interaction.id)}`, config);
  }
  if (interaction.status !== 'completed') {
    const reason = interaction.errors?.map((e) => e.message).join('; ') || interaction.status;
    throw httpError(502, `Gemini could not make the video (${reason}). Try different instructions.`);
  }

  const video = findVideo(interaction.steps);
  if (!video) throw httpError(502, 'Gemini returned no video. Try different instructions.');
  const buffer = video.data ? Buffer.from(video.data, 'base64') : await downloadGeminiFile(config, video.uri);
  const usage = interaction.usage || {};
  return {
    buffer,
    mimeType: video.mime_type || 'video/mp4',
    usage: { input_tokens: usage.total_input_tokens ?? usage.input_tokens ?? 0, output_tokens: usage.total_output_tokens ?? usage.output_tokens ?? 0 },
  };
}

// ---- OpenAI-compatible /videos (Sora): create a job, poll it, download the content ----

const SORA_SIZES = { '16:9': '1280x720', '9:16': '720x1280' };

async function generateOpenAI(config, { prompt, aspect }) {
  const base = config.openai_compat_base_url.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (config.openai_compat_api_key) headers.Authorization = `Bearer ${config.openai_compat_api_key}`;

  const createRes = await fetchWithRetry(
    `${base}/videos`,
    { method: 'POST', headers, body: JSON.stringify({ model: config.openai_compat_video_model, prompt, size: SORA_SIZES[aspect] || '1280x720', seconds: '8' }) },
    'Video provider',
    0,
  );
  let job = await createRes.json();
  for (const started = Date.now(); !['completed', 'failed', 'cancelled'].includes(job.status); ) {
    if (Date.now() - started > MAX_WAIT_MS) throw httpError(504, 'The video provider is taking too long. Try again later.');
    await sleep(POLL_MS);
    job = await (await fetchWithRetry(`${base}/videos/${encodeURIComponent(job.id)}`, { headers }, 'Video provider')).json();
  }
  if (job.status !== 'completed') throw httpError(502, `The video provider could not make the video (${job.error?.message || job.status}).`);

  const content = await fetch(`${base}/videos/${encodeURIComponent(job.id)}/content`, { headers });
  if (!content.ok) throw httpError(502, `Could not download the generated video (${content.status}).`);
  return { buffer: Buffer.from(await content.arrayBuffer()), mimeType: 'video/mp4', usage: { input_tokens: 0, output_tokens: 0 } };
}
