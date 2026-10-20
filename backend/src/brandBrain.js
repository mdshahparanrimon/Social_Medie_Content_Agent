import { repo } from './db/index.js';
import { PLATFORMS, PLATFORM_KEYS } from './platforms.js';

const GOALS = {
  awareness: 'Brand awareness: reach new people and make the brand memorable.',
  leads: 'Lead generation: get the right people to reach out, sign up, or book a call.',
  sales: 'Sales: move interested people toward buying.',
  community: 'Community: deepen relationships and conversation with existing followers.',
};

const DEFAULT_BRAND = {
  name: '',
  description: '',
  goal: 'awareness',
  audience: '',
  tone: '',
  language: 'English',
  pillars: [],
  avoid: '',
  sample_posts: '',
  platforms: ['x', 'linkedin', 'meta'],
  posts_per_week: 3,
  updated_at: null,
};

export async function getBrand() {
  return { ...DEFAULT_BRAND, ...(await repo.getBrand()) };
}

export async function saveBrand(input) {
  const next = { ...(await getBrand()), ...input };
  await repo.saveBrand({
    name: String(next.name || ''),
    description: String(next.description || ''),
    goal: GOALS[next.goal] ? next.goal : 'awareness',
    audience: String(next.audience || ''),
    tone: String(next.tone || ''),
    language: String(next.language || 'English'),
    pillars: (next.pillars || []).map((p) => String(p).trim()).filter(Boolean),
    avoid: String(next.avoid || ''),
    sample_posts: String(next.sample_posts || ''),
    platforms: (next.platforms || []).filter((p) => PLATFORM_KEYS.includes(p)),
    posts_per_week: Math.min(Math.max(parseInt(next.posts_per_week, 10) || 1, 1), 14),
    updated_at: new Date().toISOString(),
  });
  return getBrand();
}

export function missingBrandFields(brand) {
  const missing = [];
  if (!brand.name.trim()) missing.push('brand name');
  if (!brand.audience.trim()) missing.push('audience');
  if (!brand.tone.trim()) missing.push('tone of voice');
  if (brand.pillars.length === 0) missing.push('content pillars');
  if (brand.platforms.length === 0) missing.push('platforms');
  return missing;
}

// The Brand Brain summary that goes into every agent's system prompt.
export function brandContext(brand) {
  const lines = [
    `# Brand: ${brand.name}`,
    brand.description && `About: ${brand.description}`,
    `Primary goal: ${GOALS[brand.goal]}`,
    `Target audience: ${brand.audience}`,
    `Tone of voice: ${brand.tone}`,
    `Write in: ${brand.language}`,
    `Content pillars: ${brand.pillars.join('; ')}`,
    brand.avoid.trim() && `Never write about or do: ${brand.avoid}`,
    `Active platforms: ${brand.platforms.map((p) => PLATFORMS[p].label).join(', ')}`,
  ];
  if (brand.sample_posts.trim()) {
    lines.push(
      '',
      'Past posts that performed well. Match their voice and style, but never copy them:',
      '<examples>',
      brand.sample_posts.trim(),
      '</examples>',
    );
  }
  return lines.filter(Boolean).join('\n');
}
