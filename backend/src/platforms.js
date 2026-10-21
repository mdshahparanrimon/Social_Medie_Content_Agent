// Per-platform writing rules. The frontend keeps a copy of the labels and limits in lib/api.js.
// image: the AI image model is asked for `aspect`; the result is cropped to width x height.
// video: AI video models make 16:9 or 9:16 only, so each platform gets the closer of the two.
export const PLATFORMS = {
  x: {
    label: 'X',
    maxChars: 280,
    image: { aspect: '16:9', width: 1600, height: 900 },
    video: { aspect: '16:9' },
    guide: [
      'A single post (not a thread), at most 280 characters including hashtags and links.',
      'Punchy first line, one clear idea, conversational.',
      'Use 0-2 hashtags, only if they add reach.',
    ].join('\n'),
  },
  linkedin: {
    label: 'LinkedIn',
    maxChars: 3000,
    image: { aspect: '1:1', width: 1200, height: 1200 },
    video: { aspect: '16:9' },
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
    image: { aspect: '1:1', width: 1200, height: 1200 },
    video: { aspect: '9:16' },
    guide: [
      'A Facebook Page post. Warm, conversational, community-oriented.',
      'Ideal length 40-250 words. No markdown formatting.',
      'End with a question or call to action. Use 0-3 hashtags.',
    ].join('\n'),
  },
  instagram: {
    label: 'Instagram',
    maxChars: 2200,
    needsImage: true,
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

// X counts most emoji and some scripts as 2 characters and every link as 23.
export function charCount(platform, text) {
  if (platform !== 'x') return [...text].length;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, '');
  const urlCount = (text.match(/https?:\/\/\S+/g) || []).length;
  let count = urlCount * 23;
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0);
    const light =
      cp <= 4351 ||
      (cp >= 8192 && cp <= 8205) ||
      (cp >= 8208 && cp <= 8223) ||
      (cp >= 8242 && cp <= 8247);
    count += light ? 1 : 2;
  }
  return count;
}
