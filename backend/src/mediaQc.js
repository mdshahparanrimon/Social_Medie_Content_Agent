import { execFile } from 'node:child_process';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { sniffType } from './mediaIngest.js';
import { loadRules } from './mediaRules.js';
import { log } from './log.js';

// Media quality control: deterministic technical checks for images, PDFs, videos and carousel slide text.
// Every check returns a report: { ok, errors, warnings, humanReview, info, checks }.
//  - errors: block approval and publishing.
//  - warnings: shown to the user, do not block.
//  - humanReview: things a machine here cannot judge (visual quality, legibility); a person must look.
//  - checks: what ran ('passed' | 'failed' | 'skipped' | 'unavailable'), so a missing tool is never reported as a pass.

const execFileAsync = promisify(execFile);

export function newReport(kind) {
  const r = { kind, ok: true, errors: [], warnings: [], humanReview: [], info: {}, checks: {} };
  r.error = (code, message, extra) => {
    r.errors.push({ code, message, ...extra });
    r.ok = false;
  };
  r.warn = (code, message) => r.warnings.push({ code, message });
  r.review = (message) => {
    if (!r.humanReview.includes(message)) r.humanReview.push(message);
  };
  r.check = (name, state) => {
    r.checks[name] = state;
  };
  return r;
}

// A plain JSON-safe copy (drops the helper functions) for storing on a post or sending to a client.
export const plain = ({ kind, ok, errors, warnings, humanReview, info, checks }) => ({ kind, ok, errors, warnings, humanReview, info, checks });

const ratio = (w, h) => (h ? w / h : 0);
const fmtRange = ([a, b]) => `${a}:1 to ${b}:1`;

// ---- Images ----

/**
 * buffer: image bytes. opts: platform, altText, converting (true when this is a source file that will be converted
 * to a JPEG derivative, so a format the platform doesn't take is only a note), rules (override).
 */
export async function checkImage(buffer, { platform, altText, converting = false, rules: ruleSet = loadRules() } = {}) {
  const r = newReport('image');
  const rules = ruleSet.image[platform];
  const caps = ruleSet.image.all;
  if (!rules) {
    r.error('UNKNOWN_PLATFORM', `No image rules for "${platform}".`);
    return r;
  }
  const type = sniffType(buffer);
  if (!type || type.kind !== 'image') {
    r.error('NOT_AN_IMAGE', 'This file is not an image.');
    return r;
  }
  r.info.format = type.format;
  r.info.bytes = buffer.length;

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: caps.maxPixels, failOn: 'warning' }).metadata();
  } catch (err) {
    const tooBig = /pixel limit/i.test(err.message);
    r.error(tooBig ? 'IMAGE_TOO_MANY_PIXELS' : 'IMAGE_CORRUPT', tooBig ? 'The image has too many pixels to process safely.' : 'The image is corrupt or truncated and cannot be decoded.');
    r.check('decode', 'failed');
    return r;
  }
  const { width = 0, height = 0 } = meta;
  const pixels = width * height;
  Object.assign(r.info, { width, height, aspect: Number(ratio(width, height).toFixed(4)), pixels, pages: meta.pages || 1 });

  // A full decode proves the file is complete (metadata only reads the header).
  let stats;
  try {
    stats = await sharp(buffer, { limitInputPixels: caps.maxPixels, failOn: 'warning' }).stats();
    r.check('decode', 'passed');
  } catch {
    r.error('IMAGE_CORRUPT', 'The image is corrupt or truncated and cannot be decoded.');
    r.check('decode', 'failed');
    return r;
  }

  if (width > caps.maxDimension || height > caps.maxDimension) r.error('IMAGE_TOO_LARGE_DIMENSIONS', `The image is larger than ${caps.maxDimension}px on a side.`);
  if (rules.maxPixels && pixels > rules.maxPixels) r.error('IMAGE_TOO_MANY_PIXELS', `The image has ${pixels} pixels; ${platform} takes at most ${rules.maxPixels}.`);
  if (buffer.length > rules.maxBytes) r.error('IMAGE_TOO_HEAVY', `The image is ${(buffer.length / 1024 / 1024).toFixed(1)} MB; the limit is ${(rules.maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  if (width < rules.minWidth) r.error('IMAGE_TOO_SMALL', `The image is ${width}px wide; at least ${rules.minWidth}px is needed.`);
  else if (width < 600) r.warn('IMAGE_LOW_RESOLUTION', `The image is only ${width}px wide and may look blurry.`);

  if (!rules.formats.includes(type.format)) {
    const message = `${type.format.toUpperCase()} is not a format ${platform} takes (${rules.formats.join(', ')}).`;
    if (converting) r.warn('IMAGE_FORMAT_CONVERTED', `${message} It will be converted to JPEG.`);
    else r.error('IMAGE_FORMAT', message);
  }
  if ((meta.pages || 1) > 1) r.warn('IMAGE_ANIMATED', 'The image is animated; only the first frame is used when it is converted.');

  const a = ratio(width, height);
  if (rules.aspect && (a < rules.aspect[0] - 0.005 || a > rules.aspect[1] + 0.005)) {
    r.error('IMAGE_ASPECT', `The aspect ratio ${a.toFixed(2)}:1 is outside what ${platform} accepts (${fmtRange(rules.aspect)}).`, { fixable: true });
  } else if (rules.preferred && (a < rules.preferred[0] - 0.005 || a > rules.preferred[1] + 0.005)) {
    r.warn('IMAGE_ASPECT_UNUSUAL', `The aspect ratio ${a.toFixed(2)}:1 works, but ${platform} shows ${fmtRange(rules.preferred)} best; it may be cropped in the feed.`);
  }

  const flat = stats.channels.slice(0, 3).every((c) => c.stdev < 1.5);
  if (flat) {
    r.warn('IMAGE_FLAT', 'The image looks like a single flat color.');
    r.review('The image looks blank or a solid color. Check it before approving.');
  }

  if (altText && rules.altMax && [...altText].length > rules.altMax) r.warn('ALT_TOO_LONG', `The alt text is ${[...altText].length} characters; ${platform} allows ${rules.altMax}.`);
  if (rules.altRecommended && !String(altText || '').trim()) r.warn('ALT_MISSING', 'No alt text. Add a short description for screen readers.');
  r.check('rules', r.ok ? 'passed' : 'failed');
  r.review('Composition, cropping and text legibility are not machine-verified. Look at the image before approving.');
  return r;
}

/**
 * Normalized JPEG derivative for publishing: upright, flattened on white, at most 2160px. The source file is not
 * touched. If the platform has a hard aspect range and the image is outside it, it is center/attention-cropped to the
 * nearest allowed ratio (`cropped: true`) and the caller must show that to the user.
 */
export async function deriveImage(buffer, { platform, rules: ruleSet = loadRules() } = {}) {
  const rules = ruleSet.image[platform];
  const caps = ruleSet.image.all;
  const base = () => sharp(buffer, { limitInputPixels: caps.maxPixels, failOn: 'warning' }).rotate();
  const meta = await base().toBuffer({ resolveWithObject: true });
  const { width, height } = meta.info;
  let pipeline = base();
  let cropped = false;
  const a = ratio(width, height);
  if (rules?.aspect && (a < rules.aspect[0] || a > rules.aspect[1])) {
    const target = a < rules.aspect[0] ? rules.aspect[0] : rules.aspect[1];
    const w = a > target ? Math.round(height * target) : width;
    const h = a > target ? height : Math.round(width / target);
    // Resize steps don't chain in sharp, so the crop is rendered first and then normalized below.
    const crop = await base().resize(w, h, { fit: 'cover', position: sharp.strategy.attention }).png().toBuffer();
    pipeline = sharp(crop);
    cropped = true;
  }
  const out = await pipeline
    .resize(2160, 2160, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height, cropped, source: { width, height } };
}

// ---- PDFs ----

let pdftoppmState; // undefined = not probed yet
async function pdftoppm() {
  if (pdftoppmState === undefined) {
    const bin = process.env.PDFTOPPM_PATH || 'pdftoppm';
    pdftoppmState = await execFileAsync(bin, ['-v'], { timeout: 5000 }).then(() => bin, (err) => (err.stderr?.includes('pdftoppm') ? bin : null));
  }
  return pdftoppmState;
}
export const resetToolProbes = () => {
  pdftoppmState = undefined;
  ffprobeState = undefined;
};

// Renders pages to low-resolution PNGs with poppler's pdftoppm when it is installed; null when it is not.
export async function renderPdfPages(buffer, { maxPages = 30, dpi = 40 } = {}) {
  const bin = await pdftoppm();
  if (!bin) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ca-pdf-'));
  try {
    await writeFile(path.join(dir, 'in.pdf'), buffer);
    await execFileAsync(bin, ['-r', String(dpi), '-l', String(maxPages), '-png', path.join(dir, 'in.pdf'), path.join(dir, 'page')], { timeout: 60_000 });
    const files = (await readdir(dir)).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort();
    return Promise.all(files.map((f) => readFile(path.join(dir, f))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function checkPdf(buffer, { platform = 'linkedin', rules: ruleSet = loadRules(), render = renderPdfPages } = {}) {
  const r = newReport('pdf');
  const rules = ruleSet.pdf[platform];
  if (!rules) {
    r.error('UNKNOWN_PLATFORM', `No PDF rules for "${platform}".`);
    return r;
  }
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    r.error('NOT_A_PDF', 'This file is not a PDF.');
    return r;
  }
  r.info.bytes = buffer.length;
  if (buffer.length > rules.maxBytes) r.error('PDF_TOO_HEAVY', `The PDF is ${(buffer.length / 1024 / 1024).toFixed(1)} MB; the limit is ${(rules.maxBytes / 1024 / 1024).toFixed(0)} MB.`);

  let doc;
  let pages;
  try {
    doc = await PDFDocument.load(buffer, { updateMetadata: false });
    pages = doc.getPages(); // pdf-lib parses lazily: garbage only fails here
    r.check('parse', 'passed');
  } catch (err) {
    const encrypted = /encrypt/i.test(err.message);
    r.error(encrypted ? 'PDF_ENCRYPTED' : 'PDF_CORRUPT', encrypted ? 'The PDF is password-protected. Export an unprotected copy.' : 'The PDF could not be read. Export it again.');
    r.check('parse', 'failed');
    return r;
  }

  r.info.pages = pages.length;
  if (pages.length < 1) r.error('PDF_NO_PAGES', 'The PDF has no pages.');
  if (pages.length > rules.maxPages) r.error('PDF_TOO_MANY_PAGES', `The PDF has ${pages.length} pages; at most ${rules.maxPages} are allowed.`);
  if (rules.recommendedPages && (pages.length < rules.recommendedPages[0] || pages.length > rules.recommendedPages[1])) {
    r.warn('PDF_PAGE_COUNT_UNUSUAL', `${pages.length} pages. Carousels usually work best with ${rules.recommendedPages[0]}-${rules.recommendedPages[1]}.`);
  }

  const sizes = new Set();
  const orientations = new Set();
  const empty = [];
  pages.forEach((page, i) => {
    const { width, height } = page.getSize();
    sizes.add(`${Math.round(width)}x${Math.round(height)}`);
    orientations.add(Math.abs(width - height) < 2 ? 'square' : width > height ? 'landscape' : 'portrait');
    if (Math.min(width, height) < rules.minPageSide || Math.max(width, height) > rules.maxPageSide) {
      r.error('PDF_PAGE_SIZE', `Page ${i + 1} is ${Math.round(width)}x${Math.round(height)} pt, outside the supported size.`);
    }
    // A page with no content stream draws nothing at all.
    if (!page.node.Contents()) empty.push(i + 1);
  });
  r.info.pageSizes = [...sizes];
  r.info.orientations = [...orientations];
  if (empty.length) r.error('PDF_EMPTY_PAGE', `Page${empty.length > 1 ? 's' : ''} ${empty.join(', ')} ${empty.length > 1 ? 'have' : 'has'} no content.`);
  if (sizes.size > 1) r.warn('PDF_MIXED_PAGE_SIZES', 'Pages have different sizes; swiping through the carousel will look uneven.');
  if (rules.preferredOrientation && orientations.size && ![...orientations].every((o) => rules.preferredOrientation.includes(o))) {
    r.warn('PDF_ORIENTATION', `Carousels read best as ${rules.preferredOrientation.join(' or ')} pages.`);
  }
  r.check('structure', r.errors.length ? 'failed' : 'passed');

  // Visual check: only if a renderer is installed. Otherwise say so; never imply the pages were looked at.
  let images = null;
  try {
    images = await render(buffer, { maxPages: Math.min(pages.length, 30) });
  } catch (err) {
    r.error('PDF_RENDER_FAILED', 'The PDF could not be rendered to images. It may display incorrectly.');
    r.check('render', 'failed');
    log.warn('qc.pdf_render_failed', { message: err.message });
  }
  if (images) {
    r.check('render', 'passed');
    r.info.renderedPages = images.length;
    if (images.length < Math.min(pages.length, 30)) r.error('PDF_RENDER_INCOMPLETE', `Only ${images.length} of ${pages.length} pages could be rendered.`);
    const blank = [];
    for (const [i, img] of images.entries()) {
      const { channels } = await sharp(img).stats();
      if (channels.slice(0, 3).every((c) => c.stdev < 1)) blank.push(i + 1);
    }
    if (blank.length) r.error('PDF_BLANK_PAGE', `Page${blank.length > 1 ? 's' : ''} ${blank.join(', ')} render${blank.length > 1 ? '' : 's'} blank.`);
  } else if (!r.checks.render) {
    r.check('render', 'unavailable');
    r.warn('PDF_RENDER_UNAVAILABLE', 'No PDF renderer (pdftoppm) is installed, so the pages were not rendered or checked for blank content.');
  }
  r.review('Text overflow, font rendering (including Bengali) and layout are only verified by a person for uploaded PDFs.');
  return r;
}

// ---- Carousel slide text (before drawing) ----

const CTA_WORDS = /\b(comment|follow|save|share|repost|dm|message|book|sign ?up|subscribe|visit|download|read|learn more|try|join|contact|reach out|ask|tell us|let me know|link in|get started|start|reply|tag|vote)\b|[?]|কমেন্ট|ফলো|শেয়ার|সেভ|যোগাযোগ|মেসেজ|জানান|লিংক|ডাউনলোড|যোগ দিন/i;
export const wordCount = (text) => {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
};

export function checkSlides(slides, { rules: ruleSet = loadRules(), strictCta = false } = {}) {
  const r = newReport('slides');
  const rules = ruleSet.slides;
  if (slides.length < rules.minSlides) r.error('SLIDES_TOO_FEW', `A carousel needs at least ${rules.minSlides} slides.`);
  if (slides.length > rules.maxSlides) r.error('SLIDES_TOO_MANY', `A carousel can have at most ${rules.maxSlides} slides.`);
  slides.forEach((s, i) => {
    const n = i + 1;
    const hw = wordCount(s.heading);
    const bw = wordCount(s.body);
    if (hw > rules.headingWords) (hw > rules.headingWords * 1.5 ? r.error : (c, m) => r.warn(c, m))('SLIDE_HEADING_LONG', `Slide ${n}: the heading has ${hw} words; keep it to ${rules.headingWords}.`);
    if (bw > rules.bodyWords) (bw > rules.bodyWords * 1.5 ? r.error : (c, m) => r.warn(c, m))('SLIDE_BODY_LONG', `Slide ${n}: the text has ${bw} words; keep it to ${rules.bodyWords}.`);
    if (i > 0 && i < slides.length - 1 && !bw) r.warn('SLIDE_NO_BODY', `Slide ${n} has only a heading.`);
    if (/[*_#`]|\[.*\]\(.*\)/.test(`${s.heading} ${s.body}`)) r.warn('SLIDE_MARKDOWN', `Slide ${n} contains markdown characters; they are drawn as plain text.`);
  });
  const last = slides.at(-1);
  if (last && rules.requireClosingCta && !CTA_WORDS.test(`${last.heading} ${last.body}`)) {
    // A word list can't prove there is a call to action, only that none of the common ones appears.
    (strictCta ? r.error : (c, m) => r.warn(c, m))('SLIDE_CTA_MISSING', 'The last slide has no recognisable call to action (comment, follow, save, share, contact...).');
  }
  r.check('text_limits', r.errors.length ? 'failed' : 'passed');
  return r;
}

// Whether the fonts needed for non-Latin slide text are installed (Pango picks the font). 'unknown' when it can't tell.
export async function scriptFontStatus(text) {
  const needsBengali = /[\u0980-\u09FF]/.test(text);
  if (!needsBengali) return { needed: false, status: 'ok' };
  if (process.platform === 'win32') {
    const found = await readFile(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'Nirmala.ttc')).then(() => true, () => false);
    return { needed: true, script: 'Bengali', status: found ? 'ok' : 'missing' };
  }
  const listed = await execFileAsync('fc-list', [':lang=bn'], { timeout: 5000 }).then((o) => o.stdout.trim().length > 0, () => null);
  return { needed: true, script: 'Bengali', status: listed === null ? 'unknown' : listed ? 'ok' : 'missing' };
}

// Checks the slide images that were actually drawn (before they become PDF pages): size, blank pages and layout overflow.
export async function checkRenderedSlides(images, { layoutWarnings = [], sourceText = '', expected = { width: 1080, height: 1350 } } = {}) {
  const r = newReport('slide_render');
  const blank = [];
  const wrongSize = [];
  for (const [i, img] of images.entries()) {
    const meta = await sharp(img).metadata();
    if (meta.width !== expected.width || meta.height !== expected.height) wrongSize.push(i + 1);
    const { channels } = await sharp(img).stats();
    if (channels.slice(0, 3).every((c) => c.stdev < 2)) blank.push(i + 1);
  }
  if (blank.length) r.error('SLIDE_BLANK', `Slide${blank.length > 1 ? 's' : ''} ${blank.join(', ')} rendered blank.`);
  if (wrongSize.length) r.error('SLIDE_SIZE', `Slide${wrongSize.length > 1 ? 's' : ''} ${wrongSize.join(', ')} have the wrong size.`);
  for (const w of layoutWarnings) r.warn(w.code, w.message);
  r.check('rendered_pages', r.errors.length ? 'failed' : 'passed');
  const font = await scriptFontStatus(sourceText);
  r.info.fonts = font;
  if (font.needed && font.status !== 'ok') {
    r.warn('FONT_UNVERIFIED', `${font.script} text needs a ${font.script} font on the server (${font.status === 'missing' ? 'none was found' : 'could not be checked'}); letters may draw as empty boxes.`);
    r.review(`${font.script} text rendering must be checked by eye.`);
  }
  r.check('fonts', font.status === 'ok' ? 'passed' : 'unavailable');
  return r;
}

// ---- Video ----

const FOURCC_CODEC = { avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9', mp4v: 'mpeg4' };

async function readBox(handle, offset, fileSize) {
  const head = Buffer.alloc(16);
  const { bytesRead } = await handle.read(head, 0, 16, offset);
  if (bytesRead < 8) return null;
  let size = head.readUInt32BE(0);
  const type = head.subarray(4, 8).toString('latin1');
  let headerSize = 8;
  if (size === 1 && bytesRead >= 16) {
    size = Number(head.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) size = fileSize - offset;
  if (size < headerSize || offset + size > fileSize) return { type, size, headerSize, truncated: true };
  return { type, size, headerSize, truncated: false };
}

function* boxes(buf, start = 0, end = buf.length) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) return;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function parseTrak(buf, trak) {
  const out = { handler: null, width: 0, height: 0, codec: null, fourcc: null, samples: 0, mediaSeconds: null, rotated: false };
  for (const box of boxes(buf, trak.start, trak.end)) {
    if (box.type === 'tkhd') {
      const version = buf[box.start];
      const matrix = box.start + (version === 1 ? 48 : 40);
      const a = buf.readInt32BE(matrix);
      const d = buf.readInt32BE(matrix + 16);
      out.rotated = a === 0 && d === 0;
      out.width = buf.readUInt32BE(box.end - 8) / 65536;
      out.height = buf.readUInt32BE(box.end - 4) / 65536;
    } else if (box.type === 'mdia') {
      let timescale = 0;
      let duration = 0;
      for (const m of boxes(buf, box.start, box.end)) {
        if (m.type === 'mdhd') {
          const v = buf[m.start];
          timescale = buf.readUInt32BE(m.start + (v === 1 ? 20 : 12));
          duration = v === 1 ? Number(buf.readBigUInt64BE(m.start + 24)) : buf.readUInt32BE(m.start + 16);
        } else if (m.type === 'hdlr') out.handler = buf.subarray(m.start + 8, m.start + 12).toString('latin1');
        else if (m.type === 'minf') {
          for (const st of boxes(buf, m.start, m.end)) {
            if (st.type !== 'stbl') continue;
            for (const t of boxes(buf, st.start, st.end)) {
              if (t.type === 'stsd' && t.end - t.start >= 16) {
                out.fourcc = buf.subarray(t.start + 12, t.start + 16).toString('latin1');
                out.codec = FOURCC_CODEC[out.fourcc] || out.fourcc;
              } else if (t.type === 'stsz') out.samples = buf.readUInt32BE(t.start + 8);
            }
          }
        }
      }
      if (timescale && duration) out.mediaSeconds = duration / timescale;
    }
  }
  return out;
}

/** Reads container facts straight from an MP4/MOV file's boxes (no external tool): duration, tracks, codec, size. */
export async function parseMp4File(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    let offset = 0;
    let moov = null;
    let sawFtyp = false;
    let truncated = false;
    while (offset < fileSize) {
      const box = await readBox(handle, offset, fileSize);
      if (!box) break;
      if (box.truncated) {
        truncated = true;
        break;
      }
      if (box.type === 'ftyp') sawFtyp = true;
      if (box.type === 'moov') {
        if (box.size > 64 * 1024 * 1024) throw new Error('moov box is implausibly large');
        const buf = Buffer.alloc(box.size - box.headerSize);
        await handle.read(buf, 0, buf.length, offset + box.headerSize);
        moov = buf;
      }
      offset += box.size;
    }
    if (!sawFtyp) return { error: 'NOT_MP4' };
    if (!moov) return { error: truncated ? 'TRUNCATED' : 'NO_MOOV', truncated };
    const result = { bytes: fileSize, durationSeconds: null, video: null, audio: null, container: 'mov,mp4', truncated };
    for (const box of boxes(moov)) {
      if (box.type === 'mvhd') {
        const v = moov[box.start];
        const timescale = moov.readUInt32BE(box.start + (v === 1 ? 20 : 12));
        const duration = v === 1 ? Number(moov.readBigUInt64BE(box.start + 24)) : moov.readUInt32BE(box.start + 16);
        if (timescale) result.durationSeconds = duration / timescale;
      } else if (box.type === 'trak') {
        const t = parseTrak(moov, box);
        if (t.handler === 'vide' && !result.video) {
          const [w, h] = t.rotated ? [t.height, t.width] : [t.width, t.height];
          result.video = { codec: t.codec, width: w, height: h, fps: t.samples && t.mediaSeconds ? t.samples / t.mediaSeconds : null };
        } else if (t.handler === 'soun' && !result.audio) result.audio = { codec: t.codec };
      }
    }
    return result;
  } finally {
    await handle.close();
  }
}

let ffprobeState;
async function ffprobeBin() {
  if (ffprobeState === undefined) {
    const bin = process.env.FFPROBE_PATH || 'ffprobe';
    ffprobeState = await execFileAsync(bin, ['-version'], { timeout: 5000 }).then(() => bin, () => null);
  }
  return ffprobeState;
}

// Maps ffprobe's JSON onto the same shape parseMp4File returns.
export function interpretFfprobe(json) {
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s.codec_type === 'audio');
  const fps = (s) => {
    const [n, d] = String(s.avg_frame_rate && s.avg_frame_rate !== '0/0' ? s.avg_frame_rate : s.r_frame_rate || '0/1').split('/').map(Number);
    return d ? n / d : null;
  };
  const rotation = Math.abs(Number(v?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0)) % 180 === 90;
  return {
    bytes: Number(json.format?.size) || null,
    container: json.format?.format_name || null,
    durationSeconds: Number(json.format?.duration) || null,
    video: v ? { codec: v.codec_name, width: rotation ? v.height : v.width, height: rotation ? v.width : v.height, fps: fps(v) } : null,
    audio: a ? { codec: a.codec_name } : null,
  };
}

async function probe(filePath) {
  const bin = await ffprobeBin();
  if (bin) {
    try {
      const { stdout } = await execFileAsync(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return { tool: 'ffprobe', ...interpretFfprobe(JSON.parse(stdout)) };
    } catch (err) {
      return { tool: 'ffprobe', error: 'UNREADABLE', detail: String(err.stderr || err.message).slice(0, 200) };
    }
  }
  return { tool: 'mp4-header', ...(await parseMp4File(filePath).catch((err) => ({ error: 'UNREADABLE', detail: err.message }))) };
}

/** filePath: an MP4/MOV on disk. opts: platform, requireAudio, rules. */
export async function checkVideo(filePath, { platform, requireAudio, rules: ruleSet = loadRules() } = {}) {
  const r = newReport('video');
  const rules = ruleSet.video[platform];
  if (!rules) {
    r.error('UNKNOWN_PLATFORM', `No video rules for "${platform}".`);
    return r;
  }
  const info = await probe(filePath);
  r.info.inspectedWith = info.tool;
  if (info.error) {
    const messages = {
      NOT_MP4: 'This is not an MP4 or MOV file.',
      TRUNCATED: 'The video file is incomplete (cut off). Export or upload it again.',
      NO_MOOV: 'The video has no index (moov) data, so it cannot be played. Export it again.',
      UNREADABLE: 'The video could not be read. The file may be corrupt.',
    };
    r.error(`VIDEO_${info.error}`, messages[info.error] || messages.UNREADABLE);
    r.check('integrity', 'failed');
    return r;
  }
  r.check('integrity', info.truncated ? 'failed' : 'passed');
  if (info.truncated) r.error('VIDEO_TRUNCATED', 'The video file ends unexpectedly. Export or upload it again.');
  Object.assign(r.info, {
    bytes: info.bytes,
    container: info.container,
    seconds: info.durationSeconds ? Number(info.durationSeconds.toFixed(2)) : null,
    width: info.video?.width,
    height: info.video?.height,
    fps: info.video?.fps ? Number(info.video.fps.toFixed(2)) : null,
    videoCodec: info.video?.codec,
    audioCodec: info.audio?.codec || null,
  });

  if (!info.video) r.error('VIDEO_NO_VIDEO_STREAM', 'The file has no video track.');
  if (info.bytes > rules.maxBytes) r.error('VIDEO_TOO_HEAVY', `The video is ${(info.bytes / 1024 / 1024).toFixed(0)} MB; the limit is ${(rules.maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  const seconds = info.durationSeconds;
  if (!seconds) r.error('VIDEO_NO_DURATION', 'The video has no readable duration.');
  else {
    if (seconds < rules.minSeconds) r.error('VIDEO_TOO_SHORT', `The video is ${seconds.toFixed(1)} s; ${platform} needs at least ${rules.minSeconds} s.`);
    if (seconds > rules.maxSeconds) r.error('VIDEO_TOO_LONG', `The video is ${seconds.toFixed(0)} s; the limit for ${platform} is ${rules.maxSeconds} s.`);
  }
  if (info.video) {
    const a = ratio(info.video.width, info.video.height);
    if (rules.aspect && (a < rules.aspect[0] || a > rules.aspect[1])) r.error('VIDEO_ASPECT', `The aspect ratio ${a.toFixed(2)}:1 is not accepted by ${platform}.`);
    else if (rules.preferred && (a < rules.preferred[0] - 0.02 || a > rules.preferred[1] + 0.02)) {
      r.warn('VIDEO_ASPECT_UNUSUAL', `The aspect ratio ${a.toFixed(2)}:1 works, but ${platform} shows ${fmtRange(rules.preferred)} best.`);
    }
    if (Math.min(info.video.width, info.video.height) < 540) r.warn('VIDEO_LOW_RESOLUTION', `The video is ${info.video.width}x${info.video.height}; it may look blurry.`);
    if (info.video.fps && rules.minFps && info.video.fps < rules.minFps - 0.5) r.warn('VIDEO_LOW_FPS', info.video.fps.toFixed(0) + ' fps is below the ' + rules.minFps + ' fps ' + platform + ' asks for.');
    if (info.video.fps && info.video.fps > rules.maxFps) r.warn('VIDEO_HIGH_FPS', `${info.video.fps.toFixed(0)} fps is above ${rules.maxFps}; the platform may re-encode it.`);
    if (rules.codecs && info.video.codec && !rules.codecs.includes(info.video.codec)) {
      r.error('VIDEO_CODEC', `The video codec "${info.video.codec}" is not accepted by ${platform} (use ${rules.codecs.join(' or ')}).`);
    }
  }
  const needAudio = requireAudio ?? rules.requireAudio;
  if (needAudio && !info.audio) r.error('VIDEO_NO_AUDIO', 'The video has no audio track, but this post needs one.');
  else if (!info.audio) r.warn('VIDEO_SILENT', 'The video has no audio track.');
  r.check('rules', r.errors.length ? 'failed' : 'passed');
  if (info.tool !== 'ffprobe') {
    r.check('deep_probe', 'unavailable');
    r.warn('VIDEO_BASIC_INSPECTION', 'ffprobe is not installed, so only the MP4/MOV header was inspected. Frame-level corruption is not detected.');
  }
  r.review('Video content, captions and audio quality are not machine-verified. Watch the video before approving.');
  return r;
}

// ---- Combining reports ----

// One summary for a post: blocking errors from every attachment, plus everything a person still has to look at.
export function combineReports(reports) {
  const live = reports.filter(Boolean);
  return {
    ok: live.every((r) => r.ok),
    errors: live.flatMap((r) => r.errors.map((e) => ({ ...e, media: r.kind }))),
    warnings: live.flatMap((r) => r.warnings.map((w) => ({ ...w, media: r.kind }))),
    humanReview: [...new Set(live.flatMap((r) => r.humanReview))],
    reports: live.map((r) => plain(r)),
  };
}
