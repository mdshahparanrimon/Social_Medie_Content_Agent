import crypto from 'node:crypto';
import { repo } from '../db/index.js';
import { httpError } from '../errors.js';
import { runInWorkspace } from '../context.js';
import { FRONTEND_URL } from '../urls.js';

export const SESSION_COOKIE = 'ca_session';
const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Only sent over HTTPS once the app runs on a real domain.
const SECURE = FRONTEND_URL.startsWith('https://');

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return cookies;
}

export function setCookie(res, name, value, maxAgeMs) {
  res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: SECURE, path: '/', maxAge: maxAgeMs });
}

export function clearCookie(res, name) {
  res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure: SECURE, path: '/' });
}

export async function startSession(req, res, user) {
  const token = randomToken();
  await repo.createSession({
    _id: sha256(token),
    user_id: user.id,
    expires_at: new Date(Date.now() + SESSION_DAYS * DAY_MS),
    last_seen_at: new Date(),
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    ip: req.ip,
  });
  await repo.updateUser(user.id, { last_login_at: new Date().toISOString() });
  setCookie(res, SESSION_COOKIE, token, SESSION_DAYS * DAY_MS);
  return sha256(token);
}

export async function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await repo.deleteSession(sha256(token));
  clearCookie(res, SESSION_COOKIE);
}

// The signed-in user for this request, or null. Active sessions are extended (sliding 30 days), at most once a day.
export async function currentSession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const id = sha256(token);
  const session = await repo.getSession(id);
  if (!session) {
    clearCookie(res, SESSION_COOKIE);
    return null;
  }
  const user = await repo.getUser(session.user_id);
  if (!user || user.disabled) {
    await repo.deleteSession(id);
    clearCookie(res, SESSION_COOKIE);
    return null;
  }
  if (Date.now() - new Date(session.last_seen_at).getTime() > DAY_MS) {
    await repo.updateSession(id, { last_seen_at: new Date(), expires_at: new Date(Date.now() + SESSION_DAYS * DAY_MS) });
    setCookie(res, SESSION_COOKIE, token, SESSION_DAYS * DAY_MS);
  }
  return { id, user };
}

// Signed in with a verified email. Everything after this runs inside the user's workspace.
export async function requireAuth(req, res, next) {
  const session = await currentSession(req, res);
  if (!session) throw httpError(401, 'Please sign in.');
  if (!session.user.email_verified) {
    const err = httpError(403, 'Verify your email address first.');
    err.code = 'email_unverified';
    throw err;
  }
  req.user = session.user;
  req.sessionId = session.id;
  runInWorkspace(session.user.workspace_id, next);
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') throw httpError(403, 'Only the app owner can do this.');
  next();
}

// Cookie-authenticated APIs must refuse writes started by other websites (CSRF).
// Browsers always send Origin on cross-site POST/PUT/PATCH/DELETE.
export function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== FRONTEND_URL) throw httpError(403, 'Request blocked: it came from another website.');
  next();
}
