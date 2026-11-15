import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { checkImage, checkPdf, checkRenderedSlides, checkSlides, checkVideo, combineReports, deriveImage, interpretFfprobe, wordCount } from '../src/mediaQc.js';
import { loadRules } from '../src/mediaRules.js';
import { fakeMp4, jpegImage, pdfWithPages, pngImage } from './fixtures.js';

const codes = (r) => r.errors.map((e) => e.code);
const warnCodes = (r) => r.warnings.map((e) => e.code);

test('image: a normal JPEG passes and always asks for a human look', async () => {
  const r = await checkImage(await jpegImage(1080, 1350), { platform: 'instagram', altText: 'A chart' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.checks.decode, 'passed');
  assert.ok(r.humanReview.length >= 1);
});

test('image: corrupt, truncated and non-image data are rejected', async () => {
  const good = await jpegImage(800, 800);
  assert.deepEqual(codes(await checkImage(good.subarray(0, 400), { platform: 'x' })), ['IMAGE_CORRUPT']);
  assert.deepEqual(codes(await checkImage(Buffer.from('plain text, not an image'), { platform: 'x' })), ['NOT_AN_IMAGE']);
});

test('image: pixel-bomb guard rejects images above the configured pixel ceiling', async () => {
  const rules = loadRules({ MEDIA_RULES_JSON: JSON.stringify({ image: { all: { maxPixels: 10_000 } } }) });
  const r = await checkImage(await pngImage(400, 400), { platform: 'x', rules });
  assert.deepEqual(codes(r), ['IMAGE_TOO_MANY_PIXELS']);
});

test('image: Instagram aspect is a hard rule, other platforms only warn', async () => {
  const wide = await jpegImage(2000, 500); // 4:1
  const ig = await checkImage(wide, { platform: 'instagram' });
  assert.ok(codes(ig).includes('IMAGE_ASPECT'));
  const li = await checkImage(wide, { platform: 'linkedin' });
  assert.equal(li.ok, true);
  assert.ok(warnCodes(li).includes('IMAGE_ASPECT_UNUSUAL'));
  const tall = await checkImage(await jpegImage(1000, 1500), { platform: 'instagram' }); // 2:3 is narrower than 4:5
  assert.ok(codes(tall).includes('IMAGE_ASPECT'));
});

test('image: an aspect off the preferred shape but accepted is not rejected', async () => {
  const r = await checkImage(await jpegImage(1200, 630), { platform: 'instagram' }); // 1.9:1, allowed
  assert.equal(r.ok, true);
  assert.ok(warnCodes(r).includes('IMAGE_ASPECT_UNUSUAL'));
});

test('image: format rules apply to stored assets; sources being converted only get a note', async () => {
  const webp = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#fff' } }).webp().toBuffer();
  assert.ok(codes(await checkImage(webp, { platform: 'instagram' })).includes('IMAGE_FORMAT'));
  const converting = await checkImage(webp, { platform: 'instagram', converting: true });
  assert.equal(converting.ok, true);
  assert.ok(warnCodes(converting).includes('IMAGE_FORMAT_CONVERTED'));
});

test('image: size, minimum width, alt text and flat-color warnings', async () => {
  const small = await checkImage(await jpegImage(100, 100), { platform: 'x' });
  assert.ok(codes(small).includes('IMAGE_TOO_SMALL'));
  const rules = loadRules({ MEDIA_RULES_JSON: JSON.stringify({ image: { x: { maxBytes: 1000 } } }) });
  assert.ok(codes(await checkImage(await jpegImage(1000, 1000), { platform: 'x', rules })).includes('IMAGE_TOO_HEAVY'));
  const flat = await checkImage(await jpegImage(800, 800, '#ffffff'), { platform: 'x' });
  assert.ok(warnCodes(flat).includes('IMAGE_FLAT'));
  assert.ok(warnCodes(flat).includes('ALT_MISSING'));
  assert.ok(warnCodes(await checkImage(await jpegImage(800, 800), { platform: 'instagram', altText: 'x'.repeat(1200) })).includes('ALT_TOO_LONG'));
});

test('image: derivative crops to the nearest allowed ratio, flags it, and leaves the source bytes alone', async () => {
  const source = await pngImage(2000, 500);
  const copy = Buffer.from(source);
  const d = await deriveImage(source, { platform: 'instagram' });
  assert.equal(d.cropped, true);
  assert.ok(Math.abs(d.width / d.height - 1.91) < 0.02);
  assert.equal((await sharp(d.buffer).metadata()).format, 'jpeg');
  assert.ok(source.equals(copy));
  const ok = await deriveImage(await pngImage(1080, 1350), { platform: 'instagram' });
  assert.equal(ok.cropped, false);
  assert.equal(ok.width, 1080);
});

test('pdf: valid carousel passes; render is reported as unavailable, never as passed', async () => {
  const r = await checkPdf(await pdfWithPages(6), { render: async () => null });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.info.pages, 6);
  assert.equal(r.checks.render, 'unavailable');
  assert.ok(warnCodes(r).includes('PDF_RENDER_UNAVAILABLE'));
});

test('pdf: corrupt, non-PDF, empty-page, too-many-pages and oversize files', async () => {
  assert.deepEqual(codes(await checkPdf(Buffer.from('hello'), {})), ['NOT_A_PDF']);
  assert.deepEqual(codes(await checkPdf(Buffer.from('%PDF-1.7\ngarbage garbage garbage'), { render: async () => null })), ['PDF_CORRUPT']);
  const blank = await pdfWithPages(3, { text: '' });
  assert.ok(codes(await checkPdf(blank, { render: async () => null })).includes('PDF_EMPTY_PAGE'));
  const rules = loadRules({ MEDIA_RULES_JSON: JSON.stringify({ pdf: { linkedin: { maxPages: 2, maxBytes: 100 } } }) });
  const r = await checkPdf(await pdfWithPages(4), { rules, render: async () => null });
  assert.ok(codes(r).includes('PDF_TOO_MANY_PAGES'));
  assert.ok(codes(r).includes('PDF_TOO_HEAVY'));
});

test('pdf: mixed page sizes and landscape pages warn', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([1080, 1350]).drawText('a');
  pdf.addPage([1920, 1080]).drawText('b');
  pdf.addPage([1080, 1350]).drawText('c');
  const r = await checkPdf(Buffer.from(await pdf.save()), { render: async () => null });
  assert.ok(warnCodes(r).includes('PDF_MIXED_PAGE_SIZES'));
  assert.ok(warnCodes(r).includes('PDF_ORIENTATION'));
});

test('pdf: when a renderer exists, blank rendered pages are errors and render failures are reported', async () => {
  const pdf = await pdfWithPages(3);
  const white = await sharp({ create: { width: 50, height: 60, channels: 3, background: '#fff' } }).png().toBuffer();
  const busy = await sharp(Buffer.from(Array.from({ length: 50 * 60 * 3 }, (_, i) => (i * 37) % 255)), { raw: { width: 50, height: 60, channels: 3 } }).png().toBuffer();
  const blank = await checkPdf(pdf, { render: async () => [busy, white, busy] });
  assert.ok(codes(blank).includes('PDF_BLANK_PAGE'));
  assert.equal(blank.checks.render, 'passed');
  const partial = await checkPdf(pdf, { render: async () => [busy] });
  assert.ok(codes(partial).includes('PDF_RENDER_INCOMPLETE'));
  const failing = await checkPdf(pdf, { render: async () => { throw new Error('poppler crashed'); } });
  assert.ok(codes(failing).includes('PDF_RENDER_FAILED'));
  assert.equal(failing.checks.render, 'failed');
});

test('slides: word limits, markdown, CTA presence (English and Bengali)', () => {
  const slides = [
    { heading: 'Stop losing leads', body: 'A quick promise' },
    { heading: 'One idea', body: Array(43).join('word ').trim() },
    { heading: 'Another idea here', body: 'short body' },
    { heading: 'Takeaway', body: 'Comment "guide" and follow for more' },
  ];
  const r = checkSlides(slides);
  assert.equal(r.ok, true);
  assert.ok(warnCodes(r).includes('SLIDE_BODY_LONG'));
  assert.ok(!warnCodes(r).includes('SLIDE_CTA_MISSING'));
  const way = checkSlides([slides[0], { heading: 'x', body: Array(80).join('w ') }, slides[2], slides[3]]);
  assert.ok(codes(way).includes('SLIDE_BODY_LONG'));
  const noCta = [...slides.slice(0, 3), { heading: 'The end', body: 'Thanks for reading' }];
  assert.ok(warnCodes(checkSlides(noCta)).includes('SLIDE_CTA_MISSING'));
  assert.ok(codes(checkSlides(noCta, { strictCta: true })).includes('SLIDE_CTA_MISSING'));
  const bn = [...slides.slice(0, 3), { heading: 'শেষ কথা', body: 'আপনার মতামত কমেন্টে জানান' }];
  assert.ok(!warnCodes(checkSlides(bn)).includes('SLIDE_CTA_MISSING'));
  assert.ok(codes(checkSlides(slides.slice(0, 2))).includes('SLIDES_TOO_FEW'));
  assert.ok(warnCodes(checkSlides([{ heading: '**bold**', body: '' }, ...slides.slice(1)])).includes('SLIDE_MARKDOWN'));
  assert.equal(wordCount('  a  b c '), 3);
});

test('rendered slides: blank pages, wrong size and layout warnings are surfaced', async () => {
  const good = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: '#fff' } })
    .composite([{ input: await sharp({ create: { width: 400, height: 200, channels: 3, background: '#111' } }).png().toBuffer(), left: 100, top: 100 }])
    .jpeg().toBuffer();
  const blank = await jpegImage(1080, 1350, '#ffffff');
  const odd = await jpegImage(500, 500);
  const r = await checkRenderedSlides([good, blank, odd], { layoutWarnings: [{ code: 'TEXT_SHRUNK', message: 'Slide 2 text was shrunk to fit.' }] });
  assert.deepEqual(codes(r).sort(), ['SLIDE_BLANK', 'SLIDE_SIZE']);
  assert.match(r.errors.find((e) => e.code === 'SLIDE_BLANK').message, /2, 3/);
  assert.ok(warnCodes(r).includes('TEXT_SHRUNK'));
  const ok = await checkRenderedSlides([good], {});
  assert.equal(ok.ok, true);
});

async function withFile(buffer, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qc-test-'));
  const file = path.join(dir, 'v.mp4');
  await writeFile(file, buffer);
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('video: header inspection reads duration, size, codec, fps and audio; says it used no deep probe', async () => {
  await withFile(fakeMp4({ seconds: 20, width: 1080, height: 1920, fps: 30 }), async (file) => {
    const r = await checkVideo(file, { platform: 'instagram' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.info.seconds, 20);
    assert.equal(r.info.width, 1080);
    assert.equal(r.info.height, 1920);
    assert.equal(r.info.fps, 30);
    assert.equal(r.info.videoCodec, 'h264');
    assert.equal(r.info.audioCodec, 'aac'.length ? 'mp4a' : null);
    assert.equal(r.info.inspectedWith, 'mp4-header');
    assert.equal(r.checks.deep_probe, 'unavailable');
    assert.ok(r.humanReview.length >= 1);
  });
});

test('video: platform duration limits, missing audio, codecs and aspect', async () => {
  await withFile(fakeMp4({ seconds: 1.5 }), async (f) => assert.ok(codes(await checkVideo(f, { platform: 'instagram' })).includes('VIDEO_TOO_SHORT')));
  await withFile(fakeMp4({ seconds: 1000 }), async (f) => assert.ok(codes(await checkVideo(f, { platform: 'instagram' })).includes('VIDEO_TOO_LONG')));
  await withFile(fakeMp4({ seconds: 200 }), async (f) => assert.equal((await checkVideo(f, { platform: 'meta' })).ok, true));
  await withFile(fakeMp4({ audio: false }), async (f) => {
    assert.ok(warnCodes(await checkVideo(f, { platform: 'x' })).includes('VIDEO_SILENT'));
    assert.ok(codes(await checkVideo(f, { platform: 'x', requireAudio: true })).includes('VIDEO_NO_AUDIO'));
  });
  await withFile(fakeMp4({ codec: 'vp09' }), async (f) => assert.ok(codes(await checkVideo(f, { platform: 'instagram' })).includes('VIDEO_CODEC')));
  await withFile(fakeMp4({ width: 1920, height: 1080 }), async (f) => assert.ok(warnCodes(await checkVideo(f, { platform: 'instagram' })).includes('VIDEO_ASPECT_UNUSUAL')));
  const rules = loadRules({ MEDIA_RULES_JSON: JSON.stringify({ video: { instagram: { maxSeconds: 2000 } } }) });
  await withFile(fakeMp4({ seconds: 1000 }), async (f) => assert.equal((await checkVideo(f, { platform: 'instagram', rules })).ok, true));
});

test('video: truncated, non-MP4 and moov-less files are errors', async () => {
  await withFile(fakeMp4({ truncate: true }), async (f) => {
    const r = await checkVideo(f, { platform: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.checks.integrity === 'failed' || r.errors.length > 0, true);
  });
  await withFile(Buffer.from('this is definitely not a video file at all'), async (f) => assert.ok(codes(await checkVideo(f, { platform: 'x' })).includes('VIDEO_NOT_MP4')));
  const ftypOnly = fakeMp4().subarray(0, 32);
  await withFile(ftypOnly, async (f) => assert.equal((await checkVideo(f, { platform: 'x' })).ok, false));
});

test('video: ffprobe JSON is interpreted including rotation', () => {
  const info = interpretFfprobe({
    format: { size: '1000', duration: '12.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  });
  assert.equal(info.video.width, 1080);
  assert.equal(info.video.height, 1920);
  assert.ok(Math.abs(info.video.fps - 29.97) < 0.01);
  assert.equal(info.audio.codec, 'aac');
  assert.equal(info.durationSeconds, 12.5);
});

test('combineReports merges blocking errors and human-review notes', async () => {
  const img = await checkImage(await jpegImage(2000, 500), { platform: 'instagram' });
  const pdf = await checkPdf(await pdfWithPages(4), { render: async () => null });
  const c = combineReports([img, pdf, null]);
  assert.equal(c.ok, false);
  assert.ok(c.errors.every((e) => e.media));
  assert.ok(c.humanReview.length >= 2);
});
