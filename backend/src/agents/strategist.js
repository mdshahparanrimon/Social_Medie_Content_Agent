import { repo } from '../db/index.js';
import { httpError } from '../errors.js';
import { getBrand, brandContext, missingBrandFields } from '../brandBrain.js';
import { generateJSON } from '../llm/index.js';
import { PLATFORMS } from '../platforms.js';

export const FORMATS = [
  'tip',
  'how-to',
  'story',
  'opinion',
  'list',
  'question',
  'myth vs fact',
  'behind the scenes',
  'case study',
];

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Plans one week of posts. Items that already have a draft are kept; the rest are replanned.
export async function planWeek(weekStart) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart || '')) throw httpError(400, 'weekStart must be YYYY-MM-DD.');
  const brand = await getBrand();
  const missing = missingBrandFields(brand);
  if (missing.length) throw httpError(400, `Fill in your Brand Brain first: ${missing.join(', ')}.`);

  const weekEnd = addDays(weekStart, 6);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  await repo.deleteUndraftedCalendar(weekStart, weekEnd);
  const kept = await repo.listCalendar(weekStart, weekEnd);

  const needed = {};
  for (const platform of brand.platforms) {
    const already = kept.filter((item) => item.platform === platform).length;
    needed[platform] = Math.max(brand.posts_per_week - already, 0);
  }
  const platforms = brand.platforms.filter((p) => needed[p] > 0);
  if (platforms.length === 0) return kept;

  const recent = await repo.recentHooks(addDays(weekStart, -28), weekStart, 40);
  const taken = [...kept.map((item) => item.hook_idea), ...recent].map((hook) => `- ${hook}`);

  const system = `${brandContext(brand)}

# Your role
You are this brand's content strategist. You plan a weekly content calendar that serves the brand's goal, rotates through the content pillars, and mixes formats so the feed never feels repetitive.`;

  const prompt = `Plan the content calendar for the week ${weekStart} (Monday) to ${weekEnd} (Sunday).

Posts needed per platform:
${platforms.map((p) => `- ${p} (${PLATFORMS[p].label}): ${needed[p]} posts`).join('\n')}

Rules:
- Use only these dates: ${dates.join(', ')}. Spread posts across the week; at most one post per platform per day.
- Balance the content pillars across the week. Use the pillar names exactly as given.
- Choose a format for each post from: ${FORMATS.join(', ')}. Vary formats.
- X, LinkedIn and Facebook posts are single text posts (no videos or threads).
- Instagram posts are a single image with a caption: end their hook_idea with "Image: " and a short description of the photo to use.
- hook_idea: 1-2 sentences describing the specific angle and opening hook. Be concrete, not generic.
- Adapt each idea to its platform's audience and style.
${taken.length ? `\nDo not repeat these ideas, which are already planned or recently used:\n${taken.join('\n')}` : ''}`;

  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', enum: dates },
            platform: { type: 'string', enum: platforms },
            pillar: { type: 'string' },
            format: { type: 'string', enum: FORMATS },
            hook_idea: { type: 'string' },
          },
          required: ['date', 'platform', 'pillar', 'format', 'hook_idea'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };

  const { items } = await generateJSON({ task: 'strategist', system, prompt, schema });

  // Keep only valid items, and no more than each platform needs.
  const added = Object.fromEntries(platforms.map((p) => [p, 0]));
  const toInsert = [];
  for (const item of items) {
    if (!dates.includes(item.date) || !(item.platform in added)) continue;
    if (added[item.platform] >= needed[item.platform]) continue;
    toInsert.push({
      date: item.date,
      platform: item.platform,
      pillar: item.pillar,
      format: item.format,
      hook_idea: item.hook_idea,
    });
    added[item.platform]++;
  }
  await repo.insertCalendarItems(toInsert);
  return repo.listCalendar(weekStart, weekEnd);
}

export function calendarBrief(item) {
  return [
    `Content pillar: ${item.pillar}`,
    `Format: ${item.format}`,
    `Angle and hook: ${item.hook_idea}`,
    `Publishing date: ${item.date}`,
  ].join('\n');
}
