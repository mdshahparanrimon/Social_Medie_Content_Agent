// Scoring. Two kinds of evidence are kept apart:
//  - technical: computed by rules (lint results, media checks). Reproducible.
//  - subjective: from the AI review's dimension scores. Opinion of a model, possibly absent.
// The total only exists when every dimension that applies has a value; otherwise it is null and the post says so.
// A score is a guide for editing, not a prediction of engagement, and it never approves or publishes anything.

export const DEFAULT_WEIGHTS = {
  // Which dimensions apply to a post and how much each counts. Weights are relative; they are normalised to 100.
  text: { strategy: 25, copywriting: 30, platform: 15, brand: 15, technical: 15 },
  image: { strategy: 20, copywriting: 25, platform: 10, brand: 10, image: 20, technical: 15 },
  pdf: { strategy: 20, copywriting: 20, platform: 10, brand: 10, pdf: 25, technical: 15 },
  video: { strategy: 20, copywriting: 20, platform: 10, brand: 10, video: 25, technical: 15 },
};

export const DIMENSION_SOURCE = {
  strategy: 'subjective',
  copywriting: 'subjective',
  platform: 'mixed',
  brand: 'mixed',
  image: 'technical',
  pdf: 'technical',
  video: 'technical',
  technical: 'technical',
};

export function loadWeights(env = process.env) {
  if (!env.QUALITY_WEIGHTS_JSON) return DEFAULT_WEIGHTS;
  try {
    const custom = JSON.parse(env.QUALITY_WEIGHTS_JSON);
    return Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((f) => [f, { ...DEFAULT_WEIGHTS[f], ...custom[f] }]));
  } catch (err) {
    console.error(`QUALITY_WEIGHTS_JSON is not valid JSON (${err.message}); using default weights.`);
    return DEFAULT_WEIGHTS;
  }
}

export function formatOf(post, { documents } = {}) {
  if (documents && post.document_url) return 'pdf';
  if (post.video_url) return 'video';
  if (post.image_url) return 'image';
  return 'text';
}

const avg = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

// A media report -> 0..100: each error is fatal-ish, each warning a small deduction.
export function mediaScore(report) {
  if (!report) return null;
  if (!report.ok) return clamp(40 - 10 * (report.errors.length - 1));
  return clamp(100 - 6 * report.warnings.length);
}

/**
 * lint: result of lintContent. review: finalized AI review or null. media: { image, pdf, video } combined QC reports.
 * Returns { format, dimensions, total, partial_total, complete, technical_total, subjective_total, threshold, meets_threshold }.
 */
export function scorePost({ post, lint, review, media = {}, threshold = 85, documents = false, weights = loadWeights() }) {
  const format = formatOf(post, { documents });
  const w = weights[format];
  const d = review?.dimensions;
  const subj = (...keys) => (d ? avg(keys.map((k) => d[k] * 10)) : null);

  const technicalIssues = lint.byCategory.technical;
  const mediaTechnical = [media.image, media.pdf, media.video].filter(Boolean).map(mediaScore);
  const technical = avg([technicalIssues, ...mediaTechnical]);

  const raw = {
    strategy: subj('audience_relevance', 'usefulness', 'brief_compliance', 'cta_relevance'),
    copywriting: subj('hook_clarity', 'originality', 'readability'),
    // Rules and opinion each cover part of these two, so both feed in; with no AI review the rule half stands alone and is marked.
    platform: d ? avg([lint.byCategory.platform, d.platform_native_formatting * 10]) : lint.byCategory.platform,
    brand: d ? avg([lint.byCategory.brand, lint.byCategory.claims, d.brand_consistency * 10, d.factual_accuracy * 10]) : avg([lint.byCategory.brand, lint.byCategory.claims]),
    image: media.image ? mediaScore(media.image) : null,
    pdf: media.pdf ? mediaScore(media.pdf) : null,
    video: media.video ? mediaScore(media.video) : null,
    technical,
  };
  const dimensions = {};
  for (const key of Object.keys(w)) {
    dimensions[key] = { score: raw[key] === null || raw[key] === undefined ? null : clamp(raw[key]), weight: w[key], source: DIMENSION_SOURCE[key], rules_only: !d && DIMENSION_SOURCE[key] === 'mixed' };
  }
  const present = Object.values(dimensions).filter((x) => x.score !== null);
  const sumW = (list) => list.reduce((s, x) => s + x.weight, 0);
  const weighted = (list) => (list.length ? clamp(list.reduce((s, x) => s + x.score * x.weight, 0) / sumW(list)) : null);
  const complete = present.length === Object.keys(dimensions).length && !!d;
  const technicalDims = Object.values(dimensions).filter((x) => x.source === 'technical' && x.score !== null);
  const subjectiveDims = Object.values(dimensions).filter((x) => x.source === 'subjective' && x.score !== null);
  const total = complete ? weighted(present) : null;
  return {
    format,
    dimensions,
    complete,
    total,
    partial_total: weighted(present),
    technical_total: weighted(technicalDims),
    subjective_total: weighted(subjectiveDims),
    threshold,
    meets_threshold: total === null ? null : total >= threshold,
    note: complete ? null : 'No AI review result: the total is not available and only the rule-based parts are scored.',
  };
}
