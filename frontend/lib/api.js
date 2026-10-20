// Same-origin requests: Next.js forwards /api to the backend (see next.config.mjs), so the session cookie is sent automatically.
export const apiUrl = (path) => `/api${path}`;

// Fired when a request finds the session gone (signed out elsewhere, expired); the app then shows the login page.
export const AUTH_EXPIRED_EVENT = 'auth:expired';

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error("Can't reach the server. Check your internet connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    const message = data?.error || (res.status >= 500 ? "Can't reach the server. Is the backend running?" : `Request failed (${res.status})`);
    const err = new Error(message);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data ?? {};
}

// Keep in sync with backend/src/platforms.js
export const PLATFORMS = {
  x: { label: 'X', maxChars: 280 },
  linkedin: { label: 'LinkedIn', maxChars: 3000 },
  meta: { label: 'Facebook', maxChars: 5000 },
  instagram: { label: 'Instagram', maxChars: 2200, needsImage: true },
};

export function charCount(platform, text) {
  if (platform !== 'x') return [...text].length;
  const urls = text.match(/https?:\/\/\S+/g) || [];
  let count = urls.length * 23;
  for (const ch of text.replace(/https?:\/\/\S+/g, '')) {
    const cp = ch.codePointAt(0);
    const light =
      cp <= 4351 ||
      (cp >= 8192 && cp <= 8205) ||
      (cp >= 8208 && cp <= 8223) ||
      (cp >= 8242 && cp <= 8247);
    count += light ? 1 : 2;
  }
  return count;
}

// ---- Dates ----
const pad = (n) => String(n).padStart(2, '0');

export function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function mondayOf(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export function addDays(ymdString, n) {
  const d = new Date(`${ymdString}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function formatDay(ymdString) {
  return new Date(`${ymdString}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ISO string -> value for <input type="datetime-local"> in the browser's timezone
export function toLocalInput(iso) {
  const d = new Date(iso);
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
