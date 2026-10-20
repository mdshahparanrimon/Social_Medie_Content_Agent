import { isLocalUrl } from '../urls.js';

// Instagram API with Instagram Login: works with a Professional (Creator or Business) account, no Facebook Page needed.
// Long-lived tokens last 60 days and are refreshed automatically (see refreshToken).

export const appReady = (config) => Boolean(config.instagram_app_id && config.instagram_app_secret);

const graphUrl = (config, path) => `https://graph.instagram.com/${config.meta_graph_version}/${path}`;

async function call(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Instagram (${res.status}): ${data.error?.message || 'unknown error'}`);
  return data;
}

export function fetchProfile(config, accessToken) {
  const params = new URLSearchParams({ fields: 'user_id,username,name,profile_picture_url', access_token: accessToken });
  return call(`${graphUrl(config, 'me')}?${params}`);
}

// Instagram publishes in two steps: create a media container from the image URL, wait until it's processed, publish it.
export async function publish({ text, imageUrl, account, config }) {
  if (!imageUrl) throw new Error('Instagram posts need an image. Add one to the post first.');
  if (isLocalUrl(imageUrl)) {
    throw new Error('Instagram cannot download images from localhost. Set up Cloudinary in Settings → Media, then upload the image again.');
  }
  const userId = account.external_id;
  const access_token = account.credentials.access_token;

  const container = await call(graphUrl(config, `${userId}/media`), {
    method: 'POST',
    body: new URLSearchParams({ image_url: imageUrl, caption: text, access_token }),
  });

  for (let attempt = 0; attempt < 15; attempt++) {
    const params = new URLSearchParams({ fields: 'status_code', access_token });
    const { status_code } = await call(`${graphUrl(config, container.id)}?${params}`);
    if (status_code === 'FINISHED') break;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      throw new Error(`Instagram could not process the image (${status_code}). Use a JPEG between 4:5 and 1.91:1.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const published = await call(graphUrl(config, `${userId}/media_publish`), {
    method: 'POST',
    body: new URLSearchParams({ creation_id: container.id, access_token }),
  });
  const params = new URLSearchParams({ fields: 'permalink', access_token });
  const media = await call(`${graphUrl(config, published.id)}?${params}`).catch(() => ({}));
  return { externalId: published.id, url: media.permalink || null };
}

// A long-lived token can be refreshed once it's at least 24 hours old; each refresh gives another 60 days.
export async function refreshToken(account) {
  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: account.credentials.access_token });
  return call(`https://graph.instagram.com/refresh_access_token?${params}`);
}

export async function test({ account, config }) {
  const me = await fetchProfile(config, account.credentials.access_token);
  return `Working: posting as @${me.username}`;
}
