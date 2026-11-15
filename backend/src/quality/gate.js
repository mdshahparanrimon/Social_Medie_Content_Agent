import crypto from 'node:crypto';
import { repo } from '../db/index.js';
import { getConfig } from '../settings.js';
import { getBrand } from '../brandBrain.js';
import { AppError, httpError } from '../errors.js';
import { PLATFORMS } from '../platforms.js';
import { RULES_VERSION } from '../mediaRules.js';
import { checkImage, checkPdf, checkVideo, combineReports } from '../mediaQc.js';
import { loadDocument, loadImage, withVideoFile } from '../media.js';
import { log, count } from '../log.js';
import { lintContent } from './lint.js';
import { reviewDraft } from './review.js';
import { scorePost } from './score.js';

// The shared content-quality gate. The dashboard, the MCP tools, approval and the scheduler all call this, so a post
// gets the same checks whichever way it was made.
//
// Outcome of an assessment (post.quality.status):
//   blocked             a hard rule is broken (lint error, media error): cannot be approved or published
//   needs_human_review  nothing is broken, but a person must look at flagged items and accept them to approve
//   ready               no blocking or flagged items. Still needs a person to approve: nothing here publishes anything.

export const QUALITY_VERSION = 1;
const ACK_MEDIA_CODES = new Set(['IMAGE_CROPPED']);

export const contentHash = (post) =>
  crypto.createHash('sha256').update(JSON.stringify([post.content, post.image_url, post.video_url, post.document_url, post.image_alt || ''])).digest('hex').slice(0, 24);

export function qualitySettings(config) {
  return {
    threshold: config.quality_min_score,
    maxRevisions: config.quality_max_revisions,
    requireAiReview: config.quality_require_ai_review,
  };
}

// ---- Media ----

/** Runs (or reuses) the technical checks for the media the post will actually publish. */
export async function checkPostMedia(post, { useCache = true } = {}) {
  const p = PLATFORMS[post.platform];
  const cache = post.media_qc || {};
  const next = { ...cache };
  const reports = {};

  async function one(kind, url, run) {
    const hit = cache[kind];
    if (useCache && hit && hit.url === url && hit.rules_version === RULES_VERSION && hit.alt === (post.image_alt || '')) {
      reports[kind] = hit.report;
      return;
    }
    let report;
    try {
      report = await run();
      report = { kind: report.kind, ok: report.ok, errors: report.errors, warnings: report.warnings, humanReview: report.humanReview, info: report.info, checks: report.checks };
    } catch (err) {
      log.warn('qc.media_unavailable', { kind, code: err.code, message: err.message });
      report = { kind, ok: false, errors: [{ code: 'MEDIA_UNAVAILABLE', message: err.message }], warnings: [], humanReview: [], info: {}, checks: {} };
    }
    reports[kind] = report;
    next[kind] = { url, rules_version: RULES_VERSION, alt: post.image_alt || '', checked_at: new Date().toISOString(), report };
  }

  // The publishers send one media item: a PDF carousel (where supported), else the video, else the image.
  if (p.documents && post.document_url) await one('pdf', post.document_url, async () => checkPdf(await loadDocument(post.document_url), { platform: post.platform }));
  else if (post.video_url) await one('video', post.video_url, () => withVideoFile(post.video_url, (file) => checkVideo(file, { platform: post.platform })));
  else if (post.image_url) await one('image', post.image_url, async () => checkImage(await loadImage(post.image_url), { platform: post.platform, altText: post.image_alt }));
  for (const kind of Object.keys(next)) if (!reports[kind] && kind !== 'image' && kind !== 'pdf' && kind !== 'video') delete next[kind];

  const combined = combineReports(Object.values(reports));
  return { combined, reports, cache: next };
}

// ---- Content ----

/**
 * Lint + (optionally) AI review + score for one post-shaped object. No database writes.
 * runAi: 'always' | 'never' | 'if_stale' (reuse post.quality.review when the content has not changed).
 */
export async function evaluateContent({ post, brand, config, media = null, runAi = 'never', brief }) {
  const settings = qualitySettings(config);
  const recent = (await repo.recentPosts(post.platform, 30)).filter((r) => r.id !== post.id && r.status !== 'failed');
  const lint = lintContent({ post, brand, recent });

  const hash = contentHash(post);
  const previous = post.quality?.review;
  let ai;
  if (runAi === 'never' || (runAi === 'if_stale' && previous?.status === 'ok' && post.quality?.content_hash === hash)) {
    ai = previous && post.quality?.content_hash === hash ? previous : { status: 'not_run' };
  } else if (lint.errors.length && runAi !== 'always') {
    ai = { status: 'not_run', message: 'Skipped: fix the rule violations first.' };
  } else {
    ai = await reviewDraft({ post, brand, brief: brief ?? post.brief, lint, threshold: settings.threshold });
    if (ai.status !== 'ok') {
      await repo.logAudit({ type: `quality.review_${ai.status}`, post_id: post.id || null, message: ai.message, provider: ai.provider }).catch(() => {});
    }
  }
  const mediaByKind = media ? Object.fromEntries(media.combined.reports.map((r) => [r.kind, r])) : {};
  const score = scorePost({ post, lint, review: ai.status === 'ok' ? ai.review : null, media: mediaByKind, threshold: settings.threshold, documents: Boolean(PLATFORMS[post.platform]?.documents) });
  return { lint, ai, score, hash, settings };
}

function decide({ lint, ai, score, media, settings }) {
  const blockers = [
    ...lint.errors.map((i) => ({ source: 'content', code: i.code, message: i.message })),
    ...(media?.combined.errors || []).map((e) => ({ source: e.media, code: e.code, message: e.message })),
  ];
  const acks = [
    ...lint.reviews.map((i) => ({ source: 'content', code: i.code, message: i.message })),
    ...(media?.combined.warnings || []).filter((w) => ACK_MEDIA_CODES.has(w.code)).map((w) => ({ source: w.media, code: w.code, message: w.message })),
  ];
  if (ai.status === 'ok') {
    if (!ai.review.pass) {
      const why = ai.review.critical_issues[0]?.issue || (ai.review.weak_dimensions.length ? `weak: ${ai.review.weak_dimensions.join(', ')}` : `score ${ai.review.score} is below ${settings.threshold}`);
      acks.push({ source: 'ai_review', code: 'AI_REVIEW_FAILED', message: `The AI review did not pass: ${why}.` });
    }
    if (ai.review.human_review_required) acks.push({ source: 'ai_review', code: 'AI_HUMAN_REVIEW', message: ai.review.human_review_reasons.join(' ') || 'The AI reviewer asks for a human check.' });
  } else if (settings.requireAiReview) {
    acks.push({ source: 'ai_review', code: `AI_REVIEW_${ai.status.toUpperCase()}`, message: ai.message || 'The required AI review has not been done for this version of the post.' });
  }
  if (score.total !== null && !score.meets_threshold && ai.status !== 'ok') acks.push({ source: 'score', code: 'SCORE_LOW', message: `The score ${score.total} is below ${settings.threshold}.` });
  const status = blockers.length ? 'blocked' : acks.length ? 'needs_human_review' : 'ready';
  return { status, blockers, acks };
}

// The compact form stored on the post and returned to clients (no raw reports; those are in post.media_qc).
function buildQuality({ previous, post, content, decision, media, hash, checkedAt }) {
  const { lint, ai, score, settings } = content;
  const changed = previous && previous.content_hash !== hash;
  const revisions = (previous?.revision_count || 0) + (changed ? 1 : 0);
  const limitReached = revisions >= settings.maxRevisions && decision.status !== 'ready';
  return {
    version: QUALITY_VERSION,
    checked_at: checkedAt,
    content_hash: hash,
    status: decision.status,
    blockers: decision.blockers,
    needs_acknowledgement: decision.acks,
    acknowledged_at: null,
    warnings: [...lint.warnings.map((i) => ({ code: i.code, message: i.message })), ...(media?.combined.warnings || []).map((w) => ({ code: w.code, message: w.message, source: w.media }))],
    human_checklist: media?.combined.humanReview || [],
    review: ai.status === 'ok' ? { status: 'ok', ...ai.review, provider: ai.provider, model: ai.model, independent: ai.independent } : { status: ai.status, message: ai.message || null, provider: ai.provider || null },
    score,
    revision_count: revisions,
    max_revisions: settings.maxRevisions,
    revision_limit_reached: limitReached,
    next_steps: nextSteps(decision, ai, limitReached),
  };
}

function nextSteps(decision, ai, limitReached) {
  if (decision.status === 'ready') return [];
  if (limitReached) return ['The revision limit was reached. Stop revising: a person should review this draft and decide.'];
  const steps = decision.blockers.map((b) => `Fix: ${b.message}`);
  if (ai.status === 'ok') steps.push(...ai.review.revision_instructions);
  if (!steps.length) steps.push(...decision.acks.map((a) => `Check: ${a.message}`));
  return steps.slice(0, 15);
}

/**
 * Assesses a stored post and saves the result on it (post.quality, post.media_qc).
 * options: runAi ('never' default | 'if_stale' | 'always'), useMediaCache (false before publishing), persist.
 */
export async function assessPost(postOrId, { runAi = 'never', useMediaCache = true, persist = true } = {}) {
  const post = typeof postOrId === 'string' ? await repo.getPost(postOrId) : postOrId;
  if (!post) throw httpError(404, 'Post not found.');
  const [brand, config] = await Promise.all([getBrand(), getConfig()]);
  const media = await checkPostMedia(post, { useCache: useMediaCache });
  const content = await evaluateContent({ post, brand, config, media, runAi });
  const decision = decide({ ...content, media });
  const quality = buildQuality({ previous: post.quality, post, content, decision, media, hash: content.hash, checkedAt: new Date().toISOString() });
  if (post.quality?.acknowledged_at && post.quality.content_hash === content.hash) quality.acknowledged_at = post.quality.acknowledged_at;

  count(`quality.${quality.status}`);
  if (quality.status !== 'ready') log.info('quality.assessed', { post: post.id, platform: post.platform, status: quality.status, blockers: quality.blockers.map((b) => b.code), revisions: quality.revision_count });
  if (persist && post.id) {
    await repo.updatePost(post.id, { quality, media_qc: media.cache, brand_score: quality.score.total !== null ? Math.round(quality.score.total / 10) : post.brand_score ?? null });
  }
  return { quality, post: { ...post, quality, media_qc: media.cache } };
}

/**
 * Called before a post goes to "approved". Blocking problems always stop it; flagged items stop it unless a person
 * passes acknowledge = true (the dashboard confirm button; MCP can not).
 */
export function enforceApproval(quality, { acknowledge = false } = {}) {
  if (quality.status === 'blocked') {
    throw new AppError('QUALITY_BLOCKED', `This post can't be approved yet: ${quality.blockers.map((b) => b.message).join(' ')}`, { status: 422, details: { quality: summarize(quality) } });
  }
  if (quality.needs_acknowledgement.length && !acknowledge) {
    throw new AppError(
      'REVIEW_REQUIRED',
      `A person needs to review this before it is approved: ${quality.needs_acknowledgement.map((a) => a.message).join(' ')}`,
      { status: 409, details: { quality: summarize(quality) } },
    );
  }
}

/** The part of the quality record clients need (also what MCP tools return). */
export function summarize(q) {
  if (!q) return null;
  return {
    status: q.status,
    score: q.score?.total ?? null,
    partial_score: q.score?.partial_total ?? null,
    threshold: q.score?.threshold ?? null,
    technical_score: q.score?.technical_total ?? null,
    subjective_score: q.score?.subjective_total ?? null,
    blockers: q.blockers,
    needs_acknowledgement: q.needs_acknowledgement,
    warnings: q.warnings,
    human_checklist: q.human_checklist,
    ai_review: q.review?.status === 'ok'
      ? { status: 'ok', score: q.review.score, pass: q.review.pass, critical_issues: q.review.critical_issues, revision_instructions: q.review.revision_instructions, provider: q.review.provider, model: q.review.model }
      : { status: q.review?.status || 'not_run', message: q.review?.message || null },
    revision_count: q.revision_count,
    max_revisions: q.max_revisions,
    revision_limit_reached: q.revision_limit_reached,
    next_steps: q.next_steps,
  };
}

// ---- Generation loop (dashboard) ----

/**
 * Write -> check -> revise, at most settings.maxRevisions times. `write(previous, notes)` returns new text.
 * The first draft is always kept, and the best version wins if none passes; the result says whether a person must review.
 */
export async function reviseUntilReady({ platform, brief, first, write, brand: givenBrand }) {
  const [brand, config] = await Promise.all([givenBrand ?? getBrand(), getConfig()]);
  const settings = qualitySettings(config);
  let content = first;
  let best = null;
  let revisions = 0;
  for (;;) {
    const post = { platform, content, brief, quality: null };
    const evaluation = await evaluateContent({ post, brand, config, runAi: 'always', brief });
    const decision = decide({ ...evaluation, media: null });
    const rank = (decision.blockers.length ? 0 : 1000) + (evaluation.ai.status === 'ok' ? evaluation.ai.review.score : 0) - evaluation.lint.warnings.length;
    if (!best || rank > best.rank) best = { rank, content, evaluation, decision };
    const aiPass = evaluation.ai.status === 'ok' ? evaluation.ai.review.pass : !settings.requireAiReview;
    const clean = !decision.blockers.length && aiPass;
    if (clean || revisions >= settings.maxRevisions) break;
    // Hand the writer the exact problems and ask it to keep everything else.
    const notes = [
      ...decision.blockers.map((b) => b.message),
      ...(evaluation.ai.status === 'ok' ? [...evaluation.ai.review.critical_issues.map((c) => `${c.issue} (${c.evidence})`), ...evaluation.ai.review.revision_instructions] : []),
      ...evaluation.lint.reviews.map((i) => i.message),
    ];
    if (!notes.length) break;
    content = await write(content, `Fix only these problems and keep everything else that works:\n- ${notes.join('\n- ')}`);
    revisions++;
  }
  count('quality.generation_revisions', revisions);
  const { evaluation, decision } = best;
  return {
    content: best.content,
    revisions,
    reached_limit: revisions >= settings.maxRevisions && best.decision.status !== 'ready',
    evaluation,
    decision,
    score10: evaluation.score.total !== null ? Math.round(evaluation.score.total / 10) : evaluation.ai.status === 'ok' ? Math.round(evaluation.ai.review.score / 10) : null,
    critique: [...decision.blockers.map((b) => b.message), ...decision.acks.map((a) => a.message), ...(evaluation.ai.status === 'ok' ? evaluation.ai.review.warnings : [])].join('\n'),
  };
}

/** Quality record for a draft that reviseUntilReady() just produced (no media yet). */
export function qualityFromRevision(result) {
  const { evaluation, decision, revisions } = result;
  const q = buildQuality({ previous: null, post: null, content: evaluation, decision, media: null, hash: evaluation.hash, checkedAt: new Date().toISOString() });
  q.revision_count = revisions;
  q.revision_limit_reached = result.reached_limit;
  if (result.reached_limit) q.next_steps = ['The revision limit was reached. A person should review this draft and decide.'];
  return q;
}
