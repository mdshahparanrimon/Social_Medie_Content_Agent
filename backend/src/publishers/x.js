import { TwitterApi } from 'twitter-api-v2';

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

// Images aren't uploaded to X yet; the post goes out as text.
export async function publish({ text, account, config }) {
  try {
    const { data } = await client(account, config).v2.tweet(text);
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
