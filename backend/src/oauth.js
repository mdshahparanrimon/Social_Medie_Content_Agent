import crypto from 'node:crypto';
import { Router } from 'express';
import { TwitterApi } from 'twitter-api-v2';
import { getConfig } from './settings.js';
import { saveAccount, removeAccount, listAccounts } from './accounts.js';
import { PUBLISHERS } from './publishers/index.js';
import { fetchProfile as linkedinProfile } from './publishers/linkedin.js';
import { fetchProfile as instagramProfile } from './publishers/instagram.js';
import { DRIVE, DRIVE_SCOPES, driveAppReady, exchangeCode as exchangeDriveCode } from './drive.js';
import { httpError } from './errors.js';
import { API_URL, FRONTEND_URL } from './urls.js';
import { runInWorkspace, workspaceId } from './context.js';
import { requireAuth } from './auth/session.js';

// One-click "Connect": the browser goes to /start, the platform's login page, then back to /callback,
// where the account is saved and the browser returns to the Connections page.

const PENDING_TTL_MS = 15 * 60 * 1000;

export const callbackUrl = (platform) => `${API_URL}/api/oauth/${platform}/callback`;

// Logins in progress, keyed by state, remembering which workspace started them: the platform's
// callback arrives without the user's session. Kept in memory: after a restart, just click Connect again.
const pending = new Map();
// Facebook Pages waiting to be picked, per workspace, when the account manages more than one.
const pendingPages = new Map();

function remember(key, platform, data = {}) {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  pending.set(key, { platform, data, workspaceId: workspaceId(), expires: now + PENDING_TTL_MS });
  return key;
}

// The state value each platform sends back to the callback.
const stateKey = (platform, query) => String((platform === 'x' ? query.oauth_token || query.denied : query.state) || '');

function take(key, platform) {
  const entry = pending.get(key);
  pending.delete(key);
  if (!entry || entry.platform !== platform || entry.expires < Date.now()) {
    throw new Error('This login expired or was already used. Click Connect again.');
  }
  return entry.data;
}

const newState = () => crypto.randomBytes(16).toString('hex');

async function getJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const graph = (config, path, params) =>
  `https://graph.facebook.com/${config.meta_graph_version}/${path}?${new URLSearchParams(params)}`;

const PROVIDERS = {
  x: {
    setupHint: 'Add the X Consumer Key and Secret in Settings → Platform apps first.',
    async start(config) {
      const client = new TwitterApi({ appKey: config.x_api_key, appSecret: config.x_api_secret });
      const link = await client.generateAuthLink(callbackUrl('x'), { linkMode: 'authorize' });
      remember(link.oauth_token, 'x', { tokenSecret: link.oauth_token_secret });
      return link.url;
    },
    async finish(config, query) {
      if (query.denied) throw new Error('You cancelled the X login.');
      const { tokenSecret } = take(query.oauth_token, 'x');
      const login = await new TwitterApi({
        appKey: config.x_api_key,
        appSecret: config.x_api_secret,
        accessToken: query.oauth_token,
        accessSecret: tokenSecret,
      }).login(query.oauth_verifier);

      // Name and photo are nice-to-have; the connection works without them.
      const profile = await login.client.v2
        .me({ 'user.fields': ['name', 'profile_image_url'] })
        .then((r) => r.data)
        .catch(() => ({}));
      await saveAccount('x', {
        external_id: login.userId,
        name: profile.name || `@${login.screenName}`,
        username: login.screenName,
        avatar_url: profile.profile_image_url || null,
        expires_at: null,
        credentials: { access_token: login.accessToken, access_secret: login.accessSecret },
      });
      return { message: `Connected as @${login.screenName}` };
    },
  },

  linkedin: {
    setupHint: 'Add the LinkedIn Client ID and Secret in Settings → Platform apps first.',
    async start(config) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.linkedin_client_id,
        redirect_uri: callbackUrl('linkedin'),
        state: remember(newState(), 'linkedin'),
        scope: 'openid profile w_member_social',
      });
      return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
    },
    async finish(config, query) {
      if (query.error) throw new Error(`LinkedIn: ${query.error_description || query.error}`);
      take(query.state, 'linkedin');
      const token = await getJSON('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: query.code,
          redirect_uri: callbackUrl('linkedin'),
          client_id: config.linkedin_client_id,
          client_secret: config.linkedin_client_secret,
        }),
      });
      if (!token.ok) throw new Error(`LinkedIn: ${token.data.error_description || token.data.error || token.status}`);

      const me = await linkedinProfile(token.data.access_token);
      await saveAccount('linkedin', {
        external_id: me.sub,
        name: me.name,
        username: null,
        avatar_url: me.picture || null,
        expires_at: new Date(Date.now() + token.data.expires_in * 1000).toISOString(),
        credentials: { access_token: token.data.access_token },
      });
      return { message: `Connected as ${me.name}` };
    },
  },

  meta: {
    setupHint: 'Add the Meta App ID and Secret in Settings → Platform apps first.',
    async start(config) {
      const params = new URLSearchParams({
        client_id: config.meta_app_id,
        redirect_uri: callbackUrl('meta'),
        state: remember(newState(), 'meta'),
        scope: 'pages_show_list,pages_manage_posts,pages_read_engagement',
      });
      return `https://www.facebook.com/${config.meta_graph_version}/dialog/oauth?${params}`;
    },
    async finish(config, query) {
      if (query.error) throw new Error(`Facebook: ${query.error_description || query.error}`);
      take(query.state, 'meta');
      const app = { client_id: config.meta_app_id, client_secret: config.meta_app_secret };
      const fail = (r) => new Error(`Facebook: ${r.data.error?.message || r.status}`);

      const short = await getJSON(graph(config, 'oauth/access_token', { ...app, redirect_uri: callbackUrl('meta'), code: query.code }));
      if (!short.ok) throw fail(short);
      // Page tokens taken from a long-lived user token don't expire.
      const long = await getJSON(
        graph(config, 'oauth/access_token', { ...app, grant_type: 'fb_exchange_token', fb_exchange_token: short.data.access_token }),
      );
      if (!long.ok) throw fail(long);
      const pages = await getJSON(
        graph(config, 'me/accounts', { fields: 'id,name,access_token,picture{url}', access_token: long.data.access_token }),
      );
      if (!pages.ok) throw fail(pages);

      const list = pages.data.data || [];
      if (list.length === 0) {
        throw new Error('No Facebook Pages found. Create a Page, then connect again and allow access to it.');
      }
      if (list.length === 1) return { message: await savePage(list[0]) };
      pendingPages.set(workspaceId(), { pages: list, expires: Date.now() + PENDING_TTL_MS });
      return { choose_page: '1', message: 'Choose which Page to post to.' };
    },
  },

  instagram: {
    setupHint: 'Add the Instagram App ID and Secret in Settings → Platform apps first.',
    async start(config) {
      const params = new URLSearchParams({
        client_id: config.instagram_app_id,
        redirect_uri: callbackUrl('instagram'),
        response_type: 'code',
        scope: 'instagram_business_basic,instagram_business_content_publish',
        state: remember(newState(), 'instagram'),
      });
      return `https://www.instagram.com/oauth/authorize?${params}`;
    },
    async finish(config, query) {
      if (query.error) throw new Error(`Instagram: ${query.error_description || query.error_reason || query.error}`);
      take(query.state, 'instagram');
      const short = await getJSON('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: config.instagram_app_id,
          client_secret: config.instagram_app_secret,
          grant_type: 'authorization_code',
          redirect_uri: callbackUrl('instagram'),
          code: query.code,
        }),
      });
      if (!short.ok) throw new Error(`Instagram: ${short.data.error_message || short.data.error?.message || short.status}`);
      const shortToken = short.data.access_token || short.data.data?.[0]?.access_token;

      // Swap the 1-hour token for a 60-day one (refreshed automatically later).
      const long = await getJSON(
        `https://graph.instagram.com/access_token?${new URLSearchParams({
          grant_type: 'ig_exchange_token',
          client_secret: config.instagram_app_secret,
          access_token: shortToken,
        })}`,
      );
      if (!long.ok) throw new Error(`Instagram: ${long.data.error?.message || long.status}`);

      const me = await instagramProfile(config, long.data.access_token);
      await saveAccount('instagram', {
        external_id: me.user_id || me.id,
        name: me.name || `@${me.username}`,
        username: me.username,
        avatar_url: me.profile_picture_url || null,
        expires_at: new Date(Date.now() + long.data.expires_in * 1000).toISOString(),
        credentials: { access_token: long.data.access_token, refreshed_at: new Date().toISOString() },
      });
      return { message: `Connected as @${me.username}` };
    },
  },

  // Not a place to post: read-only Drive access, so post media can be added from private Drive links.
  [DRIVE]: {
    appReady: driveAppReady,
    setupHint: 'Add the Google Client ID and Secret in Settings → Sign-in & email first.',
    async start(config) {
      const params = new URLSearchParams({
        client_id: config.google_client_id,
        redirect_uri: callbackUrl(DRIVE),
        response_type: 'code',
        scope: DRIVE_SCOPES,
        // offline + consent: Google sends a refresh token, so access lasts beyond the first hour.
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: remember(newState(), DRIVE),
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    },
    async finish(config, query) {
      if (query.error) throw new Error(query.error === 'access_denied' ? 'You cancelled the Google login.' : `Google: ${query.error}`);
      take(query.state, DRIVE);
      const account = await exchangeDriveCode(config, query.code, callbackUrl(DRIVE));
      await saveAccount(DRIVE, account);
      return { message: `Connected to the Drive of ${account.email || account.name}` };
    },
  },
};

// Social platforms are ready once their developer app is set up; Drive uses the Google sign-in client.
const appReady = (platform, config) => (PROVIDERS[platform].appReady || PUBLISHERS[platform].appReady)(config);

async function savePage(page) {
  await saveAccount('meta', {
    external_id: page.id,
    name: page.name,
    username: null,
    avatar_url: page.picture?.data?.url || null,
    expires_at: null,
    credentials: { access_token: page.access_token },
  });
  return `Connected to Page "${page.name}"`;
}

function backToConnections(platform, params) {
  return `${FRONTEND_URL}/connections?${new URLSearchParams({ platform, ...params })}`;
}

function provider(platform) {
  const found = PROVIDERS[platform];
  if (!found) throw httpError(404, `Unknown platform: ${platform}`);
  return found;
}

export const oauthRouter = Router();

// Callback URL and app status per platform, for the setup screens.
oauthRouter.get('/info', requireAuth, async (req, res) => {
  const config = await getConfig();
  res.json(
    Object.fromEntries(
      Object.keys(PROVIDERS).map((platform) => [
        platform,
        { callback_url: callbackUrl(platform), app_ready: appReady(platform, config) },
      ]),
    ),
  );
});

oauthRouter.get('/meta/pages', requireAuth, (req, res) => {
  const choice = pendingPages.get(workspaceId());
  res.json(choice?.expires > Date.now() ? choice.pages.map(({ id, name }) => ({ id, name })) : []);
});

oauthRouter.post('/meta/pages', requireAuth, async (req, res) => {
  const choice = pendingPages.get(workspaceId());
  const page = choice?.expires > Date.now() && choice.pages.find((p) => p.id === req.body.id);
  if (!page) throw httpError(400, 'That choice expired. Click Connect again.');
  pendingPages.delete(workspaceId());
  res.json({ message: await savePage(page), accounts: await listAccounts() });
});

oauthRouter.get('/:platform/start', requireAuth, async (req, res) => {
  const { platform } = req.params;
  const { start, setupHint } = provider(platform);
  try {
    const config = await getConfig();
    if (!appReady(platform, config)) throw new Error(setupHint);
    res.redirect(await start(config));
  } catch (err) {
    res.redirect(backToConnections(platform, { error: err.message }));
  }
});

oauthRouter.get('/:platform/callback', async (req, res) => {
  const { platform } = req.params;
  const { finish } = provider(platform);
  try {
    const entry = pending.get(stateKey(platform, req.query));
    if (!entry) throw new Error('This login expired or was already used. Click Connect again.');
    const result = await runInWorkspace(entry.workspaceId, async () => finish(await getConfig(), req.query));
    res.redirect(backToConnections(platform, result));
  } catch (err) {
    res.redirect(backToConnections(platform, { error: err.message }));
  }
});

oauthRouter.post('/:platform/disconnect', requireAuth, async (req, res) => {
  provider(req.params.platform);
  await removeAccount(req.params.platform);
  res.json(await listAccounts());
});
