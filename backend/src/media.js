import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getConfig } from './settings.js';
import { httpError } from './errors.js';
import { API_URL } from './urls.js';

// Post images. Instagram downloads the image from a public URL, so images go to Cloudinary when it's
// set up in Settings; otherwise they're served by this backend (public only once it runs on a server).

// UPLOAD_DIR: on hosts that replace the app folder on every deploy, point this outside it so uploads survive.
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'uploads');

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

async function storeJpeg(buffer) {
  if (buffer.length > MAX_BYTES) throw httpError(400, 'Image is larger than 8 MB.');
  const config = await getConfig();
  return cloudinaryReady(config) ? uploadToCloudinary(config, `data:image/jpeg;base64,${buffer.toString('base64')}`) : saveLocally(buffer);
}

// Accepts a JPEG data URL (the browser converts every upload to JPEG, the only format Instagram takes).
export async function storeImage(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw httpError(400, 'Upload a JPEG image.');
  return storeJpeg(Buffer.from(match[1], 'base64'));
}

// AI images arrive as PNG/WebP in whatever size the model picked: center-crop them to the platform's
// size and save as JPEG, so every platform (Instagram included) accepts them.
export async function storeGeneratedImage(buffer, { width, height }) {
  const jpeg = await sharp(buffer)
    .resize(width, height, { fit: 'cover' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
  return storeJpeg(jpeg);
}

async function readImage(url) {
  const local = `${API_URL}/media/`;
  if (url.startsWith(local)) {
    try {
      return readFileSync(path.join(UPLOAD_DIR, path.basename(url.slice(local.length))));
    } catch {
      throw new Error('The post image is missing from this server. Add it again.');
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the post image (${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('The post image is larger than 8 MB.');
  return buffer;
}

// The post image as JPEG bytes, for platforms that need an upload instead of a link (X, LinkedIn).
// Pasted links can point at any format, so anything that isn't already a JPEG is converted.
export async function loadImageJpeg(url) {
  const buffer = await readImage(url);
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  return isJpeg ? buffer : sharp(buffer).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
}

// ---- Videos (AI-made MP4s). Same rule as images: Cloudinary when set up, else this server's /media. ----

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

async function uploadVideoToCloudinary(config, buffer) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const folder = 'content-agent';
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${folder}&timestamp=${timestamp}${config.cloudinary_api_secret}`)
    .digest('hex');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'video/mp4' }), 'video.mp4');
  for (const [key, value] of Object.entries({ api_key: config.cloudinary_api_key, timestamp, folder, signature })) form.append(key, value);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinary_cloud_name)}/video/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `Cloudinary: ${data.error?.message || res.status}. Check the Media settings.`);
  return data.secure_url;
}

export async function storeVideo(buffer) {
  if (buffer.length > MAX_VIDEO_BYTES) throw httpError(400, 'Video is larger than 100 MB.');
  const config = await getConfig();
  if (cloudinaryReady(config)) return uploadVideoToCloudinary(config, buffer);
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.mp4`;
  writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return `${API_URL}/media/${name}`;
}

// The post video as bytes, for platforms that need an upload (X, LinkedIn, Facebook).
export async function loadVideo(url) {
  const local = `${API_URL}/media/`;
  if (url.startsWith(local)) {
    try {
      return readFileSync(path.join(UPLOAD_DIR, path.basename(url.slice(local.length))));
    } catch {
      throw new Error('The post video is missing from this server. Generate it again.');
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the post video (${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('The post video is larger than 100 MB.');
  return buffer;
}
