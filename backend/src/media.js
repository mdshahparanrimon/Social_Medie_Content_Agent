import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './settings.js';
import { httpError } from './errors.js';
import { API_URL } from './urls.js';

// Post images. Instagram downloads the image from a public URL, so images go to Cloudinary when it's
// set up in Settings; otherwise they're served by this backend (public only once it runs on a server).

export const UPLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'uploads');

const MAX_BYTES = 8 * 1024 * 1024;

export const cloudinaryReady = (config) =>
  Boolean(config.cloudinary_cloud_name && config.cloudinary_api_key && config.cloudinary_api_secret);

async function uploadToCloudinary(config, dataUrl) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const folder = 'content-agent';
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${folder}&timestamp=${timestamp}${config.cloudinary_api_secret}`)
    .digest('hex');
  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinary_cloud_name)}/image/upload`, {
    method: 'POST',
    body: new URLSearchParams({ file: dataUrl, api_key: config.cloudinary_api_key, timestamp, folder, signature }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `Cloudinary: ${data.error?.message || res.status}. Check the Media settings.`);
  return data.secure_url;
}

function saveLocally(buffer) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.jpg`;
  writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return `${API_URL}/media/${name}`;
}

// Accepts a JPEG data URL (the browser converts every upload to JPEG, the only format Instagram takes).
export async function storeImage(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw httpError(400, 'Upload a JPEG image.');
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length > MAX_BYTES) throw httpError(400, 'Image is larger than 8 MB.');

  const config = await getConfig();
  return cloudinaryReady(config) ? uploadToCloudinary(config, dataUrl) : saveLocally(buffer);
}
