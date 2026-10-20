import { httpError } from '../errors.js';

// fetch for AI APIs: retries rate limits (common on free tiers) and server errors, and turns failures into readable messages.
export async function fetchWithRetry(url, options, label, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      throw httpError(502, `${label}: network error (${err.message}).`);
    }
    if (res.ok) return res;

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const waitSeconds = Math.min(Number(res.headers.get('retry-after')) || 15 * (attempt + 1), 60);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }

    const body = await res.text();
    let message = body;
    try {
      const json = JSON.parse(body);
      message = json.error?.message || json.message || body;
    } catch {}
    let hint = '';
    if (res.status === 401 || res.status === 403) hint = ' Check the API key in Settings.';
    if (res.status === 404) hint = ' Check the model name in Settings.';
    if (res.status === 429) hint = ' Free-tier rate limit reached; wait a minute and try again.';
    if (res.status === 503) hint = ' The provider is overloaded right now (not a problem with your key); try again in a few minutes or pick another model.';
    const err = httpError(res.status === 429 ? 429 : 502, `${label} (${res.status}): ${String(message).slice(0, 300)}${hint}`);
    err.upstreamStatus = res.status;
    throw err;
  }
}
