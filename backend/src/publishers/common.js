import { redactText } from '../log.js';

// Shared by every publisher: HTTP with a timeout, and failures classified for the scheduler.
//
// stage "pre": uploads and other steps that do not create the post. A failure here means nothing was published.
// stage "create": the one call that creates the post. If it fails without a clear answer (timeout, dropped
//   connection, 5xx) the platform may have created the post, so the outcome is UNCERTAIN and is never retried blindly.

export class PublishError extends Error {
  constructor(message, { code = 'PUBLISH_FAILED', retryable = false, uncertain = false, status = null, retryAfterMs = null, needsReconnect = false, remoteId = null } = {}) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
    this.retryable = retryable; // safe to try again: the platform definitely did not publish
    this.uncertain = uncertain; // the platform may have published
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.needsReconnect = needsReconnect;
    this.remoteId = remoteId;
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

// Meta (Facebook + Instagram) puts its own codes in the body.
const META_RATE_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const META_TOKEN_CODES = new Set([102, 190]);

function messageFrom(data, text) {
  const m = data?.error?.error_user_msg || data?.error?.message || data?.message || data?.detail || data?.title || text || 'unknown error';
  return redactText(String(m)).slice(0, 300);
}

/**
 * Turns a failed HTTP response into a PublishError.
 * label: "LinkedIn", "Instagram"... ; stage: "pre" | "create".
 */
export function errorFromResponse({ label, stage, status, data, text, headers }) {
  const detail = messageFrom(data, text);
  const retryAfterMs = parseRetryAfter(headers?.get?.('retry-after'));
  const metaCode = data?.error?.code;

  if (status === 401 || META_TOKEN_CODES.has(metaCode)) {
    return new PublishError(`${label}: the connection was rejected or has expired. Reconnect ${label} on the Connections page. (${detail})`, { code: 'AUTH', status, needsReconnect: true });
  }
  if (status === 429 || META_RATE_CODES.has(metaCode)) {
    // The platform refused before doing anything, so waiting and retrying cannot duplicate the post.
    return new PublishError(`${label}: rate limit reached. ${detail}`, { code: 'RATE_LIMIT', status, retryable: true, retryAfterMs: retryAfterMs ?? 15 * 60_000 });
  }
  if (status === 403) {
    return new PublishError(`${label}: permission denied. The app or account may be missing a required permission or product. (${detail})`, { code: 'PERMISSION', status });
  }
  if (status >= 500) {
    if (stage === 'create') {
      return new PublishError(`${label} (${status}) while publishing: it may or may not have been posted. ${detail}`, { code: 'SERVER_ERROR', status, uncertain: true });
    }
    return new PublishError(`${label} (${status}): ${detail}`, { code: 'SERVER_ERROR', status, retryable: true, retryAfterMs });
  }
  return new PublishError(`${label} (${status}): ${detail}`, { code: 'REJECTED', status });
}

export function errorFromNetwork({ label, stage, err }) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  const cancelled = err?.cancelled;
  const what = cancelled ? 'was cancelled' : timedOut ? 'timed out' : 'could not be reached';
  if (stage === 'create') {
    return new PublishError(`${label} ${what} while publishing: it may or may not have been posted.`, { code: timedOut ? 'TIMEOUT' : 'NETWORK', uncertain: true });
  }
  return new PublishError(`${label} ${what}. Nothing was posted.`, { code: timedOut ? 'TIMEOUT' : 'NETWORK', retryable: !cancelled });
}

/**
 * fetch with a timeout and cancellation. Resolves to { res, data, text } on a 2xx answer; throws PublishError otherwise.
 * signal: the attempt's overall AbortSignal.
 */
export async function api(url, { label, stage = 'pre', method = 'GET', headers, body, timeoutMs = 30_000, signal, parse = 'json' } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.any(signals) });
  } catch (err) {
    if (signal?.aborted && !err?.name?.includes('Timeout')) err.cancelled = true;
    throw errorFromNetwork({ label, stage, err });
  }
  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    // The answer started but the body was cut off.
    if (res.ok && stage === 'create') throw errorFromNetwork({ label, stage, err });
  }
  let data = null;
  if (parse === 'json' && text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw errorFromResponse({ label, stage, status: res.status, data, text, headers: res.headers });
  return { res, data, text };
}
