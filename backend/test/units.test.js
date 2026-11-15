import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS, STATUSES, assertTransition, canTransition } from '../src/postStates.js';
import { BACKOFF_CAP_MS, MAX_AUTO_ATTEMPTS, backoffMs, decideAfterFailure } from '../src/publishPolicy.js';
import { PublishError, errorFromNetwork, errorFromResponse, parseRetryAfter } from '../src/publishers/common.js';
import { classify as classifyX } from '../src/publishers/x.js';
import { apiVersionWarning, escapeCommentary } from '../src/publishers/linkedin.js';
import { DEFAULT_WEIGHTS, loadWeights, mediaScore, scorePost } from '../src/quality/score.js';
import { finalizeReview, DIMENSIONS, REVIEW_SCHEMA } from '../src/quality/review.js';
import { checkSchema } from '../src/llm/json.js';
import { redact, redactText, redactUrl } from '../src/log.js';
import { withDefaults } from '../src/brandBrain.js';
import { VideoBriefZ, briefLimits, briefToPrompt, checkBrief } from '../src/videoBrief.js';
import { imageConstraints, templatePrompt } from '../src/imagePrompt.js';
import { loadRules } from '../src/mediaRules.js';

// ---- State machine ----

test('every status has a transition entry and only valid moves are allowed', () => {
  for (const s of STATUSES) assert.ok(s in TRANSITIONS, s);
  assert.equal(canTransition('draft', 'approved'), true);
  assert.equal(canTransition('approved', 'publishing'), true);
  assert.equal(canTransition('publishing', 'uncertain'), true);
  assert.equal(canTransition('uncertain', 'published'), true);
  assert.equal(canTransition('uncertain', 'failed'), true);
});

test('invalid moves are rejected: no retrying an uncertain post, no leaving published, no skipping approval', () => {
  assert.equal(canTransition('uncertain', 'publishing'), false);
  assert.equal(canTransition('uncertain', 'approved'), false);
  assert.equal(canTransition('published', 'draft'), false);
  assert.equal(canTransition('draft', 'publishing'), false);
  assert.equal(canTransition('draft', 'published'), false);
  assert.throws(() => assertTransition('draft', 'publishing'), { code: 'INVALID_TRANSITION' });
  assert.throws(() => assertTransition('nonsense', 'draft'), { code: 'INVALID_TRANSITION' });
});

// ---- Retry policy ----

test('backoff grows exponentially with jitter, is capped, and honours Retry-After', () => {
  const lo = (n) => backoffMs(n, { random: () => 0 });
  const hi = (n) => backoffMs(n, { random: () => 1 });
  assert.equal(lo(1), 30_000);
  assert.equal(hi(1), 60_000);
  assert.equal(hi(2), 120_000);
  assert.ok(lo(3) > hi(1));
  assert.equal(hi(20), BACKOFF_CAP_MS);
  assert.equal(backoffMs(1, { random: () => 0, retryAfterMs: 10 * 60_000 }), 10 * 60_000);
  assert.equal(backoffMs(1, { retryAfterMs: 99 * 3600_000 }), 6 * 3600_000);
  const samples = new Set(Array.from({ length: 20 }, () => backoffMs(3)));
  assert.ok(samples.size > 1, 'jitter produces different delays');
});

test('retry eligibility: only definite, temporary failures are retried; uncertain ones never are', () => {
  const rate = new PublishError('rl', { retryable: true, retryAfterMs: 5000 });
  assert.equal(decideAfterFailure(rate, { attemptsMade: 1, reachedCreate: false, random: () => 0 }).action, 'retry');
  assert.equal(decideAfterFailure(rate, { attemptsMade: MAX_AUTO_ATTEMPTS, reachedCreate: false }).action, 'fail');
  assert.equal(decideAfterFailure(rate, { attemptsMade: MAX_AUTO_ATTEMPTS, reachedCreate: false }).exhausted, true);
  assert.equal(decideAfterFailure(new PublishError('bad', {}), { attemptsMade: 1, reachedCreate: false }).action, 'fail');
  assert.equal(decideAfterFailure(new PublishError('timeout', { uncertain: true }), { attemptsMade: 1, reachedCreate: true }).action, 'uncertain');
  // A surprise exception: uncertain only if the creating call had begun.
  assert.equal(decideAfterFailure(new Error('boom'), { attemptsMade: 1, reachedCreate: true }).action, 'uncertain');
  assert.equal(decideAfterFailure(new Error('boom'), { attemptsMade: 1, reachedCreate: false }).action, 'fail');
});

test('HTTP and network errors are classified by stage', () => {
  const h = new Headers({ 'retry-after': '120' });
  const e429 = errorFromResponse({ label: 'X', stage: 'create', status: 429, data: null, text: '', headers: h });
  assert.deepEqual([e429.retryable, e429.uncertain, e429.retryAfterMs], [true, false, 120_000]);
  const e401 = errorFromResponse({ label: 'LinkedIn', stage: 'pre', status: 401, data: { message: 'EXPIRED' }, headers: new Headers() });
  assert.equal(e401.needsReconnect, true);
  assert.equal(e401.retryable, false);
  const e403 = errorFromResponse({ label: 'LinkedIn', stage: 'create', status: 403, data: { message: 'ACCESS_DENIED' }, headers: new Headers() });
  assert.equal(e403.code, 'PERMISSION');
  assert.match(e403.message, /permission/i);
  const create500 = errorFromResponse({ label: 'Facebook', stage: 'create', status: 502, data: null, text: 'bad gateway', headers: new Headers() });
  assert.equal(create500.uncertain, true);
  const pre500 = errorFromResponse({ label: 'Facebook', stage: 'pre', status: 502, data: null, text: 'bad gateway', headers: new Headers() });
  assert.deepEqual([pre500.uncertain, pre500.retryable], [false, true]);
  const e400 = errorFromResponse({ label: 'Instagram', stage: 'create', status: 400, data: { error: { message: 'bad image' } }, headers: new Headers() });
  assert.deepEqual([e400.uncertain, e400.retryable], [false, false]);
  // Meta signals rate limits and dead tokens in the body.
  assert.equal(errorFromResponse({ label: 'Instagram', stage: 'pre', status: 400, data: { error: { code: 4 } }, headers: new Headers() }).code, 'RATE_LIMIT');
  assert.equal(errorFromResponse({ label: 'Instagram', stage: 'pre', status: 400, data: { error: { code: 190 } }, headers: new Headers() }).needsReconnect, true);
  const timeoutCreate = errorFromNetwork({ label: 'X', stage: 'create', err: Object.assign(new Error('t'), { name: 'TimeoutError' }) });
  assert.deepEqual([timeoutCreate.uncertain, timeoutCreate.code], [true, 'TIMEOUT']);
  const timeoutPre = errorFromNetwork({ label: 'X', stage: 'pre', err: Object.assign(new Error('t'), { name: 'TimeoutError' }) });
  assert.deepEqual([timeoutPre.uncertain, timeoutPre.retryable], [false, true]);
  assert.equal(parseRetryAfter('30'), 30_000);
  assert.equal(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString(), Date.now()) > 50_000, true);
  assert.equal(parseRetryAfter('garbage'), null);
});

test('X errors: expired credentials, rate limit with reset time, duplicates, server errors', () => {
  assert.equal(classifyX({ code: 401, data: { title: 'Unauthorized' } }, 'create').needsReconnect, true);
  const rl = classifyX({ code: 429, rateLimit: { reset: Math.floor(Date.now() / 1000) + 600 }, data: {} }, 'create');
  assert.ok(rl.retryable && rl.retryAfterMs > 500_000);
  const dup = classifyX({ code: 403, data: { detail: 'You are not allowed to create a Tweet with duplicate content.' } }, 'create');
  assert.match(dup.message, /duplicate/);
  assert.equal(dup.retryable, false);
  assert.equal(classifyX({ code: 503, data: {} }, 'create').uncertain, true);
  assert.equal(classifyX({ code: 503, data: {} }, 'pre').retryable, true);
  assert.equal(classifyX(new Error('socket hang up'), 'create').uncertain, true);
});

test('LinkedIn: hashtags stay real hashtags, markup is escaped, API version age is flagged', () => {
  assert.equal(escapeCommentary('Great #Branding tips'), 'Great #Branding tips');
  assert.equal(escapeCommentary('Use (parentheses) and [brackets] and @name'), 'Use \\(parentheses\\) and \\[brackets\\] and \\@name');
  assert.equal(escapeCommentary('Issue # 5 and C#'), 'Issue \\# 5 and C\\#');
  assert.equal(escapeCommentary('snake_case *bold* ~tilde~ {x}|y'), 'snake\\_case \\*bold\\* \\~tilde\\~ \\{x\\}\\|y');
  const now = new Date('2026-10-23T00:00:00Z');
  assert.equal(apiVersionWarning('202608', now), null);
  assert.match(apiVersionWarning('202511', now), /will stop working/);
  assert.match(apiVersionWarning('202401', now), /more than a year old/);
  assert.match(apiVersionWarning('banana', now), /YYYYMM/);
});

// ---- Scoring ----

const lintFull = { byCategory: { platform: 100, brand: 100, copy: 100, claims: 100, technical: 100 }, errors: [] };
const aiDims = (n) => Object.fromEntries(DIMENSIONS.map(([k]) => [k, n]));

test('scoring: weights are per format and a missing AI review leaves the total unknown', () => {
  const post = { platform: 'linkedin', content: 'x' };
  const without = scorePost({ post, lint: lintFull });
  assert.equal(without.total, null);
  assert.equal(without.complete, false);
  assert.equal(without.meets_threshold, null);
  assert.ok(without.partial_total > 0);
  assert.ok(without.dimensions.platform.rules_only);
  assert.match(without.note, /No AI review/);

  const withAi = scorePost({ post, lint: lintFull, review: { dimensions: aiDims(9) } });
  assert.equal(withAi.complete, true);
  assert.equal(withAi.total, 93); // (90*25 + 90*30 + 95*15 + 95*15 + 100*15) / 100
  assert.equal(withAi.meets_threshold, true);
  assert.equal(withAi.technical_total, 100);
  assert.equal(withAi.subjective_total, 90);
  assert.equal(scorePost({ post, lint: lintFull, review: { dimensions: aiDims(6) } }).meets_threshold, false);
});

test('scoring: formats add their media dimension and media errors pull the score down separately from opinion', () => {
  const okMedia = { ok: true, errors: [], warnings: [] };
  const badMedia = { ok: false, errors: [{}], warnings: [] };
  const img = scorePost({ post: { platform: 'linkedin', image_url: 'u' }, lint: lintFull, review: { dimensions: aiDims(9) }, media: { image: okMedia } });
  assert.equal(img.format, 'image');
  assert.ok('image' in img.dimensions);
  const bad = scorePost({ post: { platform: 'linkedin', image_url: 'u' }, lint: lintFull, review: { dimensions: aiDims(9) }, media: { image: badMedia } });
  assert.ok(bad.dimensions.image.score <= 40);
  assert.ok(bad.total < img.total);
  assert.equal(bad.subjective_total, img.subjective_total);
  const pdf = scorePost({ post: { platform: 'linkedin', document_url: 'u' }, lint: lintFull, review: { dimensions: aiDims(8) }, media: { pdf: okMedia }, documents: true });
  assert.equal(pdf.format, 'pdf');
  const video = scorePost({ post: { platform: 'x', video_url: 'u', image_url: 'i' }, lint: lintFull, media: { video: okMedia } });
  assert.equal(video.format, 'video');
  assert.equal(mediaScore({ ok: true, errors: [], warnings: [1, 2] }), 88);
  assert.equal(mediaScore(null), null);
});

test('scoring weights can be overridden from the environment; bad JSON falls back to defaults', () => {
  const custom = loadWeights({ QUALITY_WEIGHTS_JSON: JSON.stringify({ text: { copywriting: 60 } }) });
  assert.equal(custom.text.copywriting, 60);
  assert.equal(custom.text.strategy, DEFAULT_WEIGHTS.text.strategy);
  assert.equal(loadWeights({ QUALITY_WEIGHTS_JSON: '{nope' }), DEFAULT_WEIGHTS);
});

// ---- AI review result handling ----

const rawReview = (over = {}) => ({
  overall_score: 90,
  dimensions: aiDims(9),
  critical_issues: [],
  warnings: [],
  unverifiable_claims: [],
  revision_instructions: [],
  pass: true,
  human_review_required: false,
  human_review_reasons: [],
  ...over,
});

test('review output is validated and re-derived, never trusted as given', () => {
  const ok = finalizeReview(rawReview(), { threshold: 85 });
  assert.equal(ok.ok, true);
  assert.equal(ok.review.pass, true);
  assert.equal(ok.review.score, 90);

  assert.equal(finalizeReview({ nonsense: true }, { threshold: 85 }).ok, false);
  assert.equal(finalizeReview(rawReview({ overall_score: 140 }), { threshold: 85 }).ok, false);
  assert.equal(finalizeReview(rawReview({ dimensions: { ...aiDims(9), readability: 'high' } }), { threshold: 85 }).ok, false);
  assert.equal(finalizeReview(rawReview({ dimensions: { audience_relevance: 9 } }), { threshold: 85 }).ok, false);
  assert.equal(finalizeReview(null, { threshold: 85 }).ok, false);

  // The model says "pass" but its own details contradict it.
  assert.equal(finalizeReview(rawReview({ critical_issues: [{ dimension: 'factual_accuracy', issue: 'invented stat', evidence: '300%' }] }), { threshold: 85 }).review.pass, false);
  assert.equal(finalizeReview(rawReview({ dimensions: { ...aiDims(9), factual_accuracy: 3 } }), { threshold: 85 }).review.pass, false);
  assert.equal(finalizeReview(rawReview({ pass: false }), { threshold: 85 }).review.pass, false);
  assert.equal(finalizeReview(rawReview({ dimensions: aiDims(7), overall_score: 70 }), { threshold: 85 }).review.pass, false);
  // An inflated overall score is replaced by the average of the dimensions and flagged.
  const inflated = finalizeReview(rawReview({ dimensions: aiDims(6), overall_score: 95 }), { threshold: 85 });
  assert.equal(inflated.review.score, 60);
  assert.equal(inflated.review.human_review_required, true);
  // Unverifiable claims always ask for a person.
  assert.equal(finalizeReview(rawReview({ unverifiable_claims: ['10,000 customers'] }), { threshold: 85 }).review.human_review_required, true);
});

test('the review schema accepts well-formed output and rejects missing parts', () => {
  assert.doesNotThrow(() => checkSchema(REVIEW_SCHEMA, rawReview()));
  assert.throws(() => checkSchema(REVIEW_SCHEMA, { ...rawReview(), dimensions: undefined }));
  const { pass, ...noPass } = rawReview();
  assert.throws(() => checkSchema(REVIEW_SCHEMA, noPass), /pass/);
});

// ---- Brand Brain ----

test('old brand records get complete defaults without being changed', () => {
  const old = { name: 'Old Co', audience: 'Everyone', tone: 'Plain', pillars: ['a'], platforms: ['x'] };
  const b = withDefaults(old);
  assert.equal(b.name, 'Old Co');
  assert.deepEqual(b.banned_phrases, []);
  assert.equal(b.link_policy.allow_links, true);
  assert.equal(b.hashtag_policy.max, null);
  assert.deepEqual(Object.keys(b.cta_policies).sort(), ['awareness', 'community', 'leads', 'sales']);
  assert.equal(b.schema_version, 1);
  assert.deepEqual(old, { name: 'Old Co', audience: 'Everyone', tone: 'Plain', pillars: ['a'], platforms: ['x'] });
  // Partial nested records are completed, user values win.
  const partial = withDefaults({ link_policy: { require_utm: true } });
  assert.equal(partial.link_policy.require_utm, true);
  assert.equal(partial.link_policy.allow_links, true);
});

// ---- Logging ----

test('logs never carry tokens, signed URLs or secrets', () => {
  assert.equal(redactUrl('https://cdn.example.com/a/b.png?X-Amz-Signature=abc&token=zzz#frag'), 'https://cdn.example.com/a/b.png');
  const out = redact({ access_token: 'sek', nested: { client_secret: 'x', ok: 'fine' }, msg: 'GET https://a.com/x?sig=1 failed with Bearer abc.def', list: [{ password: 'p' }] });
  assert.equal(out.access_token, '[redacted]');
  assert.equal(out.nested.client_secret, '[redacted]');
  assert.equal(out.nested.ok, 'fine');
  assert.equal(out.msg, 'GET https://a.com/x failed with Bearer [redacted]');
  assert.equal(out.list[0].password, '[redacted]');
  assert.equal(redactText('refresh_token=abc123&x=1'), 'refresh_token=[redacted]&x=1');
  assert.equal(redact(new Error('boom https://x.com/p?key=1')).message, 'boom https://x.com/p');
});

// ---- Media rules config ----

test('platform media rules differ per platform and are overridable', () => {
  const r = loadRules({});
  assert.deepEqual(r.image.instagram.formats, ['jpeg']);
  assert.ok(r.image.linkedin.formats.includes('png'));
  assert.equal(r.video.instagram.minSeconds, 3);
  assert.ok(r.video.x.maxSeconds < r.video.meta.maxSeconds);
  assert.equal(loadRules({ MEDIA_RULES_JSON: '{"video":{"x":{"maxSeconds":30}}}' }).video.x.maxSeconds, 30);
  assert.equal(loadRules({ MEDIA_RULES_JSON: '{broken' }).video.x.maxSeconds, r.video.x.maxSeconds);
});

// ---- Creative prompts ----

test('image prompts adapt to the creative brief instead of always banning text', () => {
  const brand = withDefaults({ name: 'Acme', brand_colors: ['#0a66c2'], visual_style: { preferred: 'warm flat illustration', prohibited: 'stock handshake photos' } });
  const photo = imageConstraints({ brand, platform: 'instagram', style: 'photo' });
  assert.match(photo, /no text, letters/i);
  assert.match(photo, /#0a66c2/);
  assert.match(photo, /warm flat illustration/);
  assert.match(photo, /stock handshake photos/);
  assert.match(photo, /4:5/);
  assert.match(photo, /central 70% width/);
  const graphic = imageConstraints({ brand, platform: 'linkedin', style: 'text_graphic', overlayText: 'Write three adjectives' });
  assert.match(graphic, /Exact wording to display: "Write three adjectives"/);
  assert.doesNotMatch(graphic, /must be no text/);
  assert.match(templatePrompt({ brand, post: { content: 'Hello' }, platform: 'x', style: 'illustration' }), /illustration/i);
});

// ---- Video brief ----

const BRIEF = {
  objective: 'Show how a logo is built',
  audience: 'Small business founders',
  hook: 'A blank page becomes a logo in five seconds',
  scenes: [
    { visual: 'Time-lapse of a sketchbook', seconds: 5, narration: 'It starts messy.' },
    { visual: 'Clean vector logo appears on a laptop', seconds: 7, on_screen_text: 'Your brand, simplified' },
  ],
  captions: 'It starts messy. Your brand, simplified.',
  cta: 'Follow for more',
  duration_seconds: 12,
};

test('video brief: validated, checked against the platform, and honest about what the model can not make', () => {
  assert.equal(VideoBriefZ.safeParse(BRIEF).success, true);
  assert.equal(VideoBriefZ.safeParse({ ...BRIEF, scenes: [] }).success, false);
  assert.equal(VideoBriefZ.safeParse({ objective: 'x' }).success, false);
  const parsed = VideoBriefZ.parse(BRIEF);
  assert.deepEqual(checkBrief(parsed, 'instagram'), { errors: [], warnings: [] });
  assert.ok(checkBrief({ ...parsed, duration_seconds: 2, scenes: [{ visual: 'abcde', seconds: 2 }] }, 'instagram').errors[0].includes('shorter'));
  assert.ok(checkBrief({ ...parsed, scenes: [{ visual: 'abcde', seconds: 5 }] }, 'x').warnings.some((w) => w.includes('add up')));
  assert.ok(checkBrief({ ...parsed, captions: undefined }, 'x').warnings.some((w) => w.includes('caption')));
  assert.deepEqual(briefLimits(parsed), ['narration / voice-over', 'on-screen text', 'captions / subtitles', 'call-to-action end card']);
  const prompt = briefToPrompt(parsed, { aspect: '9:16', brandName: 'Acme' });
  assert.match(prompt, /1\. \(5s\) Time-lapse/);
  assert.match(prompt, /Do not draw any text/);
  assert.doesNotMatch(prompt, /Your brand, simplified/); // on-screen text is not sent to the video model
});
