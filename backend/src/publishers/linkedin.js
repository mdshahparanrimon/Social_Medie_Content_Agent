// Posts to your personal LinkedIn profile. Tokens last 60 days and can't be refreshed without
// LinkedIn partner approval, so you reconnect when it expires.

export const appReady = (config) => Boolean(config.linkedin_client_id && config.linkedin_client_secret);

// LinkedIn's "little text" format treats these characters as markup; unescaped ones can truncate the post.
function escapeCommentary(text) {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, '\\$&');
}

// Images aren't uploaded to LinkedIn yet; the post goes out as text.
export async function publish({ text, account, config }) {
  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.credentials.access_token}`,
      'Content-Type': 'application/json',
      // LinkedIn supports each monthly API version for about a year; update it in Settings when it gets rejected.
      'LinkedIn-Version': config.linkedin_api_version,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: `urn:li:person:${account.external_id}`,
      commentary: escapeCommentary(text),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
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
