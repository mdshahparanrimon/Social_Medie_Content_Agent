import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import express from 'express';
import { repo } from '../src/db/index.js';
import { router } from '../src/routes.js';
import { errorHandler } from '../src/errorHandler.js';
import { runInWorkspace } from '../src/context.js';
import { localPathForUrl } from '../src/media.js';
import { PUBLISHERS } from '../src/publishers/index.js';
import { saveAccount } from '../src/accounts.js';
import { PublishError } from '../src/publishers/common.js';
import { GOOD_LINKEDIN, WS, freshDatabase, inWorkspace, seedBrand } from './harness.js';
import { jpegImage, pdfWithPages, fakeMp4 } from './fixtures.js';

// The dashboard's HTTP API against the in-memory database, with a fake signed-in user and a fake publisher.

let server;
let base;
const real = { ...PUBLISHERS };
let published;
let failWith;

before(async () => {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use((req, res, next) => {
    req.user = { id: 'user-1', role: 'admin' };
    runInWorkspace(WS, next);
  });
  app.use('/api', router);
  app.use(errorHandler);
  await new Promise((resolve) => (server = app.listen(0, '127.0.0.1', resolve)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  Object.assign(PUBLISHERS, real);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  freshDatabase();
  published = [];
  failWith = null;
  PUBLISHERS.linkedin = {
    appReady: () => true,
    test: async () => 'ok',
    reconcile: async () => ({ status: 'unknown', reason: 'n/a' }),
    publish: async ({ onProgress }) => {
      published.push(1);
      if (failWith) {
        await onProgress({ phase: 'creating' });
        throw failWith;
      }
      return { externalId: 'urn:li:share:9', url: 'https://linkedin.example/9' };
    },
  };
  await inWorkspace(async () => {
    await seedBrand();
    await saveAccount('linkedin', { external_id: 'x', name: 'x', username: null, avatar_url: null, expires_at: null, credentials: { access_token: 't' } });
  });
});

async function call(method, path, body, { raw = false, type } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': type || 'application/json' } : undefined,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const newPost = (content = GOOD_LINKEDIN, platform = 'linkedin') => inWorkspace(() => repo.createPost({ platform, content, brief: 'b' }));
const dataUrl = async () => `data:image/jpeg;base64,${(await jpegImage(900, 900)).toString('base64')}`;

test('dashboard flow: image upload with alt text, quality report, approve, publish now, attempts, cleanup on delete', async () => {
  const post = await newPost();
  const img = await call('PUT', `/posts/${post.id}/image`, { dataUrl: await dataUrl(), alt: 'A blue square' });
  assert.equal(img.status, 200);
  assert.equal(img.data.image_alt, 'A blue square');
  const file = localPathForUrl(img.data.image_url);
  assert.ok(existsSync(file));

  const alt = await call('PUT', `/posts/${post.id}/image/alt`, { alt: 'A calm blue square' });
  assert.equal(alt.data.image_alt, 'A calm blue square');

  const check = await call('POST', `/posts/${post.id}/quality/check`, {});
  assert.equal(check.status, 200);
  assert.equal(check.data.quality.status, 'ready');
  assert.equal(check.data.post.media_qc.image.report.ok, true);

  const approved = await call('POST', `/posts/${post.id}/approve`, {});
  assert.equal(approved.data.status, 'approved');
  assert.equal(published.length, 0);

  const done = await call('POST', `/posts/${post.id}/publish`);
  assert.equal(done.data.status, 'published');
  assert.equal(published.length, 1);

  const attempts = await call('GET', `/posts/${post.id}/attempts`);
  assert.equal(attempts.data.length, 1);
  assert.equal(attempts.data[0].outcome, 'published');

  assert.equal((await call('DELETE', `/posts/${post.id}`)).status, 409, 'published posts are kept');
  const draft = await newPost('Second post about hiring. Comment below if you agree.');
  const other = `data:image/jpeg;base64,${(await jpegImage(700, 700, '#aa3355')).toString('base64')}`;
  const withImg = await call('PUT', `/posts/${draft.id}/image`, { dataUrl: other });
  const file2 = localPathForUrl(withImg.data.image_url);
  assert.ok(existsSync(file2));
  const removed = await call('DELETE', `/posts/${draft.id}/image`);
  assert.equal(removed.data.image_url, null);
  assert.ok(!existsSync(file2));
  assert.equal((await call('DELETE', `/posts/${draft.id}`)).status, 200);
});

test('approval errors reach the dashboard with a code and the quality report; acknowledging works only for review items', async () => {
  const flagged = await newPost('Clients grew revenue by 300%. Comment below.');
  const refused = await call('POST', `/posts/${flagged.id}/approve`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'REVIEW_REQUIRED');
  assert.ok(refused.data.details.quality.needs_acknowledgement.length >= 1);
  assert.equal((await call('POST', `/posts/${flagged.id}/approve`, { acknowledge: true })).data.status, 'approved');

  const blocked = await newPost(`${'x'.repeat(3100)} Comment below.`);
  const no = await call('POST', `/posts/${blocked.id}/approve`, { acknowledge: true });
  assert.equal(no.status, 422);
  assert.equal(no.data.code, 'QUALITY_BLOCKED');
});

test('uploads are checked by content: a fake PDF and a non-MP4 video are refused', async () => {
  const post = await newPost();
  const badPdf = await fetch(`${base}/posts/${post.id}/document?title=x`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4\nnot a pdf at all, sorry') });
  assert.equal(badPdf.status, 400);
  assert.equal((await badPdf.json()).code, 'MEDIA_INVALID');
  const okPdf = await fetch(`${base}/posts/${post.id}/document?title=Deck`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: await pdfWithPages(4) });
  assert.equal(okPdf.status, 200);
  assert.equal((await okPdf.json()).document_pages, 4);

  const fakeVideo = await fetch(`${base}/posts/${post.id}/video`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('this is not a video, only text pretending') });
  assert.equal(fakeVideo.status, 400);
  const goodVideo = await fetch(`${base}/posts/${post.id}/video`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: fakeMp4({ seconds: 12 }) });
  assert.equal(goodVideo.status, 200);
  assert.equal((await goodVideo.json()).video_status, 'ready');
});

test('an uncertain publish shows up in the list; the dashboard can check it, resolve it, and it blocks deletion and re-publishing', async () => {
  const post = await newPost();
  await call('POST', `/posts/${post.id}/approve`, {});
  failWith = new PublishError('LinkedIn timed out while publishing: it may or may not have been posted.', { uncertain: true });
  const result = await call('POST', `/posts/${post.id}/publish`);
  assert.equal(result.data.status, 'uncertain');

  const list = await call('GET', '/posts?status=uncertain');
  assert.equal(list.data.length, 1);
  assert.equal((await call('POST', `/posts/${post.id}/publish`)).data.code, 'UNCERTAIN_OUTCOME');
  assert.equal((await call('DELETE', `/posts/${post.id}`)).status, 409);
  assert.equal((await call('PATCH', `/posts/${post.id}`, { content: 'x' })).status, 409);

  const again = await call('POST', `/posts/${post.id}/reconcile`);
  assert.equal(again.data.status, 'uncertain');
  assert.equal(again.data.reconcile_count, 1);

  const resolved = await call('POST', `/posts/${post.id}/resolve`, { outcome: 'published', externalUrl: 'https://linkedin.example/real' });
  assert.equal(resolved.data.status, 'published');
  assert.equal(resolved.data.external_url, 'https://linkedin.example/real');
  assert.equal((await call('POST', `/posts/${post.id}/reconcile`)).status, 409);
  const audit = await call('GET', '/ops/audit');
  assert.ok(audit.data.some((e) => e.type === 'publish.manual_resolution' && e.actor === 'user-1'));
  const metrics = await call('GET', '/ops/metrics');
  assert.ok(metrics.data.since_start['publish.uncertain'] >= 1);
  assert.equal(metrics.data.storage.provider, 'local');
});

test('a failed publish can be retried by a person; unknown posts and wrong ids give clean errors', async () => {
  const post = await newPost();
  await call('POST', `/posts/${post.id}/approve`, {});
  failWith = new PublishError('LinkedIn: the connection was rejected or has expired. Reconnect LinkedIn.', { code: 'AUTH', needsReconnect: true });
  assert.equal((await call('POST', `/posts/${post.id}/publish`)).data.status, 'failed');
  failWith = null;
  await inWorkspace(() => repo.updateAccount('linkedin', { status: 'active' }));
  assert.equal((await call('POST', `/posts/${post.id}/publish`)).data.status, 'published');
  assert.equal((await call('GET', '/posts/nope')).status, 404);
  assert.equal((await call('POST', '/posts/000000000000000000000099/resolve', { outcome: 'published' })).status, 404);
});
