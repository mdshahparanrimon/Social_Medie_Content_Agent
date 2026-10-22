import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { repo } from './db/index.js';
import { httpError } from './errors.js';
import { runInWorkspace } from './context.js';
import { rateLimit } from './auth/rateLimit.js';
import { getConfig } from './settings.js';
import { getBrand, saveBrand, brandContext, missingBrandFields } from './brandBrain.js';
import { FORMATS } from './agents/strategist.js';
import { getPost } from './agents/creator.js';
import { EDITABLE, approvePost, editPost, setPostDocument, setPostImage, setPostVideo, unapprovePost } from './posts.js';
import { MAX_DOCUMENT_BYTES, importDocument, importImage, importVideo } from './media.js';
import { createPostImage, startPostVideo } from './agents/artist.js';
import { MAX_SLIDES, MIN_SLIDES, SLIDE_RULES, createPostCarousel } from './agents/carousel.js';
import { MAX_PDF_PAGES } from './slides.js';
import { PLATFORMS, PLATFORM_KEYS, charCount } from './platforms.js';
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
Only call schedule_post when the user asks to approve or schedule a post, because scheduled posts are published automatically.`;

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

// Tool errors go back to Claude as readable messages instead of failing the whole request.
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
};

function postSummary(post) {
  const { id, platform, status, content, image_url, image_prompt, video_url, video_status, video_error, document_url, document_title, document_pages, scheduled_at, published_at, external_url, error, calendar_item_id, created_at } = post;
  return { id, platform, status, content, image_url, image_prompt, video_url, video_status, video_error, document_url, document_title, document_pages, scheduled_at, published_at, external_url, error, calendar_item_id, created_at };
}

// Checked before downloading media from a link, so nothing is stored for a post that can't take it.
async function editablePost(id) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  return post;
}

function checkLength(platform, content) {
  const length = charCount(platform, content);
  const { label, maxChars } = PLATFORMS[platform];
  if (length > maxChars) throw httpError(400, `This ${label} post is ${length} characters; the limit is ${maxChars}. Shorten it.`);
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const platform = z.enum(PLATFORM_KEYS);

async function writingGuide() {
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
    '- Saving: create_post (with calendar_item_id when it comes from the calendar). Put only the final post text in content, exactly as it should be published.',
    '- Images: every platform can post one image. Instagram needs one before scheduling. Make it with generate_post_image, or attach a public https link (Google Drive share links work) with set_post_image. Ask the user before making images unless they asked for them.',
    '- Videos: attach a finished video from a public https link (Google Drive share links work) with set_post_video. Or generate_post_video starts a short AI video (16:9, or 9:16 for Instagram Reels and Facebook) and returns at once; it takes 1-3 minutes. Check it with list_posts (video_status: generating, ready, failed). A post with a video is published as a video. Ask the user before making AI videos unless they asked for them.',
    `- LinkedIn PDF carousels (document posts): write the slides yourself and call generate_post_carousel; the app draws them on brand-colored slides. Or attach a finished PDF from a public https link with set_post_document. The post text is the caption. A carousel wins over an image or video on LinkedIn. Slide rules:\n${SLIDE_RULES}`,
    '- Files from Google Drive: when the user made images, videos or PDFs and saved them to Drive, attach each with set_post_image, set_post_video or set_post_document using its Drive link. With Google Drive connected in the app (Connections), private files work; otherwise the file must be shared as "Anyone with the link". A Google Slides link attached with set_post_document becomes a PDF carousel. If a download fails, pass on the error to the user.',
    '- Times are ISO 8601. Without scheduled_at, schedule_post uses the platform\'s default posting time.',
    '',
    '# Brand Brain fields (raw)',
    JSON.stringify(brand, null, 2),
  ].join('\n');
}

function buildServer() {
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
      description: 'Posts in this workspace, newest last. Filter by status: draft, approved (scheduled), publishing, published, failed.',
      inputSchema: {
        status: z.array(z.enum(['draft', 'approved', 'publishing', 'published', 'failed'])).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Most recent N (default 30)'),
      },
      annotations: readOnly,
    },
    safe(async ({ status, limit = 30 }) => {
      const posts = await repo.listPosts(status?.length ? status : ['draft', 'approved', 'publishing', 'published', 'failed']);
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
      checkLength(key, content);
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
      return text(postSummary(post));
    }),
  );

  server.registerTool(
    'update_post',
    {
      title: 'Edit a post',
      description: 'Replace the text of a draft, scheduled or failed post.',
      inputSchema: { id: z.string(), content: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, content }) => {
      checkLength((await getPost(id)).platform, content);
      return text(postSummary(await editPost(id, content)));
    }),
  );

  server.registerTool(
    'set_post_image',
    {
      title: 'Set a post image',
      description:
        'Attach an image from a public https link, e.g. a Google Drive file shared as "Anyone with the link" (required for Instagram). ' +
        'It is downloaded and saved as JPEG, replacing any image. For Instagram, use an aspect ratio between 4:5 and 1.91:1.',
      inputSchema: { id: z.string(), image_url: z.string().url().startsWith('https://') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ id, image_url }) => {
      await editablePost(id);
      return text(postSummary(await setPostImage(id, await importImage(image_url))));
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
      await editablePost(id);
      return text(postSummary(await setPostVideo(id, await importVideo(video_url))));
    }),
  );

  server.registerTool(
    'generate_post_image',
    {
      title: 'Make a post image with AI',
      description:
        "Make an image for a post with the workspace's image AI (Gemini or an OpenAI image model; not your own tokens) and attach it, replacing any image. " +
        'Write `prompt` yourself: subject, setting, style, lighting, colors, composition; no text or logos unless wanted. It is cropped to the platform size.',
      inputSchema: { id: z.string(), prompt: z.string().min(10).describe('The image prompt, 2-5 sentences') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ id, prompt }) => text(postSummary(await createPostImage(id, { prompt })))),
  );

  server.registerTool(
    'generate_post_video',
    {
      title: 'Make a post video with AI',
      description:
        "Start making a short video for a post with the workspace's video AI (Gemini Omni Flash or an OpenAI video model) and attach it when done, replacing any video. " +
        'Returns at once with video_status "generating"; check list_posts after 1-3 minutes. Write `prompt` yourself: subject, action, camera movement, setting, lighting, mood; one continuous shot; no text or logos.',
      inputSchema: { id: z.string(), prompt: z.string().min(10).describe('The video prompt, 2-5 sentences') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ id, prompt }) => text(postSummary(await startPostVideo(id, { prompt })))),
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
      const doc = await importDocument(document_url);
      return text(postSummary(await setPostDocument(id, { url: doc.url, title: title || doc.filename || 'Carousel', pages: doc.pages })));
    }),
  );

  server.registerTool(
    'schedule_post',
    {
      title: 'Approve & schedule a post',
      description:
        "Approve a draft so it is published automatically at scheduled_at (or the platform's default time). Only when the user asks: it goes live on their real account.",
      inputSchema: { id: z.string(), scheduled_at: z.string().optional().describe('ISO 8601 with timezone, e.g. 2026-10-21T09:00:00+06:00') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ id, scheduled_at }) => text(postSummary(await approvePost(id, { scheduledAt: scheduled_at })))),
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
