import './env.js';
import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { repo } from '../src/db/index.js';
import { buildServer } from '../src/mcp.js';
import { useIngestTestOverrides } from '../src/mediaIngest.js';
import { saveAccount } from '../src/accounts.js';
import { PUBLISHERS } from '../src/publishers/index.js';
import { publishDuePosts } from '../src/scheduler.js';
import { resolveUncertain } from '../src/publishing.js';
import { PublishError } from '../src/publishers/common.js';
import { freshDatabase, inWorkspace, logs, seedBrand, setWorkspaceSettings } from './harness.js';
import { startServer, testing } from './mockServer.js';
import { jpegImage, fakeMp4, pdfWithPages } from './fixtures.js';

// The whole path a post takes with Claude on the MCP side: draft -> media from a Drive link -> checks -> approval ->
// scheduler -> (fake) platform -> final status and logs. No real account or network is touched.

const real = { ...PUBLISHERS };
let drive;
let published;
let behavior;
let driveFiles;

beforeEach(async () => {
  freshDatabase();
  published = [];
  behavior = async () => ({ externalId: 'urn:li:share:e2e', url: 'https://www.linkedin.com/feed/update/urn:li:share:e2e' });
  for (const key of ['linkedin', 'instagram']) {
    PUBLISHERS[key] = {
      appReady: () => true,
      test: async () => 'ok',
      reconcile: async () => ({ status: 'unknown', reason: 'not supported in the test' }),
      publish: async (args) => {
        published.push({ platform: key, text: args.text, imageUrl: args.imageUrl, videoUrl: args.videoUrl, documentUrl: args.documentUrl, imageAlt: args.imageAlt });
        return behavior(args);
      },
    };
  }
  driveFiles = {};
  drive = await startServer((req, res) => {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const file = driveFiles[id];
    if (!file) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${file.name}"` });
    res.end(file.data);
  });
  useIngestTestOverrides(testing({ driveBase: `http://mock.test:${drive.port}` }));
  await inWorkspace(async () => {
    await seedBrand();
    for (const key of ['linkedin', 'instagram']) {
      await saveAccount(key, { external_id: `${key}-id`, name: key, username: null, avatar_url: null, expires_at: null, credentials: { access_token: 'TOP-SECRET' } });
    }
  });
});

afterEach(() => drive.close());

after(() => {
  Object.assign(PUBLISHERS, real);
  useIngestTestOverrides(null);
});

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverSide);
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(clientSide);
  const call = (name, args = {}) =>
    inWorkspace(async () => {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content[0].text;
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* an error message */
      }
      return { isError: Boolean(result.isError), text, json };
    });
  return { call, close: async () => { await client.close(); await server.close(); } };
}

const driveLink = (id) => `https://drive.google.com/file/d/${id}/view?usp=sharing`;
const CAPTION = 'Most logos fail for one boring reason: nobody wrote down what the brand should feel like.\n\nBefore opening a design tool, write three adjectives and one thing you refuse to be.\n\nWhat are your three? Tell me in the comments.\n\n#Branding #SmallBusiness';

test('MCP end to end: draft, fix the report, attach a Drive image, check, approve, publish, verify state and logs', async () => {
  const mcp = await connect();
  try {
    // The guide now carries the quality protocol.
    const guide = await mcp.call('get_writing_guide');
    assert.match(guide.text, /Quality checks/);
    assert.match(guide.text, /never means a post is approved/);

    // 1. Claude saves a draft with an unverified figure and no alt text: it is saved, but flagged.
    const created = await mcp.call('create_post', { platform: 'linkedin', content: `${CAPTION}\n\nOur clients grew revenue by 300%.`, brief: 'Brand adjectives post' });
    assert.equal(created.isError, false);
    const id = created.json.id;
    assert.equal(created.json.status, 'draft');
    assert.equal(created.json.quality.status, 'needs_human_review');
    assert.ok(created.json.quality.needs_acknowledgement.some((a) => a.code === 'UNVERIFIED_NUMBER'));
    assert.equal(created.json.quality.ai_review.status, 'not_run');

    // 2. Claude can't schedule it: the claim needs a person.
    const refused = await mcp.call('schedule_post', { id });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /REVIEW_REQUIRED/);
    assert.match(refused.text, /300%/);
    assert.equal((await inWorkspace(() => repo.getPost(id))).status, 'draft');

    // 3. Claude revises; the new report shows revision 1 and a clean state.
    const revised = await mcp.call('update_post', { id, content: CAPTION });
    assert.equal(revised.json.quality.status, 'ready');
    assert.equal(revised.json.quality.revision_count, 1);

    // 4. A Drive link for the image: downloaded, converted, checked, stored, with alt text.
    driveFiles['1AbCdEfGhIjKlMnOpQrStUv'] = { name: 'cover.jpg', data: await jpegImage(1200, 1200, '#1155aa') };
    const withImage = await mcp.call('set_post_image', { id, image_url: driveLink('1AbCdEfGhIjKlMnOpQrStUv'), alt_text: 'A blue brand mood board' });
    assert.equal(withImage.isError, false, withImage.text);
    assert.match(withImage.json.image_url, /\/media\/ws-one\/[0-9a-f]{32}\.jpg$/);
    assert.equal(withImage.json.image_alt, 'A blue brand mood board');
    assert.equal(withImage.json.media_check.duplicate, false);
    assert.ok(withImage.json.media_check.look_at_it.length >= 1);

    // 5. Importing the same file again is recognised as a duplicate (one stored copy).
    const again = await mcp.call('set_post_image', { id, image_url: driveLink('1AbCdEfGhIjKlMnOpQrStUv'), alt_text: 'A blue brand mood board' });
    assert.equal(again.json.media_check.duplicate, true);
    assert.equal(again.json.image_url, withImage.json.image_url);

    // 6. A bad Drive file (an HTML error page) gives a clear error and changes nothing.
    driveFiles.AAAAAAAAAAAAAAAAAAAA1 = { name: 'x.jpg', data: Buffer.from('<!DOCTYPE html><html>nope</html>') };
    const bad = await mcp.call('set_post_image', { id, image_url: driveLink('AAAAAAAAAAAAAAAAAAAA1') });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /web page|not a supported image/);
    assert.equal((await inWorkspace(() => repo.getPost(id))).image_url, withImage.json.image_url);

    // 7. Checks pass; approval needs no acknowledgement.
    const check = await mcp.call('check_post_quality', { id });
    assert.equal(check.json.quality.status, 'ready');
    assert.equal(check.json.quality.blockers.length, 0);

    // 8. Claude (at the user's request) schedules. The post is approved but NOT published yet.
    const when = new Date(Date.now() + 3600_000).toISOString();
    const scheduled = await mcp.call('schedule_post', { id, scheduled_at: when });
    assert.equal(scheduled.isError, false, scheduled.text);
    assert.equal(scheduled.json.status, 'approved');
    assert.equal(published.length, 0);
    await inWorkspace(publishDuePosts);
    assert.equal(published.length, 0, 'not due yet');

    // 9. It becomes due: the scheduler publishes through the (fake) platform exactly once.
    await inWorkspace(() => repo.updatePost(id, { scheduled_at: new Date(Date.now() - 1000).toISOString() }));
    await publishDuePosts();
    await publishDuePosts();
    assert.equal(published.length, 1);
    assert.equal(published[0].text, CAPTION);
    assert.equal(published[0].imageAlt, 'A blue brand mood board');

    // 10. Final state, attempt log, structured logs without secrets.
    const final = await inWorkspace(() => repo.getPost(id));
    assert.equal(final.status, 'published');
    assert.equal(final.external_id, 'urn:li:share:e2e');
    const attempts = await inWorkspace(() => repo.listAttempts(id));
    assert.deepEqual(attempts.map((a) => [a.outcome, a.trigger]), [['published', 'scheduler']]);
    const events = logs.map((l) => l.event);
    for (const e of ['ingest.downloaded', 'storage.stored', 'post.approved', 'publish.attempt_started', 'publish.published']) assert.ok(events.includes(e), e);
    assert.ok(!JSON.stringify(logs).includes('TOP-SECRET'));
    const listed = await mcp.call('list_posts', { status: ['published'] });
    assert.equal(listed.json[0].status, 'published');
  } finally {
    await mcp.close();
  }
});

test('MCP: blocking rule violations are saved as a draft with actionable steps and can never be scheduled', async () => {
  const mcp = await connect();
  try {
    await inWorkspace(() => seedBrand({ banned_phrases: ['revolutionary'] }));
    await inWorkspace(() => setWorkspaceSettings({ quality_max_revisions: 1 }));
    const created = await mcp.call('create_post', { platform: 'x', content: `A revolutionary idea. ${'word '.repeat(70)}` });
    assert.equal(created.json.quality.status, 'blocked');
    const codes = created.json.quality.blockers.map((b) => b.code).sort();
    assert.deepEqual(codes, ['BANNED_PHRASE', 'TOO_LONG']);
    assert.ok(created.json.quality.next_steps.some((s) => /Fix:/.test(s)));
    const id = created.json.id;

    const second = await mcp.call('update_post', { id, content: `Still revolutionary. ${'word '.repeat(70)}` });
    assert.equal(second.json.quality.revision_count, 1);
    assert.equal(second.json.quality.revision_limit_reached, true);
    assert.match(second.json.quality.next_steps[0], /Stop revising/);

    const refused = await mcp.call('schedule_post', { id });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /QUALITY_BLOCKED/);

    const fixed = await mcp.call('update_post', { id, content: 'A plain idea for small studios: name three adjectives. Which three? Reply below.' });
    assert.equal(fixed.json.quality.status, 'ready');
    assert.equal((await mcp.call('schedule_post', { id })).json.status, 'approved');
  } finally {
    await mcp.close();
  }
});

test('MCP: Instagram needs media, a bad video is refused with the platform limit, a good one is accepted and checked', async () => {
  const mcp = await connect();
  try {
    const created = await mcp.call('create_post', { platform: 'instagram', content: 'Three adjectives define your brand. Which are yours? Tell us below.\n\n#branding #design #smallbusiness' });
    const id = created.json.id;
    assert.ok(created.json.quality.blockers.some((b) => b.code === 'MEDIA_REQUIRED'));
    assert.equal((await mcp.call('schedule_post', { id })).isError, true);

    driveFiles.BBBBBBBBBBBBBBBBBBBB1 = { name: 'short.mp4', data: fakeMp4({ seconds: 1 }) };
    const tooShort = await mcp.call('set_post_video', { id, video_url: driveLink('BBBBBBBBBBBBBBBBBBBB1') });
    assert.equal(tooShort.isError, true);
    assert.match(tooShort.text, /MEDIA_INVALID/);
    assert.match(tooShort.text, /at least 3 s/);

    driveFiles.CCCCCCCCCCCCCCCCCCCC1 = { name: 'reel.mp4', data: fakeMp4({ seconds: 15 }) };
    const ok = await mcp.call('set_post_video', { id, video_url: driveLink('CCCCCCCCCCCCCCCCCCCC1') });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.json.media_check.info.seconds, 15);
    assert.equal(ok.json.media_check.info.inspectedWith, 'mp4-header');
    const q = (await mcp.call('check_post_quality', { id })).json.quality;
    assert.equal(q.blockers.length, 0);
    assert.equal((await mcp.call('schedule_post', { id })).json.status, 'approved');
  } finally {
    await mcp.close();
  }
});

test('MCP: a PDF carousel from Drive is validated; a corrupt PDF is refused', async () => {
  const mcp = await connect();
  try {
    const created = await mcp.call('create_post', { platform: 'linkedin', content: CAPTION });
    const id = created.json.id;
    driveFiles.DDDDDDDDDDDDDDDDDDDD1 = { name: 'deck.pdf', data: await pdfWithPages(6) };
    const ok = await mcp.call('set_post_document', { id, document_url: driveLink('DDDDDDDDDDDDDDDDDDDD1'), title: 'Brand deck' });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.json.document_pages, 6);
    driveFiles.EEEEEEEEEEEEEEEEEEEE1 = { name: 'broken.pdf', data: Buffer.from('%PDF-1.4\nthis is not a real pdf body at all') };
    const bad = await mcp.call('set_post_document', { id, document_url: driveLink('EEEEEEEEEEEEEEEEEEEE1') });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /MEDIA_INVALID/);
    assert.equal((await inWorkspace(() => repo.getPost(id))).document_pages, 6);
  } finally {
    await mcp.close();
  }
});

test('MCP: an uncertain publish is visible to Claude, is not retried, and a person resolves it', async () => {
  const mcp = await connect();
  try {
    const created = await mcp.call('create_post', { platform: 'linkedin', content: CAPTION });
    const id = created.json.id;
    assert.equal((await mcp.call('schedule_post', { id })).json.status, 'approved');
    behavior = async ({ onProgress }) => {
      await onProgress({ phase: 'creating' });
      throw new PublishError('LinkedIn timed out while publishing: it may or may not have been posted.', { uncertain: true, code: 'TIMEOUT' });
    };
    await inWorkspace(() => repo.updatePost(id, { scheduled_at: new Date(Date.now() - 1000).toISOString() }));
    await publishDuePosts();
    await publishDuePosts();
    assert.equal(published.length, 1, 'never retried');
    const listed = await mcp.call('list_posts', { status: ['uncertain'] });
    assert.equal(listed.json.length, 1);
    assert.match(listed.json[0].uncertain_reason, /may or may not/);
    const resolved = await inWorkspace(() => resolveUncertain(id, { outcome: 'not_published', actor: 'u1' }));
    assert.equal(resolved.status, 'failed');
    assert.ok(logs.some((l) => l.event === 'publish.manual_resolution'));
  } finally {
    await mcp.close();
  }
});

test('MCP: the Brand Brain accepts the new fields and shows what is still missing without inventing facts', async () => {
  const mcp = await connect();
  try {
    const saved = await mcp.call('update_brand_brain', {
      verified_facts: ['Founded in 2019'],
      banned_phrases: ['best in class'],
      hashtag_policy: { max: 3, banned: ['#spam'] },
      brand_colors: ['#0A66C2', 'not-a-color'],
      cta_policies: { leads: 'Invite them to book a free 15-minute call' },
      rejected_examples: [{ text: 'We are THE BEST!!!', reason: 'too boastful' }],
    });
    assert.deepEqual(saved.json.verified_facts, ['Founded in 2019']);
    assert.deepEqual(saved.json.brand_colors, ['#0a66c2']);
    assert.deepEqual(saved.json.hashtag_policy.banned, ['spam']);
    assert.equal(saved.json.cta_policies.leads, 'Invite them to book a free 15-minute call');
    assert.equal(saved.json.schema_version, 2);
    assert.equal(saved.json.name, 'Acme Studio', 'existing values untouched');
    const guide = await mcp.call('get_writing_guide');
    assert.match(guide.text, /Verified facts/);
    assert.match(guide.text, /Optional Brand Brain details/);
    assert.doesNotMatch(guide.text, /No verified facts were provided/);
  } finally {
    await mcp.close();
  }
});
