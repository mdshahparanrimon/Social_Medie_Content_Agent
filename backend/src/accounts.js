import { repo } from './db/index.js';
import { encrypt, decrypt } from './crypto.js';

// Connected social accounts, one per platform. Tokens live in `credentials`, encrypted as a whole.

function withCredentials(doc) {
  if (!doc) return null;
  const { credentials, ...rest } = doc;
  return { ...rest, credentials: JSON.parse(decrypt(credentials) || '{}') };
}

// What the browser may see: no tokens.
function publicView(doc) {
  const { credentials, ...rest } = doc;
  return rest;
}

export async function getAccount(platform) {
  return withCredentials(await repo.getAccount(platform));
}

export async function listAccounts() {
  return (await repo.listAccounts()).map(publicView);
}

export async function saveAccount(platform, { credentials, ...fields }) {
  const now = new Date().toISOString();
  await repo.upsertAccount(platform, {
    ...fields,
    credentials: encrypt(JSON.stringify(credentials)),
    status: 'active',
    last_error: null,
    connected_at: now,
  });
}

export async function updateAccount(platform, { credentials, ...fields }) {
  const update = { ...fields };
  if (credentials) update.credentials = encrypt(JSON.stringify(credentials));
  await repo.updateAccount(platform, update);
}

export async function removeAccount(platform) {
  await repo.deleteAccount(platform);
}

export function isExpired(account) {
  return Boolean(account?.expires_at && new Date(account.expires_at).getTime() <= Date.now());
}

// Earlier versions kept tokens in settings. Move them into accounts once.
export async function migrateLegacyTokens() {
  const raw = await repo.getSettings();
  const read = (key) => (raw[key] ? decrypt(raw[key]) : null);
  const moved = [];

  if (raw.x_access_token && !(await repo.getAccount('x'))) {
    await saveAccount('x', {
      external_id: '',
      name: raw.x_account || 'X account',
      username: (raw.x_account || '').replace(/^@/, ''),
      avatar_url: null,
      expires_at: null,
      credentials: { access_token: read('x_access_token'), access_secret: read('x_access_secret') },
    });
    moved.push('X');
  }
  if (raw.linkedin_access_token && raw.linkedin_author_urn && !(await repo.getAccount('linkedin'))) {
    await saveAccount('linkedin', {
      external_id: raw.linkedin_author_urn.replace('urn:li:person:', ''),
      name: raw.linkedin_account || 'LinkedIn profile',
      username: null,
      avatar_url: null,
      expires_at: raw.linkedin_token_expires_at || null,
      credentials: { access_token: read('linkedin_access_token') },
    });
    moved.push('LinkedIn');
  }
  if (raw.meta_page_access_token && raw.meta_page_id && !(await repo.getAccount('meta'))) {
    await saveAccount('meta', {
      external_id: raw.meta_page_id,
      name: raw.meta_page_name || 'Facebook Page',
      username: null,
      avatar_url: null,
      expires_at: null,
      credentials: { access_token: read('meta_page_access_token') },
    });
    moved.push('Facebook');
  }

  const legacyKeys = [
    'x_access_token', 'x_access_secret', 'x_account',
    'linkedin_access_token', 'linkedin_author_urn', 'linkedin_account', 'linkedin_token_expires_at',
    'meta_page_id', 'meta_page_access_token', 'meta_page_name',
  ];
  if (legacyKeys.some((key) => key in raw)) {
    await repo.saveSettings(Object.fromEntries(legacyKeys.map((key) => [key, null])));
  }
  if (moved.length) console.log(`Moved saved connections to Connections: ${moved.join(', ')}`);
}
