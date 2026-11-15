import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintContent, extractHashtags, extractUrls, similarity, containsPhrase, hasCta } from '../src/quality/lint.js';
import { withDefaults } from '../src/brandBrain.js';
import { charCount } from '../src/platforms.js';
import { BRAND, GOOD_LINKEDIN } from './harness.js';

const brand = (extra = {}) => withDefaults({ ...BRAND, ...extra });
const lint = (post, extra = {}, recent = []) => lintContent({ post: { platform: 'linkedin', ...post }, brand: brand(extra), recent });
const codes = (r, sev) => r.issues.filter((i) => !sev || i.severity === sev).map((i) => i.code);

test('a good LinkedIn post has no errors', () => {
  const r = lint({ content: GOOD_LINKEDIN });
  assert.deepEqual(codes(r, 'error'), []);
});

test('empty captions are errors', () => {
  assert.deepEqual(codes(lint({ content: '   \n ' }), 'error'), ['EMPTY_CONTENT']);
});

test('platform character limits use each platform\'s counting rules', () => {
  assert.ok(codes(lint({ platform: 'x', content: 'a'.repeat(281) }), 'error').includes('TOO_LONG'));
  assert.ok(!codes(lint({ platform: 'x', content: 'a'.repeat(280) }), 'error').includes('TOO_LONG'));
  // A link counts as 23 however long it is; emoji count as 2.
  const withLink = `${'a'.repeat(250)} https://example.com/${'path/'.repeat(30)}`;
  assert.equal(charCount('x', withLink), 250 + 1 + 23);
  assert.equal(charCount('x', '😀'), 2);
  assert.equal(charCount('linkedin', '😀'), 1);
  assert.ok(codes(lint({ platform: 'x', content: `${'a'.repeat(276)} 😀😀` }), 'error').includes('TOO_LONG'));
  assert.ok(codes(lint({ platform: 'instagram', content: 'a'.repeat(2201), image_url: 'x' }), 'error').includes('TOO_LONG'));
});

test('markdown that would show up literally is an error', () => {
  for (const md of ['This is **bold** text', '# Heading\nText', 'See [my site](https://example.com)', '```code```']) {
    assert.ok(codes(lint({ content: `${md} ${'x'.repeat(40)}` }), 'error').includes('MARKDOWN'), md);
  }
  assert.ok(!codes(lint({ content: 'A #hashtag line is not a heading #Branding' }), 'error').includes('MARKDOWN'));
});

test('hashtags: extraction, counts, duplicates, banned and required', () => {
  assert.deepEqual(extractHashtags('Hi #One #two_three, not#this https://x.com/a#frag #বাংলা'), ['One', 'two_three', 'বাংলা']);
  const many = lint({ platform: 'x', content: 'Short post #a #b #c' });
  assert.ok(codes(many, 'error').includes('HASHTAGS_MAX'));
  assert.ok(codes(lint({ content: `${GOOD_LINKEDIN} #Branding` }), 'warning').includes('HASHTAGS_DUPLICATE'));
  const policy = { hashtag_policy: { max: 2, banned: ['SmallBusiness'], required: ['Acme'] } };
  const r = lint({ content: GOOD_LINKEDIN }, policy);
  assert.ok(codes(r, 'error').includes('HASHTAGS_MAX'));
  assert.ok(codes(r, 'error').includes('HASHTAG_BANNED'));
  assert.ok(codes(r, 'warning').includes('HASHTAG_REQUIRED'));
  assert.ok(codes(lint({ content: 'Year in review #2024 and more text here to be long enough for the check' }), 'warning').includes('HASHTAG_NUMERIC'));
});

test('banned phrases and prohibited topics respect word boundaries', () => {
  const b = { banned_phrases: ['game changer'], prohibited_topics: ['politics'] };
  assert.ok(codes(lint({ content: 'This is a Game  Changer for you' }, b), 'error').includes('BANNED_PHRASE'));
  assert.ok(codes(lint({ content: 'Let us talk politics today' }, b), 'error').includes('PROHIBITED_TOPIC'));
  assert.ok(!codes(lint({ content: 'Our geopoliticsy newsletter' }, b), 'error').includes('PROHIBITED_TOPIC'));
  assert.equal(containsPhrase('আমরা রাজনীতি নিয়ে লিখি না', 'রাজনীতি'), true);
});

test('numbers and absolute claims need support from verified facts', () => {
  const content = 'We grew clients\' revenue by 300% and we guarantee results. Comment below.';
  const r = lint({ content });
  assert.ok(codes(r, 'review').includes('UNVERIFIED_NUMBER'));
  assert.ok(codes(r, 'review').includes('ABSOLUTE_CLAIM'));
  const supported = lint({ content }, { verified_facts: ['Clients saw revenue grow by 300% on average in 2025'], proof_points: ['We guarantee results in writing'] });
  assert.ok(!codes(supported, 'review').includes('UNVERIFIED_NUMBER'));
  assert.ok(!codes(supported, 'review').includes('ABSOLUTE_CLAIM'));
  const flagged = lint({ content: 'Our process is bulletproof, comment if you agree' }, { claims_needing_review: ['bulletproof'] });
  assert.ok(codes(flagged, 'review').includes('CLAIM_NEEDS_REVIEW'));
});

test('CTA: required for leads and sales goals, only a warning otherwise', () => {
  const noCta = 'A calm statement about branding with nothing to do next.';
  assert.ok(codes(lint({ content: noCta }, { goal: 'leads' }), 'review').includes('CTA_MISSING'));
  assert.ok(codes(lint({ content: noCta }, { goal: 'awareness' }), 'warning').includes('CTA_MISSING'));
  assert.equal(hasCta('আপনার মতামত কমেন্টে জানান'), true);
  assert.equal(hasCta('Book a call today'), true);
});

test('links: brand policy for allowed domains, UTM, and platforms where links are not clickable', () => {
  const content = 'Read more: https://acme.com/blog/post and https://other.com/x. Comment below.';
  const r = lint({ content }, { link_policy: { allowed_domains: ['acme.com'], require_utm: true } });
  assert.ok(codes(r, 'error').includes('LINK_DOMAIN'));
  assert.ok(codes(r, 'error').includes('LINK_UTM'));
  const ok = lint({ content: 'Read: https://acme.com/p?utm_source=li&utm_medium=social&utm_campaign=q4 Comment below.' }, { link_policy: { allowed_domains: ['acme.com'], require_utm: true } });
  assert.deepEqual(codes(ok, 'error'), []);
  assert.ok(codes(lint({ content: 'No links please https://acme.com/x' }, { link_policy: { allow_links: false } }), 'error').includes('LINKS_NOT_ALLOWED'));
  assert.ok(codes(lint({ platform: 'instagram', content: 'See https://acme.com now. Comment below.', image_url: 'x' }), 'warning').includes('LINK_NOT_CLICKABLE'));
  assert.deepEqual(extractUrls('go to https://a.com/x), then https://b.com.'), ['https://a.com/x', 'https://b.com']);
});

test('hook rules flag known weak openers but never claim to prove a hook is good', () => {
  assert.ok(codes(lint({ content: "In today's fast-paced world, branding matters. Comment below." }), 'warning').includes('HOOK_GENERIC'));
  assert.ok(codes(lint({ content: 'BRANDING IS VERY IMPORTANT FOR EVERY SINGLE BUSINESS OUT THERE. Comment' }), 'warning').includes('HOOK_CAPS'));
  assert.ok(codes(lint({ content: 'We will delve into branding and unlock the power of design. Comment below.' }), 'warning').includes('AI_PHRASING'));
  assert.ok(!codes(lint({ content: GOOD_LINKEDIN }), 'warning').includes('HOOK_GENERIC'));
});

test('near-duplicates of recent posts are flagged', () => {
  const recent = [{ id: 'a', content: GOOD_LINKEDIN }];
  assert.ok(codes(lint({ id: 'b', content: GOOD_LINKEDIN }, {}, recent), 'error').includes('DUPLICATE_POST'));
  assert.ok(codes(lint({ id: 'b', content: `${GOOD_LINKEDIN}\nPS: thanks for reading everyone and have a good week` }, {}, recent), 'warning').includes('SIMILAR_POST'));
  assert.ok(!codes(lint({ id: 'b', content: 'Completely different words about pricing a service for small agencies. Reply with questions.' }, {}, recent)).includes('DUPLICATE_POST'));
  assert.ok(similarity('a b c d e', 'a b c d e') === 1);
  assert.deepEqual(codes(lint({ id: 'a', content: GOOD_LINKEDIN }, {}, recent), 'error'), []); // a post is not its own duplicate
});

test('media requirements and alt text', () => {
  assert.ok(codes(lint({ platform: 'instagram', content: 'Caption here, comment below' }), 'error').includes('MEDIA_REQUIRED'));
  const noAlt = lint({ content: GOOD_LINKEDIN, image_url: 'http://x/y.jpg' });
  assert.ok(codes(noAlt, 'warning').includes('ALT_MISSING'));
  assert.ok(noAlt.warnings.find((w) => w.code === 'ALT_MISSING').message.includes('sent to the platform'));
  assert.ok(!codes(lint({ content: GOOD_LINKEDIN, image_url: 'x', image_alt: 'A hand sketching a logo' }), 'warning').includes('ALT_MISSING'));
  assert.ok(!codes(lint({ content: GOOD_LINKEDIN, image_url: 'x', document_url: 'd' }), 'warning').includes('ALT_MISSING'));
});

test('language mismatch is detected from the script', () => {
  const bengali = 'আমাদের ব্র্যান্ডিং নিয়ে আজকের কথা। ছোট ব্যবসার জন্য একটি পরিষ্কার পরিচয় খুবই গুরুত্বপূর্ণ। আপনার মতামত কমেন্টে জানান।';
  assert.ok(codes(lint({ content: bengali }, { language: 'English' }), 'warning').includes('LANGUAGE_MISMATCH'));
  assert.ok(!codes(lint({ content: bengali }, { language: 'Bengali' }), 'warning').includes('LANGUAGE_MISMATCH'));
  assert.ok(codes(lint({ content: GOOD_LINKEDIN.repeat(1) }, { language: 'Bengali' }), 'warning').includes('LANGUAGE_MISMATCH'));
});

test('category scores drop with issues and stay within 0-100', () => {
  const r = lint({ content: 'x'.repeat(4000) });
  assert.ok(r.byCategory.platform < 100 && r.byCategory.platform >= 0);
  assert.ok(lint({ content: GOOD_LINKEDIN }).byCategory.platform >= 90);
});
