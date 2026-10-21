import { loadImageJpeg, loadVideo } from '../media.js';

// Posts to your personal LinkedIn profile. Tokens last 60 days and can't be refreshed without
// LinkedIn partner approval, so you reconnect when it expires.

export const appReady = (config) => Boolean(config.linkedin_client_id && config.linkedin_client_secret);

// LinkedIn's "little text" format treats these characters as markup; unescaped ones can truncate the post.
function escapeCommentary(text) {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, '\\$&');
}

const headers = (account, config) => ({
  Authorization: `Bearer ${account.credentials.access_token}`,
  'Content-Type': 'application/json',
  // LinkedIn supports each monthly API version for about a year; update it in Settings when it gets rejected.
  'LinkedIn-Version': config.linkedin_api_version,
  'X-Restli-Protocol-Version': '2.0.0',
});

// Images API: register the upload, PUT the bytes to the returned URL, then reference the image URN in the post.
async function uploadImage({ imageUrl, author, account, config }) {
  const init = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: headers(account, config),
    body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
  });
  const data = await init.json().catch(() => ({}));
  if (!init.ok || !data.value?.uploadUrl) {
    throw new Error(`LinkedIn image upload (${init.status}): ${data.message || 'could not start the upload'}`);
  }
  const put = await fetch(data.value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${account.credentials.access_token}`, 'Content-Type': 'image/jpeg' },
    body: await loadImageJpeg(imageUrl),
  });
  if (!put.ok) throw new Error(`LinkedIn image upload (${put.status}): the image was rejected.`);
  return data.value.image;
}

// Videos API: register the upload (LinkedIn splits it into parts), PUT each part, then finalize with the parts' ETags.
async function uploadVideo({ videoUrl, author, account, config }) {
  const bytes = await loadVideo(videoUrl);
  const init = await fetch('https://api.linkedin.com/rest/videos?action=initializeUpload', {
    method: 'POST',
    headers: headers(account, config),
    body: JSON.stringify({
      initializeUploadRequest: { owner: author, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false },
    }),
  });
  const data = await init.json().catch(() => ({}));
  const { video, uploadToken = '', uploadInstructions } = data.value || {};
  if (!init.ok || !video || !uploadInstructions?.length) {
    throw new Error(`LinkedIn video upload (${init.status}): ${data.message || 'could not start the upload'}`);
  }
  const uploadedPartIds = [];
  for (const part of uploadInstructions) {
    const put = await fetch(part.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${account.credentials.access_token}`, 'Content-Type': 'application/octet-stream' },
      body: bytes.subarray(part.firstByte, part.lastByte + 1),
    });
    if (!put.ok) throw new Error(`LinkedIn video upload (${put.status}): a part of the video was rejected.`);
    uploadedPartIds.push(put.headers.get('etag'));
  }
  const done = await fetch('https://api.linkedin.com/rest/videos?action=finalizeUpload', {
    method: 'POST',
    headers: headers(account, config),
    body: JSON.stringify({ finalizeUploadRequest: { video, uploadToken, uploadedPartIds } }),
  });
  if (!done.ok) throw new Error(`LinkedIn video upload (${done.status}): ${(await done.text()).slice(0, 200)}`);
  return video;
}

export async function publish({ text, imageUrl, videoUrl, account, config }) {
  const author = `urn:li:person:${account.external_id}`;
  const body = {
    author,
    commentary: escapeCommentary(text),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (videoUrl) body.content = { media: { id: await uploadVideo({ videoUrl, author, account, config }) } };
  else if (imageUrl) body.content = { media: { id: await uploadImage({ imageUrl, author, account, config }) } };

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: headers(account, config),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LinkedIn (${res.status}): ${body.slice(0, 300)}`);
  }
  const urn = res.headers.get('x-restli-id');
  return { externalId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null };
}

export async function fetchProfile(accessToken) {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.sub) {
    throw new Error(
      `LinkedIn (${res.status}): could not read your profile. The app needs the "Sign In with LinkedIn using OpenID Connect" product.`,
    );
  }
  return data;
}

export async function test({ account }) {
  const me = await fetchProfile(account.credentials.access_token);
  return `Working: posting as ${me.name}`;
}
