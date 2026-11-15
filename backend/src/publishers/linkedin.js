import { loadDocument, loadImageJpeg, loadVideo } from '../media.js';
import { PublishError, api } from './common.js';

// Posts to your personal LinkedIn profile. Tokens last 60 days and can't be refreshed without
// LinkedIn partner approval, so you reconnect when it expires.
// Requires the "Share on LinkedIn" product (w_member_social). Reading posts back (r_member_social) is restricted to
// approved apps, so a post whose outcome is uncertain can not be looked up here and needs a person to confirm it.

export const appReady = (config) => Boolean(config.linkedin_client_id && config.linkedin_client_secret);

const LABEL = 'LinkedIn';

// LinkedIn's "little text" format treats these characters as markup; unescaped ones can truncate the post or turn
// into mentions. A "#" that starts a hashtag is left alone: LinkedIn turns a plain "#word" into a hashtag
// (Posts API docs, "Hashtag a keyword"); an escaped one would show as plain text.
export function escapeCommentary(text) {
  return text.replace(/[\\|{}@[\]()<>*_~]|#(?![\p{L}\p{N}_])/gu, '\\$&');
}

// LinkedIn supports each monthly API version for about a year and then rejects it.
export function apiVersionWarning(version, now = new Date()) {
  const m = /^(\d{4})(0[1-9]|1[0-2])$/.exec(String(version || ''));
  if (!m) return `LinkedIn API version "${version}" is not in YYYYMM format.`;
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const monthsOld = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
  if (monthsOld > 12) return `LinkedIn API version ${version} is more than a year old and is probably no longer accepted. Update it in Settings → Platforms.`;
  if (monthsOld >= 10) return `LinkedIn API version ${version} will stop working within about ${Math.max(1, 12 - monthsOld + 1)} month(s). Update it in Settings → Platforms.`;
  return null;
}

const headers = (account, config) => ({
  Authorization: `Bearer ${account.credentials.access_token}`,
  'Content-Type': 'application/json',
  'LinkedIn-Version': config.linkedin_api_version,
  'X-Restli-Protocol-Version': '2.0.0',
});

const call = (url, opts) => api(url, { label: LABEL, ...opts });

async function initUpload(kind, body, { account, config, signal }) {
  const { data } = await call(`https://api.linkedin.com/rest/${kind}?action=initializeUpload`, {
    method: 'POST',
    headers: headers(account, config),
    body: JSON.stringify(body),
    signal,
  });
  return data?.value || {};
}

// Images API: register the upload, PUT the bytes to the returned URL, then reference the image URN in the post.
async function uploadImage({ imageUrl, author, account, config, signal }) {
  const value = await initUpload('images', { initializeUploadRequest: { owner: author } }, { account, config, signal });
  if (!value.uploadUrl) throw new PublishError('LinkedIn image upload: no upload address was returned.', { retryable: true });
  await call(value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${account.credentials.access_token}`, 'Content-Type': 'image/jpeg' },
    body: await loadImageJpeg(imageUrl),
    parse: 'none',
    timeoutMs: 120_000,
    signal,
  });
  return value.image;
}

// Videos API: register the upload (LinkedIn splits it into parts), PUT each part, then finalize with the parts' ETags.
async function uploadVideo({ videoUrl, author, account, config, signal }) {
  const bytes = await loadVideo(videoUrl);
  const value = await initUpload('videos', { initializeUploadRequest: { owner: author, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } }, { account, config, signal });
  const { video, uploadToken = '', uploadInstructions } = value;
  if (!video || !uploadInstructions?.length) throw new PublishError('LinkedIn video upload: no upload instructions were returned.', { retryable: true });
  const uploadedPartIds = [];
  for (const part of uploadInstructions) {
    const { res } = await call(part.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${account.credentials.access_token}`, 'Content-Type': 'application/octet-stream' },
      body: bytes.subarray(part.firstByte, part.lastByte + 1),
      parse: 'none',
      timeoutMs: 180_000,
      signal,
    });
    uploadedPartIds.push(res.headers.get('etag'));
  }
  await call('https://api.linkedin.com/rest/videos?action=finalizeUpload', {
    method: 'POST',
    headers: headers(account, config),
    body: JSON.stringify({ finalizeUploadRequest: { video, uploadToken, uploadedPartIds } }),
    parse: 'none',
    signal,
  });
  return video;
}

// Documents API (PDF carousels): same flow as images, a single PUT of the whole file.
async function uploadDocument({ documentUrl, author, account, config, signal }) {
  const value = await initUpload('documents', { initializeUploadRequest: { owner: author } }, { account, config, signal });
  if (!value.uploadUrl) throw new PublishError('LinkedIn PDF upload: no upload address was returned.', { retryable: true });
  await call(value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${account.credentials.access_token}`, 'Content-Type': 'application/pdf' },
    body: await loadDocument(documentUrl),
    parse: 'none',
    timeoutMs: 120_000,
    signal,
  });
  return value.document;
}

// One media per post: a PDF carousel wins over a video, a video over an image.
export async function publish({ text, imageUrl, videoUrl, documentUrl, documentTitle, imageAlt, account, config, onProgress, signal }) {
  const author = `urn:li:person:${account.external_id}`;
  const body = {
    author,
    commentary: escapeCommentary(text),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (documentUrl) {
    const id = await uploadDocument({ documentUrl, author, account, config, signal });
    body.content = { media: { title: documentTitle || 'Carousel', id } };
  } else if (videoUrl) body.content = { media: { id: await uploadVideo({ videoUrl, author, account, config, signal }) } };
  else if (imageUrl) {
    const media = { id: await uploadImage({ imageUrl, author, account, config, signal }) };
    if (imageAlt?.trim()) media.altText = imageAlt.trim().slice(0, 4086);
    body.content = { media };
  }

  // From here on LinkedIn may create the post. If this call fails without a clear answer, the outcome is uncertain.
  await onProgress?.({ phase: 'creating' });
  const { res } = await call('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: headers(account, config),
    body: JSON.stringify(body),
    stage: 'create',
    parse: 'none',
    signal,
  });
  const urn = res.headers.get('x-restli-id');
  if (urn) await onProgress?.({ phase: 'created', remoteId: urn });
  return { externalId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null };
}

// LinkedIn gives apps no way to list a member's posts (r_member_social is restricted), so this can't be checked automatically.
export async function reconcile() {
  return { status: 'unknown', reason: 'LinkedIn does not let this app read posts back. Check your LinkedIn profile and confirm manually.' };
}

export async function fetchProfile(accessToken) {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.sub) {
    throw new Error(`LinkedIn (${res.status}): could not read your profile. The app needs the "Sign In with LinkedIn using OpenID Connect" product.`);
  }
  return data;
}

export async function test({ account, config }) {
  const me = await fetchProfile(account.credentials.access_token);
  const warning = apiVersionWarning(config?.linkedin_api_version);
  return `Working: posting as ${me.name}${warning ? `. Warning: ${warning}` : ''}`;
}
