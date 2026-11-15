import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import zlib from 'node:zlib';
import { AppError } from '../src/errors.js';
import { parseSafeUrl, safeGet } from '../src/net/safeFetch.js';
import { TMP_DIR, parseConfirmationForm, parseDriveUrl, safeFilename, sniffType, withDownload } from '../src/mediaIngest.js';
import { startServer, testing } from './mockServer.js';
import { pngBuffer } from './fixtures.js';

const code = (p) =>
  p.then(
    () => assert.fail('expected a rejection'),
    (e) => {
      assert.ok(e instanceof AppError, `AppError expected, got ${e}`);
      return e.code;
    },
  );
const tmpFiles = async () => (await readdir(TMP_DIR).catch(() => [])).filter((n) => n.endsWith('.part'));
const ID = '1AbCdEfGhIjKlMnOpQrStUv';

test('Drive URL parsing: share, open, uc, docs and slides links', () => {
  assert.equal(parseDriveUrl(`https://drive.google.com/file/d/${ID}/view?usp=sharing`).id, ID);
  assert.equal(parseDriveUrl(`https://drive.google.com/open?id=${ID}`).id, ID);
  assert.equal(parseDriveUrl(`https://drive.google.com/uc?export=download&id=${ID}`).id, ID);
  assert.equal(parseDriveUrl(`https://docs.google.com/presentation/d/${ID}/edit`).kind, 'slides');
  assert.equal(parseDriveUrl(`https://drive.usercontent.google.com/download?id=${ID}`).id, ID);
  assert.equal(parseDriveUrl('https://example.com/file.png'), null);
});

test('Drive URL parsing rejects folders, missing or odd ids and look-alike hosts', () => {
  assert.throws(() => parseDriveUrl(`https://drive.google.com/drive/folders/${ID}`), { code: 'DRIVE_FOLDER' });
  assert.throws(() => parseDriveUrl('https://drive.google.com/file/d/short/view'), { code: 'INVALID_URL' });
  assert.throws(() => parseDriveUrl('https://drive.google.com/open'), { code: 'INVALID_URL' });
  assert.equal(parseDriveUrl(`https://drive.google.com.evil.com/file/d/${ID}/view`), null);
  assert.equal(parseDriveUrl(`https://evil.com/?u=drive.google.com/file/d/${ID}`), null);
});

test('URL validation: scheme, credentials, malformed input, allowlist', () => {
  for (const bad of ['', 'not a url', 'ftp://example.com/a.png', 'file:///etc/passwd', 'http://example.com/a.png', 'javascript:alert(1)', 'https://user:pw@example.com/a.png', 'https://']) {
    assert.throws(() => parseSafeUrl(bad), (e) => e.code === 'INVALID_URL', bad);
  }
  assert.throws(() => parseSafeUrl('https://evil.com/a', { allowedHosts: ['good.com'] }), { code: 'HOST_NOT_ALLOWED' });
  assert.throws(() => parseSafeUrl('https://notgood.com/a', { allowedHosts: ['good.com'] }), { code: 'HOST_NOT_ALLOWED' });
  assert.ok(parseSafeUrl('https://cdn.good.com/a', { allowedHosts: ['good.com'] }));
});

test('confirmation form of the Drive virus-scan page is parsed', () => {
  const html =
    '<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="abc"><input type="hidden" name="uuid" value="u-1"><input type="hidden" name="confirm" value="t"></form>';
  const next = new URL(parseConfirmationForm(html));
  assert.equal(next.hostname, 'drive.usercontent.google.com');
  assert.equal(next.searchParams.get('uuid'), 'u-1');
  assert.equal(parseConfirmationForm('<html>nothing</html>'), null);
});

test('safeFilename strips paths, extensions and control characters', () => {
  assert.equal(safeFilename('attachment; filename="../../etc/pa<ss>wd.png"'), 'passwd');
  assert.equal(safeFilename("attachment; filename*=UTF-8''My%20Slides.pdf"), 'My Slides');
  assert.equal(safeFilename(''), '');
});

test('signature sniffing ignores extensions and recognises formats', () => {
  assert.equal(sniffType(pngBuffer()).format, 'png');
  assert.equal(sniffType(Buffer.from('%PDF-1.7\n%....')).format, 'pdf');
  assert.equal(sniffType(Buffer.from('<!DOCTYPE html><html></html>')).kind, 'html');
  assert.equal(sniffType(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(8)])).format, 'mp4');
  assert.equal(sniffType(Buffer.alloc(20)), null);
});

test('safeGet blocks redirects to localhost, private IPs, metadata; DNS answers that are private', async () => {
  const srv = await startServer((req, res) => {
    const map = {
      '/lo': 'http://127.0.0.1:1/x',
      '/meta': 'http://169.254.169.254/latest/meta-data/',
      '/v6': 'http://[::1]:1/x',
      '/mapped': 'http://[::ffff:127.0.0.1]:1/x',
      '/dns': 'http://internal.test/x',
      '/mixed': 'http://mixed.test/x',
      '/ftp': 'ftp://example.com/x',
    };
    res.writeHead(302, { Location: map[req.url] });
    res.end();
  });
  try {
    for (const p of ['/lo', '/meta', '/v6', '/mapped', '/dns', '/mixed']) {
      assert.equal(await code(safeGet(srv.url(p), { testing: testing() })), 'BLOCKED_ADDRESS', p);
    }
    assert.equal(await code(safeGet(srv.url('/ftp'), { testing: testing() })), 'INVALID_URL');
    assert.equal(await code(safeGet('http://v6.test/', { testing: testing() })), 'BLOCKED_ADDRESS');
    assert.equal(await code(safeGet('https://127.0.0.1/', {})), 'BLOCKED_ADDRESS');
    assert.equal(await code(safeGet('https://localhost/', {})), 'BLOCKED_ADDRESS');
    assert.equal(await code(safeGet('https://[::1]/', {})), 'BLOCKED_ADDRESS');
  } finally {
    await srv.close();
  }
});

test('safeGet follows safe redirects and detects loops and redirect floods', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/a') {
      res.writeHead(302, { Location: '/b' });
      return res.end();
    }
    if (req.url === '/b') {
      res.writeHead(302, { Location: '/a' });
      return res.end();
    }
    if (req.url.startsWith('/n')) {
      res.writeHead(302, { Location: `/n${Number(req.url.slice(2)) + 1}` });
      return res.end();
    }
    res.end('ok');
  });
  try {
    assert.equal(await code(safeGet(srv.url('/a'), { testing: testing() })), 'REDIRECT_LOOP');
    assert.equal(await code(safeGet(srv.url('/n0'), { testing: testing(), maxRedirects: 3 })), 'TOO_MANY_REDIRECTS');
    const { response } = await safeGet(srv.url('/ok'), { testing: testing() });
    response.resume();
    assert.equal(response.statusCode, 200);
  } finally {
    await srv.close();
  }
});

test('safeGet resolves once and connects to the validated address (no second lookup)', async () => {
  let lookups = 0;
  const srv = await startServer((req, res) => res.end('pinned'));
  try {
    const t = testing({
      resolve: async () => {
        lookups++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    const { response } = await safeGet(srv.url('/'), { testing: t });
    response.resume();
    assert.equal(lookups, 1);
  } finally {
    await srv.close();
  }
});

test('safeGet drops request headers (e.g. Authorization) when a redirect leaves the original host', async () => {
  let seen = 'unset';
  const target = await startServer((req, res) => {
    seen = req.headers.authorization ?? null;
    res.end('x');
  });
  const origin = await startServer((req, res) => {
    res.writeHead(302, { Location: `http://mock.test:${target.port}/` });
    res.end();
  });
  try {
    const { response } = await safeGet(origin.url('/'), { headers: { Authorization: 'Bearer secret' }, testing: testing() });
    response.resume();
    assert.equal(seen, null); // different port = different host
  } finally {
    await origin.close();
    await target.close();
  }
});

test('download: valid PNG is stored in a temp file, hashed and cleaned up', async () => {
  const png = pngBuffer();
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="pic.png"' });
    res.end(png);
  });
  try {
    const sha = await withDownload(srv.url('/pic'), { kind: 'image', maxBytes: 1e6, testing: testing() }, async (file) => {
      assert.equal(file.type.format, 'png');
      assert.equal(file.filename, 'pic');
      assert.equal((await file.readBuffer()).equals(png), true);
      assert.equal((await tmpFiles()).length, 1);
      return file.sha256;
    });
    assert.match(sha, /^[0-9a-f]{64}$/);
    assert.equal((await tmpFiles()).length, 0);
  } finally {
    await srv.close();
  }
});

test('download: HTML error pages, wrong formats and HTTP errors map to clear codes', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>Sorry</html>');
    }
    if (req.url === '/sneaky') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end('<!DOCTYPE html><html><body>nope</body></html>');
    }
    if (req.url === '/pdf') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(Buffer.from('%PDF-1.4\n%abcdefgh'));
    }
    if (req.url === '/empty') {
      res.writeHead(200);
      return res.end();
    }
    const status = { '/gone': 410, '/missing': 404, '/denied': 403, '/limit': 429 }[req.url] || 500;
    res.writeHead(status);
    res.end();
  });
  const get = (p) => withDownload(srv.url(p), { kind: 'image', maxBytes: 1e6, testing: testing() }, async () => 'unreachable');
  try {
    assert.equal(await code(get('/html')), 'HTML_RESPONSE');
    assert.equal(await code(get('/sneaky')), 'HTML_RESPONSE');
    assert.equal(await code(get('/pdf')), 'UNSUPPORTED_FORMAT');
    assert.equal(await code(get('/empty')), 'EMPTY_FILE');
    assert.equal(await code(get('/gone')), 'LINK_EXPIRED');
    assert.equal(await code(get('/missing')), 'NOT_FOUND');
    assert.equal(await code(get('/denied')), 'ACCESS_DENIED');
    assert.equal(await code(get('/limit')), 'RATE_LIMITED');
    assert.equal(await code(get('/other')), 'UPSTREAM_ERROR');
    assert.equal((await tmpFiles()).length, 0);
  } finally {
    await srv.close();
  }
});

test('download: oversized responses are cut off, including chunked ones without Content-Length', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/declared') {
      res.writeHead(200, { 'Content-Length': 5_000_000 });
      return res.end(Buffer.alloc(10));
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); // chunked
    res.write(pngBuffer());
    const timer = setInterval(() => res.write(Buffer.alloc(65536)), 1);
    res.on('close', () => clearInterval(timer));
  });
  const get = (p) => withDownload(srv.url(p), { kind: 'image', maxBytes: 200_000, testing: testing() }, async () => 'unreachable');
  try {
    assert.equal(await code(get('/declared')), 'TOO_LARGE');
    assert.equal(await code(get('/chunked')), 'TOO_LARGE');
    assert.equal((await tmpFiles()).length, 0);
  } finally {
    await srv.close();
  }
});

test('download: a stalled response times out and leaves no temp file', async () => {
  process.env.MEDIA_REQUEST_TIMEOUT_MS = '300';
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(pngBuffer()); // then stalls forever
  });
  try {
    const started = Date.now();
    const c = await code(withDownload(srv.url('/slow'), { kind: 'image', maxBytes: 1e6, testing: testing() }, async () => 'x'));
    assert.ok(['TIMEOUT', 'UNREACHABLE', 'INCOMPLETE'].includes(c), c);
    assert.ok(Date.now() - started < 8000);
    assert.equal((await tmpFiles()).length, 0);
  } finally {
    delete process.env.MEDIA_REQUEST_TIMEOUT_MS;
    await srv.close();
  }
});

test('download: a server that never answers times out', async () => {
  process.env.MEDIA_REQUEST_TIMEOUT_MS = '300';
  const srv = await startServer(() => {});
  try {
    assert.equal(await code(withDownload(srv.url('/hang'), { kind: 'image', maxBytes: 1e6, testing: testing() }, async () => 'x')), 'TIMEOUT');
  } finally {
    delete process.env.MEDIA_REQUEST_TIMEOUT_MS;
    await srv.close();
  }
});

test('download: cancelling mid-transfer aborts and cleans up', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(pngBuffer());
    const t = setInterval(() => res.write(Buffer.alloc(1024)), 5);
    res.on('close', () => clearInterval(t));
  });
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 150);
    const c = await code(withDownload(srv.url('/x'), { kind: 'image', maxBytes: 1e9, signal: ctl.signal, testing: testing() }, async () => 'x'));
    assert.ok(['CANCELLED', 'UNREACHABLE', 'INCOMPLETE'].includes(c), c);
    assert.equal((await tmpFiles()).length, 0);
  } finally {
    await srv.close();
  }
});

test('download: the temp file is removed when the caller throws', async () => {
  const srv = await startServer((req, res) => res.end(pngBuffer()));
  try {
    await assert.rejects(
      withDownload(srv.url('/p'), { kind: 'image', maxBytes: 1e6, testing: testing() }, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal((await tmpFiles()).length, 0);
  } finally {
    await srv.close();
  }
});

test('download: Drive confirmation page is followed and the file arrives', async () => {
  const png = pngBuffer();
  const srv = await startServer((req, res) => {
    if (req.url.includes('uuid=')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(png);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<form id="download-form" action="http://mock.test:${srv.port}/download" method="get"><input type="hidden" name="id" value="${ID}"><input type="hidden" name="uuid" value="u1"></form>`);
  });
  try {
    const sha = await withDownload(`https://drive.google.com/file/d/${ID}/view`, { kind: 'image', maxBytes: 1e6, testing: testing({ driveBase: `http://mock.test:${srv.port}` }) }, async (f) => f.sha256);
    assert.match(sha, /^[0-9a-f]{64}$/);
    assert.equal(srv.hits.length, 2);
  } finally {
    await srv.close();
  }
});

test('download: a Drive sign-in page is reported as access denied', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><a href="https://accounts.google.com/ServiceLogin">Sign in</a></html>');
  });
  try {
    const c = await code(
      withDownload(`https://drive.google.com/file/d/${ID}/view`, { kind: 'image', maxBytes: 1e6, testing: testing({ driveBase: `http://mock.test:${srv.port}` }) }, async () => 'x'),
    );
    assert.equal(c, 'ACCESS_DENIED');
  } finally {
    await srv.close();
  }
});

test('download: garbage with an image extension is unsupported and never kept', async () => {
  const srv = await startServer((req, res) => res.end(zlib.gzipSync(Buffer.from('not an image at all, just text'))));
  try {
    assert.equal(await code(withDownload(srv.url('/fake.jpg'), { kind: 'image', maxBytes: 1e6, testing: testing() }, async () => 'x')), 'UNSUPPORTED_FORMAT');
    assert.equal((await tmpFiles()).length, 0);
  } finally {
    await srv.close();
  }
});
