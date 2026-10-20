import { repo } from '../db/index.js';
import { httpError } from '../errors.js';
import { runInWorkspace } from '../context.js';
import { getConfig, moveLegacyWorkspaceSettings } from '../settings.js';
import { migrateLegacyTokens } from '../accounts.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../email.js';
import { FRONTEND_URL } from '../urls.js';
import { randomToken, sha256 } from './session.js';

const HOUR_MS = 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export function checkEmail(email) {
  if (!EMAIL.test(email) || email.length > 254) throw httpError(400, 'Enter a valid email address.');
}

export function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

// Extra owners can be named in .env: ADMIN_EMAILS=you@example.com,partner@example.com
const adminEmails = () =>
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);

// What the browser may see about a user.
export async function publicUser(user) {
  const workspace = await repo.getWorkspace(user.workspace_id);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar_url: user.avatar_url || null,
    email_verified: Boolean(user.email_verified),
    role: user.role,
    has_password: Boolean(user.password_hash),
    providers: Object.keys(user.providers || {}).filter((p) => user.providers[p]),
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    created_at: user.created_at,
  };
}

// A new user always gets their own workspace. The very first user is the owner (admin)
// and inherits any data the app had before accounts existed.
export async function createAccount({ email, name, passwordHash = null, emailVerified = false, providers = {}, avatarUrl = null }) {
  const firstUser = (await repo.countUsers()) === 0;
  if (!firstUser && !(await getConfig()).allow_signups) {
    throw httpError(403, 'New sign-ups are closed right now.');
  }
  if (await repo.getUserByEmail(email)) throw httpError(409, 'An account with this email already exists. Sign in instead.');

  const displayName = cleanName(name) || email.split('@')[0];
  const workspace = await repo.createWorkspace({ name: `${displayName}'s workspace`, owner_id: null });
  let user;
  try {
    user = await repo.createUser({
      email,
      name: displayName,
      avatar_url: avatarUrl,
      password_hash: passwordHash,
      email_verified: emailVerified,
      providers,
      role: firstUser || adminEmails().includes(email) ? 'admin' : 'user',
      workspace_id: workspace.id,
      disabled: false,
      last_login_at: null,
    });
  } catch (err) {
    await repo.deleteWorkspace(workspace.id);
    if (err.code === 11000) throw httpError(409, 'An account with this email already exists. Sign in instead.');
    throw err;
  }
  await repo.updateWorkspace(workspace.id, { owner_id: user.id });

  if (firstUser) {
    await runInWorkspace(workspace.id, async () => {
      await repo.claimLegacyData(workspace.id);
      await moveLegacyWorkspaceSettings();
      await migrateLegacyTokens();
    });
    console.log(`[auth] ${email} is the first account: made admin (app owner) and given the existing data.`);
  }
  return user;
}

// Deletes the user, their workspace and everything in it.
export async function deleteAccount(user) {
  if (user.role === 'admin' && (await repo.countUsers({ role: 'admin', disabled: { $ne: true } })) <= 1) {
    throw httpError(409, 'You are the only admin. Make another user admin before deleting your account.');
  }
  await repo.deleteUserSessions(user.id);
  await repo.deleteAuthTokens(user.id);
  await repo.deleteWorkspace(user.workspace_id);
  await repo.deleteUser(user.id);
}

async function issueToken(user, type, ttlMs) {
  await repo.deleteAuthTokens(user.id, type);
  const token = randomToken();
  await repo.createAuthToken({ _id: sha256(token), user_id: user.id, type, expires_at: new Date(Date.now() + ttlMs) });
  return token;
}

export async function sendVerification(user) {
  const token = await issueToken(user, 'verify_email', 24 * HOUR_MS);
  await sendVerificationEmail(user, `${FRONTEND_URL}/verify-email?token=${token}`);
}

export async function sendPasswordReset(user) {
  const token = await issueToken(user, 'reset_password', HOUR_MS);
  await sendPasswordResetEmail(user, `${FRONTEND_URL}/reset-password?token=${token}`);
}

// The user a one-time token belongs to; the token is used up either way.
export async function redeemToken(token, type) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const entry = await repo.takeAuthToken(sha256(token), type);
  return entry ? repo.getUser(entry.user_id) : null;
}
