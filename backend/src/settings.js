import { repo } from './db/index.js';
import { encrypt, decrypt } from './crypto.js';
import { httpError } from './errors.js';
import { hasWorkspace } from './context.js';

// Every setting the dashboard can change.
// secret: encrypted in the database and never sent back to the browser.
// env: an old .env variable that is copied into the database once, on startup.
// workspace: each customer sets it for their own workspace. Everything else is app-wide and only the owner (admin) can change it.
export const FIELDS = {
  ai_provider: { default: 'gemini', options: ['gemini', 'openai_compat', 'anthropic'] },
  gemini_api_key: { secret: true, env: 'GEMINI_API_KEY' },
  gemini_model: { default: 'gemini-2.5-flash' },
  gemini_fallback_model: { default: 'gemini-flash-lite-latest' },
  openai_compat_base_url: { default: 'https://api.groq.com/openai/v1' },
  openai_compat_api_key: { secret: true },
  openai_compat_model: { default: 'llama-3.3-70b-versatile' },
  anthropic_api_key: { secret: true, env: 'ANTHROPIC_API_KEY' },
  anthropic_model: { default: 'claude-opus-5-5', env: 'CLAUDE_MODEL' },

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
const visibleFields = (admin) => Object.entries(FIELDS).filter(([, field]) => admin || field.workspace);

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
    if (!field) continue;
    if (!field.workspace && !admin) throw httpError(403, 'Only the app owner can change this setting.');
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

// Before workspaces, dry run and posting times were app-wide. Move them into the owner's workspace once.
export async function moveLegacyWorkspaceSettings() {
  const global = await repo.getSettings();
  const legacy = Object.fromEntries(Object.entries(global).filter(([key, value]) => isWorkspaceField(key) && value != null));
  if (!Object.keys(legacy).length) return;
  await repo.saveWorkspaceSettings(legacy);
  await repo.saveSettings(Object.fromEntries(Object.keys(legacy).map((key) => [key, null])));
  cache = null;
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
