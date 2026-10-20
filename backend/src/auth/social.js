import { FRONTEND_URL } from '../urls.js';

// "Continue with Google / LinkedIn" (OpenID Connect). Separate from connecting a LinkedIn account
// for posting: login only asks for name, email and photo. The callback goes through the frontend
// (/api is proxied to this server) so the session cookie belongs to the app's own domain.

export const loginCallbackUrl = (provider) => `${FRONTEND_URL}/api/auth/${provider}/callback`;

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `token request failed (${res.status})`);
  return data;
}

async function getUserInfo(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.sub) throw new Error(data.message || `could not read your profile (${res.status})`);
  return data;
}

// OpenID userinfo -> the fields the app uses.
const profileFrom = (info) => ({
  subject: String(info.sub),
  email: info.email ? String(info.email).trim().toLowerCase() : '',
  emailVerified: info.email_verified === true || info.email_verified === 'true',
  name: info.name || [info.given_name, info.family_name].filter(Boolean).join(' '),
  avatarUrl: info.picture || null,
});

export const LOGIN_PROVIDERS = {
  google: {
    label: 'Google',
    ready: (config) => Boolean(config.google_client_id && config.google_client_secret),
    authorizeUrl: (config, state) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: config.google_client_id,
        redirect_uri: loginCallbackUrl('google'),
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      })}`,
    async profile(config, code) {
      const token = await postForm('https://oauth2.googleapis.com/token', {
        code,
        client_id: config.google_client_id,
        client_secret: config.google_client_secret,
        redirect_uri: loginCallbackUrl('google'),
        grant_type: 'authorization_code',
      });
      return profileFrom(await getUserInfo('https://openidconnect.googleapis.com/v1/userinfo', token.access_token));
    },
  },

  linkedin: {
    label: 'LinkedIn',
    // Same developer app as posting; it needs the "Sign In with LinkedIn using OpenID Connect" product.
    ready: (config) => Boolean(config.linkedin_client_id && config.linkedin_client_secret),
    authorizeUrl: (config, state) =>
      `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({
        response_type: 'code',
        client_id: config.linkedin_client_id,
        redirect_uri: loginCallbackUrl('linkedin'),
        scope: 'openid profile email',
        state,
      })}`,
    async profile(config, code) {
      const token = await postForm('https://www.linkedin.com/oauth/v2/accessToken', {
        grant_type: 'authorization_code',
        code,
        client_id: config.linkedin_client_id,
        client_secret: config.linkedin_client_secret,
        redirect_uri: loginCallbackUrl('linkedin'),
      });
      return profileFrom(await getUserInfo('https://api.linkedin.com/v2/userinfo', token.access_token));
    },
  },
};
