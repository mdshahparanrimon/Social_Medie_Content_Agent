import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './errors.js';
import { log, count, redactUrl } from './log.js';
import { parseSafeUrl, safeGet } from './net/safeFetch.js';

// Secure download of a media file from a link: Google Drive share links and plain direct links.
// The body is streamed into a private temp file (never held in memory), hashed, size-capped and identified by its
// real signature. The temp file is always removed by withDownload(), also when the download fails or is cancelled.

export const TMP_DIR = process.env.INGEST_TMP_DIR || path.join(os.tmpdir(), 'content-agent-ingest');
const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'];
// Where a Drive download may legitimately redirect to.
const DRIVE_FOLLOW_HOSTS = ['google.com', 'googleusercontent.com', 'googleapis.com'];
const FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;

// Tests route downloads to a local mock server through these overrides. They can not be set outside NODE_ENV=test.
let defaultTesting = null;
export function useIngestTestOverrides(overrides) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Ingest test overrides are only available when NODE_ENV=test.');
  defaultTesting = overrides;
}
export const ingestTestOverrides = () => (process.env.NODE_ENV === 'test' ? defaultTesting : null);

const envMs = (name, fallback) => Number(process.env[name]) || fallback;
// Optional comma-separated allowlist for direct (non-Drive) links, e.g. MEDIA_ALLOWED_HOSTS=cdn.example.com,example.org
const allowedDirectHosts = () => {
  const list = (process.env.MEDIA_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : undefined;
};

// ---- Google Drive links ----

// { id, host, kind } for a Drive / Docs / Slides link, null for any other link. Throws for folders and unusable Drive links.
export function parseDriveUrl(value, { allowHttp = false } = {}) {
  const url = parseSafeUrl(value, { allowHttp });
  const host = url.hostname.toLowerCase();
  if (!DRIVE_HOSTS.includes(host)) return null;
  if (url.pathname.includes('/folders/')) throw new AppError('DRIVE_FOLDER', 'That is a Google Drive folder. Use the link of one file in it.');
  const id = /\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] || url.searchParams.get('id');
  if (!id || !FILE_ID.test(id)) throw new AppError('INVALID_URL', 'Could not find the file in that Google Drive link.');
  return { id, host, kind: url.pathname.startsWith('/document/') ? 'doc' : url.pathname.startsWith('/presentation/') ? 'slides' : 'file' };
}

export const publicDriveUrl = (id) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;

// Google's "can't scan for viruses" page is a small form that posts back to drive.usercontent.google.com.
export function parseConfirmationForm(html) {
  const form = /<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = form[1].replace(/&amp;/g, '&');
  const params = new URLSearchParams();
  for (const input of form[2].matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = /name="([^"]*)"/i.exec(input[0])?.[1];
    const val = /value="([^"]*)"/i.exec(input[0])?.[1] ?? '';
    if (name) params.append(name, val.replace(/&amp;/g, '&'));
  }
  try {
    const target = new URL(action);
    for (const [k, v] of params) target.searchParams.set(k, v);
    return target.href;
  } catch {
    return null;
  }
}

// ---- File signatures ----

const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

// What the bytes really are, whatever the extension or Content-Type claims. null when unknown.
export function sniffType(buf) {
  if (buf.length < 12) return null;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { kind: 'image', format: 'jpeg', mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', format: 'png', mime: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return { kind: 'image', format: 'gif', mime: 'image/gif', ext: 'gif' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { kind: 'image', format: 'webp', mime: 'image/webp', ext: 'webp' };
  }
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'document', format: 'pdf', mime: 'application/pdf', ext: 'pdf' };
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (['avif', 'avis'].includes(brand)) return { kind: 'image', format: 'avif', mime: 'image/avif', ext: 'avif' };
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return { kind: 'image', format: 'heif', mime: 'image/heif', ext: 'heic' };
    if (brand === 'qt  ') return { kind: 'video', format: 'mov', mime: 'video/quicktime', ext: 'mov' };
    return { kind: 'video', format: 'mp4', mime: 'video/mp4', ext: 'mp4' };
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', format: 'webm', mime: 'video/webm', ext: 'webm' };
  const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head')) return { kind: 'html', format: 'html', mime: 'text/html', ext: 'html' };
  return null;
}

// What each caller will accept.
export const ACCEPT = {
  image: { kinds: ['image'], formats: ['jpeg', 'png', 'webp', 'gif', 'avif'], noun: 'image' },
  video: { kinds: ['video'], formats: ['mp4', 'mov'], noun: 'video' },
  pdf: { kinds: ['document'], formats: ['pdf'], noun: 'PDF' },
};

// A safe base name for display: the server's file name without path, extension, control characters or markup.
export function safeFilename(header = '') {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  let name = /filename="?([^";]+)"?/i.exec(header)?.[1] || '';
  try {
    if (encoded) name = decodeURIComponent(encoded);
  } catch {
    /* keep the plain filename */
  }
  return path
    .basename(name.replace(/\\/g, '/'))
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .trim()
    .slice(0, 100);
}

// ---- Download ----

function mapStatus(status, noun) {
  if (status === 404) return new AppError('NOT_FOUND', `The ${noun} link does not exist or was deleted.`, { status: 404 });
  if (status === 410) return new AppError('LINK_EXPIRED', `The ${noun} link has expired. Create a new link.`, { status: 410 });
  if (status === 401 || status === 403) {
    return new AppError('ACCESS_DENIED', `The ${noun} is not accessible. Share it as "Anyone with the link", or connect Google Drive on the Connections page.`, { status: 403 });
  }
  if (status === 429) return new AppError('RATE_LIMITED', `The ${noun} host is limiting requests. Try again later.`, { status: 429 });
  return new AppError('UPSTREAM_ERROR', `Could not download the ${noun} (${status}).`, { status: 502 });
}

async function readSmallBody(res, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) {
      res.destroy();
      break;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const tooLarge = (maxBytes, noun) => new AppError('TOO_LARGE', `The ${noun} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, { status: 413 });

async function streamToFile(res, file, { maxBytes, noun, signal, totalTimedOut }) {
  const declared = Number(res.headers['content-length']);
  if (declared > maxBytes) {
    res.destroy();
    throw tooLarge(maxBytes, noun);
  }
  const hash = crypto.createHash('sha256');
  const out = createWriteStream(file, { mode: 0o600 });
  out.on('error', () => {});
  let bytes = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of res) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw tooLarge(maxBytes, noun);
      if (head.length < 64) head = Buffer.concat([head, chunk]).subarray(0, 64);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    if (res.complete === false) throw new AppError('INCOMPLETE', `The ${noun} download was cut off. Try again.`, { status: 502 });
  } catch (err) {
    res.destroy();
    out.destroy();
    if (err instanceof AppError) throw err;
    // A broken body stream: tell a deliberate cancel and a stall apart from a dropped connection.
    if (signal?.aborted && !totalTimedOut()) throw new AppError('CANCELLED', 'The download was cancelled.', { status: 499 });
    if (totalTimedOut() || res.req?.timedOut) throw new AppError('TIMEOUT', `The ${noun} download took too long.`, { status: 408 });
    throw new AppError('INCOMPLETE', `The ${noun} download was cut off. Try again.`, { status: 502 });
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  return { bytes, sha256: hash.digest('hex'), head };
}

/**
 * Downloads `url` to a temp file and calls `fn(file)` with { path, bytes, sha256, type, filename, readBuffer() }.
 * The temp file is deleted when fn finishes or throws. kind: 'image' | 'video' | 'pdf'.
 */
export async function withDownload(url, { kind, maxBytes, signal, testing: givenTesting, source } = {}, fn) {
  const testing = givenTesting ?? ingestTestOverrides() ?? undefined;
  const accept = ACCEPT[kind];
  if (!accept) throw new Error(`Unknown media kind: ${kind}`);
  const { noun } = accept;
  await mkdir(TMP_DIR, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(TMP_DIR, `${crypto.randomBytes(16).toString('hex')}.part`);
  const started = Date.now();
  try {
    // source: a trusted API endpoint (the connected Google Drive) with its own headers and a fixed host allowlist.
    const drive = source ? null : parseDriveUrl(url, { allowHttp: Boolean(testing?.allowHttp) });
    let target = source
      ? parseSafeUrl(url, { allowedHosts: source.allowedHosts }).href
      : drive
        ? publicDriveUrl(drive.id)
        : parseSafeUrl(url, { allowedHosts: allowedDirectHosts(), allowHttp: Boolean(testing?.allowHttp) }).href;
    if (drive && testing?.driveBase) target = `${testing.driveBase}/download?id=${encodeURIComponent(drive.id)}`;
    const netOptions = {
      allowedHosts: source ? source.allowedHosts : drive && !testing?.driveBase ? DRIVE_FOLLOW_HOSTS : allowedDirectHosts(),
      headers: source?.headers,
      timeoutMs: envMs('MEDIA_REQUEST_TIMEOUT_MS', 20_000),
      totalTimeoutMs: envMs('MEDIA_TOTAL_TIMEOUT_MS', 120_000),
      signal,
      testing,
    };

    for (let step = 0; ; step++) {
      const { response, finalUrl, signal: reqSignal, totalTimedOut } = await safeGet(target, netOptions);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw mapStatus(response.statusCode, noun);
      }
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (contentType.startsWith('text/html') || contentType.startsWith('application/xhtml')) {
        const html = await readSmallBody(response, 512 * 1024);
        const next = drive && step < 2 ? parseConfirmationForm(html) : null;
        if (next) {
          target = next; // validated again, host by host, by safeGet
          continue;
        }
        const signIn = /accounts\.google\.com|ServiceLogin/i.test(html);
        throw new AppError(
          signIn ? 'ACCESS_DENIED' : 'HTML_RESPONSE',
          `That link opens a web page, not a ${noun}. For Google Drive, connect Google Drive on the Connections page, or share the file as "Anyone with the link".`,
          { status: signIn ? 403 : 400 },
        );
      }

      const { bytes, sha256, head } = await streamToFile(response, tmpFile, { maxBytes, noun, signal: reqSignal, totalTimedOut });
      if (bytes === 0) throw new AppError('EMPTY_FILE', `The ${noun} file is empty.`);
      const type = sniffType(head);
      if (type?.kind === 'html') throw new AppError('HTML_RESPONSE', `That link returned a web page, not a ${noun}.`);
      if (!type || !accept.kinds.includes(type.kind) || !accept.formats.includes(type.format)) {
        const hint = kind === 'video' ? 'Use an MP4 or MOV video.' : kind === 'pdf' ? 'Use a PDF.' : 'Use a JPEG, PNG, WebP, GIF or AVIF image.';
        throw new AppError('UNSUPPORTED_FORMAT', `That file is not a supported ${noun} (${type?.format || 'unrecognised format'}). ${hint}`, {
          details: { detected: type?.format || null },
        });
      }
      const file = {
        path: tmpFile,
        bytes,
        sha256,
        type,
        filename: safeFilename(response.headers['content-disposition']),
        sourceHost: finalUrl.hostname,
        readBuffer: async () => {
          const handle = await open(tmpFile, 'r');
          try {
            return await handle.readFile();
          } finally {
            await handle.close();
          }
        },
      };
      log.info('ingest.downloaded', { kind, host: finalUrl.hostname, bytes, ms: Date.now() - started, format: type.format });
      count('ingest.ok');
      return await fn(file);
    }
  } catch (err) {
    count(`ingest.fail.${err.code || 'error'}`);
    log.warn('ingest.failed', { kind, url: redactUrl(String(url)), code: err.code, message: err.message, ms: Date.now() - started });
    throw err;
  } finally {
    await rm(tmpFile, { force: true }).catch((e) => log.error('ingest.cleanup_failed', { message: e.message }));
  }
}

// Removes leftovers of crashed downloads (older than an hour). Run at startup.
export async function sweepTemp(maxAgeMs = 60 * 60 * 1000) {
  let removed = 0;
  let names = [];
  try {
    names = await readdir(TMP_DIR);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(TMP_DIR, name);
    const info = await stat(file).catch(() => null);
    if (info && Date.now() - info.mtimeMs > maxAgeMs) {
      await rm(file, { force: true });
      removed++;
    }
  }
  return removed;
}
