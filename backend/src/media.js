import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getConfig, PRIVATE_HOST } from './settings.js';
import { pdfPageCount } from './slides.js';
import { downloadFromDrive, driveFileId } from './drive.js';
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

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

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

// ---- Documents (PDF carousels for LinkedIn). LinkedIn gets the bytes uploaded by this server, so a local copy works too. ----

export const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;

// Stored as a "raw" file with a .pdf name, so the link serves it as a PDF the browser can preview.
async function uploadDocumentToCloudinary(config, buffer) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const folder = 'content-agent';
  const public_id = `${crypto.randomBytes(12).toString('hex')}.pdf`;
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${folder}&public_id=${public_id}&timestamp=${timestamp}${config.cloudinary_api_secret}`)
    .digest('hex');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), 'carousel.pdf');
  for (const [key, value] of Object.entries({ api_key: config.cloudinary_api_key, timestamp, folder, public_id, signature })) form.append(key, value);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinary_cloud_name)}/raw/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `Cloudinary: ${data.error?.message || res.status}. Check the Media settings.`);
  return data.secure_url;
}

export async function storeDocument(buffer) {
  if (buffer.length > MAX_DOCUMENT_BYTES) throw httpError(400, `PDF is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`);
  const config = await getConfig();
  if (cloudinaryReady(config)) return uploadDocumentToCloudinary(config, buffer);
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.pdf`;
  writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return `${API_URL}/media/${name}`;
}

// The post's PDF as bytes, for LinkedIn's upload.
export async function loadDocument(url) {
  const local = `${API_URL}/media/`;
  if (url.startsWith(local)) {
    try {
      return readFileSync(path.join(UPLOAD_DIR, path.basename(url.slice(local.length))));
    } catch {
      throw new Error('The post PDF is missing from this server. Add it again.');
    }
  }
  const res = await fetch(url);
  if (!res.ok) {
    // Free Cloudinary accounts block PDF delivery until it's allowed in the account's security settings.
    const hint = url.includes('res.cloudinary.com') && res.status === 401
      ? ' In Cloudinary: Settings → Security → turn on "Allow delivery of PDF and ZIP files".'
      : '';
    throw new Error(`Could not download the post PDF (${res.status}).${hint}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- Media from a link (Claude via MCP): downloaded and stored like an upload, so every platform can use it ----

// Google Drive share links open a preview page, not the file. With Google Drive connected (Connections), the file
// is downloaded with that account, so it can stay private. Otherwise the public download link is used, which needs
// the file shared as "Anyone with the link".
const publicDriveUrl = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

// The file name the server sends (Google Drive sends the original one), without its extension.
function fileName(res) {
  const header = res.headers.get('content-disposition') || '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  let name = /filename="?([^";]+)"?/i.exec(header)?.[1] || '';
  try {
    if (encoded) name = decodeURIComponent(encoded);
  } catch {}
  return name.replace(/\.[a-z0-9]{2,4}$/i, '').trim();
}

async function download(url, maxBytes, noun) {
  if (!/^https:\/\/\S+$/.test(url || '')) throw httpError(400, `Paste a ${noun} link starting with https://`);
  // This server fetches the link itself, so it must not point into the server's own network.
  if (PRIVATE_HOST.test(new URL(url).hostname)) throw httpError(400, `That ${noun} link is not a public address.`);
  const driveId = driveFileId(url);
  if (driveId) {
    // A Google Slides deck exported as PDF makes a ready LinkedIn carousel.
    const fromDrive = await downloadFromDrive(driveId, { maxBytes, noun, exportPdf: noun === 'PDF' });
    if (fromDrive) return fromDrive;
  }
  const target = driveId ? publicDriveUrl(driveId) : url;
  let res;
  try {
    res = await fetch(target);
  } catch {
    throw httpError(400, `Could not reach that ${noun} link.`);
  }
  if (!res.ok) throw httpError(400, `Could not download the ${noun} (${res.status}). Check that the link is public.`);
  if ((res.headers.get('content-type') || '').startsWith('text/html')) {
    throw httpError(
      400,
      `That link opens a web page, not a ${noun}. For Google Drive, connect Google Drive on the Connections page, or share the file as "Anyone with the link".`,
    );
  }
  if (Number(res.headers.get('content-length')) > maxBytes) throw httpError(400, `The ${noun} is larger than ${maxBytes / 1024 / 1024} MB.`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw httpError(400, `The ${noun} is larger than ${maxBytes / 1024 / 1024} MB.`);
  return { buffer, filename: fileName(res) };
}

// Any image format; saved as JPEG (Instagram takes nothing else), at most 2160 px on its longest side.
export async function importImage(url) {
  const { buffer } = await download(url, 4 * MAX_BYTES, 'image');
  const jpeg = await sharp(buffer)
    .rotate()
    .resize(2160, 2160, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer()
    .catch(() => {
      throw httpError(400, 'That link is not an image.');
    });
  return storeJpeg(jpeg);
}

// A PDF from a link, checked (LinkedIn's page limit) and stored. The file name serves as the default title.
export async function importDocument(url) {
  const { buffer, filename } = await download(url, MAX_DOCUMENT_BYTES, 'PDF');
  const pages = await pdfPageCount(buffer);
  return { url: await storeDocument(buffer), pages, filename };
}

// MP4 or MOV (both start with an "ftyp" box), the formats every platform takes.
export async function importVideo(url) {
  const { buffer } = await download(url, MAX_VIDEO_BYTES, 'video');
  if (buffer.subarray(4, 8).toString('latin1') !== 'ftyp') throw httpError(400, 'That link is not an MP4 or MOV video.');
  return storeVideo(buffer);
}
