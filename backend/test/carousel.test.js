import './env.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument, PDFRawStream } from 'pdf-lib';
import { repo } from '../src/db/index.js';
import { renderCarousel } from '../src/slides.js';
import { createPostCarousel } from '../src/agents/carousel.js';
import { checkPdf } from '../src/mediaQc.js';
import { freshDatabase, inWorkspace, seedBrand } from './harness.js';

beforeEach(() => freshDatabase());

// All page-content text of a PDF (hex-encoded show-text strings), found by decoding every stream.
async function contentHex(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes);
  let all = '';
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let bytes = obj.contents;
    try {
      bytes = zlib.inflateSync(bytes);
    } catch {
      /* not compressed */
    }
    const text = Buffer.from(bytes).toString('latin1');
    if (text.includes(' Tj') || text.includes('Tj')) all += text;
  }
  return all;
}
const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

const SLIDES = [
  { heading: 'Stop losing leads', body: 'Three fixes you can make this week' },
  { heading: 'Answer within an hour', body: 'Replies inside 60 minutes win far more conversations than next-day ones.' },
  { heading: 'Write one clear offer', body: 'Say who it is for and what happens next.' },
  { heading: 'Follow up twice', body: 'A short reminder after three days is polite and effective.' },
  { heading: 'Try one this week', body: 'Pick a fix, then comment which one you will test.' },
];

test('a rendered carousel is a valid PDF with correct page size, language and a hidden text layer for Latin text', async () => {
  const out = await renderCarousel({ title: 'Lead fixes', slides: SLIDES, accent: '#0a66c2', brand: 'Acme', lang: 'en' });
  assert.equal(out.images.length, 5);
  assert.deepEqual(out.searchablePages, [1, 2, 3, 4, 5]);
  assert.deepEqual(out.unsearchablePages, []);
  const doc = await PDFDocument.load(out.pdf);
  assert.equal(doc.getPageCount(), 5);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 1080, height: 1350 });
  assert.equal(doc.getTitle(), 'Lead fixes');
  const content = await contentHex(out.pdf);
  assert.ok(content.toUpperCase().includes(hex('Answer within an hour')), 'the slide text is in the PDF text layer');
  assert.ok(content.includes('Tj'));
  const qc = await checkPdf(out.pdf, { platform: 'linkedin', render: async () => null });
  assert.equal(qc.ok, true, JSON.stringify(qc.errors));
  assert.equal(qc.info.pages, 5);
});

test('text that does not fit is reported instead of silently overflowing', async () => {
  const slides = [...SLIDES];
  slides[1] = { heading: 'Heading '.repeat(9).trim(), body: 'word '.repeat(200).trim() };
  const out = await renderCarousel({ title: 't', slides, accent: '#0a66c2' });
  assert.ok(out.layoutWarnings.some((w) => /^Slide 2: /.test(w.message) && /TEXT_/.test(w.code)), JSON.stringify(out.layoutWarnings));
});

test('Bengali text renders, but is image-only (no searchable layer) and the font situation is reported honestly', () =>
  inWorkspace(async () => {
    await seedBrand({ language: 'Bengali' });
    const post = await repo.createPost({ platform: 'linkedin', content: 'ক্যারোসেল', brief: 'b' });
    const bn = [
      { heading: 'ব্র্যান্ডের তিনটি শব্দ', body: 'আপনার ব্র্যান্ড কেমন অনুভূতি দেয় তা লিখে রাখুন।' },
      { heading: 'প্রথম ধাপ', body: 'তিনটি বিশেষণ বেছে নিন।' },
      { heading: 'দ্বিতীয় ধাপ', body: 'একটি জিনিস লিখুন যা আপনি কখনোই হবেন না।' },
      { heading: 'শেষ কথা', body: 'আপনার তিনটি শব্দ কমেন্টে জানান।' },
    ];
    const updated = await createPostCarousel(post.id, { slides: bn, title: 'ব্র্যান্ড', accent: '#0a66c2' });
    const qc = updated.media_qc.pdf.report;
    assert.equal(qc.ok, true, JSON.stringify(qc.errors));
    assert.deepEqual(qc.info.imageOnlyPages, [1, 2, 3, 4]);
    assert.ok(qc.warnings.some((w) => w.code === 'PDF_IMAGE_ONLY'));
    assert.ok(['ok', 'missing', 'unknown'].includes(qc.info.fonts.status));
    assert.equal(qc.info.fonts.script, 'Bengali');
    if (qc.info.fonts.status !== 'ok') assert.ok(qc.warnings.some((w) => w.code === 'FONT_UNVERIFIED'));
  }));

test('carousel creation: valid slides are attached with their QC; invalid ones are refused with what to change and nothing is stored', () =>
  inWorkspace(async () => {
    await seedBrand();
    const post = await repo.createPost({ platform: 'linkedin', content: 'Caption', brief: 'b' });
    const ok = await createPostCarousel(post.id, { slides: SLIDES, title: 'Lead fixes', accent: '#0a66c2' });
    assert.equal(ok.document_pages, 5);
    assert.equal(ok.media_qc.pdf.report.ok, true);
    assert.equal(ok.media_qc.pdf.url, ok.document_url);
    assert.ok(ok.media_qc.pdf.report.checks.text_limits);
    assert.deepEqual(ok.media_qc.pdf.report.info.searchablePages, [1, 2, 3, 4, 5]);
    const assetsBefore = repo._assets.length;

    const tooLong = [{ heading: 'Hook', body: 'x' }, { heading: 'Idea', body: Array(80).join('word ') }, { heading: 'Idea two', body: 'ok' }, { heading: 'End', body: 'Comment below' }];
    await assert.rejects(createPostCarousel(post.id, { slides: tooLong }), (e) => e.code === 'SLIDES_INVALID' && /Slide 2/.test(e.message));
    await assert.rejects(createPostCarousel(post.id, { slides: SLIDES.slice(0, 2) }), /at least 3 slides/);
    assert.equal(repo._assets.length, assetsBefore);
    assert.equal((await repo.getPost(post.id)).document_url, ok.document_url, 'the earlier carousel is untouched');

    const other = await repo.createPost({ platform: 'x', content: 'x', brief: 'b' });
    await assert.rejects(createPostCarousel(other.id, { slides: SLIDES }), /can't carry a PDF/);
  }));
