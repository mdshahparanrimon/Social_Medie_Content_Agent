import { getConfig } from '../settings.js';
import { getAccount, isExpired } from '../accounts.js';
import { PLATFORMS } from '../platforms.js';
import * as x from './x.js';
import * as linkedin from './linkedin.js';
import * as meta from './meta.js';
import * as instagram from './instagram.js';

export const PUBLISHERS = { x, linkedin, meta, instagram };

// Per platform: is the developer app set up, which account is connected, and will posts really go out.
// Platforms without a connected account are simulated; the dry-run setting simulates all of them.
export function platformStatus(config, accounts) {
  return Object.fromEntries(
    Object.entries(PUBLISHERS).map(([key, publisher]) => {
      const account = accounts.find((a) => a.platform === key);
      const usable = Boolean(account) && !isExpired(account);
      return [
        key,
        {
          app_ready: publisher.appReady(config),
          configured: usable,
          live: usable && !config.dry_run,
          account: account ? account.name : null,
          expires_at: account?.expires_at || null,
          expired: isExpired(account),
        },
      ];
    }),
  );
}

export async function publishToPlatform(post) {
  const publisher = PUBLISHERS[post.platform];
  if (!publisher) throw new Error(`Unknown platform: ${post.platform}`);
  if (PLATFORMS[post.platform].needsImage && !post.image_url && !post.video_url) {
    throw new Error(`${PLATFORMS[post.platform].label} posts need an image or a video.`);
  }
  if (post.video_status === 'generating') throw new Error('The video is still being made. Publish once it is ready.');
  const [config, account] = await Promise.all([getConfig(), getAccount(post.platform)]);
  if (config.dry_run || !account) {
    return { simulated: true, externalId: `simulated-${Date.now()}`, url: null };
  }
  if (isExpired(account)) {
    throw new Error(`The ${PLATFORMS[post.platform].label} connection expired. Reconnect it on the Connections page.`);
  }
  return {
    simulated: false,
    // A post with a video goes out as a video post; the image is used only when there's no video.
    // A PDF carousel (LinkedIn) wins over both; the publisher picks it.
    ...(await publisher.publish({
      text: post.content,
      imageUrl: post.video_url ? null : post.image_url,
      videoUrl: post.video_url || null,
      documentUrl: (PLATFORMS[post.platform].documents && post.document_url) || null,
      documentTitle: post.document_title || null,
      account,
      config,
    })),
  };
}

export async function testAccount(platform) {
  const publisher = PUBLISHERS[platform];
  if (!publisher) throw new Error(`Unknown platform: ${platform}`);
  const account = await getAccount(platform);
  if (!account) throw new Error('Not connected.');
  return publisher.test({ account, config: await getConfig() });
}
