import { repo } from '../db/index.js';
import { getConfig } from '../settings.js';
import { httpError } from '../errors.js';
import { fetchWithRetry } from './http.js';

// AI images come from the workspace's own AI provider when it can make them. Claude (API or MCP) can't,
// so then a saved Gemini key is used for images; without one, the user is told what to add.

function geminiImages(config) {
  return {
    provider: 'gemini',
    label: 'Gemini',
    model: config.gemini_image_model,
    generate: (args) => generateGemini(config, args),
  };
}

function openaiImages(config) {
  return {
    provider: 'openai_compat',
    label: 'OpenAI-compatible',
    model: config.openai_compat_image_model,
    generate: (args) => generateOpenAI(config, args),
  };
}

// The image generator for this config, or null with the reason in `missing`.
export function imageProvider(config) {
  if (config.ai_provider === 'gemini' && config.gemini_api_key) return geminiImages(config);
  if (config.ai_provider === 'openai_compat' && config.openai_compat_image_model) return openaiImages(config);
  if (config.gemini_api_key) return geminiImages(config);
  return null;
}

export function imageStatus(config) {
  const images = imageProvider(config);
  if (images) return { ready: true, label: images.label, model: images.model };
  const missing =
    config.ai_provider === 'openai_compat'
      ? 'Add an image model in Settings → AI → Images (e.g. gpt-image-1 on OpenAI), or a Gemini key.'
      : config.ai_provider === 'gemini'
        ? 'Add your Gemini API key in Settings → AI.'
        : "Claude can't make images. Add a Gemini API key in Settings → AI → Images to make them with Gemini.";
  return { ready: false, missing };
}

// One image for `prompt` at roughly `aspect` (e.g. "4:5"). Returns the raw image bytes.
export async function generateImage({ prompt, aspect }) {
  const config = await getConfig();
  const images = imageProvider(config);
  if (!images) throw httpError(400, imageStatus(config).missing);
  const { buffer, usage } = await images.generate({ prompt, aspect });
  await repo.logUsage({ task: 'image', provider: images.provider, model: images.model, cost_usd: null, ...usage });
  return buffer;
}

async function generateGemini(config, { prompt, aspect }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.gemini_image_model)}:generateContent`;
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini_api_key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } },
      }),
    },
    'Gemini image',
  );
  const data = await res.json();
  const candidate = data.candidates?.[0];
  const image = (candidate?.content?.parts || []).map((part) => part.inlineData || part.inline_data).find((inline) => inline?.data);
  if (!image) {
    const reason = candidate?.finishReason || data.promptFeedback?.blockReason || 'unknown reason';
    throw httpError(502, `Gemini returned no image (${reason}). Try different instructions.`);
  }
  const meta = data.usageMetadata || {};
  return {
    buffer: Buffer.from(image.data, 'base64'),
    usage: { input_tokens: meta.promptTokenCount ?? 0, output_tokens: meta.candidatesTokenCount ?? 0 },
  };
}

// gpt-image sizes; the image is cropped to the platform's exact size afterwards.
const OPENAI_SIZES = { '16:9': '1536x1024', '1:1': '1024x1024', '4:5': '1024x1536' };

async function generateOpenAI(config, { prompt, aspect }) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.openai_compat_api_key) headers.Authorization = `Bearer ${config.openai_compat_api_key}`;
  const res = await fetchWithRetry(
    `${config.openai_compat_base_url.replace(/\/+$/, '')}/images/generations`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.openai_compat_image_model, prompt, n: 1, size: OPENAI_SIZES[aspect] || '1024x1024' }),
    },
    'Image provider',
  );
  const data = await res.json();
  const item = data.data?.[0];
  let buffer;
  if (item?.b64_json) {
    buffer = Buffer.from(item.b64_json, 'base64');
  } else if (item?.url) {
    const image = await fetch(item.url);
    if (!image.ok) throw httpError(502, `Could not download the generated image (${image.status}).`);
    buffer = Buffer.from(await image.arrayBuffer());
  } else {
    throw httpError(502, 'The image provider returned no image.');
  }
  return {
    buffer,
    usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
  };
}
