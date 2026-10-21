import { Router } from 'express';
import { repo } from './db/index.js';
import { httpError } from './errors.js';
import { getBrand, saveBrand, missingBrandFields } from './brandBrain.js';
import { planWeek, calendarBrief } from './agents/strategist.js';
import { createPost, rewritePost, getPost } from './agents/creator.js';
import { createPostImage, startPostVideo } from './agents/artist.js';
import { publishPost } from './scheduler.js';
import { getConfig, getPublicSettings, saveSettings } from './settings.js';
import { EDITABLE, approvePost, editPost, setPostImage, unapprovePost } from './posts.js';
import { platformStatus, testAccount } from './publishers/index.js';
import { listAccounts } from './accounts.js';
import { storeImage } from './media.js';
import { aiStatus, generateJSON } from './llm/index.js';
import { imageStatus } from './llm/image.js';
import { videoStatus } from './llm/video.js';
import { PLATFORMS } from './platforms.js';

// Every route here runs behind requireAuth, inside the signed-in user's workspace.
export const router = Router();

const isAdmin = (req) => req.user.role === 'admin';

// ---- Brand Brain ----
router.get('/brand', async (req, res) => res.json(await getBrand()));
router.put('/brand', async (req, res) => res.json(await saveBrand(req.body)));

// ---- Calendar (Strategist) ----
router.get('/calendar', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) throw httpError(400, 'from and to are required.');
  res.json(await repo.listCalendar(String(from), String(to)));
});

router.post('/calendar/generate', async (req, res) => {
  res.json(await planWeek(req.body.weekStart));
});

router.post('/calendar/:id/draft', async (req, res) => {
  const item = await repo.getCalendarItem(req.params.id);
  if (!item) throw httpError(404, 'Calendar item not found.');
  if (item.post_id) throw httpError(409, 'This item already has a draft.');
  res.json(await createPost({ platform: item.platform, brief: calendarBrief(item), calendarItemId: item.id }));
});

router.delete('/calendar/:id', async (req, res) => {
  if (!(await repo.deleteCalendarItem(req.params.id))) {
    throw httpError(409, 'Item not found, or it already has a draft (delete the post first).');
  }
  res.json({ ok: true });
});

// ---- Posts (Creator + approval) ----
const ALL_STATUSES = ['draft', 'approved', 'publishing', 'published', 'failed'];

router.get('/posts', async (req, res) => {
  const statuses = req.query.status ? String(req.query.status).split(',') : ALL_STATUSES;
  res.json(await repo.listPosts(statuses));
});

// Instant mode: skip the calendar and write straight from a topic.
router.post('/posts/instant', async (req, res) => {
  const topic = String(req.body.topic || '').trim();
  const platforms = (req.body.platforms || []).filter((p) => PLATFORMS[p]);
  if (!topic) throw httpError(400, 'Enter a topic.');
  if (platforms.length === 0) throw httpError(400, 'Pick at least one platform.');
  const brief = `Topic from the brand owner:\n${topic}`;
  // One platform at a time keeps free-tier AI rate limits happy.
  const created = [];
  for (const platform of platforms) created.push(await createPost({ platform, brief }));
  res.json(created);
});

router.patch('/posts/:id', async (req, res) => res.json(await editPost(req.params.id, req.body.content)));

router.post('/posts/:id/approve', async (req, res) => {
  res.json(await approvePost(req.params.id, { content: req.body.content, scheduledAt: req.body.scheduledAt }));
});

router.post('/posts/:id/unapprove', async (req, res) => res.json(await unapprovePost(req.params.id)));

// Attach an image: { dataUrl } for an upload (JPEG), or { url } for an image that's already online.
router.put('/posts/:id/image', async (req, res) => {
  // Check the post first, so an image isn't uploaded for a post that can't take it.
  const post = await getPost(req.params.id);
  if (!EDITABLE.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  let imageUrl;
  if (req.body.dataUrl) {
    imageUrl = await storeImage(req.body.dataUrl);
  } else if (/^https?:\/\/\S+$/.test(req.body.url || '')) {
    imageUrl = req.body.url;
  } else {
    throw httpError(400, 'Upload an image or paste an image link starting with https://');
  }
  res.json(await setPostImage(req.params.id, imageUrl));
});

// Make an image with AI from the post (and optional instructions) and attach it.
router.post('/posts/:id/image/generate', async (req, res) => {
  res.json(await createPostImage(req.params.id, { instructions: req.body.instructions }));
});

router.delete('/posts/:id/image', async (req, res) => {
  const post = await getPost(req.params.id);
  // An approved Instagram post without an image couldn't be published, so only drafts can lose theirs.
  const editable = PLATFORMS[post.platform].needsImage ? ['draft', 'failed'] : ['draft', 'approved', 'failed'];
  const updated = await repo.updatePost(post.id, { image_url: null, image_prompt: null }, { onlyIfStatus: editable });
  if (!updated) throw httpError(409, 'Move the post back to draft before removing its image.');
  res.json(updated);
});

// One post, e.g. to follow a video that's being made (video_status).
router.get('/posts/:id', async (req, res) => res.json(await getPost(req.params.id)));

// Start making a video with AI. Returns at once with video_status 'generating'; poll GET /posts/:id.
router.post('/posts/:id/video/generate', async (req, res) => {
  res.json(await startPostVideo(req.params.id, { instructions: req.body.instructions }));
});

router.delete('/posts/:id/video', async (req, res) => {
  const post = await getPost(req.params.id);
  if (post.video_status === 'generating') throw httpError(409, 'Wait until the video is finished, then remove it.');
  // Instagram needs an image or a video, so an approved one can't drop its only media.
  const editable = PLATFORMS[post.platform].needsImage && !post.image_url ? ['draft', 'failed'] : EDITABLE;
  const updated = await repo.updatePost(
    post.id,
    { video_url: null, video_prompt: null, video_status: null, video_error: null },
    { onlyIfStatus: editable },
  );
  if (!updated) throw httpError(409, 'Move the post back to draft before removing its video.');
  res.json(updated);
});

router.post('/posts/:id/rewrite', async (req, res) => {
  res.json(await rewritePost(req.params.id, req.body.feedback));
});

router.post('/posts/:id/publish', async (req, res) => {
  res.json(await publishPost(req.params.id));
});

router.delete('/posts/:id', async (req, res) => {
  const post = await getPost(req.params.id);
  if (['publishing', 'published'].includes(post.status)) throw httpError(409, `A ${post.status} post cannot be deleted.`);
  await repo.deletePost(post.id);
  res.json({ ok: true });
});

// ---- Settings ----
// The owner sees and changes app-wide settings too; everyone else only their workspace's own.
router.get('/settings', async (req, res) => res.json(await getPublicSettings({ admin: isAdmin(req) })));
router.put('/settings', async (req, res) => res.json(await saveSettings(req.body, { admin: isAdmin(req) })));

// Always answers 200 with { ok, message }.
// Tests this workspace's own AI key.
router.post('/settings/test/ai', async (req, res) => {
  const config = await getConfig();
  // With MCP the app calls no AI; the real test is asking Claude in claude.ai.
  if (config.ai_provider === 'mcp') {
    return res.json(
      config.mcp_token_hash
        ? { ok: true, message: 'Connector URL is active. In claude.ai, ask: "Show my brand brain from Content Agent".' }
        : { ok: false, message: 'Create the connector URL first, then add it in claude.ai.' },
    );
  }
  try {
    await generateJSON({
      task: 'connection-test',
      system: 'You are a connection test.',
      prompt: 'Return {"ok": true}.',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      effort: 'low',
    });
    const ai = aiStatus(await getConfig());
    res.json({ ok: true, message: `${ai.label} (${ai.model}) is working.` });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ---- Connected accounts (connect/disconnect live in oauth.js) ----
router.get('/accounts', async (req, res) => res.json(await listAccounts()));

router.post('/accounts/:platform/test', async (req, res) => {
  try {
    res.json({ ok: true, message: await testAccount(req.params.platform) });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ---- Status ----
router.get('/status', async (req, res) => {
  const config = await getConfig();
  const [brand, counts, usage, upcoming, accounts] = await Promise.all([
    getBrand(),
    repo.countPostsByStatus(),
    repo.usageTotals(),
    repo.upcomingPosts(5),
    listAccounts(),
  ]);
  res.json({
    ai: aiStatus(config),
    images: imageStatus(config),
    videos: videoStatus(config),
    brandMissing: missingBrandFields(brand),
    dryRun: config.dry_run,
    platforms: platformStatus(config, accounts),
    counts,
    usage,
    upcoming,
  });
});
