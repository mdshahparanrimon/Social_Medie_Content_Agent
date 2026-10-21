import { repo } from './db/index.js';
import { httpError } from './errors.js';
import { getPost } from './agents/creator.js';
import { defaultScheduleTime } from './settings.js';
import { PLATFORMS } from './platforms.js';

// Post changes shared by the dashboard (routes.js) and Claude via MCP (mcp.js), so both follow the same rules.

export const EDITABLE = ['draft', 'approved', 'failed'];

export function contentChange(post, content) {
  if (content === undefined || content === post.content) return {};
  if (!String(content).trim()) throw httpError(400, 'Post content cannot be empty.');
  return { content: String(content) };
}

export const changed = () => httpError(409, 'This post changed in the meantime. Reload and try again.');

export async function editPost(id, content) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be edited.`);
  const updated = await repo.updatePost(post.id, contentChange(post, content), { onlyIfStatus: EDITABLE });
  if (!updated) throw changed();
  return updated;
}

// Approve = schedule: at `scheduledAt`, or else the platform's default slot (on the calendar day, if planned).
export async function approvePost(id, { content, scheduledAt } = {}) {
  const post = await getPost(id);
  if (!['draft', 'failed'].includes(post.status)) throw httpError(409, `A ${post.status} post cannot be approved.`);
  if (PLATFORMS[post.platform].needsImage && !post.image_url && !post.video_url) {
    throw httpError(400, `${PLATFORMS[post.platform].label} posts need an image or a video. Add one before approving.`);
  }
  if (post.video_status === 'generating') throw httpError(409, 'The video is still being made. Approve the post once it is ready.');

  let when;
  if (scheduledAt) {
    const date = new Date(scheduledAt);
    if (Number.isNaN(date.getTime())) throw httpError(400, 'Invalid schedule time.');
    if (date.getTime() < Date.now() - 60_000) throw httpError(400, 'That time is in the past. Pick a future time or use Publish now.');
    when = date.toISOString();
  } else {
    const item = post.calendar_item_id ? await repo.getCalendarItem(post.calendar_item_id) : null;
    when = await defaultScheduleTime(post.platform, item?.date);
  }

  const updated = await repo.updatePost(
    post.id,
    { ...contentChange(post, content), status: 'approved', scheduled_at: when, error: null },
    { onlyIfStatus: ['draft', 'failed'] },
  );
  if (!updated) throw changed();
  return updated;
}

export async function unapprovePost(id) {
  const post = await getPost(id);
  const updated = await repo.updatePost(post.id, { status: 'draft', scheduled_at: null }, { onlyIfStatus: ['approved', 'failed'] });
  if (!updated) throw httpError(409, `A ${post.status} post cannot go back to draft.`);
  return updated;
}

// imagePrompt: set for AI-made images, so the dashboard can show what the image was made from.
export async function setPostImage(id, imageUrl, { imagePrompt = null } = {}) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  const updated = await repo.updatePost(post.id, { image_url: imageUrl, image_prompt: imagePrompt }, { onlyIfStatus: EDITABLE });
  if (!updated) throw changed();
  return updated;
}
