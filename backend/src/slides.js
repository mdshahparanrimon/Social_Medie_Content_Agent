import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { httpError } from './errors.js';

// LinkedIn carousels are PDFs: each slide is drawn as an image (sharp renders text with Pango, so any script,
// Bengali included, is shaped correctly) and the slides become the pages of one PDF.

const W = 1080;
const H = 1350;
const PAD = 90;
const TEXT_W = W - 2 * PAD;
const DARK = '#0f172a';
// Named sans fonts first: a bare "sans-serif" can resolve to a serif or monospace font on Windows.
// Scripts these fonts lack (e.g. Bengali) fall back to a system font that has them (Nirmala UI, Noto Sans Bengali).
const FONT = 'Segoe UI,Noto Sans,DejaVu Sans,Arial,sans-serif';

export const DEFAULT_ACCENT = '#0a66c2';
export const MAX_PDF_PAGES = 300;

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const validAccent = (color) => (/^#[0-9a-f]{6}$/i.test(color || '') ? color.toLowerCase() : DEFAULT_ACCENT);

// Light accents get dark text on top, dark ones white text.
function onColor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? DARK : '#ffffff';
}

// Text wrapped to `width`, shrunk step by step until it fits in `maxHeight`.
async function textBlock(text, { size, color, bold = false, width = TEXT_W, maxHeight, align = 'left' }) {
  const markup = `<span foreground="${color}"${bold ? ' weight="bold"' : ''}>${escape(text)}</span>`;
  for (let pt = size; ; pt = Math.floor(pt * 0.9)) {
    const { data, info } = await sharp({ text: { text: markup, font: `${FONT} ${pt}`, width, dpi: 72, rgba: true, wrap: 'word', align, spacing: Math.round(pt * 0.25) } })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (!maxHeight || info.height <= maxHeight || pt <= 20) return { input: data, height: info.height, width: info.width };
  }
}

const rect = (x, y, w, h, fill) => ({
  input: Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`),
  left: x,
  top: y,
});

async function footer({ brand, page, total, color }) {
  const layers = [];
  if (brand) {
    const name = await textBlock(brand, { size: 28, color, bold: true, width: TEXT_W - 200 });
    layers.push({ input: name.input, left: PAD, top: H - PAD - name.height });
  }
  const count = await textBlock(`${page} / ${total}`, { size: 28, color, width: 200, align: 'right' });
  layers.push({ input: count.input, left: W - PAD - count.width, top: H - PAD - count.height });
  return layers;
}

async function draw(background, layers) {
  return sharp({ create: { width: W, height: H, channels: 3, background } }).composite(layers).jpeg({ quality: 88 }).toBuffer();
}

// Stacks blocks ({ input, height, gap }) and centers the stack vertically between `top` and `bottom`.
function stack(blocks, { top, bottom }) {
  const total = blocks.reduce((sum, b) => sum + b.height + (b.gap || 0), 0);
  let y = Math.max(top, Math.round(top + (bottom - top - total) / 2));
  return blocks.map((b) => {
    y += b.gap || 0;
    const layer = { input: b.input, left: PAD, top: y };
    y += b.height;
    return layer;
  });
}

const CONTENT_TOP = PAD + 40;
const CONTENT_BOTTOM = H - PAD - 120;

async function coverSlide({ slide, accent, brand, total }) {
  const fg = onColor(accent);
  const bar = { ...rect(0, 0, 120, 12, fg), height: 12 };
  const heading = await textBlock(slide.heading, { size: 100, color: fg, bold: true, maxHeight: 640 });
  const blocks = [bar, { ...heading, gap: 48 }];
  if (slide.body) blocks.push({ ...(await textBlock(slide.body, { size: 46, color: fg, maxHeight: 300 })), gap: 44 });
  const swipe = await textBlock('Swipe →', { size: 36, color: fg, bold: true, width: 400 });
  const layers = [...stack(blocks, { top: CONTENT_TOP, bottom: CONTENT_BOTTOM }), { input: swipe.input, left: W - PAD - swipe.width, top: H - PAD - swipe.height - 70 }];
  return draw(accent, [...layers, ...(await footer({ brand, page: 1, total, color: fg }))]);
}

async function contentSlide({ slide, accent, brand, page, total }) {
  const number = await textBlock(String(page - 1).padStart(2, '0'), { size: 130, color: accent, bold: true, width: 400 });
  const heading = await textBlock(slide.heading, { size: 72, color: DARK, bold: true, maxHeight: 400 });
  const blocks = [number, { ...heading, gap: 24 }];
  if (slide.body) {
    const room = CONTENT_BOTTOM - CONTENT_TOP - number.height - heading.height - 80;
    blocks.push({ ...(await textBlock(slide.body, { size: 48, color: '#334155', maxHeight: room })), gap: 44 });
  }
  const layers = [rect(0, 0, W, 16, accent), ...stack(blocks, { top: CONTENT_TOP, bottom: CONTENT_BOTTOM })];
  return draw('#ffffff', [...layers, ...(await footer({ brand, page, total, color: '#64748b' }))]);
}

async function closingSlide({ slide, accent, brand, page, total }) {
  const bar = { ...rect(0, 0, 120, 12, accent), height: 12 };
  const heading = await textBlock(slide.heading, { size: 84, color: '#ffffff', bold: true, maxHeight: 560 });
  const blocks = [bar, { ...heading, gap: 48 }];
  if (slide.body) blocks.push({ ...(await textBlock(slide.body, { size: 46, color: '#cbd5e1', maxHeight: 380 })), gap: 44 });
  const layers = [rect(0, 0, W, 16, accent), ...stack(blocks, { top: CONTENT_TOP, bottom: CONTENT_BOTTOM })];
  return draw(DARK, [...layers, ...(await footer({ brand, page, total, color: '#94a3b8' }))]);
}

// slides: [{ heading, body }], the first is the cover and the last the closing slide. One JPEG per slide.
export async function renderSlides({ slides, accent, brand }) {
  const color = validAccent(accent);
  const total = slides.length;
  const images = [];
  for (const [i, slide] of slides.entries()) {
    const args = { slide, accent: color, brand, page: i + 1, total };
    images.push(await (i === 0 ? coverSlide(args) : i === total - 1 ? closingSlide(args) : contentSlide(args)));
  }
  return images;
}

// The slides as the pages of one PDF. Returns the PDF bytes.
export async function renderCarousel({ title, slides, accent, brand }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  if (brand) pdf.setAuthor(brand);
  for (const jpeg of await renderSlides({ slides, accent, brand })) {
    const image = await pdf.embedJpg(jpeg);
    pdf.addPage([W, H]).drawImage(image, { x: 0, y: 0, width: W, height: H });
  }
  return Buffer.from(await pdf.save());
}

// Checks an uploaded file is a readable PDF that LinkedIn takes; returns its page count.
export async function pdfPageCount(buffer) {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, 'That file is not a PDF.');
  let pages;
  try {
    pages = (await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
  } catch {
    throw httpError(400, 'That PDF could not be read. Export it again and upload the new file.');
  }
  if (pages < 1) throw httpError(400, 'That PDF has no pages.');
  if (pages > MAX_PDF_PAGES) throw httpError(400, `That PDF has ${pages} pages; LinkedIn takes at most ${MAX_PDF_PAGES}.`);
  return pages;
}
