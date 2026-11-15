import { getConfig } from '../settings.js';
import { getAccount, isExpired } from '../accounts.js';
import { PLATFORMS } from '../platforms.js';
import { PublishError } from './common.js';
import * as x from './x.js';
import * as linkedin from './linkedin.js';
import * as meta from './meta.js';
import * as instagram from './instagram.js';

// Tests replace entries here with fakes; production uses the real publishers.
export const PUBLISHERS = { x, linkedin, meta, instagram };

// Per platform: is the developer app set up, which account is connected, and will posts really go out.
// Platforms without a connected account are simulated; the dry-run setting simulates all of them.
export function platformStatus(config, accounts) {
  return Object.fromEntries(
    Object.entries(PUBLISHERS).map(([key, publisher]) => {
      const account = accounts.find((a) => a.platform === key);
      const usable = Boolean(account) && !isExpired(account) && account.status !== 'error';
      const warnings = [];
      if (key === 'linkedin') {
        const w = linkedin.apiVersionWarning(config.linkedin_api_version);
        if (w) warnings.push(w);
      }
      if (account?.status === 'error' && account.last_error) warnings.push(account.last_error);
      return [
        key,
        {
          app_ready: publisher.appReady(config),
          configured: usable,
          live: usable && !config.dry_run,
          account: account ? account.name : null,
          expires_at: account?.expires_at || null,
          expired: isExpired(account),
          warnings,
        },
      ];
    }),
  );
}

/**
 * Publishes one post. ctx: { attemptId, onProgress(event), signal }.
 * Throws PublishError (classified: retryable / uncertain / needsReconnect) or resolves to { simulated, externalId, url }.
 */
export async function publishToPlatform(post, ctx = {}) {
  const publisher = PUBLISHERS[post.platform];
  if (!publisher) throw new PublishError(`Unknown platform: ${post.platform}`);
  const meta_ = PLATFORMS[post.platform];
  if (meta_.needsImage && !post.image_url && !post.video_url) throw new PublishError(`${meta_.label} posts need an image or a video.`);
  if (post.video_status === 'generating') throw new PublishError('The video is still being made. Publish once it is ready.');
  const [config, account] = await Promise.all([getConfig(), getAccount(post.platform)]);
  if (config.dry_run || !account) {
    return { simulated: true, externalId: `simulated-${Date.now()}`, url: null };
  }
  if (isExpired(account) || account.status === 'error') {
    throw new PublishError(`The ${meta_.label} connection expired or was rejected. Reconnect it on the Connections page.`, { code: 'AUTH', needsReconnect: true });
  }
  return {
    simulated: false,
    // A post with a video goes out as a video post; the image is used only when there's no video.
    // A PDF carousel (LinkedIn) wins over both; the publisher picks it.
    ...(await publisher.publish({
      text: post.content,
      imageUrl: post.video_url ? null : post.image_url,
      imageAlt: post.image_alt || null,
      videoUrl: post.video_url || null,
      documentUrl: (meta_.documents && post.document_url) || null,
      documentTitle: post.document_title || null,
      account,
      config,
      attemptId: ctx.attemptId,
      onProgress: ctx.onProgress,
      signal: ctx.signal,
    })),
  };
}

/** Asks the platform whether an uncertain post exists. Resolves to { status: 'found'|'not_found'|'unknown', ... }. */
export async function reconcileOnPlatform(post, attempt) {
  const publisher = PUBLISHERS[post.platform];
  const [config, account] = await Promise.all([getConfig(), getAccount(post.platform)]);
  if (!publisher?.reconcile || !account) return { status: 'unknown', reason: 'The account is not connected, so the platform can not be asked.' };
  return publisher.reconcile({ post, account, config, attempt });
}

export async function testAccount(platform) {
  const publisher = PUBLISHERS[platform];
  if (!publisher) throw new Error(`Unknown platform: ${platform}`);
  const account = await getAccount(platform);
  if (!account) throw new Error('Not connected.');
  return publisher.test({ account, config: await getConfig() });
}
