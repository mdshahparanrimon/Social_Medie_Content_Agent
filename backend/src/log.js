// Structured JSON logs with secrets and signed URLs removed. One line per event: {"ts","level","event",...fields}.

const SECRET_KEY = /token|secret|password|authorization|api[-_]?key|cookie|credential|signature|session/i;

// Query strings and fragments often carry signatures or access tokens; only origin + path is kept.
export function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)]+/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const KEYED = /\b(access_token|refresh_token|client_secret|api_key|key|token|signature)=([^&\s"']+)/gi;

export function redactText(text) {
  return String(text).replace(BEARER, '$1 [redacted]').replace(KEYED, '$1=[redacted]').replace(URL_IN_TEXT, (u) => redactUrl(u));
}

export function redact(value, depth = 0) {
  if (value == null || depth > 5) return value;
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) return { name: value.name, code: value.code, message: redactText(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]));
  }
  return value;
}

// Tests can capture output with setLogSink; by default logs go to stdout/stderr.
let sink = null;
export const setLogSink = (fn) => {
  sink = fn;
};

function emit(level, event, fields) {
  const entry = { ts: new Date().toISOString(), level, event, ...redact(fields) };
  if (sink) return sink(entry);
  (level === 'error' || level === 'warn' ? console.error : console.log)(JSON.stringify(entry));
}

export const log = {
  info: (event, fields = {}) => emit('info', event, fields),
  warn: (event, fields = {}) => emit('warn', event, fields),
  error: (event, fields = {}) => emit('error', event, fields),
};

// Counters for operational visibility (GET /api/ops/metrics); in memory, reset on restart.
const counters = new Map();
export function count(name, by = 1) {
  counters.set(name, (counters.get(name) || 0) + by);
}
export const metrics = () => Object.fromEntries([...counters].sort());
export const resetMetrics = () => counters.clear();
