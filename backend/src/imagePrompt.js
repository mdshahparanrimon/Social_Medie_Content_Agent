import { PLATFORMS } from './platforms.js';
import { withDefaults } from './brandBrain.js';

// Image prompts. The strategy follows the creative brief instead of forcing one look on everything:
//   photo         a realistic scene, no text
//   illustration  a drawn/graphic scene, no text
//   text_graphic  a branded graphic whose words are part of the design (quote card, stat, announcement).
//                 AI image models often misspell text, so the exact words are given and a person must proofread the result.
//   auto          the text AI (or Claude) picks the best of the above for the brief

export const IMAGE_STYLES = ['auto', 'photo', 'illustration', 'text_graphic'];

const STRATEGY = {
  photo: {
    medium: 'A realistic photograph',
    text: 'There must be no text, letters, numbers, logos, signs or watermarks anywhere in the image.',
    craft: 'Natural, believable lighting (name the light: e.g. soft window light, golden hour). Shallow to medium depth of field. Realistic textures.',
  },
  illustration: {
    medium: 'A clean modern illustration (flat or lightly textured vector style)',
    text: 'There must be no text, letters, numbers, logos or watermarks anywhere in the image.',
    craft: 'Simple shapes, a restrained palette, generous negative space, consistent line weight.',
  },
  text_graphic: {
    medium: 'A bold typographic social graphic',
    text: 'The ONLY text in the image is the exact wording given below, spelled exactly, in a large, high-contrast, highly legible sans-serif. No other text, logos or watermarks.',
    craft: 'Strong visual hierarchy: the main words dominate, one small supporting element at most. Plenty of padding so no word touches an edge.',
  },
};

// Where a platform may crop. Critical elements must stay inside the safe area.
const SAFE_AREA = {
  '4:5': 'Instagram shows this at 4:5 in the feed but crops the middle 3:4 on profile grids, so keep every important element inside the central 70% width and 85% height.',
  '1:1': 'Square: keep important elements inside the central 80%; feeds may trim the edges slightly.',
  '16:9': 'Wide: previews often crop to the centre, so keep the focal point and any words inside the central 70% width.',
};

export function brandVisualLines(brand) {
  const b = withDefaults(brand);
  return [
    b.brand_colors.length && `Use this brand palette: ${b.brand_colors.join(', ')}.`,
    b.visual_style.preferred && `Visual style to follow: ${b.visual_style.preferred}.`,
    b.visual_style.prohibited && `Avoid: ${b.visual_style.prohibited}.`,
    b.tone && `Mood that matches the brand's tone (${b.tone}).`,
  ].filter(Boolean);
}

/**
 * Builds the full constraint block that goes with every image prompt, so a prompt written by Claude or by the app
 * always carries the brand look, the platform crop rules and the text policy.
 */
export function imageConstraints({ brand, platform, style = 'photo', overlayText }) {
  const s = STRATEGY[style] || STRATEGY.photo;
  const { aspect } = PLATFORMS[platform].image;
  const lines = [
    `Format: ${aspect} for ${PLATFORMS[platform].label}.`,
    SAFE_AREA[aspect],
    'Composition: one clear focal point, placed on a thirds line or the centre; a simple uncluttered background; clear foreground/background separation so it reads at thumbnail size.',
    s.craft,
    ...brandVisualLines(brand),
    s.text,
    style === 'text_graphic' && overlayText ? `Exact wording to display: "${overlayText}"` : null,
    'No real people, celebrities or other brands. No watermarks.',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Prompt used when no text AI is available (MCP mode): the user's message + the constraints. */
export function templatePrompt({ brand, post, platform, style, instructions, overlayText }) {
  const s = STRATEGY[style === 'auto' ? 'photo' : style] || STRATEGY.photo;
  return [
    `${s.medium} for a ${PLATFORMS[platform].label} post by ${brand.name || 'the brand'}${brand.audience ? `, for ${brand.audience}` : ''}.`,
    `The post says: ${post.content}`,
    instructions && `Direction: ${instructions}`,
    imageConstraints({ brand, platform, style: style === 'auto' ? 'photo' : style, overlayText }),
  ]
    .filter(Boolean)
    .join('\n');
}

export const IMAGE_PROMPT_SCHEMA = {
  type: 'object',
  properties: {
    style: { type: 'string' },
    prompt: { type: 'string' },
    overlay_text: { type: 'string' },
    alt_text: { type: 'string' },
  },
  required: ['style', 'prompt', 'overlay_text', 'alt_text'],
  additionalProperties: false,
};

export function imageBriefInstructions({ platform, style }) {
  const { aspect } = PLATFORMS[platform].image;
  return [
    `Write the image prompt for this ${PLATFORMS[platform].label} post (${aspect}).`,
    style === 'auto'
      ? 'Choose style: "photo", "illustration" or "text_graphic". Use text_graphic only when the post is a quote, statistic, checklist or announcement that is stronger with words in the image; otherwise prefer photo or illustration.'
      : `Use the style "${style}".`,
    'The prompt must state: the subject and what it shows about the post\'s message; the setting; composition with ONE focal point and where it sits; lighting; colours; and visual hierarchy. 3-6 sentences, concrete and visual, no marketing language.',
    'If style is text_graphic, put the exact words to display (at most 12 words, copied or condensed from the post, no invented claims) in overlay_text; otherwise overlay_text is an empty string.',
    'alt_text: a plain, literal description of what the finished image shows for a screen-reader user, at most 140 characters, no "image of".',
  ].join('\n');
}
