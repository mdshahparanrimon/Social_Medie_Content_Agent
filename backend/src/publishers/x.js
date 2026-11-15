import { TwitterApi } from 'twitter-api-v2';
import { loadImageJpeg, loadVideo } from '../media.js';
import { PublishError, errorFromNetwork } from './common.js';
import { redactText } from '../log.js';

// OAuth 1.0a: your app's Consumer Key/Secret + the connected account's access token. These tokens don't expire.
// Single posts only (no threads). Alt text is not sent: it needs a separate media-metadata call this app doesn't make.
// Reading the timeline back (used to settle an uncertain outcome) needs a paid API tier; on the free tier it is unavailable.

export const appReady = (config) => Boolean(config.x_api_key && config.x_api_secret);

const LABEL = 'X';

function client(account, config) {
  return new TwitterApi({
    appKey: config.x_api_key,
    appSecret: config.x_api_secret,
    accessToken: account.credentials.access_token,
    accessSecret: account.credentials.access_secret,
  });
}

const detail = (err) => redactText(err.data?.detail || err.data?.title || err.message || 'unknown error').slice(0, 300);

// twitter-api-v2 has no timeout of its own, so every call is raced against one and the attempt's abort signal.
async function guarded(promise, { stage, signal, timeoutMs = 60_000 }) {
  let timer;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', cancelled: true })), { once: true });
  });
  try {
    return await Promise.race([promise, stop]);
  } catch (err) {
    throw classify(err, stage);
  } finally {
    clearTimeout(timer);
  }
}

export function classify(err, stage) {
  if (err instanceof PublishError) return err;
  const status = err.code;
  if (typeof status !== 'number') return errorFromNetwork({ label: LABEL, stage, err });
  if (status === 401) return new PublishError(`X: the connection was rejected or has expired. Reconnect X on the Connections page. (${detail(err)})`, { code: 'AUTH', status, needsReconnect: true });
  if (status === 429) {
    const reset = err.rateLimit?.reset ? err.rateLimit.reset * 1000 - Date.now() : null;
    return new PublishError(`X: rate limit reached. ${detail(err)}`, { code: 'RATE_LIMIT', status, retryable: true, retryAfterMs: reset && reset > 0 ? reset : 15 * 60_000 });
  }
  if (status === 403) return new PublishError(`X: not allowed. ${detail(err)}`, { code: 'PERMISSION', status });
  if (status >= 500) {
    return stage === 'create'
      ? new PublishError(`X (${status}) while publishing: it may or may not have been posted. ${detail(err)}`, { code: 'SERVER_ERROR', status, uncertain: true })
      : new PublishError(`X (${status}): ${detail(err)}`, { code: 'SERVER_ERROR', status, retryable: true });
  }
  return new PublishError(`X (${status}): ${detail(err)}`, { code: 'REJECTED', status });
}

// With an image or video, it's uploaded first (v2 media upload; videos in chunks, then X processes them) and attached.
export async function publish({ text, imageUrl, videoUrl, account, config, onProgress, signal }) {
  const api = client(account, config).v2;
  const payload = { text };
  if (videoUrl) {
    const bytes = await loadVideo(videoUrl);
    const mediaId = await guarded(api.uploadMedia(bytes, { media_type: 'video/mp4', media_category: 'tweet_video' }), { stage: 'pre', signal, timeoutMs: 300_000 });
    payload.media = { media_ids: [mediaId] };
  } else if (imageUrl) {
    const bytes = await loadImageJpeg(imageUrl);
    const mediaId = await guarded(api.uploadMedia(bytes, { media_type: 'image/jpeg', media_category: 'tweet_image' }), { stage: 'pre', signal, timeoutMs: 120_000 });
    payload.media = { media_ids: [mediaId] };
  }
  await onProgress?.({ phase: 'creating' });
  const { data } = await guarded(api.tweet(payload), { stage: 'create', signal });
  await onProgress?.({ phase: 'created', remoteId: data.id });
  return { externalId: data.id, url: `https://x.com/i/web/status/${data.id}` };
}

const stripLinks = (t) => t.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

export async function reconcile({ post, account, config, attempt }) {
  try {
    const api = client(account, config).v2;
    const me = await api.me();
    const timeline = await api.userTimeline(me.data.id, { max_results: 10, 'tweet.fields': ['created_at'] });
    const since = new Date(attempt?.started_at || post.updated_at).getTime() - 120_000;
    const want = stripLinks(post.content);
    const match = (timeline.data?.data || []).find((t) => stripLinks(t.text) === want && new Date(t.created_at).getTime() >= since);
    if (match) return { status: 'found', externalId: match.id, url: `https://x.com/i/web/status/${match.id}` };
    return { status: 'not_found', reason: 'The post is not among your latest 10 posts.' };
  } catch (err) {
    return { status: 'unknown', reason: `X would not let the app read your timeline (${detail(err)}). Check X and confirm manually.` };
  }
}

export async function test({ account, config }) {
  try {
    const { data } = await client(account, config).v2.me();
    return `Working: posting as @${data.username}`;
  } catch (err) {
    throw new Error(`X: ${detail(err)}`);
  }
}
