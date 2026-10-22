import { httpError } from '../errors.js';
import { getBrand, brandContext, missingBrandFields } from '../brandBrain.js';
import { generateJSON } from '../llm/index.js';
import { renderCarousel, validAccent } from '../slides.js';
import { storeDocument } from '../media.js';
import { EDITABLE, setPostDocument } from '../posts.js';
import { getPost } from './creator.js';
import { PLATFORMS } from '../platforms.js';

// LinkedIn PDF carousel: the text AI writes the slides from the post, slides.js draws them into a PDF.

export const MIN_SLIDES = 3;
export const MAX_SLIDES = 12;

const CAROUSEL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    accent_color: { type: 'string' },
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: { heading: { type: 'string' }, body: { type: 'string' } },
        required: ['heading', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'accent_color', 'slides'],
  additionalProperties: false,
};

export const SLIDE_RULES = [
  `${MIN_SLIDES}-${MAX_SLIDES} slides, 6-9 is best.`,
  'Slide 1 is the cover: a scroll-stopping hook as the heading (at most 10 words) and a short promise as the body.',
  'Middle slides: one idea each, a heading of at most 10 words and a body of at most 40 words that is specific and useful.',
  'The last slide sums up the takeaway and ends with a call to action (comment, follow, save, or the brand goal).',
  'Plain text only: no markdown, no emoji, no hashtags, no slide numbers (they are added automatically).',
].join('\n');

function cleanSlides(slides) {
  const clean = slides
    .map((s) => ({ heading: String(s.heading || '').trim(), body: String(s.body || '').trim() }))
    .filter((s) => s.heading);
  if (clean.length < MIN_SLIDES) throw httpError(400, `A carousel needs at least ${MIN_SLIDES} slides with a heading.`);
  if (clean.length > MAX_SLIDES) throw httpError(400, `A carousel can have at most ${MAX_SLIDES} slides.`);
  return clean;
}

async function writeSlides({ brand, post, instructions }) {
  const system = `${brandContext(brand)}

# Your role
You turn this brand's LinkedIn posts into PDF carousels (document posts) that people swipe through to the end.`;
  let prompt = `Write a LinkedIn carousel that goes with this post. The post text is the caption; the slides should deliver its content in more depth, not repeat the caption word for word.

Post:
<post>
${post.content}
</post>`;
  if (instructions) prompt += `\n\nInstructions from the brand owner (follow them):\n<instructions>\n${instructions}\n</instructions>`;
  prompt += `\n\nRules:\n${SLIDE_RULES}\nWrite in ${brand.language}.\ntitle: the document title shown above the carousel on LinkedIn (at most 60 characters).\naccent_color: one hex color like #0a66c2 that fits the brand (dark enough for white text).`;
  return generateJSON({ task: 'carousel', system, prompt, schema: CAROUSEL_SCHEMA });
}

// Makes a carousel PDF and attaches it to the post. `slides` (from Claude via MCP) skips the writing step.
export async function createPostCarousel(id, { instructions, title, slides, accent } = {}) {
  const post = await getPost(id);
  if (!PLATFORMS[post.platform].documents) throw httpError(400, `${PLATFORMS[post.platform].label} posts can't carry a PDF carousel.`);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  const brand = await getBrand();

  let plan = { title, slides, accent_color: accent };
  if (!slides) {
    const missing = missingBrandFields(brand);
    if (missing.length) throw httpError(400, `Fill in your Brand Brain first: ${missing.join(', ')}.`);
    plan = await writeSlides({ brand, post, instructions: instructions?.trim() });
  }
  const clean = cleanSlides(plan.slides);
  const docTitle = String(plan.title || clean[0].heading).trim().slice(0, 100);
  const color = validAccent(plan.accent_color);

  const pdf = await renderCarousel({ title: docTitle, slides: clean, accent: color, brand: brand.name });
  const url = await storeDocument(pdf);
  return setPostDocument(post.id, { url, title: docTitle, pages: clean.length, slides: clean, accent: color });
}
