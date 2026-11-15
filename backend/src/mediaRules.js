// Media limits per platform and format. Every number is a configurable default, not a guarantee of what the platform
// accepts today: platforms change these. Override any value with MEDIA_RULES_JSON (deep-merged), e.g.
//   MEDIA_RULES_JSON={"video":{"instagram":{"maxSeconds":180}},"image":{"x":{"maxBytes":4000000}}}
// RULES_VERSION changes whenever defaults change, so cached validation results are re-run.

export const RULES_VERSION = 2;

const MB = 1024 * 1024;

const DEFAULTS = {
  image: {
    // formats: what the platform itself takes. The app converts uploads to JPEG derivatives before publishing.
    // aspect: [min, max] width/height the platform accepts (hard) ; preferred: [min, max] that looks best (soft).
    // Aspect outside `aspect` is an error only where the platform rejects it (Instagram); elsewhere it is a warning.
    x: { formats: ['jpeg', 'png', 'webp', 'gif'], maxBytes: 5 * MB, minWidth: 200, aspect: null, preferred: [1, 2], altRecommended: true, altMax: 1000 },
    linkedin: { formats: ['jpeg', 'png', 'gif'], maxBytes: 8 * MB, minWidth: 200, maxPixels: 36_152_320, aspect: null, preferred: [0.5, 2.4], altRecommended: true, altMax: 4086 },
    meta: { formats: ['jpeg', 'png', 'gif', 'webp'], maxBytes: 8 * MB, minWidth: 200, aspect: null, preferred: [0.8, 1.91], altRecommended: false },
    instagram: { formats: ['jpeg'], maxBytes: 8 * MB, minWidth: 320, aspect: [0.8, 1.91], preferred: [0.8, 1.25], altRecommended: true, altMax: 1000 },
    // Hard ceilings for every platform: decompression-bomb protection.
    all: { maxPixels: 100_000_000, maxDimension: 12_000 },
  },
  video: {
    // Seconds, bytes and aspect ratios for the post's video. `aspect` is a hard range, `preferred` a soft one.
    x: { formats: ['mp4', 'mov'], maxSeconds: 140, minSeconds: 0.5, maxBytes: 100 * MB, requireAudio: false, preferred: [0.5, 2.4], maxFps: 60 },
    linkedin: { formats: ['mp4', 'mov'], maxSeconds: 600, minSeconds: 3, maxBytes: 100 * MB, requireAudio: false, preferred: [0.5, 2.4], maxFps: 60 },
    meta: { formats: ['mp4', 'mov'], maxSeconds: 14_400, minSeconds: 1, maxBytes: 100 * MB, requireAudio: false, preferred: [0.5, 1.91], maxFps: 60 },
    // Instagram Reels (Graph API docs, checked 2026-10): 3 s to 15 min, 300 MB, H.264/HEVC, AAC, 23-60 fps. maxBytes stays at the app's own 100 MB cap.
    instagram: { formats: ['mp4', 'mov'], maxSeconds: 900, minSeconds: 3, maxBytes: 100 * MB, requireAudio: false, aspect: [0.01, 10], preferred: [0.5, 0.6], maxFps: 60, minFps: 23, codecs: ['h264', 'hevc'] },
  },
  pdf: {
    // LinkedIn document posts. The app's own byte cap is lower than LinkedIn's.
    linkedin: { maxBytes: 30 * MB, maxPages: 300, recommendedPages: [3, 12], preferredOrientation: ['portrait', 'square'], minPageSide: 200, maxPageSide: 14_400 },
  },
  slides: {
    minSlides: 3,
    maxSlides: 12,
    coverHeadingWords: 10,
    headingWords: 10,
    bodyWords: 40,
    // Words are counted by whitespace; scripts written without spaces (e.g. Thai) are measured in characters instead.
    requireClosingCta: true,
  },
};

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base?.[k] ?? {}, v) : v;
  return out;
}

export function loadRules(env = process.env) {
  if (!env.MEDIA_RULES_JSON) return DEFAULTS;
  try {
    return merge(DEFAULTS, JSON.parse(env.MEDIA_RULES_JSON));
  } catch (err) {
    // A broken override must not silently relax validation: fall back to the defaults and say so loudly.
    console.error(`MEDIA_RULES_JSON is not valid JSON (${err.message}); using the default media rules.`);
    return DEFAULTS;
  }
}

export const rulesFor = (kind, platform, env = process.env) => loadRules(env)[kind]?.[platform] ?? null;
