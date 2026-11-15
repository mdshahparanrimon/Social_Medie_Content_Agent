import { PLATFORMS, charCount } from '../platforms.js';
import { withDefaults } from '../brandBrain.js';

// Deterministic content checks. These are RULES, not judgement: they catch things a program can verify (length,
// formatting, banned words, hashtag counts, links, near-duplicates, unverified numbers). They cannot tell whether a
// hook is engaging, a claim is true, or the voice is on brand; that is the job of the AI review and of a person.
//
// Each issue: { severity, code, message, category }
//   severity "error"   blocks approval and publishing (a hard rule was broken)
//   severity "review"  a person must look and explicitly accept it before approval
//   severity "warning" worth fixing, never blocks
//   category: platform | brand | copy | claims | technical (used by the score)

const issue = (severity, code, category, message) => ({ severity, code, category, message });

export const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Phrase match that respects word boundaries for Latin text and falls back to substring for other scripts.
export function containsPhrase(text, phrase) {
  const t = norm(text);
  const p = norm(phrase);
  if (!p) return false;
  if (/^[\p{Script=Latin}\p{N}\s'’-]+$/u.test(p)) return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, 'u').test(t);
  return t.includes(p);
}

export const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const HASHTAG_RE = /(?<![\p{L}\p{N}_&/#])#([\p{L}\p{N}\p{M}_]{1,100})/gu;
export const extractHashtags = (text) => [...String(text).replace(URL_RE, ' ').matchAll(HASHTAG_RE)].map((m) => m[1]);
export const extractUrls = (text) => (String(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, ''));

const CTA_RE = /\b(comment|follow|save|share|repost|dm|message|book|sign ?up|subscribe|visit|download|read|learn more|try|join|contact|reach out|ask|tell us|let me know|link in|get started|reply|tag|vote|register|apply|call|email)\b|\?|কমেন্ট|ফলো|শেয়ার|সেভ|যোগাযোগ|মেসেজ|জানান|লিংক|ডাউনলোড|যোগ দিন|বুক করুন/i;
export const hasCta = (text) => CTA_RE.test(text);

const GENERIC_OPENERS = [
  "in today's fast-paced", "in today's digital", 'in the ever-evolving', "i'm excited to announce", "i am excited to announce", "i'm thrilled to announce",
  'are you ready to', 'did you know that', 'hey guys', 'hello everyone', 'good morning linkedin', 'attention all',
];
const AI_PHRASES = ['delve', 'unlock the power', 'game-changer', 'game changer', 'revolutionize', 'elevate your', 'in the realm of', 'tapestry', 'navigate the landscape', 'harness the power', 'take it to the next level'];

// Claim patterns: numbers with a unit or superlatives that need support.
const NUMERIC_CLAIM = /(\d[\d,.]*\s?(%|x\b|times\b|percent\b|k\b|m\b|million\b|billion\b|\+)|[$৳€£]\s?\d[\d,.]*)/giu;
const ABSOLUTE_CLAIM = /\b(guarantee[sd]?|guaranteed|proven|#1|number one|best in|world'?s (best|first|leading)|only (company|platform|tool)|100%|risk[- ]free|never fails|always works)\b/i;

function shingles(text, n = 3) {
  const words = norm(text).replace(URL_RE, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const set = new Set();
  for (let i = 0; i <= words.length - n; i++) set.add(words.slice(i, i + n).join(' '));
  if (!set.size && words.length) set.add(words.join(' '));
  return set;
}
export function similarity(a, b) {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const s of A) if (B.has(s)) shared++;
  return shared / (A.size + B.size - shared);
}

const letters = (text) => [...text].filter((c) => /\p{L}/u.test(c));
const emojiCount = (text) => (text.match(/\p{Extended_Pictographic}/gu) || []).length;

function firstLine(text) {
  return text.split(/\n/).find((l) => l.trim())?.trim() || '';
}

/**
 * post: { id, platform, content, image_url, video_url, document_url, image_alt }
 * brand: Brand Brain (defaults are filled in). recent: [{ id, content }] of the same platform.
 * Returns { issues, byCategory } where byCategory maps category -> 0..100.
 */
export function lintContent({ post, brand: rawBrand, recent = [] }) {
  const brand = withDefaults(rawBrand);
  const p = PLATFORMS[post.platform];
  const issues = [];
  const add = (...args) => issues.push(issue(...args));
  const content = String(post.content ?? '');
  const trimmed = content.trim();

  if (!p) {
    add('error', 'UNKNOWN_PLATFORM', 'platform', `Unknown platform "${post.platform}".`);
    return finish(issues);
  }
  if (!trimmed) {
    add('error', 'EMPTY_CONTENT', 'technical', 'The post text is empty.');
    return finish(issues);
  }

  // Length
  const length = charCount(post.platform, content);
  if (length > p.maxChars) add('error', 'TOO_LONG', 'platform', `${length} characters; ${p.label} allows ${p.maxChars}${post.platform === 'x' ? ' (X counts links as 23 and emoji as 2)' : ''}.`);
  else if (length < p.ideal[0]) add('warning', 'SHORT', 'platform', `Only ${length} characters; ${p.label} posts usually work better at ${p.ideal[0]}-${p.ideal[1]}.`);
  else if (length > p.ideal[1] && p.maxChars > p.ideal[1] + 100) add('warning', 'LONG', 'platform', `${length} characters is long for ${p.label} (usually ${p.ideal[0]}-${p.ideal[1]}).`);

  // Markdown leakage: the platforms publish plain text.
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\(https?:[^)\s]+\)|^\s{0,3}#{1,6}\s+\S|```/m.test(content)) {
    add('error', 'MARKDOWN', 'platform', `Markdown formatting (**bold**, # headings, [links](url), code fences) shows up literally on ${p.label}. Use plain text.`);
  }

  // Hashtags
  const tags = extractHashtags(content);
  const policy = brand.hashtag_policy;
  const max = policy.max ?? p.hashtags.max;
  const min = policy.min ?? p.hashtags.min;
  if (tags.length > max) add('error', 'HASHTAGS_MAX', 'platform', `${tags.length} hashtags; at most ${max} for ${p.label}${policy.max !== null ? ' (brand policy)' : ''}.`);
  if (tags.length < min) add('warning', 'HASHTAGS_MIN', 'platform', `${tags.length} hashtags; ${min} or more are expected on ${p.label}.`);
  const lowerTags = tags.map((t) => t.toLowerCase());
  if (new Set(lowerTags).size !== lowerTags.length) add('warning', 'HASHTAGS_DUPLICATE', 'platform', 'The same hashtag appears more than once.');
  for (const t of tags) {
    if (/^\d+$/.test(t)) add('warning', 'HASHTAG_NUMERIC', 'platform', `#${t} is only digits, which most platforms do not treat as a hashtag.`);
    if (t.length > 30) add('warning', 'HASHTAG_LONG', 'platform', `#${t.slice(0, 20)}... is very long.`);
  }
  for (const banned of policy.banned) if (lowerTags.includes(banned.toLowerCase())) add('error', 'HASHTAG_BANNED', 'brand', `#${banned} is on the brand's banned hashtag list.`);
  for (const req of policy.required) if (!lowerTags.includes(req.toLowerCase())) add('warning', 'HASHTAG_REQUIRED', 'brand', `The brand policy asks for #${req}.`);
  if (/\s#\s+\w/.test(content)) add('warning', 'HASHTAG_SPACE', 'platform', 'A "#" followed by a space is not a hashtag.');

  // Brand rules
  for (const phrase of brand.banned_phrases) if (containsPhrase(content, phrase)) add('error', 'BANNED_PHRASE', 'brand', `Contains the banned phrase "${phrase}".`);
  for (const topic of brand.prohibited_topics) if (containsPhrase(content, topic)) add('error', 'PROHIBITED_TOPIC', 'brand', `Mentions a prohibited topic: "${topic}".`);
  for (const phrase of AI_PHRASES) if (containsPhrase(content, phrase)) add('warning', 'AI_PHRASING', 'copy', `"${phrase}" reads like generic AI writing; use a concrete, plainer wording.`);

  // Language / script
  const letterList = letters(content);
  if (letterList.length >= 40) {
    const bn = letterList.filter((c) => /[ঀ-৿]/.test(c)).length / letterList.length;
    if (/bengali|bangla/i.test(brand.language) && bn < 0.3) add('warning', 'LANGUAGE_MISMATCH', 'brand', 'The brand writes in Bengali but this post is mostly not Bengali.');
    if (/^english/i.test(brand.language) && bn > 0.3) add('warning', 'LANGUAGE_MISMATCH', 'brand', 'The brand writes in English but this post is mostly Bengali.');
  }

  // Claims. Heuristic: it flags numbers and absolute statements that no verified fact backs up; it cannot know if they are true.
  const support = norm([...brand.verified_facts, ...brand.proof_points].join(' \n '));
  for (const phrase of brand.claims_needing_review) {
    if (containsPhrase(content, phrase)) add('review', 'CLAIM_NEEDS_REVIEW', 'claims', `"${phrase}" is a claim the brand wants a person to verify before it goes live.`);
  }
  const numeric = [...new Set((content.replace(URL_RE, ' ').match(NUMERIC_CLAIM) || []).map((m) => m.trim()))];
  for (const claim of numeric) {
    const digits = claim.replace(/[^\d.]/g, '');
    if (!digits || !support.includes(digits)) add('review', 'UNVERIFIED_NUMBER', 'claims', `"${claim}" is a figure that is not in the brand's verified facts or proof points. Confirm it is accurate.`);
  }
  const absolute = content.match(ABSOLUTE_CLAIM)?.[0];
  if (absolute && !containsPhrase(support, absolute)) add('review', 'ABSOLUTE_CLAIM', 'claims', `"${absolute}" is an absolute claim. Make sure it can be backed up.`);

  // CTA by business goal
  if (!hasCta(content)) {
    const needed = ['leads', 'sales'].includes(brand.goal);
    add(needed ? 'review' : 'warning', 'CTA_MISSING', 'copy', `No call to action found${needed ? `, and the brand goal is "${brand.goal}"` : ''}. ${brand.cta_policies[brand.goal] ? `Brand policy: ${brand.cta_policies[brand.goal]}` : 'Say what the reader should do next.'}`);
  }

  // Links
  const urls = extractUrls(content);
  if (urls.length && !brand.link_policy.allow_links) add('error', 'LINKS_NOT_ALLOWED', 'brand', 'The brand policy does not allow links in posts.');
  for (const raw of urls) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      add('warning', 'LINK_MALFORMED', 'platform', `"${raw.slice(0, 40)}" is not a valid link.`);
      continue;
    }
    const domains = brand.link_policy.allowed_domains;
    if (domains.length && !domains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`))) add('error', 'LINK_DOMAIN', 'brand', `${u.hostname} is not one of the brand's allowed link domains.`);
    if (brand.link_policy.require_utm) {
      const missing = ['utm_source', 'utm_medium', 'utm_campaign'].filter((k) => !u.searchParams.get(k));
      if (missing.length) add('error', 'LINK_UTM', 'brand', `${u.hostname} link is missing ${missing.join(', ')}.`);
    }
  }
  if (urls.length && !p.linksClickable) add('warning', 'LINK_NOT_CLICKABLE', 'platform', `Links are not clickable on ${p.label}; say "link in bio" instead.`);

  // Hook rules (see the note at the top: these only catch known weak patterns)
  const hook = firstLine(content);
  if (hook) {
    const hookLen = [...hook].length;
    if (p.hookChars && hookLen > p.hookChars * 1.6) add('warning', 'HOOK_LONG', 'copy', `The first line is ${hookLen} characters; only about ${p.hookChars} show before "see more".`);
    if (GENERIC_OPENERS.some((o) => norm(hook).startsWith(o))) add('warning', 'HOOK_GENERIC', 'copy', 'The opening is a stock phrase. Start with the specific idea, result or question.');
    if (/^[#@]/.test(hook)) add('warning', 'HOOK_STARTS_TAG', 'copy', 'The post opens with a hashtag or mention instead of a hook.');
    const hl = letters(hook);
    if (hl.length > 12 && hl.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length / hl.length > 0.6) add('warning', 'HOOK_CAPS', 'copy', 'The first line is mostly capital letters.');
  }
  if (emojiCount(content) > (post.platform === 'linkedin' ? 5 : 10)) add('warning', 'EMOJI_HEAVY', 'copy', 'Many emoji; this can read as spam.');
  if (post.platform === 'x' && /(^|\n)\s*\d+\s*\/\s*\d*\s*(\n|$)/.test(content)) add('warning', 'THREAD_MARKER', 'platform', 'This looks like a thread marker, but the app publishes single posts.');

  // Near-duplicates of recent posts on the same platform
  let best = { score: 0 };
  for (const other of recent) {
    if (other.id === post.id) continue;
    const score = similarity(content, other.content);
    if (score > best.score) best = { score, other };
  }
  if (best.score >= 0.85) add('error', 'DUPLICATE_POST', 'copy', `Almost identical to a recent post (${Math.round(best.score * 100)}% similar). Platforms flag repeated posts; write something new.`);
  else if (best.score >= 0.6) add('warning', 'SIMILAR_POST', 'copy', `Very similar to a recent post (${Math.round(best.score * 100)}% similar).`);

  // Media-related requirements
  if (p.needsImage && !post.image_url && !post.video_url) add('error', 'MEDIA_REQUIRED', 'technical', `${p.label} posts need an image or a video.`);
  const hasImage = Boolean(post.image_url) && !post.video_url && !(p.documents && post.document_url);
  if (hasImage && !String(post.image_alt || '').trim()) {
    add('warning', 'ALT_MISSING', 'platform', p.altText ? 'The image has no alt text. Add a short description; it is sent to the platform for screen readers.' : `The image has no alt text. (${p.label} publishing does not send alt text, but keep one for the post record.)`);
  }
  return finish(issues);
}

const PENALTY = { error: 40, review: 15, warning: 6 };

function finish(issues) {
  const byCategory = {};
  for (const cat of ['platform', 'brand', 'copy', 'claims', 'technical']) {
    const penalty = issues.filter((i) => i.category === cat).reduce((sum, i) => sum + PENALTY[i.severity], 0);
    byCategory[cat] = Math.max(0, 100 - penalty);
  }
  return {
    issues,
    errors: issues.filter((i) => i.severity === 'error'),
    reviews: issues.filter((i) => i.severity === 'review'),
    warnings: issues.filter((i) => i.severity === 'warning'),
    byCategory,
  };
}
