import crypto from 'node:crypto';
import { existsSync, openAsBlob } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './settings.js';
import { repo } from './db/index.js';
import { workspaceId, runInWorkspace } from './context.js';
import { AppError } from './errors.js';
import { log, count, redactUrl } from './log.js';
import { withDownload, ACCEPT, ingestTestOverrides } from './mediaIngest.js';
import { checkImage, checkPdf, checkVideo, deriveImage, plain } from './mediaQc.js';
import { safeGet } from './net/safeFetch.js';
import { downloadFromDrive, driveFileId } from './drive.js';
import { API_URL } from './urls.js';

// Stored media (post images, videos, PDFs). Instagram downloads images from a public URL, so files go to Cloudinary
// when it's set up in Settings; otherwise this backend serves them from UPLOAD_DIR under /media.
//
// Rules this module enforces:
//  - In production, scheduled posts must not depend on a disk that disappears on deploy: local storage is refused
//    unless ALLOW_LOCAL_STORAGE=true (set it only when UPLOAD_DIR is on a persistent volume).
//  - Local files live in UPLOAD_DIR/<workspace id>/<random name>; names never come from the user.
//  - Every stored file has an `assets` record (owner workspace, SHA-256, size, provider). Identical content is stored
//    once; a file is deleted when no post uses it any more.

// UPLOAD_DIR: on hosts that replace the app folder on every deploy, point this outside it so uploads survive.
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'uploads');

const MB = 1024 * 1024;
const MAX_BYTES = 8 * MB; // stored (JPEG) post images
export const MAX_IMPORT_IMAGE_BYTES = 32 * MB; // source images fetched from a link, before conversion
export const MAX_VIDEO_BYTES = 100 * MB;
export const MAX_DOCUMENT_BYTES = 30 * MB;

export const cloudinaryReady = (config) =>
  Boolean(config.cloudinary_cloud_name && config.cloudinary_api_key && config.cloudinary_api_secret);

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// ---- Where files may be stored ----

const isProduction = () => process.env.NODE_ENV === 'production';
const localAllowedInProduction = () => process.env.ALLOW_LOCAL_STORAGE === 'true';

export function storageStatus(config) {
  const cloud = cloudinaryReady(config);
  const durable = cloud || !isProduction() || localAllowedInProduction();
  return {
    provider: cloud ? 'cloudinary' : 'local',
    durable,
    production: isProduction(),
    message: durable
      ? cloud
        ? 'Media is stored on Cloudinary.'
        : isProduction()
          ? 'Media is stored on this server\'s disk (ALLOW_LOCAL_STORAGE=true). Make sure UPLOAD_DIR is on a persistent volume.'
          : 'Media is stored on this computer (development).'
      : 'Production needs persistent media storage: set up Cloudinary in Settings → Media (or set ALLOW_LOCAL_STORAGE=true with UPLOAD_DIR on a persistent disk).',
  };
}

function assertDurable(config) {
  const status = storageStatus(config);
  if (!status.durable) throw new AppError('STORAGE_NOT_DURABLE', status.message, { status: 503 });
}

// ---- Low-level put / get / delete ----

const RESOURCE_TYPE = { image: 'image', original: 'image', video: 'video', document: 'raw' };

function cloudinarySignature(config, params) {
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(`${toSign}${config.cloudinary_api_secret}`).digest('hex');
}

async function putCloudinary(config, source, { kind, mime, ext }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const folder = `content-agent/${workspaceId()}`;
  const resource = RESOURCE_TYPE[kind];
  const params = { folder, timestamp };
  // Raw files keep their name as given, so the link serves a PDF the browser can preview.
  if (resource === 'raw') params.public_id = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const signature = cloudinarySignature(config, params);
  const form = new FormData();
  const blob = source.path ? await openAsBlob(source.path, { type: mime }) : new Blob([source.buffer], { type: mime });
  form.append('file', blob, `upload.${ext}`);
  for (const [k, v] of Object.entries({ ...params, api_key: config.cloudinary_api_key, signature })) form.append(k, v);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinary_cloud_name)}/${resource}/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError('STORAGE_FAILED', `Cloudinary: ${data.error?.message || res.status}. Check the Media settings.`, { status: 502 });
  return { url: data.secure_url, provider: 'cloudinary', ref: JSON.stringify({ resource, public_id: data.public_id }) };
}

async function putLocal(source, { ext }) {
  const dir = path.join(UPLOAD_DIR, workspaceId());
  await mkdir(dir, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext.replace(/[^a-z0-9]/gi, '')}`;
  const final = path.join(dir, name);
  const partial = `${final}.tmp`;
  try {
    if (source.path) await copyFile(source.path, partial);
    else await writeFile(partial, source.buffer, { mode: 0o640 });
    await rename(partial, final); // readers never see half a file
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  return { url: `${API_URL}/media/${workspaceId()}/${name}`, provider: 'local', ref: path.join(workspaceId(), name) };
}

// The file under UPLOAD_DIR for one of this server's /media links, or null. Each path segment is validated.
export function localPathForUrl(url) {
  const prefix = `${API_URL}/media/`;
  if (!String(url).startsWith(prefix)) return null;
  const parts = String(url).slice(prefix.length).split('/');
  if (parts.length < 1 || parts.length > 2 || !parts.every((p) => /^[A-Za-z0-9][\w.-]*$/.test(p) && !p.includes('..'))) return null;
  const full = path.resolve(UPLOAD_DIR, ...parts);
  return full.startsWith(path.resolve(UPLOAD_DIR) + path.sep) ? full : null;
}

/**
 * Stores bytes (source: { buffer } or { path }) and records ownership. kind: image | original | video | document.
 * Identical content already stored by this workspace is reused: { url, duplicate: true }.
 * extra: { source_sha256, profile, original_url } for derivatives.
 */
async function storeAsset(source, { kind, ext, mime, sha, extra = {} }) {
  const config = await getConfig();
  assertDurable(config);
  const hash = sha || sha256(source.buffer);
  const bytes = source.buffer ? source.buffer.length : source.size;
  const existing = await repo.findAsset({ kind, sha256: hash });
  if (existing) {
    const local = localPathForUrl(existing.url);
    if (!local || existsSync(local)) {
      count('storage.dedupe');
      return { url: existing.url, duplicate: true, sha256: hash };
    }
    await repo.deleteAsset(existing.url); // the file vanished (old deploy): store it again
  }
  try {
    const put = cloudinaryReady(config) ? await putCloudinary(config, source, { kind, mime, ext }) : await putLocal(source, { ext });
    await repo.insertAsset({ url: put.url, kind, sha256: hash, bytes, provider: put.provider, ref: put.ref, mime, ...extra });
    log.info('storage.stored', { kind, provider: put.provider, bytes });
    return { url: put.url, duplicate: false, sha256: hash };
  } catch (err) {
    count('storage.fail');
    log.error('storage.failed', { kind, message: err.message, code: err.code });
    await repo.logAudit({ type: 'storage.failed', kind, message: err.message }).catch(() => {});
    if (err instanceof AppError) throw err;
    throw new AppError('STORAGE_FAILED', 'The file could not be saved. Try again; if it keeps failing, check the storage settings.', { status: 502 });
  }
}

async function destroyCloudinary(config, ref) {
  const { resource, public_id } = JSON.parse(ref);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = { public_id, timestamp };
  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudinary_cloud_name)}/${resource}/destroy`, {
    method: 'POST',
    body: new URLSearchParams({ ...params, api_key: config.cloudinary_api_key, signature: cloudinarySignature(config, params) }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !['ok', 'not found'].includes(data.result)) throw new Error(`Cloudinary delete (${res.status}): ${data.error?.message || data.result || 'failed'}`);
}

// Deletes the stored file behind `url` once no post of this workspace uses it. Errors are logged and reported, never swallowed.
export async function releaseMedia(url) {
  if (!url) return { released: false };
  if ((await repo.countMediaReferences(url)) > 0) return { released: false, reason: 'in_use' };
  const asset = await repo.findAsset({ url });
  const config = await getConfig();
  try {
    if (asset?.provider === 'cloudinary') await destroyCloudinary(config, asset.ref);
    else {
      const local = localPathForUrl(url);
      if (local) await rm(local, { force: true });
    }
    if (asset) await repo.deleteAsset(url);
    if (asset?.original_url) await releaseMedia(asset.original_url);
    log.info('storage.released', { kind: asset?.kind || 'legacy', provider: asset?.provider || 'local' });
    return { released: true };
  } catch (err) {
    count('storage.release_failed');
    log.error('storage.release_failed', { message: err.message, url: redactUrl(url) });
    await repo.logAudit({ type: 'storage.release_failed', message: err.message }).catch(() => {});
    return { released: false, reason: 'error', error: err.message };
  }
}

// Files no post uses (an upload that was never attached, a replaced image whose cleanup failed). Grace period first.
export async function sweepOrphanAssets({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
  const old = await repo.assetsCreatedBefore(new Date(Date.now() - olderThanMs).toISOString());
  let released = 0;
  for (const asset of old) {
    if (asset.kind === 'original' || !asset.workspace_id) continue;
    const result = await runInWorkspace(asset.workspace_id, () => releaseMedia(asset.url));
    if (result.released) released++;
  }
  if (released) log.info('storage.orphans_removed', { count: released });
  return released;
}

// ---- Reading stored files back (publishers upload bytes themselves) ----

async function fetchBytes(url, maxBytes, noun) {
  const { response } = await safeGet(url, { timeoutMs: 30_000, totalTimeoutMs: 180_000 });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    // Free Cloudinary accounts block PDF delivery until it's allowed in the account's security settings.
    const hint = url.includes('res.cloudinary.com') && response.statusCode === 401
      ? ' In Cloudinary: Settings → Security → turn on "Allow delivery of PDF and ZIP files".'
      : '';
    throw new AppError('MEDIA_UNAVAILABLE', `Could not download the post ${noun} (${response.statusCode}).${hint}`, { status: 502 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) {
      response.destroy();
      throw new AppError('TOO_LARGE', `The post ${noun} is larger than ${Math.round(maxBytes / MB)} MB.`, { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function loadBytes(url, maxBytes, noun) {
  const local = localPathForUrl(url);
  if (local) {
    try {
      return await readFile(local);
    } catch {
      throw new AppError('MEDIA_UNAVAILABLE', `The post ${noun} is missing from this server. Add it again.`, { status: 410 });
    }
  }
  if (String(url).startsWith(`${API_URL}/media/`)) throw new AppError('MEDIA_UNAVAILABLE', `The post ${noun} link is not valid. Add it again.`, { status: 410 });
  return fetchBytes(url, maxBytes, noun);
}

// The post image as JPEG bytes, for platforms that need an upload instead of a link (X, LinkedIn).
// Stored images are already JPEG derivatives; anything else (older posts) is converted.
export async function loadImageJpeg(url) {
  const buffer = await loadBytes(url, MAX_BYTES * 4, 'image');
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return buffer;
  return (await deriveImage(buffer, { platform: 'x' })).buffer;
}

export const loadVideo = (url) => loadBytes(url, MAX_VIDEO_BYTES, 'video');
export const loadDocument = (url) => loadBytes(url, MAX_DOCUMENT_BYTES, 'PDF');
export const loadImage = (url) => loadBytes(url, MAX_BYTES * 4, 'image');

// A stored video as a file path for ffprobe/header inspection: the stored file itself, or a temporary copy.
export async function withVideoFile(url, fn) {
  const local = localPathForUrl(url);
  if (local && existsSync(local)) return fn(local);
  const buffer = await loadBytes(url, MAX_VIDEO_BYTES, 'video');
  const tmp = path.join((await import('node:os')).tmpdir(), `ca-video-${crypto.randomBytes(8).toString('hex')}.mp4`);
  await writeFile(tmp, buffer);
  try {
    return await fn(tmp);
  } finally {
    await rm(tmp, { force: true });
  }
}

// ---- Storing images, videos, documents ----

// Accepts a JPEG data URL (the browser converts every upload to JPEG, the only format Instagram takes).
export async function storeImage(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw new AppError('UNSUPPORTED_FORMAT', 'Upload a JPEG image.');
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length > MAX_BYTES) throw new AppError('TOO_LARGE', 'Image is larger than 8 MB.', { status: 413 });
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new AppError('UNSUPPORTED_FORMAT', 'That file is not a JPEG image.');
  return (await storeAsset({ buffer }, { kind: 'image', ext: 'jpg', mime: 'image/jpeg', extra: { source: 'upload' } })).url;
}

// AI images arrive as PNG/WebP in whatever size the model picked: center-crop them to the platform's
// size and save as JPEG, so every platform (Instagram included) accepts them. Returns { url, buffer }.
export async function storeGeneratedImage(buffer, { width, height }) {
  const sharp = (await import('sharp')).default;
  const jpeg = await sharp(buffer).resize(width, height, { fit: 'cover' }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  if (jpeg.length > MAX_BYTES) throw new AppError('TOO_LARGE', 'Image is larger than 8 MB.', { status: 413 });
  const stored = await storeAsset({ buffer: jpeg }, { kind: 'image', ext: 'jpg', mime: 'image/jpeg', extra: { source: 'generated' } });
  return { url: stored.url, buffer: jpeg };
}

export async function storeVideo(buffer) {
  if (buffer.length > MAX_VIDEO_BYTES) throw new AppError('TOO_LARGE', 'Video is larger than 100 MB.', { status: 413 });
  return (await storeAsset({ buffer }, { kind: 'video', ext: 'mp4', mime: 'video/mp4', extra: { source: 'upload' } })).url;
}

export async function storeDocument(buffer) {
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new AppError('TOO_LARGE', `PDF is larger than ${MAX_DOCUMENT_BYTES / MB} MB.`, { status: 413 });
  return (await storeAsset({ buffer }, { kind: 'document', ext: 'pdf', mime: 'application/pdf', extra: { source: 'upload' } })).url;
}

// ---- Media from a link (Claude via MCP, or pasted in the dashboard) ----

// With Google Drive connected (Connections), a Drive file is downloaded with that account, so it can stay private.
// Otherwise the public download link is used, which needs the file shared as "Anyone with the link".
async function download(url, { kind, maxBytes, signal, testing: givenTesting }, fn) {
  const testing = givenTesting ?? ingestTestOverrides() ?? undefined;
  const noun = ACCEPT[kind].noun;
  let driveId = null;
  try {
    driveId = driveFileId(url, { allowHttp: Boolean(testing?.allowHttp) });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('INVALID_URL', err.message);
  }
  if (driveId && !testing) {
    // A Google Slides deck exported as PDF makes a ready LinkedIn carousel.
    const plan = await downloadFromDrive(driveId, { maxBytes, noun, exportPdf: kind === 'pdf' });
    if (plan) {
      return withDownload(plan.url, { kind, maxBytes, signal, source: { headers: plan.headers, allowedHosts: ['googleapis.com'] } }, (file) =>
        fn({ ...file, filename: file.filename || plan.filename }),
      );
    }
  }
  return withDownload(url, { kind, maxBytes, signal, testing }, fn);
}

const failQc = (report, noun) => {
  const first = report.errors[0];
  const err = new AppError('MEDIA_INVALID', `${first.message}${report.errors.length > 1 ? ` (+${report.errors.length - 1} more problem${report.errors.length > 2 ? 's' : ''})` : ''}`, {
    details: { noun, errors: report.errors, warnings: report.warnings },
  });
  count('qc.rejected');
  return err;
};

/**
 * An image from a link: checked, converted to a normalized JPEG derivative for the platform and stored. The source file
 * is kept too (kind "original") so the derivative can be re-made. Returns { url, qc, duplicate, cropped }.
 * options: platform (required for platform rules), altText.
 */
export async function importImage(url, { platform = 'x', altText, signal, testing } = {}) {
  return download(url, { kind: 'image', maxBytes: MAX_IMPORT_IMAGE_BYTES, signal, testing }, async (file) => {
    const dup = await repo.findAsset({ kind: 'image', source_sha256: file.sha256, profile: platform });
    if (dup) {
      count('ingest.duplicate');
      log.info('ingest.duplicate', { kind: 'image' });
      const buffer = await loadImage(dup.url).catch(() => null);
      if (buffer) return { url: dup.url, duplicate: true, cropped: false, qc: plain(await checkImage(buffer, { platform, altText })) };
    }
    const buffer = await file.readBuffer();
    const source = await checkImage(buffer, { platform, altText, converting: true });
    // An aspect ratio the platform rejects is fixed by the crop below; the derivative is checked again afterwards.
    const blocking = source.errors.filter((e) => !e.fixable);
    if (blocking.length) throw failQc({ errors: blocking, warnings: source.warnings }, 'image');
    const derived = await deriveImage(buffer, { platform });
    const qc = await checkImage(derived.buffer, { platform, altText });
    if (!qc.ok) throw failQc(qc, 'image');
    if (derived.cropped) {
      qc.warn('IMAGE_CROPPED', `The image (${derived.source.width}x${derived.source.height}) was cropped to ${derived.width}x${derived.height} to fit ${platform}. Check that nothing important was cut off.`);
      qc.review('The image was automatically cropped. Look at it before approving.');
    }
    const original = await storeAsset({ buffer }, { kind: 'original', ext: file.type.ext, mime: file.type.mime, extra: { source: 'import' } });
    const stored = await storeAsset(
      { buffer: derived.buffer },
      { kind: 'image', ext: 'jpg', mime: 'image/jpeg', extra: { source: 'import', source_sha256: file.sha256, profile: platform, original_url: original.url } },
    );
    return { url: stored.url, duplicate: stored.duplicate, cropped: derived.cropped, qc: plain(qc) };
  });
}

// A PDF from a link, checked and stored. The file name serves as the default title. Returns { url, pages, filename, qc, duplicate }.
export async function importDocument(url, { platform = 'linkedin', signal, testing } = {}) {
  return download(url, { kind: 'pdf', maxBytes: MAX_DOCUMENT_BYTES, signal, testing }, async (file) => {
    const buffer = await file.readBuffer();
    const qc = await checkPdf(buffer, { platform });
    if (!qc.ok) throw failQc(qc, 'PDF');
    const stored = await storeAsset({ buffer }, { kind: 'document', ext: 'pdf', mime: 'application/pdf', sha: file.sha256, extra: { source: 'import' } });
    return { url: stored.url, pages: qc.info.pages, filename: file.filename, qc: plain(qc), duplicate: stored.duplicate };
  });
}

// MP4 or MOV, the formats every platform takes. Returns { url, qc, duplicate }.
export async function importVideo(url, { platform = 'x', requireAudio, signal, testing } = {}) {
  return download(url, { kind: 'video', maxBytes: MAX_VIDEO_BYTES, signal, testing }, async (file) => {
    const qc = await checkVideo(file.path, { platform, requireAudio });
    if (!qc.ok) throw failQc(qc, 'video');
    const stored = await storeAsset(
      { path: file.path, size: file.bytes },
      { kind: 'video', ext: file.type.ext, mime: file.type.mime, sha: file.sha256, extra: { source: 'import' } },
    );
    return { url: stored.url, qc: plain(qc), duplicate: stored.duplicate };
  });
}

// An uploaded PDF (raw body): same checks as a linked one.
export async function checkAndStoreUploadedDocument(buffer, { platform = 'linkedin' } = {}) {
  const qc = await checkPdf(buffer, { platform });
  if (!qc.ok) throw failQc(qc, 'PDF');
  return { url: await storeDocument(buffer), pages: qc.info.pages, qc: plain(qc) };
}

// An uploaded video (raw body): signature check + the same QC as a linked one.
export async function checkAndStoreUploadedVideo(buffer, { platform = 'x', requireAudio } = {}) {
  if (buffer.length > MAX_VIDEO_BYTES) throw new AppError('TOO_LARGE', 'Video is larger than 100 MB.', { status: 413 });
  const tmp = path.join((await import('node:os')).tmpdir(), `ca-upload-${crypto.randomBytes(8).toString('hex')}.mp4`);
  await writeFile(tmp, buffer, { mode: 0o600 });
  try {
    const qc = await checkVideo(tmp, { platform, requireAudio });
    if (!qc.ok) throw failQc(qc, 'video');
    return { url: await storeVideo(buffer), qc: plain(qc) };
  } finally {
    await rm(tmp, { force: true });
  }
}
