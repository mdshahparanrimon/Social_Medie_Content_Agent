import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { httpError } from '../errors.js';

const scrypt = promisify(crypto.scrypt);
// scrypt with a per-password salt. Parameters are stored in the hash so they can be raised later.
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [scheme, N, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expectedBuf = Buffer.from(expected, 'base64');
  const hash = await scrypt(password, Buffer.from(salt, 'base64'), expectedBuf.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return crypto.timingSafeEqual(hash, expectedBuf);
}

// Same work as a real check, so "no such user" and "wrong password" take the same time.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
export async function fakeVerify(password) {
  await verifyPassword(String(password), await DUMMY_HASH);
  return false;
}

const COMMON = new Set(['password', 'password1', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'iloveyou', '11111111']);

export function checkPasswordRules(password, email) {
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Use a password with at least 8 characters.');
  if (password.length > 128) throw httpError(400, 'That password is too long (128 characters max).');
  if (email && password.toLowerCase() === String(email).toLowerCase()) throw httpError(400, "Your password can't be your email address.");
  if (/^(.)\1+$/.test(password) || COMMON.has(password.toLowerCase())) {
    throw httpError(400, 'That password is too easy to guess. Pick another.');
  }
}
