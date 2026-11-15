import { repo } from './db/index.js';
import { PLATFORMS, PLATFORM_KEYS } from './platforms.js';

export const GOALS = {
  awareness: 'Brand awareness: reach new people and make the brand memorable.',
  leads: 'Lead generation: get the right people to reach out, sign up, or book a call.',
  sales: 'Sales: move interested people toward buying.',
  community: 'Community: deepen relationships and conversation with existing followers.',
};

// Version 2 added the fields below `posts_per_week`. Older records have none of them; getBrand() fills the defaults at
// read time (nothing is rewritten until the user saves), so existing workspaces keep working untouched.
export const BRAND_SCHEMA_VERSION = 2;

const DEFAULT_LINK_POLICY = { allow_links: true, require_utm: false, utm_source: '', utm_medium: 'social', utm_campaign: '', allowed_domains: [] };
const DEFAULT_HASHTAG_POLICY = { min: null, max: null, banned: [], required: [] };

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

  // ---- Added in schema version 2. Nothing here is invented: empty means "not provided". ----
  schema_version: 1,
  customer_segments: [], // who the brand sells to, one short line each
  pain_points: [], // problems the audience has
  proof_points: [], // approved evidence the brand may cite (a real result, a customer count it can document)
  verified_facts: [], // statements the brand confirms are true and may be used as claims
  claims_needing_review: [], // phrases/claim types that need a citation or a human check (e.g. "guaranteed", "% growth")
  banned_phrases: [], // exact phrases that must never appear
  prohibited_topics: [], // topics that must never be written about (detected by phrase)
  cta_policies: { awareness: '', leads: '', sales: '', community: '' }, // preferred call to action per business goal
  link_policy: DEFAULT_LINK_POLICY,
  hashtag_policy: DEFAULT_HASHTAG_POLICY,
  brand_colors: [], // hex colors
  brand_fonts: [],
  logo_url: '',
  visual_style: { preferred: '', prohibited: '' },
  platform_preferences: {}, // { linkedin: 'first person, no emoji', ... }
  approved_examples: [], // posts the brand liked
  rejected_examples: [], // [{ text, reason }]
};

const HEX = /^#[0-9a-f]{6}$/i;

const text = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const list = (v, { max = 50, len = 300 } = {}) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [])
    .map((x) => text(x, len))
    .filter(Boolean)
    .slice(0, max);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const intOrNull = (v, lo, hi) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : null;
};

// Cleans the version-2 fields from user or AI input. Returns only valid values; never throws on bad input.
function cleanExtras(input, current) {
  const out = {};
  const has = (k) => input[k] !== undefined;
  if (has('customer_segments')) out.customer_segments = list(input.customer_segments);
  if (has('pain_points')) out.pain_points = list(input.pain_points);
  if (has('proof_points')) out.proof_points = list(input.proof_points);
  if (has('verified_facts')) out.verified_facts = list(input.verified_facts);
  if (has('claims_needing_review')) out.claims_needing_review = list(input.claims_needing_review, { len: 120 });
  if (has('banned_phrases')) out.banned_phrases = list(input.banned_phrases, { len: 120 });
  if (has('prohibited_topics')) out.prohibited_topics = list(input.prohibited_topics, { len: 120 });
  if (has('cta_policies')) {
    out.cta_policies = Object.fromEntries(Object.keys(GOALS).map((g) => [g, text(input.cta_policies?.[g] ?? current.cta_policies?.[g], 300)]));
  }
  if (has('link_policy')) {
    const p = { ...DEFAULT_LINK_POLICY, ...current.link_policy, ...input.link_policy };
    out.link_policy = {
      allow_links: bool(p.allow_links, true),
      require_utm: bool(p.require_utm, false),
      utm_source: text(p.utm_source, 80),
      utm_medium: text(p.utm_medium, 80),
      utm_campaign: text(p.utm_campaign, 80),
      allowed_domains: list(p.allowed_domains, { max: 30, len: 120 }).map((d) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')),
    };
  }
  if (has('hashtag_policy')) {
    const p = { ...DEFAULT_HASHTAG_POLICY, ...current.hashtag_policy, ...input.hashtag_policy };
    const hashtag = (t) => text(t, 60).replace(/^#/, '');
    out.hashtag_policy = {
      min: intOrNull(p.min, 0, 30),
      max: intOrNull(p.max, 0, 30),
      banned: list(p.banned, { max: 50, len: 60 }).map(hashtag),
      required: list(p.required, { max: 10, len: 60 }).map(hashtag),
    };
    const { min, max } = out.hashtag_policy;
    if (min !== null && max !== null && min > max) out.hashtag_policy.min = max;
  }
  if (has('brand_colors')) out.brand_colors = list(input.brand_colors, { max: 12, len: 7 }).filter((c) => HEX.test(c)).map((c) => c.toLowerCase());
  if (has('brand_fonts')) out.brand_fonts = list(input.brand_fonts, { max: 6, len: 60 });
  if (has('logo_url')) {
    const u = text(input.logo_url, 500);
    out.logo_url = /^https:\/\//i.test(u) ? u : '';
  }
  if (has('visual_style')) {
    out.visual_style = { preferred: text(input.visual_style?.preferred, 600), prohibited: text(input.visual_style?.prohibited, 600) };
  }
  if (has('platform_preferences') && input.platform_preferences && typeof input.platform_preferences === 'object') {
    out.platform_preferences = Object.fromEntries(
      PLATFORM_KEYS.filter((p) => text(input.platform_preferences[p])).map((p) => [p, text(input.platform_preferences[p], 600)]),
    );
  }
  if (has('approved_examples')) out.approved_examples = list(input.approved_examples, { max: 10, len: 1500 });
  if (has('rejected_examples')) {
    out.rejected_examples = (Array.isArray(input.rejected_examples) ? input.rejected_examples : [])
      .map((e) => (typeof e === 'string' ? { text: text(e, 1500), reason: '' } : { text: text(e?.text, 1500), reason: text(e?.reason, 300) }))
      .filter((e) => e.text)
      .slice(0, 10);
  }
  return out;
}

// Fills defaults, including inside the nested policies, so partial or old records always have a complete shape.
export function withDefaults(stored) {
  const b = { ...DEFAULT_BRAND, ...stored };
  b.link_policy = { ...DEFAULT_LINK_POLICY, ...stored?.link_policy };
  b.hashtag_policy = { ...DEFAULT_HASHTAG_POLICY, ...stored?.hashtag_policy };
  b.cta_policies = { ...DEFAULT_BRAND.cta_policies, ...stored?.cta_policies };
  b.visual_style = { ...DEFAULT_BRAND.visual_style, ...stored?.visual_style };
  b.platform_preferences = { ...stored?.platform_preferences };
  return b;
}

export async function getBrand() {
  return withDefaults(await repo.getBrand());
}

export async function saveBrand(input) {
  const current = await getBrand();
  const next = { ...current, ...input };
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
    ...cleanExtras(input, current),
    schema_version: BRAND_SCHEMA_VERSION,
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

// Optional fields that make content checks stronger. Shown to Claude/the user as suggestions, never required.
export function brandGaps(brand) {
  const gaps = [];
  if (!brand.proof_points.length && !brand.verified_facts.length) gaps.push('verified facts or proof points (without them every statistic or result claim is flagged for review)');
  if (!brand.banned_phrases.length && !brand.prohibited_topics.length) gaps.push('banned phrases / prohibited topics');
  if (!brand.cta_policies[brand.goal]) gaps.push(`a call-to-action policy for the "${brand.goal}" goal`);
  if (!brand.pain_points.length) gaps.push('audience pain points');
  return gaps;
}

const bullet = (label, items) => (items.length ? `${label}:\n${items.map((i) => `- ${i}`).join('\n')}` : '');

// The Brand Brain summary that goes into every agent's system prompt.
export function brandContext(brand) {
  const b = withDefaults(brand);
  const lines = [
    `# Brand: ${b.name}`,
    b.description && `About: ${b.description}`,
    `Primary goal: ${GOALS[b.goal]}`,
    b.cta_policies[b.goal] && `Call to action for this goal: ${b.cta_policies[b.goal]}`,
    `Target audience: ${b.audience}`,
    bullet('Customer segments', b.customer_segments),
    bullet('Audience pain points', b.pain_points),
    `Tone of voice: ${b.tone}`,
    `Write in: ${b.language}`,
    `Content pillars: ${b.pillars.join('; ')}`,
    b.avoid.trim() && `Never write about or do: ${b.avoid}`,
    b.prohibited_topics.length && `Prohibited topics: ${b.prohibited_topics.join('; ')}`,
    b.banned_phrases.length && `Never use these phrases: ${b.banned_phrases.map((p) => `"${p}"`).join(', ')}`,
    `Active platforms: ${b.platforms.map((p) => PLATFORMS[p].label).join(', ')}`,
    bullet('Platform preferences', Object.entries(b.platform_preferences).map(([p, v]) => `${PLATFORMS[p].label}: ${v}`)),
    bullet('Approved proof points (the only evidence you may cite)', b.proof_points),
    bullet('Verified facts (you may state these as true)', b.verified_facts),
    b.claims_needing_review.length && `Claims that need human verification (do not make them unless a verified fact above supports them): ${b.claims_needing_review.join('; ')}`,
    !b.proof_points.length && !b.verified_facts.length && 'No verified facts were provided: do not state numbers, results, customer counts, awards or guarantees about the brand.',
    !b.link_policy.allow_links && 'Do not put links in posts.',
    b.link_policy.require_utm && `Every link must carry UTM parameters (utm_source, utm_medium, utm_campaign).`,
    b.hashtag_policy.max !== null && `Use at most ${b.hashtag_policy.max} hashtags.`,
    b.hashtag_policy.required.length && `Always include hashtags: ${b.hashtag_policy.required.map((h) => `#${h}`).join(' ')}`,
    b.hashtag_policy.banned.length && `Never use hashtags: ${b.hashtag_policy.banned.map((h) => `#${h}`).join(' ')}`,
  ];
  const visual = [
    b.brand_colors.length && `Brand colors: ${b.brand_colors.join(', ')}`,
    b.brand_fonts.length && `Brand fonts: ${b.brand_fonts.join(', ')}`,
    b.visual_style.preferred && `Preferred visual style: ${b.visual_style.preferred}`,
    b.visual_style.prohibited && `Visual styles to avoid: ${b.visual_style.prohibited}`,
  ].filter(Boolean);
  if (visual.length) lines.push('', '## Visual identity', ...visual);
  if (b.sample_posts.trim()) {
    lines.push('', 'Past posts that performed well. Match their voice and style, but never copy them:', '<examples>', b.sample_posts.trim(), '</examples>');
  }
  if (b.approved_examples.length) lines.push('', 'Approved example posts (voice reference, never copy):', '<approved>', ...b.approved_examples, '</approved>');
  if (b.rejected_examples.length) {
    lines.push('', 'Rejected posts. Avoid what made them wrong:', '<rejected>', ...b.rejected_examples.map((e) => `${e.text}${e.reason ? `\n(why rejected: ${e.reason})` : ''}`), '</rejected>');
  }
  return lines.filter(Boolean).join('\n');
}
