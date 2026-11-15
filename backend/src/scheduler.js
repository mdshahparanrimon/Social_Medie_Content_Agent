import { repo } from './db/index.js';
import { refreshToken as refreshInstagramToken } from './publishers/instagram.js';
import { getAccount, updateAccount } from './accounts.js';
import { runInWorkspace } from './context.js';
import { publishPost, recoverStalePosts, reconcileUncertainPosts } from './publishing.js';
import { transition } from './postStates.js';
import { sweepOrphanAssets } from './media.js';
import { sweepTemp } from './mediaIngest.js';
import { log } from './log.js';

// Re-exported: the dashboard's "Publish now" uses the same code path as the scheduler.
export { publishPost };

const CHECK_EVERY_MS = 60_000;
const REFRESH_EVERY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// If the server was off when a post was due, don't publish it more than this late.
const MISSED_WINDOW_MS = 6 * 60 * 60 * 1000;

// Due posts of every workspace; each one is handled inside its own workspace.
export async function publishDuePosts() {
  const now = Date.now();
  for (const post of await repo.allDuePosts(new Date(now).toISOString())) {
    if (post.workspace_id) await runInWorkspace(post.workspace_id, () => publishDue(post, now));
  }
}

async function publishDue(post, now) {
  // A retry after a temporary failure is not "missed": measure lateness from when it was last due.
  const dueSince = new Date(post.next_attempt_at || post.scheduled_at).getTime();
  if (now - dueSince > MISSED_WINDOW_MS && !post.publish_attempt_count) {
    await transition(post.id, 'approved', 'failed', { error: 'Missed its time slot (the app was not running). Reschedule it or publish now.' });
    return;
  }
  // Claiming inside publishPost is atomic: if another worker got there first, this just reports it and moves on.
  const result = await publishPost(post.id, { trigger: 'scheduler' }).catch((err) => ({ status: `skipped (${err.message})` }));
  log.info('scheduler.post', { post: post.id, platform: post.platform, status: result?.status, simulated: Boolean(result?.simulated) });
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
  // Posts left in 'publishing' by a stopped server may or may not have gone out: they become 'uncertain', never 'failed'.
  const recovered = await recoverStalePosts();
  if (recovered) log.warn('scheduler.recovered_stale', { count: recovered });
  await repo.failInterruptedVideos('Interrupted: the server restarted while the video was being made. Generate it again.');
  await sweepTemp().catch((err) => log.error('scheduler.temp_sweep_failed', { message: err.message }));

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await recoverStalePosts();
      await publishDuePosts();
      await reconcileUncertainPosts();
    } catch (err) {
      log.error('scheduler.tick_failed', { message: err.message });
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, CHECK_EVERY_MS);

  const refresh = () => refreshTokens().catch((err) => log.error('scheduler.token_refresh_failed', { message: err.message }));
  refresh();
  setInterval(refresh, REFRESH_EVERY_MS);

  const housekeeping = () =>
    Promise.all([sweepOrphanAssets(), sweepTemp()]).catch((err) => log.error('scheduler.housekeeping_failed', { message: err.message }));
  setTimeout(housekeeping, 5 * 60_000);
  setInterval(housekeeping, DAY_MS);
}
