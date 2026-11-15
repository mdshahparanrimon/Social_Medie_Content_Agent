import './env.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repo } from '../src/db/index.js';
import { UPLOAD_DIR, importDocument, importImage, importVideo, localPathForUrl, releaseMedia, storageStatus, storeDocument, storeImage, sweepOrphanAssets, checkAndStoreUploadedDocument } from '../src/media.js';
import { deletePostAndMedia, removePostMedia, setPostDocument, setPostImage } from '../src/posts.js';
import { runInWorkspace } from '../src/context.js';
import { freshDatabase, inWorkspace, logs, seedBrand, WS } from './harness.js';
import { startServer, testing } from './mockServer.js';
import { fakeMp4, jpegImage, pdfWithPages, pngImage } from './fixtures.js';

beforeEach(() => freshDatabase());

const dataUrl = async (w = 800, h = 800) => `data:image/jpeg;base64,${(await jpegImage(w, h)).toString('base64')}`;
const fileOf = (url) => localPathForUrl(url);

test('local files go to a per-workspace folder with random names; assets record the owner and hash', () =>
  inWorkspace(async () => {
    const url = await storeImage(await dataUrl());
    assert.match(url, new RegExp(`^http://localhost:4000/media/${WS}/[0-9a-f]{32}\\.jpg$`));
    assert.ok(existsSync(fileOf(url)));
    assert.ok(path.resolve(fileOf(url)).startsWith(path.resolve(UPLOAD_DIR, WS)));
    const asset = await repo.findAsset({ url });
    assert.equal(asset.workspace_id, WS);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.equal(asset.provider, 'local');
  }));

test('identical content is stored once per workspace and never shared across workspaces', async () => {
  const data = await dataUrl();
  let a1, a2, b1;
  await inWorkspace(async () => {
    a1 = await storeImage(data);
    a2 = await storeImage(data);
  });
  await runInWorkspace('ws-two', async () => {
    b1 = await storeImage(data);
  });
  assert.equal(a1, a2);
  assert.notEqual(a1, b1);
  assert.equal(repo._assets.filter((a) => a.workspace_id === WS).length, 1);
  assert.ok(b1.includes('/ws-two/'));
  // The other workspace can't find the first workspace's asset record.
  await runInWorkspace('ws-two', async () => assert.equal(await repo.findAsset({ url: a1 }), null));
});

test('a stored file that vanished from disk is stored again instead of linking to nothing', () =>
  inWorkspace(async () => {
    const data = await dataUrl();
    const url = await storeImage(data);
    const { rm } = await import('node:fs/promises');
    await rm(fileOf(url));
    const again = await storeImage(data);
    assert.ok(existsSync(fileOf(again)));
  }));

test('only well-formed /media links of this server map to files; traversal attempts do not', () => {
  assert.equal(localPathForUrl('http://localhost:4000/media/../../etc/passwd'), null);
  assert.equal(localPathForUrl('http://localhost:4000/media/ws/..%2F..%2Fx'), null);
  assert.equal(localPathForUrl('http://localhost:4000/media/a/b/c.jpg'), null);
  assert.equal(localPathForUrl('http://localhost:4000/media/.hidden'), null);
  assert.equal(localPathForUrl('https://evil.com/media/x.jpg'), null);
  assert.ok(localPathForUrl('http://localhost:4000/media/ws/abc.jpg').startsWith(path.resolve(UPLOAD_DIR)));
  assert.ok(localPathForUrl('http://localhost:4000/media/legacyflat.jpg')); // files uploaded before per-workspace folders
});

test('in production, ephemeral local storage is refused unless explicitly allowed', () =>
  inWorkspace(async () => {
    const before = { env: process.env.NODE_ENV, allow: process.env.ALLOW_LOCAL_STORAGE };
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_LOCAL_STORAGE;
    try {
      assert.equal(storageStatus({}).durable, false);
      await assert.rejects(storeDocument(await pdfWithPages(3)), { code: 'STORAGE_NOT_DURABLE', status: 503 });
      assert.equal(repo._assets.length, 0);
      process.env.ALLOW_LOCAL_STORAGE = 'true';
      assert.equal(storageStatus({}).durable, true);
      assert.ok(await storeDocument(await pdfWithPages(3)));
      assert.equal(storageStatus({ cloudinary_cloud_name: 'c', cloudinary_api_key: 'k', cloudinary_api_secret: 's' }).provider, 'cloudinary');
      delete process.env.ALLOW_LOCAL_STORAGE;
      assert.equal(storageStatus({ cloudinary_cloud_name: 'c', cloudinary_api_key: 'k', cloudinary_api_secret: 's' }).durable, true);
    } finally {
      process.env.NODE_ENV = before.env;
      if (before.allow === undefined) delete process.env.ALLOW_LOCAL_STORAGE;
      else process.env.ALLOW_LOCAL_STORAGE = before.allow;
    }
  }));

test('storage failures become a clear error, a log line and an audit event, and nothing is recorded', async () => {
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, 'ws-broken'), 'a file where the workspace folder should be');
  await runInWorkspace('ws-broken', async () => {
    await assert.rejects(storeImage(await dataUrl()), { code: 'STORAGE_FAILED', status: 502 });
    assert.equal(repo._assets.length, 0);
    assert.ok(logs.some((l) => l.event === 'storage.failed'));
    assert.ok((await repo.listAudit()).some((e) => e.type === 'storage.failed'));
  });
});

test('upload checks: a non-JPEG disguised as a data URL, and a PDF upload that is corrupt, are rejected before storing', () =>
  inWorkspace(async () => {
    await assert.rejects(storeImage('data:image/jpeg;base64,' + Buffer.from('not a jpeg at all, plain text').toString('base64')), { code: 'UNSUPPORTED_FORMAT' });
    await assert.rejects(storeImage('data:image/png;base64,AAAA'), { code: 'UNSUPPORTED_FORMAT' });
    await assert.rejects(checkAndStoreUploadedDocument(Buffer.from('%PDF-1.7\ngarbage garbage garbage')), { code: 'MEDIA_INVALID' });
    assert.equal(repo._assets.length, 0);
  }));

test('replacing or removing media deletes the old file once nothing uses it; shared files stay until the last user is gone', () =>
  inWorkspace(async () => {
    await seedBrand();
    const p1 = await repo.createPost({ platform: 'linkedin', content: 'one', brief: 'b' });
    const p2 = await repo.createPost({ platform: 'linkedin', content: 'two', brief: 'b' });
    const data = await dataUrl(900, 900);
    const shared = await storeImage(data);
    await setPostImage(p1.id, shared);
    await setPostImage(p2.id, shared);

    const other = await storeImage(await dataUrl(700, 700));
    await setPostImage(p1.id, other); // p1 stops using the shared file, p2 still does
    assert.ok(existsSync(fileOf(shared)), 'still used by the second post');
    assert.ok(!existsSync(fileOf(other)) === false);

    const fresh = await storeImage(await dataUrl(650, 650));
    await setPostImage(p2.id, fresh); // the last user lets go
    assert.ok(!existsSync(fileOf(shared)), 'deleted once unused');
    assert.equal(await repo.findAsset({ url: shared }), null);

    await removePostMedia(await repo.getPost(p1.id), 'image', ['draft']);
    assert.ok(!existsSync(fileOf(other)));
    await deletePostAndMedia(await repo.getPost(p2.id));
    assert.ok(!existsSync(fileOf(fresh)));
    assert.equal(repo._assets.length, 0);
  }));

test('release failures are reported, not swallowed', () =>
  inWorkspace(async () => {
    const url = await storeImage(await dataUrl(500, 500));
    const asset = repo._assets[0];
    asset.provider = 'cloudinary'; // pretend it lives there; no Cloudinary is configured, so the delete must fail loudly
    asset.ref = JSON.stringify({ resource: 'image', public_id: 'x' });
    const result = await releaseMedia(url);
    assert.equal(result.released, false);
    assert.equal(result.reason, 'error');
    assert.ok(logs.some((l) => l.event === 'storage.release_failed'));
    assert.ok(repo._assets.length === 1, 'the record stays so the sweep can retry');
  }));

test('orphan sweep removes old unreferenced files and keeps referenced and recent ones', () =>
  inWorkspace(async () => {
    const used = await storeImage(await dataUrl(610, 610));
    const orphan = await storeImage(await dataUrl(620, 620));
    const recent = await storeImage(await dataUrl(630, 630));
    const post = await repo.createPost({ platform: 'linkedin', content: 'x', brief: 'b' });
    await repo.updatePost(post.id, { image_url: used });
    const old = new Date(Date.now() - 3 * 86400_000).toISOString();
    for (const a of repo._assets) if (a.url !== recent) a.created_at = old;
    assert.equal(await sweepOrphanAssets(), 1);
    assert.ok(existsSync(fileOf(used)));
    assert.ok(!existsSync(fileOf(orphan)));
    assert.ok(existsSync(fileOf(recent)));
  }));

// ---- Importing from a link ----

test('image import: converts to a platform-ready JPEG, keeps the original, reports the crop, and detects the duplicate', () =>
  inWorkspace(async () => {
    const wide = await pngImage(2000, 500, '#2255aa');
    const srv = await startServer((req, res) => res.end(wide));
    try {
      const first = await importImage(srv.url('/wide.png'), { platform: 'instagram', altText: 'A blue banner', testing: testing() });
      assert.equal(first.duplicate, false);
      assert.equal(first.cropped, true);
      assert.ok(first.qc.warnings.some((w) => w.code === 'IMAGE_CROPPED'));
      assert.ok(first.qc.humanReview.some((m) => /cropped/.test(m)));
      assert.equal(first.qc.ok, true);
      const kinds = repo._assets.map((a) => a.kind).sort();
      assert.deepEqual(kinds, ['image', 'original']);
      const derivative = repo._assets.find((a) => a.kind === 'image');
      const original = repo._assets.find((a) => a.kind === 'original');
      assert.equal(derivative.original_url, original.url);
      assert.match(original.url, /\.png$/);
      assert.match(derivative.url, /\.jpg$/);

      const again = await importImage(srv.url('/wide-again.png'), { platform: 'instagram', testing: testing() });
      assert.equal(again.duplicate, true);
      assert.equal(again.url, first.url);
      assert.equal(repo._assets.length, 2);
      assert.ok(logs.some((l) => l.event === 'ingest.duplicate'));

      // A different platform needs a different derivative (no crop for LinkedIn) of the same source.
      const linkedin = await importImage(srv.url('/wide.png'), { platform: 'linkedin', testing: testing() });
      assert.equal(linkedin.cropped, false);
      assert.notEqual(linkedin.url, first.url);
    } finally {
      await srv.close();
    }
  }));

test('image import: corrupt, truncated and oversized-pixel files are rejected with actionable errors and store nothing', () =>
  inWorkspace(async () => {
    const good = await jpegImage(1000, 1000);
    const srv = await startServer((req, res) => res.end(req.url === '/truncated.jpg' ? good.subarray(0, 600) : Buffer.concat([good.subarray(0, 3), Buffer.alloc(300, 7)])));
    try {
      for (const p of ['/truncated.jpg', '/garbage.jpg']) {
        await assert.rejects(importImage(srv.url(p), { platform: 'x', testing: testing() }), (e) => e.code === 'MEDIA_INVALID' && /corrupt|truncated/.test(e.message));
      }
      assert.equal(repo._assets.length, 0);
    } finally {
      await srv.close();
    }
  }));

test('PDF import: checks the pages, stores once, reports duplicates', () =>
  inWorkspace(async () => {
    const pdf = await pdfWithPages(5);
    const srv = await startServer((req, res) => {
      res.setHeader('Content-Disposition', 'attachment; filename="My Carousel.pdf"');
      res.end(req.url === '/bad' ? Buffer.from('%PDF-1.4\nnot really a pdf at all') : pdf);
    });
    try {
      const doc = await importDocument(srv.url('/c.pdf'), { testing: testing() });
      assert.equal(doc.pages, 5);
      assert.equal(doc.filename, 'My Carousel');
      assert.equal(doc.duplicate, false);
      assert.ok(doc.qc.warnings.some((w) => w.code === 'PDF_RENDER_UNAVAILABLE') || doc.qc.checks.render === 'passed');
      assert.equal((await importDocument(srv.url('/c2.pdf'), { testing: testing() })).duplicate, true);
      await assert.rejects(importDocument(srv.url('/bad'), { testing: testing() }), { code: 'MEDIA_INVALID' });
      assert.equal(repo._assets.length, 1);
    } finally {
      await srv.close();
    }
  }));

test('video import: header-checked against the platform; wrong length is refused, good file stored', () =>
  inWorkspace(async () => {
    const srv = await startServer((req, res) => res.end(req.url === '/short' ? fakeMp4({ seconds: 1 }) : req.url === '/webm' ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Array(40).fill(0)]) : fakeMp4({ seconds: 20 })));
    try {
      await assert.rejects(importVideo(srv.url('/short'), { platform: 'instagram', testing: testing() }), (e) => e.code === 'MEDIA_INVALID' && /at least 3 s/.test(e.message));
      await assert.rejects(importVideo(srv.url('/webm'), { platform: 'x', testing: testing() }), { code: 'UNSUPPORTED_FORMAT' });
      const ok = await importVideo(srv.url('/ok'), { platform: 'instagram', testing: testing() });
      assert.equal(ok.qc.info.seconds, 20);
      assert.ok(existsSync(fileOf(ok.url)));
      assert.equal(repo._assets.length, 1);
    } finally {
      await srv.close();
    }
  }));

test('a failed import leaves no temp files and no stored assets behind', () =>
  inWorkspace(async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>Quota exceeded</html>');
    });
    try {
      await assert.rejects(importImage(srv.url('/x'), { platform: 'x', testing: testing() }), { code: 'HTML_RESPONSE' });
      const { readdir } = await import('node:fs/promises');
      const { TMP_DIR } = await import('../src/mediaIngest.js');
      assert.deepEqual((await readdir(TMP_DIR).catch(() => [])).filter((n) => n.endsWith('.part')), []);
      assert.equal(repo._assets.length, 0);
    } finally {
      await srv.close();
    }
  }));

test('setPostDocument keeps the QC report on the post so approval does not repeat the check', () =>
  inWorkspace(async () => {
    const post = await repo.createPost({ platform: 'linkedin', content: 'x', brief: 'b' });
    const stored = await checkAndStoreUploadedDocument(await pdfWithPages(4));
    const updated = await setPostDocument(post.id, { url: stored.url, title: 't', pages: stored.pages, qc: stored.qc });
    assert.equal(updated.media_qc.pdf.url, stored.url);
    assert.equal(updated.media_qc.pdf.report.ok, true);
  }));
