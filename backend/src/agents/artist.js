import { httpError } from '../errors.js';
import { getConfig } from '../settings.js';
import { getBrand, brandContext } from '../brandBrain.js';
import { aiStatus, generateJSON } from '../llm/index.js';
import { generateImage } from '../llm/image.js';
import { generateVideo, videoProvider, videoStatus } from '../llm/video.js';
import { storeGeneratedImage, storeVideo } from '../media.js';
import { changed, EDITABLE, setPostImage } from '../posts.js';
import { repo } from '../db/index.js';
import { getPost } from './creator.js';
import { PLATFORMS } from '../platforms.js';

const PROMPT_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
  additionalProperties: false,
};

const RULES = [
  'One clear subject and composition that a scroller understands at a glance.',
  'No text, letters or logos in the image unless the instructions ask for them.',
  'No real people, celebrities or other brands.',
].join(' ');

const VIDEO_RULES = [
  'One continuous shot of a few seconds with a clear subject, a simple action and a smooth camera move.',
  'No text, captions, letters or logos unless the instructions ask for them.',
  'No real people, celebrities or other brands.',
].join(' ');

const KINDS = {
  image: { noun: 'image', model: 'AI image model', task: 'image-prompt', rules: RULES, describe: 'Describe the subject, setting, style, lighting, colors and composition in 2-5 sentences.' },
  video: {
    noun: 'short video',
    model: 'AI video model',
    task: 'video-prompt',
    rules: VIDEO_RULES,
    describe: 'Describe the subject, the action, the camera movement, setting, lighting, style and mood in 2-5 sentences.',
  },
};

// The text AI turns the post into a concrete image or video prompt. Without one (MCP mode), a plain template is used.
async function writePrompt({ brand, post, instructions, kind = 'image' }) {
  const { label } = PLATFORMS[post.platform];
  const { aspect } = PLATFORMS[post.platform][kind];
  const k = KINDS[kind];
  const config = await getConfig();
  const ai = aiStatus(config);
  if (ai.provider === 'mcp' || !ai.ready) {
    return [
      `A ${aspect} social media ${k.noun} for a ${label} post by ${brand.name}.`,
      brand.tone && `Brand mood: ${brand.tone}.`,
      `The post: ${post.content}`,
      instructions && `Instructions: ${instructions}`,
      k.rules,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const system = `${brandContext(brand)}

# Your role
You are this brand's art director. You write prompts for an ${k.model} that make on-brand, scroll-stopping social ${k.noun}s.`;
  let prompt = `Write a prompt for the ${k.noun} that goes with this ${label} post (${aspect} format).

Post:
<post>
${post.content}
</post>`;
  if (instructions) prompt += `\n\nInstructions from the brand owner (follow them):\n<instructions>\n${instructions}\n</instructions>`;
  prompt += `\n\n${k.describe} ${k.rules}`;

  const result = await generateJSON({ task: k.task, system, prompt, schema: PROMPT_SCHEMA, effort: 'low' });
  return result.prompt.trim();
}

// Makes an image for the post and attaches it. `prompt` (from Claude via MCP) skips the prompt-writing step.
export async function createPostImage(id, { instructions, prompt } = {}) {
  const post = await getPost(id);
  // Checked before generating, so no image is paid for that can't be attached.
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  const { image } = PLATFORMS[post.platform];
  const imagePrompt = prompt?.trim() || (await writePrompt({ brand: await getBrand(), post, instructions: instructions?.trim() }));
  const buffer = await generateImage({ prompt: imagePrompt, aspect: image.aspect });
  const url = await storeGeneratedImage(buffer, image);
  return setPostImage(post.id, url, { imagePrompt });
}

// ---- Video: minutes, not seconds, so it runs in the background and the post carries its progress ----
// video_status: 'generating' -> 'ready' (video_url set) or 'failed' (video_error set).

async function makeVideo(post, { instructions, prompt }) {
  try {
    const videoPrompt = prompt?.trim() || (await writePrompt({ brand: await getBrand(), post, instructions, kind: 'video' }));
    const { buffer } = await generateVideo({ prompt: videoPrompt, aspect: PLATFORMS[post.platform].video.aspect });
    const url = await storeVideo(buffer);
    await repo.updatePost(post.id, { video_url: url, video_prompt: videoPrompt, video_status: 'ready', video_error: null });
  } catch (err) {
    console.error(`[video] post ${post.id}: ${err.message}`);
    await repo.updatePost(post.id, { video_status: 'failed', video_error: err.message });
  }
}

// Starts making a video for the post and returns the post right away (video_status 'generating').
export async function startPostVideo(id, { instructions, prompt } = {}) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  if (post.video_status === 'generating') throw httpError(409, 'A video is already being made for this post.');
  const config = await getConfig();
  if (!videoProvider(config)) throw httpError(400, videoStatus(config).missing);

  const started = await repo.updatePost(
    post.id,
    { video_status: 'generating', video_error: null, video_started_at: new Date().toISOString() },
    { onlyIfStatus: EDITABLE },
  );
  if (!started) throw changed();
  // Not awaited: it outlives this request. The request's workspace context carries over into it.
  makeVideo(post, { instructions: instructions?.trim(), prompt });
  return started;
}
