import crypto from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError, httpError } from '../errors.js';
import { getConfig } from '../settings.js';
import { getBrand, brandContext } from '../brandBrain.js';
import { aiStatus, generateJSON } from '../llm/index.js';
import { generateImage } from '../llm/image.js';
import { generateVideo, videoProvider, videoStatus } from '../llm/video.js';
import { storeGeneratedImage, storeVideo } from '../media.js';
import { checkImage, checkVideo, plain } from '../mediaQc.js';
import { RULES_VERSION } from '../mediaRules.js';
import { IMAGE_PROMPT_SCHEMA, IMAGE_STYLES, imageBriefInstructions, imageConstraints, templatePrompt } from '../imagePrompt.js';
import { VideoBriefZ, briefLimits, briefToPrompt, checkBrief } from '../videoBrief.js';
import { changed, EDITABLE, setPostImage } from '../posts.js';
import { repo } from '../db/index.js';
import { getPost } from './creator.js';
import { PLATFORMS } from '../platforms.js';
import { log } from '../log.js';

const PROMPT_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
  additionalProperties: false,
};

const VIDEO_RULES = [
  'One continuous shot of a few seconds with a clear subject, a simple action and a smooth camera move.',
  'No text, captions, letters or logos unless the instructions ask for them.',
  'No real people, celebrities or other brands.',
].join(' ');

// The text AI writes an image prompt (with its style choice and alt text) from the post. Without one (MCP mode), a template is used.
async function planImage({ brand, post, instructions, style, overlayText }) {
  const config = await getConfig();
  const ai = aiStatus(config);
  const fallbackStyle = style === 'auto' ? 'photo' : style;
  if (ai.provider === 'mcp' || !ai.ready) {
    return { style: fallbackStyle, prompt: templatePrompt({ brand, post, platform: post.platform, style: fallbackStyle, instructions, overlayText }), alt: '' };
  }
  const system = `${brandContext(brand)}

# Your role
You are this brand's art director. You write prompts for an AI image model that make on-brand, scroll-stopping social images.`;
  let prompt = `${imageBriefInstructions({ platform: post.platform, style })}

Post:
<post>
${post.content}
</post>`;
  if (instructions) prompt += `\n\nInstructions from the brand owner (follow them):\n<instructions>\n${instructions}\n</instructions>`;
  if (overlayText) prompt += `\n\nThe image must display exactly this text: "${overlayText}"`;
  const result = await generateJSON({ task: 'image-prompt', system, prompt, schema: IMAGE_PROMPT_SCHEMA, effort: 'low' });
  const chosen = IMAGE_STYLES.includes(result.style) && result.style !== 'auto' ? result.style : fallbackStyle;
  const text = chosen === 'text_graphic' ? overlayText || result.overlay_text : '';
  return {
    style: chosen,
    // The constraints are added by the app, not left to the model's memory of the rules.
    prompt: `${result.prompt.trim()}\n\n${imageConstraints({ brand, platform: post.platform, style: chosen, overlayText: text })}`,
    alt: result.alt_text.trim().slice(0, 300),
  };
}

/**
 * Makes an image for the post and attaches it.
 * `prompt` (from Claude via MCP) skips the prompt-writing step; the brand/platform constraints are still appended.
 * style: auto | photo | illustration | text_graphic. overlayText: the exact words for a text_graphic.
 */
export async function createPostImage(id, { instructions, prompt, style = 'auto', overlayText, altText } = {}) {
  const post = await getPost(id);
  // Checked before generating, so no image is paid for that can't be attached.
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  if (!IMAGE_STYLES.includes(style)) throw httpError(400, `style must be one of: ${IMAGE_STYLES.join(', ')}.`);
  const brand = await getBrand();
  const { image } = PLATFORMS[post.platform];

  let plan;
  if (prompt?.trim()) {
    const resolved = style === 'auto' ? (overlayText ? 'text_graphic' : 'photo') : style;
    plan = { style: resolved, prompt: `${prompt.trim()}\n\n${imageConstraints({ brand, platform: post.platform, style: resolved, overlayText })}`, alt: '' };
  } else {
    plan = await planImage({ brand, post, instructions: instructions?.trim(), style, overlayText: overlayText?.trim() });
  }
  const buffer = await generateImage({ prompt: plan.prompt, aspect: image.aspect });
  const stored = await storeGeneratedImage(buffer, image);
  const alt = (altText ?? plan.alt ?? '').trim();
  const qc = plain(await checkImage(stored.buffer, { platform: post.platform, altText: alt }));
  if (plan.style === 'text_graphic') qc.humanReview.push('The image contains generated text. Proofread every word before approving.');
  return setPostImage(post.id, stored.url, { imagePrompt: plan.prompt, alt, qc });
}

// ---- Video: minutes, not seconds, so it runs in the background and the post carries its progress ----
// video_status: 'generating' -> 'ready' (video_url set) or 'failed' (video_error set).

async function writeVideoPrompt({ brand, post, instructions }) {
  const { label } = PLATFORMS[post.platform];
  const { aspect } = PLATFORMS[post.platform].video;
  const config = await getConfig();
  const ai = aiStatus(config);
  if (ai.provider === 'mcp' || !ai.ready) {
    return [
      `A ${aspect} social media short video for a ${label} post by ${brand.name}.`,
      brand.tone && `Brand mood: ${brand.tone}.`,
      `The post: ${post.content}`,
      instructions && `Instructions: ${instructions}`,
      VIDEO_RULES,
    ].filter(Boolean).join('\n');
  }
  const system = `${brandContext(brand)}

# Your role
You are this brand's art director. You write prompts for an AI video model that make on-brand, scroll-stopping short videos.`;
  let prompt = `Write a prompt for the short video that goes with this ${label} post (${aspect} format).

Post:
<post>
${post.content}
</post>`;
  if (instructions) prompt += `\n\nInstructions from the brand owner (follow them):\n<instructions>\n${instructions}\n</instructions>`;
  prompt += `\n\nDescribe the subject, the action, the camera movement, setting, lighting, style and mood in 2-5 sentences. ${VIDEO_RULES}`;
  return (await generateJSON({ task: 'video-prompt', system, prompt, schema: PROMPT_SCHEMA, effort: 'low' })).prompt.trim();
}

async function makeVideo(post, { instructions, prompt, brief }) {
  const tmp = path.join(os.tmpdir(), `ca-gen-${crypto.randomBytes(8).toString('hex')}.mp4`);
  try {
    const brand = await getBrand();
    const videoPrompt = prompt?.trim() || (await writeVideoPrompt({ brand, post, instructions }));
    const { buffer } = await generateVideo({ prompt: videoPrompt, aspect: brief?.aspect || PLATFORMS[post.platform].video.aspect });
    // A generated video is checked like any other before it is attached.
    await writeFile(tmp, buffer);
    const report = await checkVideo(tmp, { platform: post.platform });
    if (!report.ok) {
      log.warn('video.generated_rejected', { post: post.id, errors: report.errors.map((e) => e.code) });
      await repo.updatePost(post.id, { video_status: 'failed', video_error: `The generated video does not meet ${PLATFORMS[post.platform].label}'s requirements: ${report.errors.map((e) => e.message).join(' ')} Generate it again.` });
      return;
    }
    const url = await storeVideo(buffer);
    const latest = await repo.getPost(post.id);
    const media_qc = { ...(latest?.media_qc || {}), video: { url, rules_version: RULES_VERSION, alt: '', checked_at: new Date().toISOString(), report: plain(report) } };
    await repo.updatePost(post.id, { video_url: url, video_prompt: videoPrompt, video_status: 'ready', video_error: null, media_qc });
  } catch (err) {
    log.error('video.failed', { post: post.id, code: err.code, message: err.message });
    await repo.updatePost(post.id, { video_status: 'failed', video_error: err.message });
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Starts making a video for the post and returns the post right away (video_status 'generating').
 * brief: a structured video brief (see videoBrief.js); its visual parts become the prompt and the rest is saved as a spec.
 */
export async function startPostVideo(id, { instructions, prompt, brief } = {}) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  if (post.video_status === 'generating') throw httpError(409, 'A video is already being made for this post.');
  const config = await getConfig();
  if (!videoProvider(config)) throw httpError(400, videoStatus(config).missing);

  let parsed = null;
  let extra = {};
  if (brief) {
    const result = VideoBriefZ.safeParse(brief);
    if (!result.success) throw new AppError('BRIEF_INVALID', `The video brief is incomplete: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    parsed = result.data;
    const check = checkBrief(parsed, post.platform);
    if (check.errors.length) throw new AppError('BRIEF_INVALID', `The video brief can't be used: ${check.errors.join(' ')}`, { details: check });
    extra = { video_brief: parsed, video_brief_warnings: check.warnings, video_brief_manual: briefLimits(parsed) };
    prompt = prompt?.trim() || briefToPrompt(parsed, { aspect: parsed.aspect || PLATFORMS[post.platform].video.aspect, brandName: (await getBrand()).name });
  }

  const started = await repo.updatePost(
    post.id,
    { video_status: 'generating', video_error: null, video_started_at: new Date().toISOString(), ...extra },
    { onlyIfStatus: EDITABLE },
  );
  if (!started) throw changed();
  // Not awaited: it outlives this request. The request's workspace context carries over into it.
  makeVideo(post, { instructions: instructions?.trim(), prompt, brief: parsed });
  return started;
}
