import { Router } from 'express';
import { repo } from '../db/index.js';
import { httpError } from '../errors.js';
import { getConfig } from '../settings.js';
import { emailConfigured } from '../email.js';
import { FRONTEND_URL } from '../urls.js';
import { checkPasswordRules, fakeVerify, hashPassword, verifyPassword } from './password.js';
import { clearRateLimit, rateLimit } from './rateLimit.js';
import { clearCookie, currentSession, endSession, parseCookies, randomToken, setCookie, startSession } from './session.js';
import { LOGIN_PROVIDERS, loginCallbackUrl } from './social.js';
import {
  checkEmail,
  cleanName,
  createAccount,
  deleteAccount,
  normalizeEmail,
  publicUser,
  redeemToken,
  sendPasswordReset,
  sendVerification,
} from './users.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const authRouter = Router();

// Signed in (verified or not). For the few routes an unverified user may use.
async function requireSession(req, res) {
  const session = await currentSession(req, res);
  if (!session) throw httpError(401, 'Please sign in.');
  req.user = session.user;
  req.sessionId = session.id;
  return session.user;
}

const respondWithUser = async (res, user) => res.json({ user: await publicUser(user) });

// Emails can fail (provider down, bad key) without blocking sign-up; the user can resend.
async function trySendVerification(user) {
  try {
    await sendVerification(user);
    return true;
  } catch (err) {
    console.error('[auth] verification email failed:', err.message);
    return false;
  }
}

// ---- Public ----

// Which sign-in options the login page should show.
authRouter.get('/providers', async (req, res) => {
  const config = await getConfig();
  res.json({
    google: LOGIN_PROVIDERS.google.ready(config),
    linkedin: LOGIN_PROVIDERS.linkedin.ready(config),
    signups: config.allow_signups || (await repo.countUsers()) === 0,
    email_delivery: emailConfigured(config),
    // For the owner's setup screen: paste these into the Google / LinkedIn developer apps.
    callback_urls: { google: loginCallbackUrl('google'), linkedin: loginCallbackUrl('linkedin') },
  });
});

authRouter.post('/register', async (req, res) => {
  rateLimit(`register:${req.ip}`, 10, HOUR);
  const email = normalizeEmail(req.body.email);
  const name = cleanName(req.body.name);
  checkEmail(email);
  if (!name) throw httpError(400, 'Enter your name.');
  checkPasswordRules(req.body.password, email);

  const user = await createAccount({ email, name, passwordHash: await hashPassword(req.body.password) });
  await startSession(req, res, user);
  const sent = await trySendVerification(user);
  res.status(201).json({ user: await publicUser(user), verification_sent: sent });
});

authRouter.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  rateLimit(`login-ip:${req.ip}`, 30, 15 * MINUTE);
  rateLimit(`login:${email}`, 8, 15 * MINUTE);

  const user = email ? await repo.getUserByEmail(email) : null;
  const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : await fakeVerify(password);
  if (!ok) throw httpError(401, 'Email or password is incorrect.');
  if (user.disabled) throw httpError(403, 'This account has been disabled. Contact support.');

  clearRateLimit(`login:${email}`);
  await startSession(req, res, user);
  await respondWithUser(res, user);
});

authRouter.post('/logout', async (req, res) => {
  await endSession(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', async (req, res) => {
  const session = await currentSession(req, res);
  if (!session) throw httpError(401, 'Please sign in.');
  await respondWithUser(res, session.user);
});

// The link in the email. It also signs you in if you open it in another browser.
authRouter.post('/verify-email', async (req, res) => {
  rateLimit(`verify:${req.ip}`, 20, 15 * MINUTE);
  const user = await redeemToken(req.body.token, 'verify_email');
  if (!user) throw httpError(400, 'This link is invalid or has expired. Sign in and request a new one.');
  const updated = await repo.updateUser(user.id, { email_verified: true });
  if (!(await currentSession(req, res))) await startSession(req, res, updated);
  await respondWithUser(res, updated);
});

// Always the same answer, so it can't be used to find out who has an account.
authRouter.post('/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  checkEmail(email);
  rateLimit(`forgot-ip:${req.ip}`, 10, 15 * MINUTE);
  rateLimit(`forgot:${email}`, 3, HOUR);
  const user = await repo.getUserByEmail(email);
  if (user && !user.disabled) {
    await sendPasswordReset(user).catch((err) => console.error('[auth] reset email failed:', err.message));
  }
  res.json({ ok: true, message: 'If an account exists for that email, we sent a link to reset the password.' });
});

authRouter.post('/reset-password', async (req, res) => {
  rateLimit(`reset:${req.ip}`, 20, 15 * MINUTE);
  const user = await redeemToken(req.body.token, 'reset_password');
  if (!user || user.disabled) throw httpError(400, 'This reset link is invalid or has expired. Request a new one.');
  checkPasswordRules(req.body.password, user.email);
  // Opening the emailed link proves the address, so it counts as verified.
  const updated = await repo.updateUser(user.id, { password_hash: await hashPassword(req.body.password), email_verified: true });
  await repo.deleteUserSessions(user.id);
  await startSession(req, res, updated);
  await respondWithUser(res, updated);
});

// ---- Signed in ----

authRouter.post('/resend-verification', async (req, res) => {
  const user = await requireSession(req, res);
  if (user.email_verified) return res.json({ ok: true, message: 'Your email is already verified.' });
  rateLimit(`resend:${user.id}`, 3, 15 * MINUTE);
  if (!(await trySendVerification(user))) throw httpError(502, 'We could not send the email right now. Try again in a few minutes.');
  res.json({ ok: true, message: `We sent a new link to ${user.email}.` });
});

authRouter.patch('/me', async (req, res) => {
  const user = await requireSession(req, res);
  const name = cleanName(req.body.name);
  if (!name) throw httpError(400, 'Enter your name.');
  await respondWithUser(res, await repo.updateUser(user.id, { name }));
});

// Change the password, or set a first one for accounts made with Google/LinkedIn. Other devices are signed out.
authRouter.post('/password', async (req, res) => {
  const user = await requireSession(req, res);
  if (user.password_hash) {
    rateLimit(`password:${user.id}`, 8, 15 * MINUTE);
    if (!(await verifyPassword(String(req.body.current_password || ''), user.password_hash))) {
      throw httpError(400, 'Your current password is incorrect.');
    }
  }
  checkPasswordRules(req.body.new_password, user.email);
  const updated = await repo.updateUser(user.id, { password_hash: await hashPassword(req.body.new_password) });
  const signedOut = await repo.deleteUserSessions(user.id, { except: req.sessionId });
  res.json({ user: await publicUser(updated), signed_out: signedOut });
});

authRouter.get('/security', async (req, res) => {
  const user = await requireSession(req, res);
  res.json({ sessions: await repo.countUserSessions(user.id) });
});

authRouter.post('/logout-others', async (req, res) => {
  const user = await requireSession(req, res);
  res.json({ signed_out: await repo.deleteUserSessions(user.id, { except: req.sessionId }) });
});

authRouter.delete('/providers/:provider', async (req, res) => {
  const user = await requireSession(req, res);
  const { provider } = req.params;
  if (!LOGIN_PROVIDERS[provider] || !user.providers?.[provider]) throw httpError(404, 'That sign-in method is not linked.');
  const others = Object.keys(user.providers).filter((p) => p !== provider && user.providers[p]);
  if (!user.password_hash && others.length === 0) {
    throw httpError(409, 'Set a password first, otherwise you could not sign in anymore.');
  }
  await respondWithUser(res, await repo.updateUser(user.id, {}, { unset: [`providers.${provider}`] }));
});

// Deletes the account, the workspace and all its posts, connections and settings.
authRouter.delete('/me', async (req, res) => {
  const user = await requireSession(req, res);
  rateLimit(`delete:${user.id}`, 5, 15 * MINUTE);
  const confirmed = user.password_hash
    ? await verifyPassword(String(req.body.password || ''), user.password_hash)
    : normalizeEmail(req.body.email) === user.email;
  if (!confirmed) throw httpError(400, user.password_hash ? 'Your password is incorrect.' : 'Type your email address to confirm.');
  await deleteAccount(user);
  await endSession(req, res);
  res.json({ ok: true });
});

// ---- Google / LinkedIn ----

const STATE_COOKIE = 'ca_login_state';
const STATE_TTL = 10 * MINUTE;
// Logins in progress, keyed by state. The same state is also in a cookie, so a login can only finish
// in the browser that started it (stops "login CSRF"). After a restart, just click the button again.
const pending = new Map();

const safeNext = (next) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/');
const goTo = (path, params) => `${FRONTEND_URL}${path}${params ? `?${new URLSearchParams(params)}` : ''}`;

function loginProvider(name) {
  const provider = LOGIN_PROVIDERS[name];
  if (!provider) throw httpError(404, 'Unknown sign-in method.');
  return provider;
}

authRouter.get('/:provider/start', async (req, res) => {
  const provider = loginProvider(req.params.provider);
  const link = req.query.mode === 'link';
  const back = link ? '/account' : '/login';
  const config = await getConfig();
  if (!provider.ready(config)) return res.redirect(goTo(back, { error: `${provider.label} sign-in is not set up yet.` }));

  let userId = null;
  if (link) {
    const session = await currentSession(req, res);
    if (!session) return res.redirect(goTo('/login', { next: '/account' }));
    userId = session.user.id;
  }
  const now = Date.now();
  for (const [key, entry] of pending) if (entry.expires < now) pending.delete(key);
  const state = randomToken();
  pending.set(state, { provider: req.params.provider, userId, next: safeNext(req.query.next), expires: now + STATE_TTL });
  setCookie(res, STATE_COOKIE, state, STATE_TTL);
  res.redirect(provider.authorizeUrl(config, state));
});

authRouter.get('/:provider/callback', async (req, res) => {
  const name = req.params.provider;
  const provider = loginProvider(name);
  const state = String(req.query.state || '');
  const entry = pending.get(state);
  pending.delete(state);
  const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE];
  clearCookie(res, STATE_COOKIE);
  const back = entry?.userId ? '/account' : '/login';
  const fail = (message) => res.redirect(goTo(back, { error: message }));

  if (!entry || entry.provider !== name || entry.expires < Date.now() || cookieState !== state) {
    return fail('That sign-in attempt expired. Please try again.');
  }
  if (req.query.error) {
    return fail(req.query.error === 'access_denied' || req.query.error === 'user_cancelled_login'
      ? `${provider.label} sign-in was cancelled.`
      : `${provider.label}: ${req.query.error_description || req.query.error}`);
  }

  let profile;
  try {
    profile = await provider.profile(await getConfig(), String(req.query.code || ''));
  } catch (err) {
    return fail(`${provider.label}: ${err.message}`);
  }

  try {
    // Linking from the Account page.
    if (entry.userId) {
      const owner = await repo.getUserByProvider(name, profile.subject);
      if (owner && owner.id !== entry.userId) return fail(`That ${provider.label} account is already used by another user.`);
      await repo.updateUser(entry.userId, { [`providers.${name}`]: profile.subject });
      return res.redirect(goTo('/account', { linked: name }));
    }

    let user = await repo.getUserByProvider(name, profile.subject);
    if (!user) {
      if (!profile.email || !profile.emailVerified) {
        return fail(`Your ${provider.label} account has no verified email address. Sign up with email instead.`);
      }
      const existing = await repo.getUserByEmail(profile.email);
      if (existing) {
        // Same verified email: it's the same person, so link the method to their account.
        user = await repo.updateUser(existing.id, {
          [`providers.${name}`]: profile.subject,
          email_verified: true,
          ...(existing.avatar_url ? {} : { avatar_url: profile.avatarUrl }),
        });
      } else {
        user = await createAccount({
          email: profile.email,
          name: profile.name,
          emailVerified: true,
          providers: { [name]: profile.subject },
          avatarUrl: profile.avatarUrl,
        });
      }
    }
    if (user.disabled) return fail('This account has been disabled. Contact support.');
    await startSession(req, res, user);
    res.redirect(goTo(entry.next));
  } catch (err) {
    fail(err.status && err.status < 500 ? err.message : 'Sign-in failed. Please try again.');
    if (!err.status || err.status >= 500) console.error('[auth]', err);
  }
});
