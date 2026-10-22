import { httpError } from './errors.js';
import { getConfig } from './settings.js';
import { getAccount, updateAccount } from './accounts.js';

// Google Drive connection: lets the app download the workspace owner's Drive files by their share link,
// without making them public. Uses the same Google OAuth client as "Continue with Google", with read-only
// Drive access. Stored as the account "google_drive"; Google access tokens last an hour and are renewed
// with the refresh token.

export const DRIVE = 'google_drive';
export const DRIVE_SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.readonly';

export const driveAppReady = (config) => Boolean(config.google_client_id && config.google_client_secret);

// The file id in a Drive / Docs / Slides link, or null for any other link.
export function driveFileId(url) {
  const { hostname, pathname, searchParams } = new URL(url);
  if (!['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'].includes(hostname)) return null;
  if (pathname.includes('/folders/')) throw httpError(400, 'That is a Google Drive folder. Use the link of one file in it.');
  const id = /\/d\/([\w-]+)/.exec(pathname)?.[1] || searchParams.get('id');
  if (!id) throw httpError(400, 'Could not find the file in that Google Drive link.');
  return id;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---- Connect (used by oauth.js) ----

export async function exchangeCode(config, code, redirectUri) {
  const token = await postForm('https://oauth2.googleapis.com/token', {
    code,
    client_id: config.google_client_id,
    client_secret: config.google_client_secret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (!token.ok) throw new Error(`Google: ${token.data.error_description || token.data.error || token.status}`);
  if (!String(token.data.scope || '').includes('drive.readonly')) {
    throw new Error('Google: Drive access was not allowed. Connect again and tick "See and download all your Google Drive files".');
  }
  if (!token.data.refresh_token) {
    throw new Error('Google did not grant lasting access. Remove the app at myaccount.google.com/permissions, then connect again.');
  }
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token.data.access_token}` },
  });
  const me = await res.json().catch(() => ({}));
  return {
    external_id: String(me.sub || ''),
    name: me.name || me.email || 'Google Drive',
    username: null,
    email: me.email || null,
    avatar_url: me.picture || null,
    // The connection itself doesn't expire; only the hourly access token does (kept in credentials).
    expires_at: null,
    credentials: {
      access_token: token.data.access_token,
      refresh_token: token.data.refresh_token,
      token_expires_at: Date.now() + token.data.expires_in * 1000,
    },
  };
}

// ---- Use ----

// A valid access token for the connected Drive, renewed when it's about to expire; null when Drive isn't connected.
async function accessToken() {
  const account = await getAccount(DRIVE);
  if (!account) return null;
  const { credentials } = account;
  if (credentials.token_expires_at - Date.now() > 60_000) return credentials.access_token;

  const config = await getConfig();
  const fresh = await postForm('https://oauth2.googleapis.com/token', {
    client_id: config.google_client_id,
    client_secret: config.google_client_secret,
    refresh_token: credentials.refresh_token,
    grant_type: 'refresh_token',
  });
  if (!fresh.ok) {
    const message = 'Google Drive access was revoked or expired. Reconnect Google Drive on the Connections page.';
    await updateAccount(DRIVE, { status: 'error', last_error: message });
    throw httpError(400, message);
  }
  await updateAccount(DRIVE, {
    status: 'active',
    last_error: null,
    credentials: { ...credentials, access_token: fresh.data.access_token, token_expires_at: Date.now() + fresh.data.expires_in * 1000 },
  });
  return fresh.data.access_token;
}

export async function driveConnected() {
  return Boolean(await getAccount(DRIVE));
}

const GOOGLE_APPS = 'application/vnd.google-apps.';

// Downloads one Drive file with the connected account. Google Docs/Slides files are exported as PDF when
// `exportPdf` is set (e.g. a Slides deck as a LinkedIn carousel). Returns null when Drive isn't connected.
export async function downloadFromDrive(id, { maxBytes, noun, exportPdf = false }) {
  const token = await accessToken();
  if (!token) return null;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;

  const meta = await fetch(`${base}?fields=name,mimeType,size&supportsAllDrives=true`, auth);
  if (!meta.ok) {
    const account = await getAccount(DRIVE);
    if (meta.status === 404 || meta.status === 403) {
      throw httpError(400, `The connected Google account (${account.email || account.name}) can't open that ${noun}. Check that it's in that account's Drive or shared with it.`);
    }
    throw httpError(502, `Google Drive (${meta.status}): could not read the file.`);
  }
  const file = await meta.json();
  const nativeGoogle = file.mimeType.startsWith(GOOGLE_APPS);
  if (nativeGoogle && !exportPdf) throw httpError(400, `That is a Google ${file.mimeType.slice(GOOGLE_APPS.length)} file, not a ${noun}. Download it as a ${noun} and save that to Drive.`);
  if (Number(file.size) > maxBytes) throw httpError(400, `The ${noun} is larger than ${maxBytes / 1024 / 1024} MB.`);

  const url = nativeGoogle ? `${base}/export?mimeType=application%2Fpdf` : `${base}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, auth);
  if (!res.ok) throw httpError(400, `Google Drive (${res.status}): could not download the ${noun}.`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw httpError(400, `The ${noun} is larger than ${maxBytes / 1024 / 1024} MB.`);
  return { buffer, filename: file.name.replace(/\.[a-z0-9]{2,4}$/i, '').trim() };
}

export async function testDrive() {
  const token = await accessToken();
  if (!token) throw new Error('Not connected.');
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Drive (${res.status}): ${data.error?.message || 'could not reach Drive'}`);
  return `Working: reading Drive files of ${data.user?.emailAddress || 'your account'}`;
}
