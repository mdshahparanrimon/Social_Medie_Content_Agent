import { repo } from '../db/index.js';
import { httpError } from '../errors.js';
import { getBrand, brandContext, missingBrandFields } from '../brandBrain.js';
import { generateJSON } from '../llm/index.js';
import { PLATFORMS } from '../platforms.js';
import { reviseUntilReady, qualityFromRevision } from '../quality/gate.js';

const POST_SCHEMA = {
  type: 'object',
  properties: { post: { type: 'string' } },
  required: ['post'],
  additionalProperties: false,
};

async function writeDraft({ brand, platform, brief, previous, notes }) {
  const { label, guide } = PLATFORMS[platform];
  const system = `${brandContext(brand)}

# Your role
You are this brand's social media writer. Write in the brand's voice for its audience. Be specific and useful; avoid clichés, filler, and generic AI phrasing. Never invent statistics, quotes, or facts about the brand.

# Platform: ${label}
${guide}`;

  let prompt = `Write a ${label} post for this brief:\n<brief>\n${brief}\n</brief>`;
  if (previous) {
    prompt += `\n\nPrevious draft:\n<draft>\n${previous}\n</draft>\n\nWrite an improved version that addresses this feedback:\n<feedback>\n${notes}\n</feedback>`;
  }
  prompt += '\n\nPut only the final post text, exactly as it should be published, in the "post" field.';

  const { post } = await generateJSON({ task: 'creator', system, prompt, schema: POST_SCHEMA });
  return post.trim();
}

// Generate -> check (rules + independent AI review) -> revise only what failed, a configurable number of times.
// The first draft is always kept; if nothing passes, the best version is saved with the reasons for a person to review.
async function writeWithReview({ platform, brief, previous, notes }) {
  const brand = await getBrand();
  const missing = missingBrandFields(brand);
  if (missing.length) throw httpError(400, `Fill in your Brand Brain first: ${missing.join(', ')}.`);
  if (!PLATFORMS[platform]) throw httpError(400, `Unknown platform: ${platform}`);

  const write = (prev, feedback) => writeDraft({ brand, platform, brief, previous: prev, notes: feedback });
  const first = await writeDraft({ brand, platform, brief, previous, notes });
  return reviseUntilReady({ platform, brief, first, write, brand });
}

export async function getPost(id) {
  const post = await repo.getPost(id);
  if (!post) throw httpError(404, 'Post not found.');
  return post;
}

export async function createPost({ platform, brief, calendarItemId = null }) {
  const result = await writeWithReview({ platform, brief });
  const post = await repo.createPost({
    calendar_item_id: calendarItemId,
    platform,
    brief,
    content: result.content,
    brand_score: result.score10,
    critique: result.critique,
  });
  return repo.updatePost(post.id, { quality: qualityFromRevision(result) });
}

export async function rewritePost(id, userFeedback) {
  const post = await getPost(id);
  if (post.status !== 'draft') throw httpError(409, 'Only drafts can be rewritten.');
  const notes = userFeedback?.trim() || 'Write a fresh version with a different angle and a stronger hook.';
  const result = await writeWithReview({ platform: post.platform, brief: post.brief, previous: post.content, notes });
  const updated = await repo.updatePost(
    id,
    { content: result.content, brand_score: result.score10, critique: result.critique, quality: qualityFromRevision(result) },
    { onlyIfStatus: ['draft'] },
  );
  if (!updated) throw httpError(409, 'This post changed while it was being rewritten. Reload and try again.');
  return updated;
}
