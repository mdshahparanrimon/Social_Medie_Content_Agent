import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Minimal valid PNG (1x1).
export function pngBuffer() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
}

export const jpegImage = (width, height, color = '#3366cc') =>
  sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();

export const pngImage = (width, height, color = '#3366cc') =>
  sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

export async function pdfWithPages(count, { width = 1080, height = 1350, text = 'Hello' } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const page = pdf.addPage([width, height]);
    if (text) page.drawText(`${text} ${i + 1}`, { x: 50, y: height - 100, size: 40, font });
  }
  return Buffer.from(await pdf.save());
}

// A synthetic MP4: just enough boxes (ftyp, moov/mvhd/trak/tkhd/mdia/hdlr/stsd) for the header parser. Not playable.
const box = (type, ...payload) => {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

const IDENTITY = Buffer.concat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32));

export function fakeMp4({ seconds = 10, width = 1080, height = 1920, audio = true, codec = 'avc1', fps = 30, truncate = false } = {}) {
  const timescale = 1000;
  const mvhd = box('mvhd', Buffer.alloc(4), u32(0), u32(0), u32(timescale), u32(Math.round(seconds * timescale)), Buffer.alloc(80));
  // tkhd v0: version/flags(4) created(4) modified(4) track_id(4) reserved(4) duration(4) reserved(8) layer/alt/vol/res(8) matrix(36) width(4) height(4)
  const tkhd = (w, h) =>
    box('tkhd', Buffer.from([0, 0, 0, 3]), Buffer.alloc(8), u32(1), Buffer.alloc(4), u32(0), Buffer.alloc(8), Buffer.alloc(8), IDENTITY, u32(w << 16), u32(h << 16));
  const trak = (handler, w, h, fourcc) =>
    box(
      'trak',
      tkhd(w, h),
      box('mdia', box('mdhd', Buffer.alloc(4), u32(0), u32(0), u32(1000), u32(Math.round(seconds * 1000)), Buffer.alloc(4)), box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(12)), box('minf', box('stbl', box('stsd', Buffer.alloc(4), u32(1), box(fourcc, Buffer.alloc(8))), box('stsz', Buffer.alloc(4), u32(0), u32(Math.round(seconds * fps)))))),
    );
  const moov = box('moov', mvhd, trak('vide', width, height, codec), ...(audio ? [trak('soun', 0, 0, 'mp4a')] : []));
  const file = Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2avc1mp41', 'latin1')), moov, box('mdat', Buffer.alloc(64))]);
  return truncate ? file.subarray(0, file.length - 40) : file;
}
