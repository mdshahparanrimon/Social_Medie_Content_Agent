import './env.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { repo } from '../src/db/index.js';
import { saveAccount, getAccount } from '../src/accounts.js';
import { PUBLISHERS } from '../src/publishers/index.js';
import { PublishError, api } from '../src/publishers/common.js';
import { publishPost, recoverStalePosts, reconcilePost, reconcileUncertainPosts, resolveUncertain } from '../src/publishing.js';
import { publishDuePosts } from '../src/scheduler.js';
import { runInWorkspace } from '../src/context.js';
import { GOOD_LINKEDIN, WS, freshDatabase, inWorkspace, logs, seedBrand, setWorkspaceSettings } from './harness.js';
import { startServer } from './mockServer.js';

const realLinkedin = PUBLISHERS.linkedin;
let calls;
let behavior;

function installFake() {
  calls = [];
  behavior = async () => ({ externalId: 'urn:li:share:1', url: 'https://www.linkedin.com/feed/update/urn:li:share:1' });
  PUBLISHERS.linkedin = {
    appReady: () => true,
    test: async () => 'ok',
    reconcile: async () => ({ status: 'unknown', reason: 'not supported' }),
    async publish(args) {
      calls.push(args);
      return behavior(args);
    },
  };
}

async function setup({ connected = true } = {}) {
  freshDatabase();
  installFake();
  await inWorkspace(async () => {
    await seedBrand();
    if (connected) await saveAccount('linkedin', { external_id: 'abc', name: 'Test User', username: null, avatar_url: null, expires_at: null, credentials: { access_token: 'SECRET-TOKEN-123' } });
  });
}

const makeApproved = async (content = GOOD_LINKEDIN, extra = {}) => {
  const post = await repo.createPost({ platform: 'linkedin', content, brief: 'b' });
  return repo.updatePost(post.id, { status: 'approved', scheduled_at: new Date(Date.now() - 1000).toISOString(), ...extra });
};

beforeEach(() => setup());
test.after(() => {
  PUBLISHERS.linkedin = realLinkedin;
});

test('a successful publish: claim, attempt log, final state, no secrets in logs', () =>
  inWorkspace(async () => {
    const post = await makeApproved();
    const done = await publishPost(post.id);
    assert.equal(done.status, 'published');
    assert.equal(done.external_id, 'urn:li:share:1');
    assert.equal(done.publish_attempt_count, 1);
    assert.ok(done.publish_attempt_id);
    assert.equal(done.error, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].account.credentials.access_token, 'SECRET-TOKEN-123'); // the publisher gets the real token...
    const attempts = await repo.listAttempts(post.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'published');
    assert.equal(attempts[0].attempt_id, done.publish_attempt_id);
    assert.ok(logs.some((l) => l.event === 'publish.published'));
    assert.ok(!JSON.stringify(logs).includes('SECRET-TOKEN-123')); // ...but logs never see it
    assert.equal((await repo.getPost(post.id)).quality.status !== 'blocked', true);
  }));

test('without a connected account the publish is simulated and nothing external is called', async () => {
  await setup({ connected: false });
  await inWorkspace(async () => {
    const post = await makeApproved();
    const done = await publishPost(post.id);
    assert.equal(done.status, 'published');
    assert.equal(done.simulated, true);
    assert.equal(calls.length, 0);
  });
});

test('the remote id is saved the moment it exists, even if the call then fails', () =>
  inWorkspace(async () => {
    behavior = async ({ onProgress }) => {
      await onProgress({ phase: 'container', remoteId: 'container-9' });
      await onProgress({ phase: 'creating' });
      throw new PublishError('timed out while publishing', { code: 'TIMEOUT', uncertain: true });
    };
    const post = await makeApproved();
    const done = await publishPost(post.id);
    assert.equal(done.status, 'uncertain');
    assert.equal(done.remote_id, 'container-9');
    const [attempt] = await repo.listAttempts(post.id);
    assert.equal(attempt.remote_id, 'container-9');
    assert.equal(attempt.outcome, 'uncertain');
  }));

test('an uncertain outcome is never retried automatically or by a second click', () =>
  inWorkspace(async () => {
    behavior = async ({ onProgress }) => {
      await onProgress({ phase: 'creating' });
      throw new PublishError('LinkedIn timed out while publishing: it may or may not have been posted.', { uncertain: true, code: 'TIMEOUT' });
    };
    const post = await makeApproved();
    assert.equal((await publishPost(post.id)).status, 'uncertain');
    await assert.rejects(publishPost(post.id), { code: 'UNCERTAIN_OUTCOME' });
    await publishDuePosts(); // the scheduler ignores it
    await publishDuePosts();
    assert.equal(calls.length, 1);
    assert.equal((await repo.getPost(post.id)).status, 'uncertain');
    assert.ok(logs.some((l) => l.event === 'publish.attempt_failed' && l.action === 'uncertain'));
  }));

test('an unexpected error after the creating call began is treated as uncertain; before it, as a plain failure', () =>
  inWorkspace(async () => {
    behavior = async ({ onProgress }) => {
      await onProgress({ phase: 'creating' });
      throw new Error('socket hang up');
    };
    const a = await makeApproved(GOOD_LINKEDIN);
    assert.equal((await publishPost(a.id)).status, 'uncertain');
    behavior = async () => {
      throw new Error('bug before any request');
    };
    const b = await makeApproved(`${GOOD_LINKEDIN} Second version, with different words about pricing.`);
    assert.equal((await publishPost(b.id)).status, 'failed');
  }));

test('a rate limit schedules a retry with backoff; the scheduler waits, then succeeds', () =>
  inWorkspace(async () => {
    let n = 0;
    behavior = async () => {
      if (++n === 1) throw new PublishError('rate limit reached', { code: 'RATE_LIMIT', retryable: true, retryAfterMs: 120_000 });
      return { externalId: 'urn:li:share:2', url: null };
    };
    const post = await makeApproved();
    const first = await publishPost(post.id, { trigger: 'scheduler' });
    assert.equal(first.status, 'approved');
    assert.ok(new Date(first.next_attempt_at).getTime() >= Date.now() + 119_000, 'respects Retry-After');
    assert.match(first.error, /Trying again/);
    assert.equal((await repo.allDuePosts(new Date().toISOString())).length, 0);
    await publishDuePosts();
    assert.equal(calls.length, 1, 'not retried before the backoff has passed');

    await repo.updatePost(post.id, { next_attempt_at: new Date(Date.now() - 1000).toISOString() });
    await publishDuePosts();
    const done = await repo.getPost(post.id);
    assert.equal(done.status, 'published');
    assert.equal(done.publish_attempt_count, 2);
    assert.deepEqual((await repo.listAttempts(post.id)).map((a) => a.outcome), ['retry_scheduled', 'published']);
  }));

test('retries stop after the maximum number of attempts', () =>
  inWorkspace(async () => {
    behavior = async () => {
      throw new PublishError('server busy', { retryable: true, code: 'SERVER_ERROR' });
    };
    const post = await makeApproved();
    for (let i = 0; i < 3; i++) {
      await repo.updatePost(post.id, { next_attempt_at: null });
      await publishPost(post.id);
    }
    const final = await repo.getPost(post.id);
    assert.equal(final.status, 'failed');
    assert.match(final.error, /gave up after 3 attempts/);
    assert.equal(calls.length, 3);
  }));

test('expired credentials fail the post, mark the account for reconnecting, and are not retried', () =>
  inWorkspace(async () => {
    behavior = async () => {
      throw new PublishError('LinkedIn: the connection was rejected or has expired. Reconnect LinkedIn on the Connections page.', { code: 'AUTH', needsReconnect: true });
    };
    const post = await makeApproved();
    const done = await publishPost(post.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /Reconnect/);
    const account = await repo.getAccount('linkedin');
    assert.equal(account.status, 'error');
    // A later post fails fast without calling the platform.
    const next = await makeApproved(`${GOOD_LINKEDIN} Another post with new wording about hiring designers.`);
    const second = await publishPost(next.id);
    assert.equal(second.status, 'failed');
    assert.equal(calls.length, 1);
    assert.ok(logs.some((l) => l.event === 'publish.attempt_failed' && l.code === 'AUTH'));
    assert.equal((await getAccount('linkedin')).status, 'error');
  }));

test('two workers racing for the same post: exactly one publishes', () =>
  inWorkspace(async () => {
    behavior = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { externalId: 'urn:li:share:3', url: null };
    };
    const post = await makeApproved();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => publishPost(post.id)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 5);
    assert.equal(calls.length, 1);
    assert.equal((await repo.getPost(post.id)).publish_attempt_count, 1);
  }));

test('a claimed post is invisible to the scheduler, and "Publish now" during a scheduler run is refused', () =>
  inWorkspace(async () => {
    let release;
    behavior = () => new Promise((resolve) => (release = () => resolve({ externalId: 'urn:li:share:4', url: null })));
    const post = await makeApproved();
    const running = publishPost(post.id, { trigger: 'scheduler' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await repo.getPost(post.id)).status, 'publishing');
    assert.equal((await repo.allDuePosts(new Date().toISOString())).length, 0);
    await assert.rejects(publishPost(post.id), { status: 409 });
    release();
    assert.equal((await running).status, 'published');
  }));

test('a post left "publishing" by a crashed worker becomes uncertain once its lease expires, not failed', () =>
  inWorkspace(async () => {
    const post = await makeApproved();
    behavior = () => new Promise(() => {}); // never answers
    publishPost(post.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await recoverStalePosts(), 0, 'a live lease is left alone');
    await repo.updatePost(post.id, { lease_expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(await recoverStalePosts(), 1);
    const after = await repo.getPost(post.id);
    assert.equal(after.status, 'uncertain');
    assert.match(after.uncertain_reason, /may have posted/);
    assert.equal((await repo.listAttempts(post.id))[0].outcome, 'interrupted');
    assert.ok(logs.some((l) => l.event === 'publish.interrupted'));
  }));

test('reconciliation: found settles as published; not found and unknown leave it for a person', () =>
  inWorkspace(async () => {
    behavior = async ({ onProgress }) => {
      await onProgress({ phase: 'creating' });
      throw new PublishError('timed out', { uncertain: true });
    };
    const post = await makeApproved();
    await publishPost(post.id);

    PUBLISHERS.linkedin.reconcile = async () => ({ status: 'unknown', reason: 'cannot read posts' });
    let r = await reconcilePost(post.id);
    assert.equal(r.status, 'uncertain');
    assert.equal(r.reconcile_count, 1);
    assert.equal(r.reconcile_note, 'cannot read posts');

    PUBLISHERS.linkedin.reconcile = async () => ({ status: 'not_found', reason: 'not in the latest posts' });
    r = await reconcilePost(post.id);
    assert.equal(r.status, 'uncertain', 'absence is not proof, so it is never auto-failed');

    PUBLISHERS.linkedin.reconcile = async () => ({ status: 'found', externalId: 'urn:li:share:77', url: 'https://x/77' });
    r = await reconcilePost(post.id);
    assert.equal(r.status, 'published');
    assert.equal(r.external_id, 'urn:li:share:77');
    assert.equal(r.reconciled, true);
    assert.equal((await repo.listAttempts(post.id))[0].outcome, 'published_reconciled');
  }));

test('the scheduler re-checks uncertain posts, but not more often than every few minutes', () =>
  inWorkspace(async () => {
    behavior = async ({ onProgress }) => {
      await onProgress({ phase: 'creating' });
      throw new PublishError('timed out', { uncertain: true });
    };
    let asked = 0;
    const post = await makeApproved();
    await publishPost(post.id);
    PUBLISHERS.linkedin.reconcile = async () => {
      asked++;
      return { status: 'unknown', reason: 'x' };
    };
    await reconcileUncertainPosts();
    await reconcileUncertainPosts();
    assert.equal(asked, 1);
    await repo.updatePost(post.id, { last_reconcile_at: new Date(Date.now() - 10 * 60_000).toISOString() });
    await reconcileUncertainPosts();
    assert.equal(asked, 2);
  }));

test('manual resolution: published or not published; only for uncertain posts; recorded in the audit log', () =>
  inWorkspace(async () => {
    behavior = async ({ onProgress }) => {
      await onProgress({ phase: 'creating' });
      throw new PublishError('timed out', { uncertain: true });
    };
    const a = await makeApproved();
    await publishPost(a.id);
    const published = await resolveUncertain(a.id, { outcome: 'published', externalUrl: 'https://linkedin.com/feed/update/1', actor: 'user-1' });
    assert.equal(published.status, 'published');
    assert.equal(published.resolved_manually, true);
    assert.equal(published.external_url, 'https://linkedin.com/feed/update/1');

    const b = await makeApproved(`${GOOD_LINKEDIN} Different second post about pricing a service fairly.`);
    await publishPost(b.id);
    const failed = await resolveUncertain(b.id, { outcome: 'not_published', actor: 'user-1' });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /not posted/);

    await assert.rejects(resolveUncertain(a.id, { outcome: 'published' }), { code: 'INVALID_TRANSITION' });
    await assert.rejects(resolveUncertain(b.id, { outcome: 'banana' }), { code: 'INVALID_TRANSITION' });
    const audit = await repo.listAudit();
    assert.equal(audit.filter((e) => e.type === 'publish.manual_resolution').length, 2);
  }));

test('the quality gate runs again before publishing: a blocker fails the post without calling the platform', () =>
  inWorkspace(async () => {
    const post = await makeApproved();
    // The brand bans a phrase after the post was approved.
    await repo.saveBrand({ banned_phrases: ['boring reason'] });
    const done = await publishPost(post.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /banned phrase/);
    assert.equal(calls.length, 0);
    assert.equal((await repo.listAttempts(post.id))[0].outcome, 'blocked');
    assert.ok(logs.some((l) => l.event === 'publish.blocked'));
  }));

test('a missing media file blocks publishing instead of posting without it', () =>
  inWorkspace(async () => {
    const post = await makeApproved(GOOD_LINKEDIN, { image_url: 'http://localhost:4000/media/ws-one/does-not-exist.jpg' });
    const done = await publishPost(post.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /missing from this server/);
    assert.equal(calls.length, 0);
  }));

test('workspace isolation: another workspace can neither see nor publish the post', async () => {
  let id;
  await inWorkspace(async () => {
    id = (await makeApproved()).id;
  });
  await runInWorkspace('someone-else', async () => {
    await assert.rejects(publishPost(id), { status: 404 });
    await assert.rejects(resolveUncertain(id, { outcome: 'published' }), { status: 404 });
    assert.equal(await repo.getPost(id), null);
    assert.deepEqual(await repo.listAttempts(id), []);
  });
  await inWorkspace(async () => assert.equal((await repo.getPost(id)).status, 'approved'));
  assert.equal(calls.length, 0);
});

test('the scheduler publishes each due post inside its own workspace', async () => {
  const ids = {};
  for (const ws of ['ws-a', 'ws-b']) {
    await runInWorkspace(ws, async () => {
      await seedBrand();
      await saveAccount('linkedin', { external_id: ws, name: ws, username: null, avatar_url: null, expires_at: null, credentials: { access_token: `tok-${ws}` } });
      ids[ws] = (await makeApproved(`${GOOD_LINKEDIN} Post for ${ws} with its own words.`)).id;
    });
  }
  await publishDuePosts();
  assert.deepEqual(calls.map((c) => c.account.credentials.access_token).sort(), ['tok-ws-a', 'tok-ws-b']);
  for (const ws of ['ws-a', 'ws-b']) await runInWorkspace(ws, async () => assert.equal((await repo.getPost(ids[ws])).status, 'published'));
});

test('a database error while recording a successful publish is retried; the remote id is never lost', () =>
  inWorkspace(async () => {
    const post = await makeApproved();
    const original = repo.updatePost;
    let failures = 2;
    repo.updatePost = async (id, fields, opts) => {
      if (fields.status === 'published' && failures-- > 0) throw new Error('database unavailable');
      return original(id, fields, opts);
    };
    try {
      const done = await publishPost(post.id);
      assert.equal(done.status, 'published');
      assert.ok(logs.filter((l) => l.event === 'publish.record_failed').length === 2);
      assert.ok(logs.filter((l) => l.event === 'publish.record_failed').every((l) => l.remote_id === 'urn:li:share:1'));
    } finally {
      repo.updatePost = original;
    }
  }));

test('a platform that never answers is bounded by the timeout: create-stage is uncertain, earlier stages are retryable', async () => {
  const srv = await startServer(() => {}); // accepts the request, never replies
  try {
    await assert.rejects(api(`http://127.0.0.1:${srv.port}/x`, { label: 'LinkedIn', stage: 'create', timeoutMs: 150, method: 'POST' }), (e) => e.uncertain === true && e.code === 'TIMEOUT' && e.retryable === false);
    await assert.rejects(api(`http://127.0.0.1:${srv.port}/x`, { label: 'LinkedIn', stage: 'pre', timeoutMs: 150 }), (e) => e.uncertain === false && e.retryable === true && e.code === 'TIMEOUT');
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(api(`http://127.0.0.1:${srv.port}/x`, { label: 'LinkedIn', stage: 'pre', timeoutMs: 5000, signal: ctl.signal }), (e) => /cancelled/.test(e.message) && e.retryable === false);
  } finally {
    await srv.close();
  }
});

test('a real HTTP 429 with Retry-After and a 401 are classified from live responses', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/limit') {
      res.writeHead(429, { 'Retry-After': '90' });
      return res.end('{"message":"slow down"}');
    }
    res.writeHead(401);
    res.end('{"message":"EXPIRED_ACCESS_TOKEN"}');
  });
  try {
    await assert.rejects(api(`http://127.0.0.1:${srv.port}/limit`, { label: 'LinkedIn', stage: 'create', method: 'POST' }), (e) => e.retryable && e.retryAfterMs === 90_000 && !e.uncertain);
    await assert.rejects(api(`http://127.0.0.1:${srv.port}/auth`, { label: 'LinkedIn', stage: 'create', method: 'POST' }), (e) => e.needsReconnect && !e.retryable);
  } finally {
    await srv.close();
  }
});

test('dry-run setting simulates even connected accounts', () =>
  inWorkspace(async () => {
    await setWorkspaceSettings({ dry_run: true });
    const done = await publishPost((await makeApproved()).id);
    assert.equal(done.simulated, true);
    assert.equal(calls.length, 0);
  }));
