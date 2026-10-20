import { httpError } from '../errors.js';

// Fixed-window counters in memory: enough for one server. Move them to Redis if you run several.
const hits = new Map();

function sweep(now) {
  if (hits.size < 10_000) return;
  for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
}

// Throws 429 once `key` was used more than `max` times within `windowMs`.
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  sweep(now);
  let entry = hits.get(key);
  if (!entry || entry.reset <= now) {
    entry = { count: 0, reset: now + windowMs };
    hits.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > max) {
    const minutes = Math.ceil((entry.reset - now) / 60_000);
    throw httpError(429, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

export function clearRateLimit(key) {
  hits.delete(key);
}
