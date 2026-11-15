import { repo } from './db/index.js';
import { AppError, httpError } from './errors.js';
import { getPost } from './agents/creator.js';
import { defaultScheduleTime, getConfig } from './settings.js';
import { PLATFORMS } from './platforms.js';
import { RULES_VERSION } from './mediaRules.js';
import { releaseMedia } from './media.js';
import { transition } from './postStates.js';
import { assessPost, enforceApproval, qualitySettings } from './quality/gate.js';
import { log } from './log.js';

// Post changes shared by the dashboard (routes.js) and Claude via MCP (mcp.js), so both follow the same rules.

export const EDITABLE = ['draft', 'approved', 'failed'];

export function contentChange(post, content) {
  if (content === undefined || content === post.content) return {};
  if (!String(content).trim()) throw httpError(400, 'Post content cannot be empty.');
  return { content: String(content) };
}

export const changed = () => httpError(409, 'This post changed in the meantime. Reload and try again.');

// The old file is deleted once nothing else uses it. A failed delete is logged by releaseMedia; the orphan sweep retries it.
async function releaseReplaced(oldUrls, keep = []) {
  for (const url of oldUrls) if (url && !keep.includes(url)) await releaseMedia(url);
}

export async function editPost(id, content) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be edited.`);
  const updated = await repo.updatePost(post.id, contentChange(post, content), { onlyIfStatus: EDITABLE });
  if (!updated) throw changed();
  // Re-check the new text. An approved post that no longer passes goes back to draft instead of publishing as-is.
  const { quality } = await assessPost(updated, { runAi: 'never' });
  if (updated.status === 'approved' && quality.status === 'blocked') {
    const back = await transition(updated.id, 'approved', 'draft', { scheduled_at: null, error: `Moved back to draft after editing: ${quality.blockers.map((b) => b.message).join(' ')}` });
    return back ? { ...back, quality } : { ...updated, quality };
  }
  return { ...updated, quality };
}

/**
 * Approve = schedule: at `scheduledAt`, or else the platform's default slot (on the calendar day, if planned).
 * The quality gate runs first. Blocking problems always stop it. Items flagged for a person stop it too, unless the
 * caller passes acknowledge = true (the dashboard's confirm button; the MCP tools can not).
 * Nothing here publishes: it only makes the post eligible for its scheduled time.
 */
export async function approvePost(id, { content, scheduledAt, acknowledge = false } = {}) {
  const post = await getPost(id);
  if (!['draft', 'failed'].includes(post.status)) throw httpError(409, `A ${post.status} post cannot be approved.`);
  if (PLATFORMS[post.platform].needsImage && !post.image_url && !post.video_url) {
    throw httpError(400, `${PLATFORMS[post.platform].label} posts need an image or a video. Add one before approving.`);
  }
  if (post.video_status === 'generating') throw httpError(409, 'The video is still being made. Approve the post once it is ready.');

  const config = await getConfig();
  const next = { ...post, ...contentChange(post, content) };
  const { quality, post: assessed } = await assessPost(next, { runAi: qualitySettings(config).requireAiReview ? 'if_stale' : 'never', persist: false });
  try {
    enforceApproval(quality, { acknowledge });
  } catch (err) {
    // Keep the result on the draft so the dashboard and the next MCP call can show what to fix.
    await repo.updatePost(post.id, { quality, media_qc: assessed.media_qc }, { onlyIfStatus: ['draft', 'failed'] });
    throw err;
  }
  if (acknowledge && quality.needs_acknowledgement.length) quality.acknowledged_at = new Date().toISOString();

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

  const updated = await transition(post.id, ['draft', 'failed'], 'approved', {
    ...contentChange(post, content),
    scheduled_at: when,
    error: null,
    next_attempt_at: null,
    publish_attempt_count: 0,
    quality,
    media_qc: assessed.media_qc,
    approved_at: new Date().toISOString(),
  });
  if (!updated) throw changed();
  log.info('post.approved', { post: post.id, platform: post.platform, quality: quality.status, acknowledged: Boolean(quality.acknowledged_at) });
  return updated;
}

export async function unapprovePost(id) {
  const post = await getPost(id);
  const updated = await transition(post.id, ['approved', 'failed'], 'draft', { scheduled_at: null, next_attempt_at: null }).catch(() => null);
  if (!updated) throw httpError(409, `A ${post.status} post cannot go back to draft.`);
  return updated;
}

// What a stored QC result looks like in post.media_qc, so attaching media does not need to be checked a second time.
const qcEntry = (url, report, alt = '') => ({ url, rules_version: RULES_VERSION, alt, checked_at: new Date().toISOString(), report });

// imagePrompt: set for AI-made images, so the dashboard can show what the image was made from.
// alt: alt text for the image. qc: the report from importImage (kept so approval doesn't repeat the check).
export async function setPostImage(id, imageUrl, { imagePrompt = null, alt, qc = null } = {}) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  const imageAlt = alt !== undefined ? String(alt || '').trim().slice(0, 1000) : post.image_url === imageUrl ? post.image_alt || '' : '';
  const media_qc = { ...(post.media_qc || {}) };
  if (qc) media_qc.image = qcEntry(imageUrl, qc, imageAlt);
  else delete media_qc.image;
  const updated = await repo.updatePost(post.id, { image_url: imageUrl, image_prompt: imagePrompt, image_alt: imageAlt, media_qc }, { onlyIfStatus: EDITABLE });
  if (!updated) throw changed();
  await releaseReplaced([post.image_url], [imageUrl]);
  return updated;
}

export async function setImageAlt(id, alt) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  const updated = await repo.updatePost(post.id, { image_alt: String(alt || '').trim().slice(0, 1000) }, { onlyIfStatus: EDITABLE });
  if (!updated) throw changed();
  return updated;
}

// A PDF carousel (LinkedIn only), replacing any the post had. slides/accent: set for AI-made carousels.
export async function setPostDocument(id, { url, title, pages, slides = null, accent = null, qc = null }) {
  const post = await getPost(id);
  if (!PLATFORMS[post.platform].documents) throw httpError(400, `${PLATFORMS[post.platform].label} posts can't carry a PDF carousel.`);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  const media_qc = { ...(post.media_qc || {}) };
  if (qc) media_qc.pdf = qcEntry(url, qc);
  else delete media_qc.pdf;
  const updated = await repo.updatePost(
    post.id,
    { document_url: url, document_title: title, document_pages: pages, document_slides: slides, document_accent: accent, media_qc },
    { onlyIfStatus: EDITABLE },
  );
  if (!updated) throw changed();
  await releaseReplaced([post.document_url], [url]);
  return updated;
}

// A finished video (not AI-made), replacing any video the post had.
export async function setPostVideo(id, videoUrl, { qc = null } = {}) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  if (post.video_status === 'generating') throw httpError(409, 'A video is being made for this post. Wait until it is finished.');
  const media_qc = { ...(post.media_qc || {}) };
  if (qc) media_qc.video = qcEntry(videoUrl, qc);
  else delete media_qc.video;
  const updated = await repo.updatePost(
    post.id,
    { video_url: videoUrl, video_prompt: null, video_status: 'ready', video_error: null, media_qc },
    { onlyIfStatus: EDITABLE },
  );
  if (!updated) throw changed();
  await releaseReplaced([post.video_url], [videoUrl]);
  return updated;
}

// Removes one kind of media from a post and deletes its file when nothing else uses it.
export async function removePostMedia(post, kind, allowedStatuses) {
  const fields = {
    image: { image_url: null, image_prompt: null, image_alt: '' },
    video: { video_url: null, video_prompt: null, video_status: null, video_error: null },
    document: { document_url: null, document_title: null, document_pages: null, document_slides: null, document_accent: null },
  }[kind];
  const old = { image: post.image_url, video: post.video_url, document: post.document_url }[kind];
  const media_qc = { ...(post.media_qc || {}) };
  delete media_qc[kind === 'document' ? 'pdf' : kind];
  const updated = await repo.updatePost(post.id, { ...fields, media_qc }, { onlyIfStatus: allowedStatuses });
  if (!updated) throw new AppError('INVALID_TRANSITION', `Move the post back to draft before removing its ${kind}.`, { status: 409 });
  await releaseReplaced([old]);
  return updated;
}

export async function deletePostAndMedia(post) {
  await repo.deletePost(post.id);
  await releaseReplaced([post.image_url, post.video_url, post.document_url]);
}
