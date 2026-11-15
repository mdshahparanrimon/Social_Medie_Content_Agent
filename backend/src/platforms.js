import twitterText from 'twitter-text';

// Per-platform writing rules. The frontend keeps a copy of the labels and limits in lib/api.js.
// image: the AI image model is asked for `aspect`; the result is cropped to width x height.
// video: AI video models make 16:9 or 9:16 only, so each platform gets the closer of the two.
// hashtags: the usual range for good posts (a brand's hashtag policy can narrow it, see quality/lint.js).
// hookChars: roughly how much of the text shows before the platform's "see more" cut.
// ideal: a comfortable length range in characters; outside it is a warning, not an error.
// altText: whether the publisher sends alt text to the platform (true only where the API call exists in publishers/).
// linksClickable: false means a pasted URL is plain text (Instagram captions).
export const PLATFORMS = {
  x: {
    label: 'X',
    maxChars: 280,
    hashtags: { min: 0, max: 2 },
    hookChars: 100,
    ideal: [40, 270],
    altText: false,
    linksClickable: true,
    image: { aspect: '16:9', width: 1600, height: 900 },
    video: { aspect: '16:9' },
    guide: [
      'A single post (not a thread), at most 280 weighted characters (links count as 23, emoji as 2) including hashtags.',
      'Punchy first line, one clear idea, conversational. No markdown formatting.',
      'Use 0-2 hashtags, only if they add reach.',
    ].join('\n'),
  },
  linkedin: {
    label: 'LinkedIn',
    maxChars: 3000,
    hashtags: { min: 0, max: 5 },
    hookChars: 140,
    ideal: [600, 1300],
    altText: true,
    linksClickable: true,
    image: { aspect: '1:1', width: 1200, height: 1200 },
    video: { aspect: '16:9' },
    // PDF carousels (document posts); the caption is the post text.
    documents: true,
    guide: [
      'Professional but human. Ideal length 600-1300 characters, never above 3000.',
      'The first 2 lines must hook the reader (they show before "see more").',
      'Short paragraphs with line breaks; lists are fine. No markdown formatting (no **bold**).',
      'End with a question or clear takeaway, then 3-5 relevant hashtags.',
    ].join('\n'),
  },
  meta: {
    label: 'Facebook',
    maxChars: 5000,
    hashtags: { min: 0, max: 3 },
    hookChars: 125,
    ideal: [150, 1500],
    altText: false,
    linksClickable: true,
    image: { aspect: '1:1', width: 1200, height: 1200 },
    video: { aspect: '9:16' },
    guide: [
      'A Facebook Page post. Warm, conversational, community-oriented; write to "you", not at an audience.',
      'Ideal length 40-250 words; the first ~125 characters show before "See more". No markdown formatting.',
      'One link at most, placed on its own line near the end; Facebook previews it. A photo post with the text as caption usually beats a bare link.',
      'Ask a question or give one clear next step. Use 0-3 hashtags.',
      'Videos: square or vertical, captions burned in (most people watch muted).',
    ].join('\n'),
  },
  instagram: {
    label: 'Instagram',
    maxChars: 2200,
    needsImage: true,
    hashtags: { min: 0, max: 8 },
    hookChars: 125,
    ideal: [100, 1500],
    altText: true,
    linksClickable: false,
    image: { aspect: '4:5', width: 1080, height: 1350 },
    // Posted as a Reel.
    video: { aspect: '9:16' },
    guide: [
      'The caption for a single-image Instagram post. The image is added separately; do not describe it as "this image".',
      'The first line is the hook (only about 125 characters show before "more").',
      'Short paragraphs with line breaks, a few emoji are fine. No markdown formatting.',
      'Links are not clickable on Instagram; say "link in bio" instead.',
      'End with a call to action, then 3-8 relevant hashtags. Maximum 2200 characters.',
    ].join('\n'),
  },
};

export const PLATFORM_KEYS = Object.keys(PLATFORMS);

// X's real counting rules (twitter-text, X's own library): NFC-normalised text, most emoji and CJK/Bengali/etc. count
// as 2, every link (including bare "example.com") counts as 23. Other platforms count Unicode characters.
export function charCount(platform, text) {
  if (platform !== 'x') return [...text].length;
  return twitterText.parseTweet(text).weightedLength;
}
