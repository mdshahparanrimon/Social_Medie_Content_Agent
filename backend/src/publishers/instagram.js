import { isLocalUrl } from '../urls.js';
import { PublishError, api } from './common.js';

// Instagram API with Instagram Login: works with a Professional (Creator or Business) account, no Facebook Page needed.
// Long-lived tokens last 60 days and are refreshed automatically (see refreshToken).
// Not implemented: carousel posts (several images). The post model carries one image or one video.

export const appReady = (config) => Boolean(config.instagram_app_id && config.instagram_app_secret);

const LABEL = 'Instagram';
const graphUrl = (config, path) => `https://graph.instagram.com/${config.meta_graph_version}/${path}`;
const call = (url, opts) => api(url, { label: LABEL, ...opts });

export async function fetchProfile(config, accessToken) {
  const params = new URLSearchParams({ fields: 'user_id,username,name,profile_picture_url', access_token: accessToken });
  return (await call(`${graphUrl(config, 'me')}?${params}`)).data;
}

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      const err = new Error('cancelled');
      err.cancelled = true;
      reject(new PublishError('Instagram: publishing was cancelled. Nothing was posted.', { code: 'CANCELLED' }));
    }, { once: true });
  });

// Instagram publishes in two steps: create a media container from the image (or video) URL, wait until it's
// processed, publish it. A video goes out as a Reel, which takes Instagram longer to process.
// Everything before media_publish is safe to repeat (an unpublished container does nothing); media_publish is the
// call that creates the post.
export async function publish({ text, imageUrl, videoUrl, imageAlt, account, config, onProgress, signal }) {
  const mediaUrl = videoUrl || imageUrl;
  const noun = videoUrl ? 'video' : 'image';
  if (!mediaUrl) throw new PublishError('Instagram posts need an image or a video. Add one to the post first.');
  if (isLocalUrl(mediaUrl)) {
    throw new PublishError(`Instagram cannot download ${noun}s from localhost. Set up Cloudinary in Settings → Media, then add the ${noun} again.`);
  }
  const userId = account.external_id;
  const access_token = account.credentials.access_token;

  const source = videoUrl ? { media_type: 'REELS', video_url: videoUrl, share_to_feed: 'true' } : { image_url: imageUrl };
  if (!videoUrl && imageAlt?.trim()) source.alt_text = imageAlt.trim().slice(0, 1000); // images only; Reels don't take alt text
  const { data: container } = await call(graphUrl(config, `${userId}/media`), {
    method: 'POST',
    body: new URLSearchParams({ ...source, caption: text, access_token }),
    signal,
  });
  await onProgress?.({ phase: 'container', remoteId: container.id });

  const [attempts, waitMs] = videoUrl ? [60, 5000] : [30, 2000];
  let ready = false;
  for (let attempt = 0; attempt < attempts && !ready; attempt++) {
    if (attempt > 0) await wait(waitMs, signal);
    const params = new URLSearchParams({ fields: 'status_code', access_token });
    const { data } = await call(`${graphUrl(config, container.id)}?${params}`, { signal });
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      throw new PublishError(
        videoUrl
          ? `Instagram could not process the video (${data.status_code}). Reels need an MP4/MOV (H.264 or HEVC, AAC audio, 23-60 fps, 3 s to 15 min).`
          : `Instagram could not process the image (${data.status_code}). Use a JPEG between 4:5 and 1.91:1.`,
        { code: 'MEDIA_REJECTED' },
      );
    }
    ready = data.status_code === 'FINISHED';
  }
  // Publishing an unfinished container fails with a confusing "media not ready" error, and nothing was posted yet.
  if (!ready) throw new PublishError(`Instagram is still processing the ${noun}. Nothing was posted; it will be tried again.`, { code: 'PROCESSING', retryable: true });

  await onProgress?.({ phase: 'creating', remoteId: container.id });
  const { data: published } = await call(graphUrl(config, `${userId}/media_publish`), {
    method: 'POST',
    body: new URLSearchParams({ creation_id: container.id, access_token }),
    stage: 'create',
    signal,
  });
  await onProgress?.({ phase: 'created', remoteId: published.id });
  const params = new URLSearchParams({ fields: 'permalink', access_token });
  const media = await call(`${graphUrl(config, published.id)}?${params}`, { signal }).then((r) => r.data, () => ({}));
  return { externalId: published.id, url: media.permalink || null };
}

// After an uncertain media_publish: the container reports PUBLISHED once its post exists; the recent-media list
// gives the post itself.
export async function reconcile({ post, account, config, attempt }) {
  const access_token = account.credentials.access_token;
  try {
    let containerPublished = false;
    if (attempt?.remote_id) {
      const { data } = await call(`${graphUrl(config, attempt.remote_id)}?${new URLSearchParams({ fields: 'status_code', access_token })}`);
      containerPublished = data.status_code === 'PUBLISHED';
    }
    const params = new URLSearchParams({ fields: 'id,caption,permalink,timestamp', limit: '15', access_token });
    const { data } = await call(`${graphUrl(config, `${account.external_id}/media`)}?${params}`);
    const since = new Date(attempt?.started_at || post.updated_at).getTime() - 120_000;
    const match = (data.data || []).find((m) => (m.caption || '').trim() === post.content.trim() && new Date(m.timestamp).getTime() >= since);
    if (match) return { status: 'found', externalId: match.id, url: match.permalink || null };
    if (containerPublished) return { status: 'found', externalId: attempt.remote_id, url: null, note: 'Instagram reports the container as published; open Instagram to find the post.' };
    return { status: 'not_found', reason: 'The post is not among the latest 15 Instagram posts.' };
  } catch (err) {
    return { status: 'unknown', reason: err.message };
  }
}

// A long-lived token can be refreshed once it's at least 24 hours old; each refresh gives another 60 days.
export async function refreshToken(account) {
  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: account.credentials.access_token });
  return (await call(`https://graph.instagram.com/refresh_access_token?${params}`)).data;
}

export async function test({ account, config }) {
  const me = await fetchProfile(config, account.credentials.access_token);
  return `Working: posting as @${me.username}`;
}
