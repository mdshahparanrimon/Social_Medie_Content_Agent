import { repo } from './db/index.js';
import { httpError } from './errors.js';
import { publishToPlatform } from './publishers/index.js';
import { refreshToken as refreshInstagramToken } from './publishers/instagram.js';
import { getAccount, updateAccount } from './accounts.js';
import { runInWorkspace } from './context.js';

const CHECK_EVERY_MS = 60_000;
const REFRESH_EVERY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// If the server was off when a post was due, don't publish it more than this late.
const MISSED_WINDOW_MS = 6 * 60 * 60 * 1000;

export async function publishPost(id) {
  // Claim the post first so the scheduler and "Publish now" can never post it twice.
  const post = await repo.updatePost(id, { status: 'publishing' }, { onlyIfStatus: ['approved', 'failed'] });
  if (!post) {
    if (!(await repo.getPost(id))) throw httpError(404, 'Post not found.');
    throw httpError(409, 'Only approved or failed posts can be published.');
  }

  try {
    const result = await publishToPlatform(post);
    return await repo.updatePost(id, {
      status: 'published',
      published_at: new Date().toISOString(),
      external_id: result.externalId,
      external_url: result.url,
      simulated: result.simulated,
      error: null,
    });
  } catch (err) {
    return repo.updatePost(id, { status: 'failed', error: err.message });
  }
}

// Due posts of every workspace; each one is handled inside its own workspace.
async function publishDuePosts() {
  const now = Date.now();
  for (const post of await repo.allDuePosts(new Date(now).toISOString())) {
    if (post.workspace_id) await runInWorkspace(post.workspace_id, () => publishDue(post, now));
  }
}

async function publishDue(post, now) {
  if (now - new Date(post.scheduled_at).getTime() > MISSED_WINDOW_MS) {
    await repo.updatePost(
      post.id,
      { status: 'failed', error: 'Missed its time slot (the app was not running). Reschedule it or publish now.' },
      { onlyIfStatus: ['approved'] },
    );
    return;
  }
  const result = await publishPost(post.id).catch((err) => ({ status: `skipped (${err.message})` }));
  console.log(`[scheduler] post ${post.id} on ${post.platform}: ${result.status}${result.simulated ? ' (simulated)' : ''}`);
}

// Instagram tokens last 60 days; renew them when under 10 days are left (Instagram allows it once a token is a day old).
// X and Facebook Page tokens don't expire. LinkedIn can't be renewed; the dashboard asks you to reconnect.
async function refreshTokens() {
  for (const { workspace_id } of await repo.allAccountsForPlatform('instagram')) {
    if (workspace_id) await runInWorkspace(workspace_id, refreshInstagram);
  }
}

async function refreshInstagram() {
  const account = await getAccount('instagram');
  if (!account?.expires_at) return;
  const left = new Date(account.expires_at).getTime() - Date.now();
  const age = Date.now() - new Date(account.credentials.refreshed_at || account.connected_at).getTime();
  if (left > 10 * DAY_MS || left <= 0 || age < DAY_MS) return;
  try {
    const fresh = await refreshInstagramToken(account);
    await updateAccount('instagram', {
      expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
      credentials: { ...account.credentials, access_token: fresh.access_token, refreshed_at: new Date().toISOString() },
      status: 'active',
      last_error: null,
    });
    console.log('[tokens] Instagram token renewed for 60 more days');
  } catch (err) {
    await updateAccount('instagram', { status: 'error', last_error: err.message });
    console.error('[tokens] Instagram token renewal failed:', err.message);
  }
}

export async function startScheduler() {
  // A post stuck in 'publishing' means the server stopped mid-request; it may or may not have gone out.
  await repo.failInterruptedPosts('Interrupted while publishing. Check the platform before retrying.');

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await publishDuePosts();
    } catch (err) {
      console.error('[scheduler]', err);
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, CHECK_EVERY_MS);

  const refresh = () => refreshTokens().catch((err) => console.error('[tokens]', err));
  refresh();
  setInterval(refresh, REFRESH_EVERY_MS);
}
