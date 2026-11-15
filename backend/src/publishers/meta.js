import { loadVideo } from '../media.js';
import { api } from './common.js';

// Facebook Page posting. Meta's API can't post to personal profiles, only Pages.
// Page tokens taken from a long-lived user token don't expire.
// Facebook processes uploaded videos after the upload call returns; a processing failure after that is only visible
// on the Page itself, not through this app.

export const appReady = (config) => Boolean(config.meta_app_id && config.meta_app_secret);

const LABEL = 'Facebook';
const graphUrl = (config, path) => `https://graph.facebook.com/${config.meta_graph_version}/${path}`;
const call = (url, opts) => api(url, { label: LABEL, ...opts });

// Videos are uploaded as a file (so videos stored on this server work too) to the Page's videos.
async function publishVideo({ text, videoUrl, account, config, onProgress, signal }) {
  const form = new FormData();
  form.append('source', new Blob([await loadVideo(videoUrl)], { type: 'video/mp4' }), 'video.mp4');
  form.append('description', text);
  form.append('access_token', account.credentials.access_token);
  await onProgress?.({ phase: 'creating' });
  const { data } = await call(`https://graph-video.facebook.com/${config.meta_graph_version}/${account.external_id}/videos`, {
    method: 'POST',
    body: form,
    stage: 'create',
    timeoutMs: 300_000,
    signal,
  });
  await onProgress?.({ phase: 'created', remoteId: data.id });
  return { externalId: data.id, url: `https://www.facebook.com/${data.id}` };
}

// With a video: a video post. With an image: a photo post with the text as its caption. Otherwise: a text post.
export async function publish({ text, imageUrl, videoUrl, account, config, onProgress, signal }) {
  if (videoUrl) return publishVideo({ text, videoUrl, account, config, onProgress, signal });
  const pageId = account.external_id;
  const access_token = account.credentials.access_token;
  await onProgress?.({ phase: 'creating' });
  if (imageUrl) {
    const { data } = await call(graphUrl(config, `${pageId}/photos`), {
      method: 'POST',
      body: new URLSearchParams({ url: imageUrl, caption: text, access_token }),
      stage: 'create',
      timeoutMs: 120_000,
      signal,
    });
    const id = data.post_id || data.id;
    await onProgress?.({ phase: 'created', remoteId: id });
    return { externalId: id, url: `https://www.facebook.com/${id}` };
  }
  const { data } = await call(graphUrl(config, `${pageId}/feed`), {
    method: 'POST',
    body: new URLSearchParams({ message: text, access_token }),
    stage: 'create',
    signal,
  });
  await onProgress?.({ phase: 'created', remoteId: data.id });
  return { externalId: data.id, url: `https://www.facebook.com/${data.id}` };
}

// Text and photo posts show up in the Page's feed with their text; videos are not matched (unknown).
export async function reconcile({ post, account, config, attempt }) {
  if (post.video_url) return { status: 'unknown', reason: 'Video posts can not be matched automatically. Check the Facebook Page and confirm manually.' };
  try {
    const params = new URLSearchParams({ fields: 'id,message,created_time,permalink_url', limit: '15', access_token: account.credentials.access_token });
    const { data } = await call(`${graphUrl(config, `${account.external_id}/posts`)}?${params}`);
    const since = new Date(attempt?.started_at || post.updated_at).getTime() - 120_000;
    const match = (data.data || []).find((p) => (p.message || '').trim() === post.content.trim() && new Date(p.created_time).getTime() >= since);
    if (match) return { status: 'found', externalId: match.id, url: match.permalink_url || `https://www.facebook.com/${match.id}` };
    return { status: 'not_found', reason: 'The post is not among the latest 15 Page posts.' };
  } catch (err) {
    return { status: 'unknown', reason: err.message };
  }
}

export async function test({ account, config }) {
  const params = new URLSearchParams({ fields: 'name', access_token: account.credentials.access_token });
  const { data } = await call(`${graphUrl(config, account.external_id)}?${params}`);
  return `Working: posting to Page "${data.name}"`;
}
