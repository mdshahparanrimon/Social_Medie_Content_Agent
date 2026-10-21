import { loadVideo } from '../media.js';

// Facebook Page posting. Meta's API can't post to personal profiles, only Pages.
// Page tokens taken from a long-lived user token don't expire.

export const appReady = (config) => Boolean(config.meta_app_id && config.meta_app_secret);

const graphUrl = (config, path) => `https://graph.facebook.com/${config.meta_graph_version}/${path}`;

async function graphPost(config, path, params) {
  const res = await fetch(graphUrl(config, path), { method: 'POST', body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Facebook (${res.status}): ${data.error?.message || 'unknown error'}`);
  return data;
}

// Videos are uploaded as a file (so videos stored on this server work too) to the Page's videos.
async function publishVideo({ text, videoUrl, account, config }) {
  const form = new FormData();
  form.append('source', new Blob([await loadVideo(videoUrl)], { type: 'video/mp4' }), 'video.mp4');
  form.append('description', text);
  form.append('access_token', account.credentials.access_token);
  const res = await fetch(`https://graph-video.facebook.com/${config.meta_graph_version}/${account.external_id}/videos`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Facebook video (${res.status}): ${data.error?.message || 'unknown error'}`);
  return { externalId: data.id, url: `https://www.facebook.com/${data.id}` };
}

// With a video: a video post. With an image: a photo post with the text as its caption. Otherwise: a text post.
export async function publish({ text, imageUrl, videoUrl, account, config }) {
  if (videoUrl) return publishVideo({ text, videoUrl, account, config });
  const pageId = account.external_id;
  const access_token = account.credentials.access_token;
  if (imageUrl) {
    const data = await graphPost(config, `${pageId}/photos`, { url: imageUrl, caption: text, access_token });
    const id = data.post_id || data.id;
    return { externalId: id, url: `https://www.facebook.com/${id}` };
  }
  const data = await graphPost(config, `${pageId}/feed`, { message: text, access_token });
  return { externalId: data.id, url: `https://www.facebook.com/${data.id}` };
}

export async function test({ account, config }) {
  const params = new URLSearchParams({ fields: 'name', access_token: account.credentials.access_token });
  const res = await fetch(`${graphUrl(config, account.external_id)}?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Facebook (${res.status}): ${data.error?.message || 'unknown error'}`);
  return `Working: posting to Page "${data.name}"`;
}
