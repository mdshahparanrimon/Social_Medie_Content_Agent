import crypto from 'node:crypto';
import { repo } from './db/index.js';
import { AppError, httpError } from './errors.js';
import { runInWorkspace, workspaceId } from './context.js';
import { updateAccount } from './accounts.js';
import { publishToPlatform, reconcileOnPlatform } from './publishers/index.js';
import { transition } from './postStates.js';
import { decideAfterFailure } from './publishPolicy.js';
import { assessPost } from './quality/gate.js';
import { log, count, redactText } from './log.js';

// Publishing a post, kept apart from the platform code:
//   1. claim      one atomic database move approved/failed -> publishing, with an attempt id and a lease.
//                 Only the caller that wins the claim may call the platform, so two workers can't both post it.
//   2. preflight  the quality gate and media checks run again on what will really be sent. A blocker stops here,
//                 before anything leaves the building.
//   3. publish    the platform call, with progress events (remote ids are saved the moment they exist).
//   4. settle     the result is written back with a validated state transition:
//                   published | failed (not posted) | approved again (safe retry, with backoff) | uncertain.
//
// This does NOT give exactly-once publishing. Platforms offer no idempotency key for these calls, so if a request
// times out after the platform accepted it, the post may exist. That case is "uncertain": it is never retried by
// itself; the app asks the platform where it can, and otherwise asks a person.

export const LEASE_MS = 15 * 60_000;
export const PUBLISH_TIMEOUT_MS = 12 * 60_000;
const RECONCILE_EVERY_MS = 5 * 60_000;
const MAX_AUTO_RECONCILES = 24;

const nowIso = () => new Date().toISOString();
const short = (message) => redactText(String(message || 'Publishing failed.')).slice(0, 500);

async function settle(id, from, to, fields) {
  const updated = await transition(id, from, to, { lease_expires_at: null, ...fields });
  if (!updated) log.error('publish.settle_conflict', { post: id, to });
  return updated;
}

// The attempt log is for diagnosis; failing to write it must not hide the publishing result, but it is never silent.
async function safely(label, fn) {
  try {
    return await fn();
  } catch (err) {
    count('publish.bookkeeping_failed');
    log.error('publish.bookkeeping_failed', { step: label, message: err.message });
    return null;
  }
}

export async function publishPost(id, { trigger = 'manual' } = {}) {
  const ws = workspaceId(); // throws outside a workspace: every call is workspace-scoped
  const current = await repo.getPost(id);
  if (!current) throw httpError(404, 'Post not found.');
  if (current.status === 'uncertain') {
    throw new AppError('UNCERTAIN_OUTCOME', 'The last attempt to publish this post has an unknown result. Check the platform, then confirm whether it was posted. It is not published again automatically, to avoid a duplicate.', { status: 409 });
  }

  const attemptId = crypto.randomUUID();
  const claimed = await repo.claimPost(id, { attemptId, leaseMs: LEASE_MS, fromStatuses: ['approved', 'failed'] });
  if (!claimed) throw httpError(409, 'Only approved or failed posts can be published (or another worker is publishing it right now).');
  const attemptNo = claimed.publish_attempt_count || 1;

  await safely('attempt.insert', () =>
    repo.insertAttempt({ attempt_id: attemptId, post_id: String(id), platform: claimed.platform, trigger, number: attemptNo, started_at: nowIso(), phase: 'claimed', outcome: 'started', remote_id: null }),
  );
  log.info('publish.attempt_started', { post: id, workspace: ws, platform: claimed.platform, attempt: attemptNo, attempt_id: attemptId, trigger });
  count('publish.attempts');

  const finishAttempt = (fields) => safely('attempt.update', () => repo.updateAttempt(attemptId, { finished_at: nowIso(), ...fields }));

  // 2. Preflight: same gate as approval, with fresh media checks. Blocking problems fail the post without calling the platform.
  try {
    const { quality } = await assessPost(claimed, { runAi: 'never', useMediaCache: false });
    if (quality.status === 'blocked') {
      const message = `Not published: ${quality.blockers.map((b) => b.message).join(' ')}`;
      await finishAttempt({ outcome: 'blocked', error: short(message) });
      count('publish.blocked');
      log.warn('publish.blocked', { post: id, platform: claimed.platform, blockers: quality.blockers.map((b) => b.code) });
      return await settle(id, 'publishing', 'failed', { error: short(message) });
    }
  } catch (err) {
    await finishAttempt({ outcome: 'failed', error: short(err.message) });
    log.error('publish.preflight_error', { post: id, message: err.message });
    return settle(id, 'publishing', 'failed', { error: short(`Could not check the post before publishing: ${err.message}`) });
  }

  // 3. Publish.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  timer.unref?.(); // a pending publish must not keep the process alive
  let reachedCreate = false;
  let remoteId = null;
  const onProgress = async (event) => {
    if (event.phase === 'creating' || event.phase === 'created') reachedCreate = true;
    if (event.remoteId) {
      remoteId = event.remoteId;
      await safely('remote_id', () => repo.updatePost(id, { remote_id: event.remoteId }, { onlyIfStatus: ['publishing', 'uncertain'] }));
    }
    await safely('attempt.progress', () => repo.updateAttempt(attemptId, { phase: event.phase, ...(event.remoteId ? { remote_id: event.remoteId } : {}) }));
  };

  try {
    const result = await publishToPlatform(claimed, { attemptId, onProgress, signal: controller.signal });
    clearTimeout(timer);
    await finishAttempt({ outcome: 'published', remote_id: result.externalId, simulated: result.simulated });
    count('publish.published');
    log.info('publish.published', { post: id, platform: claimed.platform, attempt: attemptNo, simulated: result.simulated, remote_id: result.externalId });
    const fields = { published_at: nowIso(), external_id: result.externalId, external_url: result.url, simulated: result.simulated, error: null, uncertain_reason: null, next_attempt_at: null };
    // The platform has the post. Make sure the database says so, even through a brief database hiccup.
    for (let i = 0; i < 3; i++) {
      try {
        return (await settle(id, 'publishing', 'published', fields)) || (await settle(id, 'uncertain', 'published', fields)) || (await repo.getPost(id));
      } catch (err) {
        log.error('publish.record_failed', { post: id, remote_id: result.externalId, attempt: i + 1, message: err.message });
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
    // Still can't write: the lease will expire, the post becomes "uncertain", and the remote id is in the attempt log.
    throw new AppError('RECORD_FAILED', `The post was published (${result.externalId}) but could not be recorded. It will show as uncertain; confirm it.`, { status: 500 });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof AppError && err.code === 'RECORD_FAILED') throw err;
    const message = short(controller.signal.aborted && !err.message ? 'Publishing timed out.' : err.message);
    const decision = decideAfterFailure(err, { attemptsMade: attemptNo, reachedCreate });
    log.warn('publish.attempt_failed', { post: id, platform: claimed.platform, attempt: attemptNo, action: decision.action, code: err.code, status: err.status, message });

    if (decision.action === 'uncertain') {
      count('publish.uncertain');
      await finishAttempt({ outcome: 'uncertain', error: message, remote_id: remoteId });
      await safely('audit', () => repo.logAudit({ type: 'publish.uncertain', post_id: String(id), platform: claimed.platform, attempt_id: attemptId, message }));
      return settle(id, 'publishing', 'uncertain', { error: message, uncertain_reason: message, last_reconcile_at: null, reconcile_count: 0 });
    }
    if (decision.action === 'retry') {
      count('publish.retry_scheduled');
      const next = new Date(Date.now() + decision.delayMs).toISOString();
      await finishAttempt({ outcome: 'retry_scheduled', error: message, retry_at: next });
      return settle(id, 'publishing', 'approved', { error: `Attempt ${attemptNo} failed (${message}). Trying again at ${next}.`, next_attempt_at: next });
    }
    count('publish.failed');
    await finishAttempt({ outcome: 'failed', error: message });
    if (err.needsReconnect) {
      await safely('account.error', () => updateAccount(claimed.platform, { status: 'error', last_error: message }));
      count('publish.needs_reconnect');
    }
    return settle(id, 'publishing', 'failed', { error: decision.exhausted ? `${message} (gave up after ${attemptNo} attempts)` : message, next_attempt_at: null });
  }
}

// ---- Uncertain outcomes ----

/** Asks the platform whether an uncertain post exists; settles it when the answer is clear. */
export async function reconcilePost(id) {
  const post = await repo.getPost(id);
  if (!post || post.status !== 'uncertain') return post;
  const attempts = await repo.listAttempts(id);
  const attempt = attempts.at(-1);
  const result = await reconcileOnPlatform(post, attempt);
  log.info('publish.reconciled', { post: id, platform: post.platform, status: result.status });
  if (result.status === 'found') {
    count('publish.reconciled_found');
    if (attempt) await safely('attempt.update', () => repo.updateAttempt(attempt.attempt_id, { outcome: 'published_reconciled', remote_id: result.externalId }));
    return settle(id, 'uncertain', 'published', {
      published_at: nowIso(), external_id: result.externalId, external_url: result.url, simulated: false, error: null,
      uncertain_reason: null, reconciled: true, reconcile_note: result.note || null,
    });
  }
  // Not found is not proof: platforms list recent posts with a delay and only show the latest few. A person decides.
  return repo.updatePost(id, { last_reconcile_at: nowIso(), reconcile_count: (post.reconcile_count || 0) + 1, reconcile_note: result.reason || result.status }, { onlyIfStatus: ['uncertain'] });
}

/** A person's decision about an uncertain post: it was posted, or it was not. */
export async function resolveUncertain(id, { outcome, externalUrl = null, actor = null }) {
  const post = await repo.getPost(id);
  if (!post) throw httpError(404, 'Post not found.');
  if (post.status !== 'uncertain') throw new AppError('INVALID_TRANSITION', `Only posts with an unknown result can be resolved (this one is ${post.status}).`, { status: 409 });
  let updated;
  if (outcome === 'published') {
    updated = await transition(id, 'uncertain', 'published', { published_at: nowIso(), external_url: externalUrl || post.external_url || null, error: null, uncertain_reason: null, resolved_manually: true, simulated: false });
  } else if (outcome === 'not_published') {
    updated = await transition(id, 'uncertain', 'failed', { error: 'You confirmed this was not posted. You can publish it again.', uncertain_reason: null, resolved_manually: true });
  } else {
    throw httpError(400, 'outcome must be "published" or "not_published".');
  }
  if (!updated) throw httpError(409, 'This post changed in the meantime. Reload and try again.');
  await safely('audit', () => repo.logAudit({ type: 'publish.manual_resolution', post_id: String(id), outcome, actor: actor ? String(actor) : null }));
  log.info('publish.manual_resolution', { post: id, outcome });
  return updated;
}

/** Posts whose publisher vanished (crash, restart, stalled call): lease expired while "publishing". */
export async function recoverStalePosts() {
  let recovered = 0;
  for (const post of await repo.stalePublishingPosts(nowIso())) {
    if (!post.workspace_id) continue;
    await runInWorkspace(post.workspace_id, async () => {
      const message = 'Interrupted while publishing (the server stopped or the request stalled). The platform may have posted it.';
      const updated = await transition(post.id, 'publishing', 'uncertain', { error: message, uncertain_reason: message, lease_expires_at: null, last_reconcile_at: null, reconcile_count: 0 });
      if (!updated) return;
      recovered++;
      count('publish.uncertain');
      if (post.publish_attempt_id) await safely('attempt.update', () => repo.updateAttempt(post.publish_attempt_id, { outcome: 'interrupted', finished_at: nowIso() }));
      await safely('audit', () => repo.logAudit({ type: 'publish.interrupted', post_id: post.id, platform: post.platform }));
      log.warn('publish.interrupted', { post: post.id, platform: post.platform });
    });
  }
  return recovered;
}

/** Scheduler step: re-check uncertain posts (every few minutes, a limited number of times). */
export async function reconcileUncertainPosts() {
  for (const post of await repo.allUncertainPosts()) {
    if (!post.workspace_id) continue;
    if ((post.reconcile_count || 0) >= MAX_AUTO_RECONCILES) continue;
    if (post.last_reconcile_at && Date.now() - new Date(post.last_reconcile_at).getTime() < RECONCILE_EVERY_MS) continue;
    await runInWorkspace(post.workspace_id, () => reconcilePost(post.id)).catch((err) => log.error('publish.reconcile_error', { post: post.id, message: err.message }));
  }
}
