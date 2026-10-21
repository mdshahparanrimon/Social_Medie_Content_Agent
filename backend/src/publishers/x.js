import { TwitterApi } from 'twitter-api-v2';
import { loadImageJpeg, loadVideo } from '../media.js';

// OAuth 1.0a: your app's Consumer Key/Secret + the connected account's access token. These tokens don't expire.

export const appReady = (config) => Boolean(config.x_api_key && config.x_api_secret);

function client(account, config) {
  return new TwitterApi({
    appKey: config.x_api_key,
    appSecret: config.x_api_secret,
    accessToken: account.credentials.access_token,
    accessSecret: account.credentials.access_secret,
  });
}

const errorMessage = (err) => `X: ${err.data?.detail || err.data?.title || err.message}`;

// With an image or video, it's uploaded first (v2 media upload; videos in chunks, then X processes them) and attached.
export async function publish({ text, imageUrl, videoUrl, account, config }) {
  const api = client(account, config).v2;
  try {
    const payload = { text };
    if (videoUrl) {
      const mediaId = await api.uploadMedia(await loadVideo(videoUrl), { media_type: 'video/mp4', media_category: 'tweet_video' });
      payload.media = { media_ids: [mediaId] };
    } else if (imageUrl) {
      const mediaId = await api.uploadMedia(await loadImageJpeg(imageUrl), { media_type: 'image/jpeg', media_category: 'tweet_image' });
      payload.media = { media_ids: [mediaId] };
    }
    const { data } = await api.tweet(payload);
    return { externalId: data.id, url: `https://x.com/i/web/status/${data.id}` };
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}

export async function test({ account, config }) {
  try {
    const { data } = await client(account, config).v2.me();
    return `Working: posting as @${data.username}`;
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}
