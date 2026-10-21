import crypto from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

// The key already written in .env, for when the server was started without loading that file.
// Generating another one then would leave data encrypted with two different keys.
function keyFromEnvFile() {
  try {
    const lines = readFileSync(ENV_PATH, 'utf8').split(/\r?\n/).filter((line) => line.startsWith('ENCRYPTION_KEY='));
    return lines.length ? lines.at(-1).slice('ENCRYPTION_KEY='.length).trim() : null;
  } catch {
    return null;
  }
}

// API keys saved from the dashboard are encrypted with ENCRYPTION_KEY before they reach the database.
function loadKey() {
  let secret = process.env.ENCRYPTION_KEY || keyFromEnvFile();
  // On a host the .env file isn't kept between deploys, so a generated key would be lost and every saved key with it.
  if (!secret && process.env.NODE_ENV === 'production') {
    console.error('\nENCRYPTION_KEY is not set. Add it to the environment variables (copy it from your local backend/.env).\n');
    process.exit(1);
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64');
    appendFileSync(
      ENV_PATH,
      `\n# Encrypts the API keys you save in Settings. Keep it: without it, saved keys can't be read.\nENCRYPTION_KEY=${secret}\n`,
    );
    process.env.ENCRYPTION_KEY = secret;
    console.log('Generated ENCRYPTION_KEY and saved it to backend/.env');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

const KEY = loadKey();

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

// Returns null if the value can't be decrypted (e.g. ENCRYPTION_KEY changed).
export function decrypt(payload) {
  try {
    const [, iv, tag, data] = payload.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
