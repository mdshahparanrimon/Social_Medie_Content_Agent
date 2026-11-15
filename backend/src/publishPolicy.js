// Which failures are retried automatically, and when. Pure functions, so they are easy to test.

export const MAX_AUTO_ATTEMPTS = Number(process.env.PUBLISH_MAX_ATTEMPTS) || 3;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 30 * 60_000;
export const RETRY_AFTER_CAP_MS = 6 * 60 * 60_000;

/**
 * Exponential backoff with "equal jitter": half of the delay is fixed, half random, so many posts that failed together
 * do not all retry at the same instant. attempt = the number of attempts made so far (1 = the first failed).
 * A platform's Retry-After is a minimum.
 */
export function backoffMs(attempt, { retryAfterMs = null, random = Math.random, base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS } = {}) {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jittered = exp / 2 + random() * (exp / 2);
  return Math.round(Math.min(RETRY_AFTER_CAP_MS, Math.max(jittered, retryAfterMs ?? 0)));
}

/**
 * What to do with a failed attempt:
 *  - "uncertain": the platform may have published. Never retry; reconcile or ask a person.
 *  - "retry": definitely not published and the cause is temporary (rate limit, 5xx before creating, timeouts before creating).
 *  - "fail": definitely not published and retrying would not help (bad credentials, rejected content, missing permission).
 * A PublishError carries the classification; any other error that happened after the creating call began is uncertain.
 */
export function decideAfterFailure(err, { attemptsMade, reachedCreate, maxAttempts = MAX_AUTO_ATTEMPTS, random = Math.random }) {
  if (err?.uncertain) return { action: 'uncertain' };
  if (err?.name !== 'PublishError') return reachedCreate ? { action: 'uncertain' } : { action: 'fail' };
  if (err.retryable && attemptsMade < maxAttempts) {
    return { action: 'retry', delayMs: backoffMs(attemptsMade, { retryAfterMs: err.retryAfterMs, random }) };
  }
  return { action: 'fail', exhausted: err.retryable };
}
