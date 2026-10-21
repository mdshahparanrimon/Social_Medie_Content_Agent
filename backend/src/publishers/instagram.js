import { isLocalUrl } from '../urls.js';

// Instagram API with Instagram Login: works with a Professional (Creator or Business) account, no Facebook Page needed.
// Long-lived tokens last 60 days and are refreshed automatically (see refreshToken).

export const appReady = (config) => Boolean(config.instagram_app_id && config.instagram_app_secret);

const graphUrl = (config, path) => `https://graph.instagram.com/${config.meta_graph_version}/${path}`;

async function call(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  // error_user_msg is Instagram's plain-language explanation (e.g. an unsupported aspect ratio); prefer it when present.
  if (!res.ok) throw new Error(`Instagram (${res.status}): ${data.error?.error_user_msg || data.error?.message || 'unknown error'}`);
  return data;
}

export function fetchProfile(config, accessToken) {
  const params = new URLSearchParams({ fields: 'user_id,username,name,profile_picture_url', access_token: accessToken });
  return call(`${graphUrl(config, 'me')}?${params}`);
}

// Instagram publishes in two steps: create a media container from the image (or video) URL, wait until it's
// processed, publish it. A video goes out as a Reel, which takes Instagram longer to process.
export async function publish({ text, imageUrl, videoUrl, account, config }) {
  const mediaUrl = videoUrl || imageUrl;
  const noun = videoUrl ? 'video' : 'image';
  if (!mediaUrl) throw new Error('Instagram posts need an image or a video. Add one to the post first.');
  if (isLocalUrl(mediaUrl)) {
    throw new Error(`Instagram cannot download ${noun}s from localhost. Set up Cloudinary in Settings → Media, then add the ${noun} again.`);
  }
  const userId = account.external_id;
  const access_token = account.credentials.access_token;

  const source = videoUrl ? { media_type: 'REELS', video_url: videoUrl, share_to_feed: 'true' } : { image_url: imageUrl };
  const container = await call(graphUrl(config, `${userId}/media`), {
    method: 'POST',
    body: new URLSearchParams({ ...source, caption: text, access_token }),
  });

  const [attempts, waitMs] = videoUrl ? [60, 5000] : [30, 2000];
  let ready = false;
  for (let attempt = 0; attempt < attempts && !ready; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const params = new URLSearchParams({ fields: 'status_code', access_token });
    const { status_code } = await call(`${graphUrl(config, container.id)}?${params}`);
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      throw new Error(
        videoUrl
          ? `Instagram could not process the video (${status_code}). Reels need an MP4 between 3 and 90 seconds.`
          : `Instagram could not process the image (${status_code}). Use a JPEG between 4:5 and 1.91:1.`,
      );
    }
    ready = status_code === 'FINISHED';
  }
  // Publishing an unfinished container fails with a confusing "media not ready" error, and nothing was posted yet.
  if (!ready) throw new Error(`Instagram is still processing the ${noun}. Nothing was posted; try publishing again in a minute.`);

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
