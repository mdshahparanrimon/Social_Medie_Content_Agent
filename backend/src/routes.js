import { Router } from 'express';
import { repo } from './db/index.js';
import { httpError } from './errors.js';
import { getBrand, saveBrand, missingBrandFields } from './brandBrain.js';
import { planWeek, calendarBrief } from './agents/strategist.js';
import { createPost, rewritePost, getPost } from './agents/creator.js';
import { publishPost } from './scheduler.js';
import { getConfig, getPublicSettings, saveSettings, defaultScheduleTime } from './settings.js';
import { platformStatus, testAccount } from './publishers/index.js';
import { listAccounts } from './accounts.js';
import { storeImage } from './media.js';
import { aiStatus, generateJSON } from './llm/index.js';
import { PLATFORMS } from './platforms.js';
import { requireAdmin } from './auth/session.js';

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

function contentChange(post, content) {
  if (content === undefined || content === post.content) return {};
  if (!String(content).trim()) throw httpError(400, 'Post content cannot be empty.');
  return { content: String(content) };
}

const changed = () => httpError(409, 'This post changed in the meantime. Reload and try again.');

router.patch('/posts/:id', async (req, res) => {
  const post = await getPost(req.params.id);
  const editable = ['draft', 'approved', 'failed'];
  if (!editable.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be edited.`);
  const updated = await repo.updatePost(post.id, contentChange(post, req.body.content), { onlyIfStatus: editable });
  if (!updated) throw changed();
  res.json(updated);
});

router.post('/posts/:id/approve', async (req, res) => {
  const post = await getPost(req.params.id);
  if (!['draft', 'failed'].includes(post.status)) throw httpError(409, `A ${post.status} post cannot be approved.`);
  if (PLATFORMS[post.platform].needsImage && !post.image_url) {
    throw httpError(400, `${PLATFORMS[post.platform].label} posts need an image. Add one before approving.`);
  }

  let scheduledAt;
  if (req.body.scheduledAt) {
    const when = new Date(req.body.scheduledAt);
    if (Number.isNaN(when.getTime())) throw httpError(400, 'Invalid schedule time.');
    if (when.getTime() < Date.now() - 60_000) throw httpError(400, 'That time is in the past. Pick a future time or use Publish now.');
    scheduledAt = when.toISOString();
  } else {
    const item = post.calendar_item_id ? await repo.getCalendarItem(post.calendar_item_id) : null;
    scheduledAt = await defaultScheduleTime(post.platform, item?.date);
  }

  const updated = await repo.updatePost(
    post.id,
    { ...contentChange(post, req.body.content), status: 'approved', scheduled_at: scheduledAt, error: null },
    { onlyIfStatus: ['draft', 'failed'] },
  );
  if (!updated) throw changed();
  res.json(updated);
});

router.post('/posts/:id/unapprove', async (req, res) => {
  const post = await getPost(req.params.id);
  const updated = await repo.updatePost(post.id, { status: 'draft', scheduled_at: null }, { onlyIfStatus: ['approved', 'failed'] });
  if (!updated) throw httpError(409, `A ${post.status} post cannot go back to draft.`);
  res.json(updated);
});

// Attach an image: { dataUrl } for an upload (JPEG), or { url } for an image that's already online.
router.put('/posts/:id/image', async (req, res) => {
  const post = await getPost(req.params.id);
  const editable = ['draft', 'approved', 'failed'];
  if (!editable.includes(post.status)) throw httpError(409, `A ${post.status} post cannot be changed.`);
  let imageUrl;
  if (req.body.dataUrl) {
    imageUrl = await storeImage(req.body.dataUrl);
  } else if (/^https?:\/\/\S+$/.test(req.body.url || '')) {
    imageUrl = req.body.url;
  } else {
    throw httpError(400, 'Upload an image or paste an image link starting with https://');
  }
  const updated = await repo.updatePost(post.id, { image_url: imageUrl }, { onlyIfStatus: editable });
  if (!updated) throw changed();
  res.json(updated);
});

router.delete('/posts/:id/image', async (req, res) => {
  const post = await getPost(req.params.id);
  // An approved Instagram post without an image couldn't be published, so only drafts can lose theirs.
  const editable = PLATFORMS[post.platform].needsImage ? ['draft', 'failed'] : ['draft', 'approved', 'failed'];
  const updated = await repo.updatePost(post.id, { image_url: null }, { onlyIfStatus: editable });
  if (!updated) throw httpError(409, 'Move the post back to draft before removing its image.');
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
router.post('/settings/test/ai', requireAdmin, async (req, res) => {
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
    brandMissing: missingBrandFields(brand),
    dryRun: config.dry_run,
    platforms: platformStatus(config, accounts),
    counts,
    usage,
    upcoming,
  });
});
