import { repo } from '../db/index.js';
import { httpError } from '../errors.js';
import { getBrand, brandContext, missingBrandFields } from '../brandBrain.js';
import { generateJSON } from '../llm/index.js';
import { PLATFORMS, charCount } from '../platforms.js';

// A draft must score at least this (1-10) in self-review, or it gets revised.
const MIN_SCORE = 8;
const MAX_REVISIONS = 2;

const POST_SCHEMA = {
  type: 'object',
  properties: { post: { type: 'string' } },
  required: ['post'],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    issues: { type: 'array', items: { type: 'string' } },
    revision_instructions: { type: 'string' },
  },
  required: ['score', 'issues', 'revision_instructions'],
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

async function reviewDraft({ brand, platform, brief, content }) {
  const { label, guide } = PLATFORMS[platform];
  const system = `${brandContext(brand)}

# Your role
You are a strict brand editor. You judge whether a draft is on-brand and ready to publish.`;

  const prompt = `Review this ${label} draft.

Brief:
<brief>
${brief}
</brief>

Platform rules:
${guide}

Draft:
<draft>
${content}
</draft>

Score it from 1 to 10 for publish-readiness: brand voice and tone, fit with the audience and goal, strength of the hook, clarity, platform fit, and that it avoids the brand's forbidden topics. 8 means ready to publish. List concrete issues (empty if none) and give short revision instructions.`;

  const review = await generateJSON({ task: 'critic', system, prompt, schema: REVIEW_SCHEMA, effort: 'low' });
  return { ...review, score: Math.min(Math.max(review.score, 1), 10) };
}

// Generate -> self-review -> revise until the draft is on-brand and fits the platform.
async function writeWithReview({ platform, brief, previous, notes }) {
  const brand = await getBrand();
  const missing = missingBrandFields(brand);
  if (missing.length) throw httpError(400, `Fill in your Brand Brain first: ${missing.join(', ')}.`);
  if (!PLATFORMS[platform]) throw httpError(400, `Unknown platform: ${platform}`);

  let content = await writeDraft({ brand, platform, brief, previous, notes });
  let review;
  for (let revision = 0; ; revision++) {
    review = await reviewDraft({ brand, platform, brief, content });
    const length = charCount(platform, content);
    const { maxChars } = PLATFORMS[platform];
    const tooLong = length > maxChars;
    if ((review.score >= MIN_SCORE && !tooLong) || revision === MAX_REVISIONS) break;

    const feedback = [review.revision_instructions, ...review.issues];
    if (tooLong) feedback.unshift(`It is ${length} characters but the limit is ${maxChars}. Make it shorter.`);
    content = await writeDraft({ brand, platform, brief, previous: content, notes: feedback.join('\n') });
  }
  return { content, score: review.score, critique: review.issues.join('\n') };
}

export async function getPost(id) {
  const post = await repo.getPost(id);
  if (!post) throw httpError(404, 'Post not found.');
  return post;
}

export async function createPost({ platform, brief, calendarItemId = null }) {
  const { content, score, critique } = await writeWithReview({ platform, brief });
  return repo.createPost({
    calendar_item_id: calendarItemId,
    platform,
    brief,
    content,
    brand_score: score,
    critique,
  });
}

export async function rewritePost(id, userFeedback) {
  const post = await getPost(id);
  if (post.status !== 'draft') throw httpError(409, 'Only drafts can be rewritten.');
  const notes = userFeedback?.trim() || 'Write a fresh version with a different angle and a stronger hook.';
  const { content, score, critique } = await writeWithReview({
    platform: post.platform,
    brief: post.brief,
    previous: post.content,
    notes,
  });
  const updated = await repo.updatePost(id, { content, brand_score: score, critique }, { onlyIfStatus: ['draft'] });
  if (!updated) throw httpError(409, 'This post changed while it was being rewritten. Reload and try again.');
  return updated;
}
