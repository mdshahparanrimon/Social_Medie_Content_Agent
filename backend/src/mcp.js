import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { repo } from './db/index.js';
import { httpError, AppError } from './errors.js';
import { runInWorkspace } from './context.js';
import { rateLimit } from './auth/rateLimit.js';
import { getConfig } from './settings.js';
import { getBrand, saveBrand, brandContext, missingBrandFields, brandGaps } from './brandBrain.js';
import { FORMATS } from './agents/strategist.js';
import { getPost } from './agents/creator.js';
import { EDITABLE, approvePost, editPost, setImageAlt, setPostDocument, setPostImage, setPostVideo, unapprovePost } from './posts.js';
import { MAX_DOCUMENT_BYTES, importDocument, importImage, importVideo } from './media.js';
import { assessPost, summarize } from './quality/gate.js';
import { reviewerSetup } from './quality/review.js';
import { IMAGE_STYLES } from './imagePrompt.js';
import { VideoBriefZ } from './videoBrief.js';
import { createPostImage, startPostVideo } from './agents/artist.js';
import { MAX_SLIDES, MIN_SLIDES, SLIDE_RULES, createPostCarousel } from './agents/carousel.js';
import { MAX_PDF_PAGES } from './slides.js';
import { PLATFORMS, PLATFORM_KEYS } from './platforms.js';
import { API_URL } from './urls.js';

// MCP connector: lets a user's own Claude (claude.ai custom connector, Claude Desktop, Claude Code) plan, write
// and schedule posts in their workspace, using their Claude subscription instead of an API key.
// The connector URL carries a secret token (only its hash is stored); the token picks the workspace.

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const connectorUrl = (token) => `${API_URL}/mcp/${token}`;

// ---- Connector URL management (dashboard, signed in) ----
export const mcpTokenRouter = Router();

const noActivity = { mcp_last_used_at: null, mcp_last_client: null, mcp_last_tool: null };

mcpTokenRouter.get('/', async (req, res) => {
  const config = await getConfig();
  res.json({
    active: Boolean(config.mcp_token_hash),
    created_at: config.mcp_token_created_at || null,
    last_used_at: config.mcp_last_used_at || null,
    last_client: config.mcp_last_client || null,
    last_tool: config.mcp_last_tool || null,
  });
});

// Creates the URL, or replaces it (the old one stops working). The full URL is only shown this once.
mcpTokenRouter.post('/', async (req, res) => {
  const token = `ca_${crypto.randomBytes(32).toString('base64url')}`;
  const created_at = new Date().toISOString();
  await repo.saveWorkspaceSettings({ mcp_token_hash: hashToken(token), mcp_token_created_at: created_at, ...noActivity });
  res.json({ active: true, created_at, url: connectorUrl(token) });
});

mcpTokenRouter.delete('/', async (req, res) => {
  await repo.saveWorkspaceSettings({ mcp_token_hash: null, mcp_token_created_at: null, ...noActivity });
  res.json({ active: false, created_at: null });
});

// Remembers Claude's handshake (which client connected) and tool calls; other requests (pings, tool lists) aren't saved.
async function recordActivity(body) {
  if (!body || Array.isArray(body)) return;
  const now = new Date().toISOString();
  if (body.method === 'initialize') {
    const client = body.params?.clientInfo?.name;
    await repo.saveWorkspaceSettings({ mcp_last_used_at: now, ...(client && { mcp_last_client: String(client).slice(0, 80) }) });
  } else if (body.method === 'tools/call') {
    await repo.saveWorkspaceSettings({ mcp_last_used_at: now, mcp_last_tool: String(body.params?.name || '').slice(0, 80) });
  }
}

// ---- Tools ----
const INSTRUCTIONS = `Content Agent plans, stores and publishes social media posts for the user's brand.
You write the posts yourself; this server gives you the brand and platform rules and saves your work.
Start with get_writing_guide. Posts you create are drafts: the user reviews them in the Content Agent app.
Every post you save is checked (length, formatting, brand rules, claims, media) and the result comes back with it: fix what it lists with update_post.
Only call schedule_post when the user asks to approve or schedule a post, because scheduled posts are published automatically. schedule_post refuses posts that fail the checks or need a person's review: tell the user to open the post in the Content Agent app.`;

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

// Tool errors go back to Claude as readable messages instead of failing the whole request.
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    const extra = err.details?.quality ? `

Quality report:
${JSON.stringify(err.details.quality, null, 2)}` : err.details && err.code ? `

Details:
${JSON.stringify(err.details, null, 2)}` : '';
    return { isError: true, content: [{ type: 'text', text: `${err.code ? `[${err.code}] ` : ''}${err.message}${extra}` }] };
  }
};

// Run the independent AI review when a reviewer is configured; otherwise only the rule checks run (the report says so).
async function aiReviewMode() {
  return reviewerSetup(await getConfig()).usable ? 'always' : 'never';
}

function postSummary(post) {
  const { id, platform, status, content, image_url, image_alt, image_prompt, video_url, video_status, video_error, document_url, document_title, document_pages, scheduled_at, published_at, external_url, error, uncertain_reason, calendar_item_id, created_at } = post;
  return {
    id, platform, status, content, image_url, image_alt, image_prompt, video_url, video_status, video_error, document_url, document_title, document_pages,
    scheduled_at, published_at, external_url, error, uncertain_reason, calendar_item_id, created_at,
    quality: summarize(post.quality),
  };
}

// Checked before downloading media from a link, so nothing is stored for a post that can't take it.
async function editablePost(id) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  return post;
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const platform = z.enum(PLATFORM_KEYS);

export async function writingGuide() {
  const brand = await getBrand();
  const missing = missingBrandFields(brand);
  const platforms = PLATFORM_KEYS.map(
    (key) => `## ${PLATFORMS[key].label} (platform "${key}", max ${PLATFORMS[key].maxChars} characters)\n${PLATFORMS[key].guide}`,
  );
  return [
    missing.length
      ? `Brand Brain is incomplete (missing: ${missing.join(', ')}). Ask the user for these and save them with update_brand_brain before writing.\n`
      : '',
    brandContext(brand),
    '',
    '# Platform rules',
    ...platforms,
    '',
    '# How to work',
    `- Planning: check list_calendar for the week, then add_calendar_items. Formats: ${FORMATS.join(', ')}. Rotate the content pillars and vary formats; at most one post per platform per day.`,
    '- Writing: write in the brand voice for its audience. Be specific and useful; avoid clichés, filler and generic AI phrasing. Never invent statistics, quotes or facts about the brand.',
    '- Before saving, review your draft like a strict brand editor (voice, audience fit, hook, platform rules, forbidden topics) and revise it until it is ready to publish.',
    '- Quality checks: create_post and update_post return a quality report. "blockers" are rules that were broken (length, markdown, banned phrases, unverified media problems): fix every one. "needs_acknowledgement" items are things the user must look at (unverified numbers, claims, missing CTA for a leads/sales goal): remove or fix them if you can, otherwise tell the user. Use only facts from the Brand Brain; never invent numbers, results or quotes. Stop after the revision limit shown in the report and tell the user the draft needs their review. A good score never means a post is approved; the user approves in the app.',
    '- Saving: create_post (with calendar_item_id when it comes from the calendar). Put only the final post text in content, exactly as it should be published.',
    '- Images: every platform can post one image. Instagram needs one before scheduling. Make it with generate_post_image (choose style: photo, illustration or text_graphic; for text_graphic give the exact overlay_text and tell the user to proofread it), or attach a public https link (Google Drive share links work) with set_post_image. Always give alt_text (a literal description, under 140 characters). Images are checked and may be cropped to fit the platform: the result says so. Ask the user before making images unless they asked for them.',
    '- Videos: attach a finished video from a public https link (Google Drive share links work) with set_post_video. Or generate_post_video starts a short AI video (16:9, or 9:16 for Instagram Reels and Facebook) and returns at once; it takes 1-3 minutes. Pass a structured `brief` (objective, audience, hook, scenes with seconds, narration, on-screen text, captions, cta) for anything more than a simple clip; the AI video model only draws the visuals, so narration, text overlays and captions are listed back as things to add in an editor. Check it with list_posts (video_status: generating, ready, failed). A post with a video is published as a video. Ask the user before making AI videos unless they asked for them.',
    `- LinkedIn PDF carousels (document posts): write the slides yourself and call generate_post_carousel; the app draws them on brand-colored slides. Or attach a finished PDF from a public https link with set_post_document. The post text is the caption. A carousel wins over an image or video on LinkedIn. Slide rules:\n${SLIDE_RULES}`,
    '- Files from Google Drive: when the user made images, videos or PDFs and saved them to Drive, attach each with set_post_image, set_post_video or set_post_document using its Drive link. With Google Drive connected in the app (Connections), private files work; otherwise the file must be shared as "Anyone with the link". A Google Slides link attached with set_post_document becomes a PDF carousel. If a download fails, pass on the error to the user.',
    '- Times are ISO 8601. Without scheduled_at, schedule_post uses the platform\'s default posting time.',
    '',
    brandGaps(brand).length ? `Optional Brand Brain details that would make checks stronger (ask the user, do not invent): ${brandGaps(brand).join('; ')}.` : '',
    '',
    '# Brand Brain fields (raw)',
    JSON.stringify(brand, null, 2),
  ].join('\n');
}

export function buildServer() {
  const server = new McpServer({ name: 'content-agent', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'get_writing_guide',
    {
      title: 'Get brand & writing guide',
      description: "The brand's Brain (voice, audience, pillars, things to avoid, sample posts), each platform's rules and how to work. Call this before planning or writing.",
      inputSchema: {},
      annotations: readOnly,
    },
    safe(async () => text(await writingGuide())),
  );

  server.registerTool(
    'update_brand_brain',
    {
      title: 'Update Brand Brain',
      description: 'Change Brand Brain fields. Only the fields you pass change. Confirm the values with the user first.',
      inputSchema: {
        name: z.string().optional(),
        description: z.string().optional(),
        goal: z.enum(['awareness', 'leads', 'sales', 'community']).optional(),
        audience: z.string().optional(),
        tone: z.string().optional(),
        language: z.string().optional(),
        pillars: z.array(z.string()).optional().describe('Content pillars (themes the brand posts about)'),
        avoid: z.string().optional().describe('Topics or styles the brand never uses'),
        sample_posts: z.string().optional().describe('Past posts that performed well'),
        platforms: z.array(platform).optional().describe('Platforms the brand posts on'),
        posts_per_week: z.number().int().min(1).max(14).optional().describe('Per platform'),
        customer_segments: z.array(z.string()).optional().describe('Who the brand sells to, one short line each'),
        pain_points: z.array(z.string()).optional().describe('Problems the audience has'),
        proof_points: z.array(z.string()).optional().describe('Approved evidence the brand may cite. Only what the user confirmed.'),
        verified_facts: z.array(z.string()).optional().describe('Statements the user confirmed are true and may be used as claims'),
        claims_needing_review: z.array(z.string()).optional().describe('Phrases/claim types that need a person to verify (e.g. "guaranteed")'),
        banned_phrases: z.array(z.string()).optional().describe('Exact phrases that must never appear'),
        prohibited_topics: z.array(z.string()).optional().describe('Topics never to write about'),
        cta_policies: z.partialRecord(z.enum(['awareness', 'leads', 'sales', 'community']), z.string()).optional().describe('Preferred call to action per business goal'),
        link_policy: z.object({ allow_links: z.boolean().optional(), require_utm: z.boolean().optional(), utm_source: z.string().optional(), utm_medium: z.string().optional(), utm_campaign: z.string().optional(), allowed_domains: z.array(z.string()).optional() }).optional(),
        hashtag_policy: z.object({ min: z.number().int().nullable().optional(), max: z.number().int().nullable().optional(), banned: z.array(z.string()).optional(), required: z.array(z.string()).optional() }).optional(),
        brand_colors: z.array(z.string()).optional().describe('Hex colors, e.g. #0a66c2'),
        brand_fonts: z.array(z.string()).optional(),
        logo_url: z.string().optional(),
        visual_style: z.object({ preferred: z.string().optional(), prohibited: z.string().optional() }).optional(),
        platform_preferences: z.partialRecord(platform, z.string()).optional().describe('Writing preferences per platform'),
        approved_examples: z.array(z.string()).optional(),
        rejected_examples: z.array(z.object({ text: z.string(), reason: z.string().optional() })).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async (fields) => text(await saveBrand(fields))),
  );

  server.registerTool(
    'list_calendar',
    {
      title: 'List content calendar',
      description: 'Planned post ideas between two dates (inclusive), with the linked post status if one was written.',
      inputSchema: { from: ymd, to: ymd },
      annotations: readOnly,
    },
    safe(async ({ from, to }) => text(await repo.listCalendar(from, to))),
  );

  server.registerTool(
    'add_calendar_items',
    {
      title: 'Add to content calendar',
      description: 'Add planned post ideas to the calendar. Write each post later with create_post and its calendar_item_id.',
      inputSchema: {
        items: z
          .array(
            z.object({
              date: ymd,
              platform,
              pillar: z.string().min(1),
              format: z.enum(FORMATS),
              hook_idea: z.string().min(1).describe('1-2 sentences: the specific angle and opening hook'),
            }),
          )
          .min(1)
          .max(50),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ items }) => {
      await repo.insertCalendarItems(items);
      const dates = items.map((item) => item.date).sort();
      return text(await repo.listCalendar(dates[0], dates.at(-1)));
    }),
  );

  server.registerTool(
    'list_posts',
    {
      title: 'List posts',
      description: 'Posts in this workspace, newest last. Filter by status: draft, approved (scheduled), publishing, published, failed, uncertain (may or may not have gone out: the user must confirm in the app).',
      inputSchema: {
        status: z.array(z.enum(['draft', 'approved', 'publishing', 'published', 'failed', 'uncertain'])).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Most recent N (default 30)'),
      },
      annotations: readOnly,
    },
    safe(async ({ status, limit = 30 }) => {
      const posts = await repo.listPosts(status?.length ? status : ['draft', 'approved', 'publishing', 'published', 'failed', 'uncertain']);
      return text(posts.slice(-limit).map(postSummary));
    }),
  );

  server.registerTool(
    'create_post',
    {
      title: 'Save a new post (draft)',
      description: 'Save a post you wrote as a draft for the user to review. Follow get_writing_guide first.',
      inputSchema: {
        platform,
        content: z.string().min(1).describe('The final post text, exactly as it should be published'),
        brief: z.string().optional().describe('What the post is about (shown to the user, used for rewrites in the app)'),
        calendar_item_id: z.string().optional().describe('The calendar item this post is written for'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ platform: key, content, brief, calendar_item_id }) => {
      if (calendar_item_id) {
        const item = await repo.getCalendarItem(calendar_item_id);
        if (!item) throw httpError(404, 'Calendar item not found.');
        if (item.post_id) throw httpError(409, 'This calendar item already has a post.');
        if (item.platform !== key) throw httpError(400, `That calendar item is for ${PLATFORMS[item.platform].label}.`);
      }
      const post = await repo.createPost({
        platform: key,
        content: content.trim(),
        brief: brief?.trim() || 'Written by Claude via MCP.',
        calendar_item_id: calendar_item_id || null,
      });
      // The draft is always saved. The same checks as in the app run now, and the report says what to fix.
      const { post: checked } = await assessPost(post, { runAi: await aiReviewMode() });
      return text(postSummary(checked));
    }),
  );

  server.registerTool(
    'update_post',
    {
      title: 'Edit a post',
      description: 'Replace the text of a draft, scheduled or failed post. Returns the quality report for the new text. An approved post that no longer passes goes back to draft.',
      inputSchema: { id: z.string(), content: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, content }) => {
      const updated = await editPost(id, content);
      // Each changed version counts as one revision; the report shows how many are left.
      const { post } = await assessPost(updated, { runAi: await aiReviewMode() });
      return text(postSummary(post));
    }),
  );

  server.registerTool(
    'set_post_image',
    {
      title: 'Set a post image',
      description:
        'Attach an image from a public https link, e.g. a Google Drive file shared as "Anyone with the link" (required for Instagram). ' +
        'It is downloaded and saved as JPEG, replacing any image. For Instagram, use an aspect ratio between 4:5 and 1.91:1.',
      inputSchema: { id: z.string(), image_url: z.string().url().startsWith('https://'), alt_text: z.string().max(1000).optional().describe('What the image shows, for screen readers (under 140 characters is best)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ id, image_url, alt_text }) => {
      const post = await editablePost(id);
      const img = await importImage(image_url, { platform: post.platform, altText: alt_text });
      const updated = await setPostImage(id, img.url, { alt: alt_text ?? '', qc: img.qc });
      return text({ ...postSummary(updated), media_check: { duplicate: img.duplicate, cropped: img.cropped, warnings: img.qc.warnings, look_at_it: img.qc.humanReview } });
    }),
  );

  server.registerTool(
    'set_post_video',
    {
      title: 'Set a post video',
      description:
        'Attach a finished MP4 or MOV video (up to 100 MB) from a public https link, e.g. a Google Drive file shared as "Anyone with the link". ' +
        'It is downloaded and saved, replacing any video; the post is then published as a video (a Reel on Instagram, 3-90 seconds).',
      inputSchema: { id: z.string(), video_url: z.string().url().startsWith('https://') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ id, video_url }) => {
      const post = await editablePost(id);
      const vid = await importVideo(video_url, { platform: post.platform });
      const updated = await setPostVideo(id, vid.url, { qc: vid.qc });
      return text({ ...postSummary(updated), media_check: { duplicate: vid.duplicate, info: vid.qc.info, warnings: vid.qc.warnings, look_at_it: vid.qc.humanReview } });
    }),
  );

  server.registerTool(
    'generate_post_image',
    {
      title: 'Make a post image with AI',
      description:
        "Make an image for a post with the workspace's image AI (Gemini or an OpenAI image model; not your own tokens) and attach it, replacing any image. " +
        'Write `prompt` yourself: subject, setting, lighting, colors, composition with one focal point. By default no text or logos are drawn; use style text_graphic with overlay_text when words belong in the image. It is cropped to the platform size.',
      inputSchema: {
        id: z.string(),
        prompt: z.string().min(10).describe('The image prompt, 3-6 sentences: subject, setting, ONE focal point, lighting, colours. The app adds brand colours, platform crop rules and the text policy.'),
        style: z.enum(IMAGE_STYLES).optional().describe('photo | illustration | text_graphic (words are part of the design) | auto (default)'),
        overlay_text: z.string().max(120).optional().describe('For text_graphic: the exact words to show (the user must proofread the result)'),
        alt_text: z.string().max(1000).optional().describe('Literal description for screen readers, under 140 characters'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ id, prompt, style, overlay_text, alt_text }) => text(postSummary(await createPostImage(id, { prompt, style, overlayText: overlay_text, altText: alt_text })))),
  );

  server.registerTool(
    'generate_post_video',
    {
      title: 'Make a post video with AI',
      description:
        "Start making a short video for a post with the workspace's video AI (Gemini Omni Flash or an OpenAI video model) and attach it when done, replacing any video. " +
        'Returns at once with video_status "generating"; check list_posts after 1-3 minutes. Write `prompt` yourself: subject, action, camera movement, setting, lighting, mood; one continuous shot; no text or logos.',
      inputSchema: {
        id: z.string(),
        prompt: z.string().min(10).optional().describe('The video prompt, 2-5 sentences. Not needed when you pass a brief.'),
        brief: VideoBriefZ.optional().describe('Structured brief: objective, audience, hook, scenes (visual + seconds + optional narration/on_screen_text), captions, cta, duration_seconds. Only the visuals are generated; narration, text and captions must be added in an editor.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ id, prompt, brief }) => {
      if (!prompt && !brief) throw httpError(400, 'Give a prompt or a brief.');
      const post = await startPostVideo(id, { prompt, brief });
      return text({ ...postSummary(post), brief_warnings: post.video_brief_warnings || [], add_in_an_editor: post.video_brief_manual || [] });
    }),
  );

  server.registerTool(
    'generate_post_carousel',
    {
      title: 'Make a LinkedIn PDF carousel',
      description:
        'Turn slides you write into a PDF carousel (cover, one idea per slide, closing call to action) and attach it to a LinkedIn post, replacing any carousel. ' +
        'The app draws the slides with slide numbers and the brand name; it calls no AI. Follow the slide rules in get_writing_guide.',
      inputSchema: {
        id: z.string(),
        title: z.string().min(1).max(100).describe('Document title shown above the carousel on LinkedIn'),
        accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Brand color for the slides, e.g. #0a66c2 (dark enough for white text)'),
        slides: z
          .array(z.object({ heading: z.string().min(1), body: z.string().default('') }))
          .min(MIN_SLIDES)
          .max(MAX_SLIDES)
          .describe('First = cover, last = closing slide with the call to action'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ id, title, accent_color, slides }) => text(postSummary(await createPostCarousel(id, { title, slides, accent: accent_color })))),
  );

  server.registerTool(
    'set_post_document',
    {
      title: 'Set a LinkedIn PDF carousel',
      description:
        `Attach a finished PDF (up to ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB, ${MAX_PDF_PAGES} pages) from a public https link, e.g. a Google Drive file shared as "Anyone with the link", to a LinkedIn post. ` +
        'It is downloaded and saved, replacing any carousel.',
      inputSchema: {
        id: z.string(),
        document_url: z.string().url().startsWith('https://'),
        title: z.string().min(1).max(100).optional().describe("Document title shown above the carousel on LinkedIn (default: the file's name)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ id, document_url, title }) => {
      const post = await editablePost(id);
      if (!PLATFORMS[post.platform].documents) throw httpError(400, `${PLATFORMS[post.platform].label} posts can't carry a PDF carousel.`);
      const doc = await importDocument(document_url, { platform: post.platform });
      const updated = await setPostDocument(id, { url: doc.url, title: title || doc.filename || 'Carousel', pages: doc.pages, qc: doc.qc });
      return text({ ...postSummary(updated), media_check: { duplicate: doc.duplicate, warnings: doc.qc.warnings, look_at_it: doc.qc.humanReview } });
    }),
  );

  server.registerTool(
    'schedule_post',
    {
      title: 'Approve & schedule a post',
      description:
        "Approve a draft so it is published automatically at scheduled_at (or the platform's default time). Only when the user asks: it goes live on their real account. Refused, with the reasons, when the post fails the checks or has items that need the user's own review; the user can approve those in the app.",
      inputSchema: { id: z.string(), scheduled_at: z.string().optional().describe('ISO 8601 with timezone, e.g. 2026-10-21T09:00:00+06:00') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ id, scheduled_at }) => text(postSummary(await approvePost(id, { scheduledAt: scheduled_at })))),
  );

  server.registerTool(
    'check_post_quality',
    {
      title: 'Check a post',
      description: 'Re-run the quality checks (rules, media and, if an AI reviewer is set up, the independent AI review) and return the report. Saves the report on the post; changes nothing else.',
      inputSchema: { id: z.string(), ai_review: z.boolean().optional().describe('Also run the AI review with the workspace reviewer (may take a few seconds)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, ai_review }) => {
      const { post } = await assessPost(id, { runAi: ai_review ? 'always' : 'never', useMediaCache: false });
      return text({ id: post.id, status: post.status, quality: summarize(post.quality) });
    }),
  );

  server.registerTool(
    'set_post_image_alt',
    {
      title: 'Set image alt text',
      description: 'Set the alt text of the post image (what it shows, for screen readers). LinkedIn and Instagram send it to the platform.',
      inputSchema: { id: z.string(), alt_text: z.string().max(1000) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, alt_text }) => text(postSummary(await setImageAlt(id, alt_text)))),
  );

  server.registerTool(
    'unschedule_post',
    {
      title: 'Unschedule a post',
      description: 'Move an approved (scheduled) or failed post back to draft, so it is not published.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id }) => text(postSummary(await unapprovePost(id)))),
  );

  return server;
}

// ---- MCP endpoint (Streamable HTTP, stateless: each request gets a fresh server) ----
export const mcpRouter = Router();

async function workspaceForToken(req) {
  const workspaceId = await repo.workspaceIdForMcpToken(hashToken(String(req.params.token)));
  const workspace = workspaceId && (await repo.getWorkspace(workspaceId));
  const owner = workspace?.owner_id && (await repo.getUser(workspace.owner_id));
  if (!owner || owner.disabled) {
    // Slows down anyone guessing tokens.
    rateLimit(`mcp-bad:${req.ip}`, 20, 15 * 60_000);
    return null;
  }
  return workspaceId;
}

const rpcError = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });

mcpRouter.post('/:token', async (req, res) => {
  const workspaceId = await workspaceForToken(req);
  if (!workspaceId) return rpcError(res, 404, 'Unknown connector URL. Copy the current one from Settings → AI in Content Agent.');
  rateLimit(`mcp:${workspaceId}`, 300, 60_000);

  await runInWorkspace(workspaceId, async () => {
    await recordActivity(req.body).catch((err) => console.error('MCP activity not saved:', err.message));
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
});

// Stateless server: no server-initiated streams or sessions to end.
mcpRouter.all('/:token', (req, res) => rpcError(res, 405, 'Method not allowed.'));
