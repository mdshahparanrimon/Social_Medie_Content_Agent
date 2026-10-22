import { repo } from './db/index.js';
import { encrypt, decrypt } from './crypto.js';
import { httpError } from './errors.js';
import { hasWorkspace, runInWorkspace } from './context.js';

// Every setting the dashboard can change.
// secret: encrypted in the database and never sent back to the browser.
// env: an old .env variable that is copied into the database once, on startup.
// workspace: each customer sets it for their own workspace. Everything else is app-wide and only the owner (admin) can change it.
export const FIELDS = {
  // AI: every workspace brings its own provider and key; nobody's usage runs on someone else's key.
  // 'mcp': no API key; the user's own Claude (claude.ai) writes through the MCP connector (see mcp.js).
  ai_provider: { default: 'gemini', options: ['gemini', 'openai_compat', 'anthropic', 'mcp'], workspace: true },
  gemini_api_key: { secret: true, workspace: true },
  gemini_model: { default: 'gemini-2.5-flash', workspace: true },
  gemini_fallback_model: { default: 'gemini-flash-lite-latest', workspace: true },
  openai_compat_base_url: { default: 'https://api.groq.com/openai/v1', workspace: true },
  openai_compat_api_key: { secret: true, workspace: true },
  openai_compat_model: { default: 'llama-3.3-70b-versatile', workspace: true },
  anthropic_api_key: { secret: true, workspace: true },
  anthropic_model: { default: 'claude-opus-5-5', workspace: true },
  // AI images (see llm/image.js): Gemini, or an OpenAI-style /images/generations model.
  gemini_image_model: { default: 'gemini-3.1-flash-image', workspace: true },
  openai_compat_image_model: { workspace: true },
  // AI video: Gemini Omni Flash (Interactions API) with the Gemini key, or an OpenAI-compatible /videos API (Sora).
  gemini_video_model: { default: 'gemini-omni-1.1-flash', workspace: true },
  openai_compat_video_model: { workspace: true },
  // internal: managed by the server (mcp.js), never sent to or saved from the browser.
  mcp_token_hash: { workspace: true, internal: true },
  mcp_token_created_at: { workspace: true, internal: true },
  // Last request from Claude through the connector, so Settings can show that it's really connected.
  mcp_last_used_at: { workspace: true, internal: true },
  mcp_last_client: { workspace: true, internal: true },
  mcp_last_tool: { workspace: true, internal: true },

  dry_run: { type: 'boolean', default: false, workspace: true },
  post_time_x: { type: 'time', default: '10:00', workspace: true },
  post_time_linkedin: { type: 'time', default: '09:00', workspace: true },
  post_time_meta: { type: 'time', default: '13:00', workspace: true },
  post_time_instagram: { type: 'time', default: '18:00', workspace: true },

  // Sign-up and login.
  allow_signups: { type: 'boolean', default: true },
  google_client_id: {},
  google_client_secret: { secret: true },
  // Emails (verification, password reset) are sent with Resend. Without a key, links are printed in the server console.
  resend_api_key: { secret: true, env: 'RESEND_API_KEY' },
  email_from: { default: 'Content Agent <onboarding@resend.dev>', env: 'EMAIL_FROM' },

  // Platform apps: your developer apps, set up once. The accounts you connect with them live in `accounts`.
  x_api_key: { secret: true, env: 'X_API_KEY' },
  x_api_secret: { secret: true, env: 'X_API_SECRET' },

  linkedin_client_id: {},
  linkedin_client_secret: { secret: true },
  linkedin_api_version: { default: '202608', env: 'LINKEDIN_API_VERSION' },

  meta_app_id: {},
  meta_app_secret: { secret: true },
  meta_graph_version: { default: 'v23.0', env: 'META_GRAPH_VERSION' },

  instagram_app_id: {},
  instagram_app_secret: { secret: true },

  // Image hosting, so Instagram can download post images.
  cloudinary_cloud_name: {},
  cloudinary_api_key: {},
  cloudinary_api_secret: { secret: true },
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

let cache = null;

async function stored() {
  if (!cache) cache = await repo.getSettings();
  return cache;
}

const isWorkspaceField = (key) => Boolean(FIELDS[key]?.workspace);
const visibleFields = (admin) => Object.entries(FIELDS).filter(([, field]) => !field.internal && (admin || field.workspace));

export const PRIVATE_HOST =/^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i;

// The server calls this URL, so members may only point it at a public HTTPS address, not the server's own network.
function checkPublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, 'Base URL must be a full address, e.g. https://openrouter.ai/api/v1');
  }
  if (url.protocol !== 'https:' || PRIVATE_HOST.test(url.hostname)) {
    throw httpError(400, 'Base URL must be a public https:// address.');
  }
}

function defaultValue(field) {
  return field.default ?? (field.type === 'boolean' ? false : '');
}

// Full config for server-side use, with secrets decrypted: app-wide values plus the current workspace's own.
export async function getConfig() {
  const global = await stored();
  const own = hasWorkspace() ? await repo.getWorkspaceSettings() : {};
  return Object.fromEntries(
    Object.entries(FIELDS).map(([key, field]) => {
      const value = field.workspace ? own[key] : global[key];
      if (value == null || value === '') return [key, defaultValue(field)];
      return [key, field.secret ? (decrypt(value) ?? '') : value];
    }),
  );
}

// What the browser sees: secrets only as "set" plus their last 4 characters. Non-admins see only their workspace's settings.
export async function getPublicSettings({ admin = false } = {}) {
  const config = await getConfig();
  return Object.fromEntries(
    visibleFields(admin).map(([key, field]) => {
      if (!field.secret) return [key, config[key]];
      const value = config[key];
      return [key, { set: Boolean(value), hint: value ? `••••${value.slice(-4)}` : '' }];
    }),
  );
}

// For secrets: a non-empty string replaces the saved value, '' keeps it, null removes it.
export async function saveSettings(input, { admin = false } = {}) {
  const updates = {};
  for (const [key, value] of Object.entries(input || {})) {
    const field = FIELDS[key];
    if (!field || field.internal) continue;
    if (!field.workspace && !admin) throw httpError(403, 'Only the app owner can change this setting.');
    if (key === 'openai_compat_base_url' && !admin && value) checkPublicUrl(String(value).trim());
    if (field.secret) {
      if (value === null) updates[key] = null;
      else if (typeof value === 'string' && value.trim()) updates[key] = encrypt(value.trim());
    } else if (field.type === 'boolean') {
      updates[key] = Boolean(value);
    } else if (field.type === 'time') {
      if (!TIME.test(value || '')) throw httpError(400, `Invalid time "${value}". Use HH:MM.`);
      updates[key] = value;
    } else if (field.options) {
      if (!field.options.includes(value)) throw httpError(400, `${key} must be one of: ${field.options.join(', ')}.`);
      updates[key] = value;
    } else {
      updates[key] = String(value ?? '').trim();
    }
  }
  const pick = (workspace) => Object.fromEntries(Object.entries(updates).filter(([key]) => isWorkspaceField(key) === workspace));
  const own = pick(true);
  const global = pick(false);
  if (Object.keys(own).length) await repo.saveWorkspaceSettings(own);
  if (Object.keys(global).length) {
    await repo.saveSettings(global);
    cache = null;
  }
  return getPublicSettings({ admin });
}

// Settings that used to be app-wide (dry run, posting times, the AI keys) move into the owner's workspace once.
// Values the workspace already has win.
export async function moveLegacyWorkspaceSettings() {
  const global = await repo.getSettings();
  const legacy = Object.fromEntries(Object.entries(global).filter(([key, value]) => isWorkspaceField(key) && value != null));
  if (!Object.keys(legacy).length) return;
  const own = await repo.getWorkspaceSettings();
  const missing = Object.fromEntries(Object.entries(legacy).filter(([key]) => own[key] == null || own[key] === ''));
  if (Object.keys(missing).length) await repo.saveWorkspaceSettings(missing);
  await repo.saveSettings(Object.fromEntries(Object.keys(legacy).map((key) => [key, null])));
  cache = null;
}

// On startup: an app that already has an owner still gets its old app-wide values moved (sign-up only does it for the first user).
export async function moveLegacySettingsToOwner() {
  const owner = (await repo.listUsers()).filter((user) => user.role === 'admin').at(-1);
  if (owner?.workspace_id) await runInWorkspace(owner.workspace_id, moveLegacyWorkspaceSettings);
}

// Copies settings that still live in .env into the database, once. After that the dashboard is the source of truth.
export async function importSettingsFromEnv() {
  const values = await stored();
  const imported = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    if (field.workspace) continue;
    const envValue = field.env && process.env[field.env];
    if (!envValue || (values[key] != null && values[key] !== '')) continue;
    imported[key] = field.type === 'boolean' ? envValue === 'true' : envValue;
  }
  const keys = Object.keys(imported);
  if (keys.length) {
    await saveSettings(imported, { admin: true });
    const envNames = keys.map((key) => FIELDS[key].env).join(', ');
    console.log(`Imported from .env into the database: ${envNames}. You can now delete these lines from .env.`);
  }
}

// The next fixed posting slot for a platform: on `date` (YYYY-MM-DD) if given, else today.
// Slots already in the past roll forward to the next day.
export async function defaultScheduleTime(platform, date) {
  const config = await getConfig();
  const [hours, minutes] = config[`post_time_${platform}`].split(':').map(Number);
  const slot = date ? new Date(`${date}T00:00:00`) : new Date();
  slot.setHours(hours, minutes, 0, 0);
  const now = new Date();
  while (slot <= now) slot.setDate(slot.getDate() + 1);
  return slot.toISOString();
}
