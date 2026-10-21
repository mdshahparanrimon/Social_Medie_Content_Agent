import { MongoClient, ObjectId } from 'mongodb';
import { workspaceId } from '../context.js';

const now = () => new Date().toISOString();

function toId(id) {
  return /^[a-f\d]{24}$/i.test(String(id)) ? new ObjectId(String(id)) : null;
}

// Mongo documents -> plain objects with string ids, the shape the rest of the app uses.
function out(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  const result = { id: String(_id), ...rest };
  if (rest.post_id) result.post_id = String(rest.post_id);
  if (rest.calendar_item_id) result.calendar_item_id = String(rest.calendar_item_id);
  return result;
}

// Workspace-owned data: every filter and insert gets the current workspace from the request context.
const scoped = (filter = {}) => ({ ...filter, workspace_id: workspaceId() });

export async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in backend/.env.');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'content_agent');

  const brand = db.collection('brand');
  const calendar = db.collection('calendar_items');
  const posts = db.collection('posts');
  const settings = db.collection('settings');
  const usage = db.collection('llm_usage');
  const accounts = db.collection('accounts');
  const users = db.collection('users');
  const workspaces = db.collection('workspaces');
  const sessions = db.collection('sessions');
  const authTokens = db.collection('auth_tokens');

  // Before workspaces, accounts were unique per platform across the whole database.
  await accounts.dropIndex('platform_1').catch(() => {});
  const providerIndex = (provider) =>
    users.createIndex(
      { [`providers.${provider}`]: 1 },
      { unique: true, partialFilterExpression: { [`providers.${provider}`]: { $type: 'string' } } },
    );
  await Promise.all([
    calendar.createIndex({ workspace_id: 1, date: 1 }),
    posts.createIndex({ workspace_id: 1, status: 1, scheduled_at: 1 }),
    posts.createIndex({ status: 1, scheduled_at: 1 }),
    accounts.createIndex({ workspace_id: 1, platform: 1 }, { unique: true }),
    usage.createIndex({ workspace_id: 1 }),
    users.createIndex({ email: 1 }, { unique: true }),
    settings.createIndex({ mcp_token_hash: 1 }, { unique: true, partialFilterExpression: { mcp_token_hash: { $type: 'string' } } }),
    providerIndex('google'),
    providerIndex('linkedin'),
    sessions.createIndex({ user_id: 1 }),
    sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    authTokens.createIndex({ user_id: 1, type: 1 }),
    authTokens.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  ]);

  const WORKSPACE_COLLECTIONS = [calendar, posts, usage, accounts];

  return {
    // ---- Brand Brain (one document per workspace, keyed by workspace id) ----
    async getBrand() {
      const doc = await brand.findOne({ _id: workspaceId() });
      if (!doc) return null;
      const { _id, ...fields } = doc;
      return fields;
    },
    async saveBrand(fields) {
      await brand.updateOne({ _id: workspaceId() }, { $set: fields }, { upsert: true });
    },

    // ---- Calendar ----
    async listCalendar(from, to) {
      const items = await calendar.find(scoped({ date: { $gte: from, $lte: to } })).sort({ date: 1, platform: 1 }).toArray();
      const postIds = items.map((item) => item.post_id).filter(Boolean);
      const linked = await posts.find(scoped({ _id: { $in: postIds } }), { projection: { status: 1 } }).toArray();
      const statuses = new Map(linked.map((p) => [String(p._id), p.status]));
      return items.map((item) => ({
        ...out(item),
        post_status: item.post_id ? (statuses.get(String(item.post_id)) ?? null) : null,
      }));
    },
    async getCalendarItem(id) {
      const _id = toId(id);
      return _id ? out(await calendar.findOne(scoped({ _id }))) : null;
    },
    async insertCalendarItems(items) {
      const workspace_id = workspaceId();
      if (items.length) {
        await calendar.insertMany(items.map((item) => ({ ...item, workspace_id, post_id: null, created_at: now() })));
      }
    },
    async deleteUndraftedCalendar(from, to) {
      await calendar.deleteMany(scoped({ date: { $gte: from, $lte: to }, post_id: null }));
    },
    // Only items without a draft can be deleted. Returns false if nothing was deleted.
    async deleteCalendarItem(id) {
      const _id = toId(id);
      if (!_id) return false;
      const { deletedCount } = await calendar.deleteOne(scoped({ _id, post_id: null }));
      return deletedCount > 0;
    },
    async recentHooks(from, before, limit) {
      const items = await calendar
        .find(scoped({ date: { $gte: from, $lt: before } }), { projection: { hook_idea: 1 } })
        .sort({ date: -1 })
        .limit(limit)
        .toArray();
      return items.map((item) => item.hook_idea);
    },

    // ---- Posts ----
    async createPost(fields) {
      const doc = {
        workspace_id: workspaceId(),
        calendar_item_id: toId(fields.calendar_item_id),
        platform: fields.platform,
        brief: fields.brief,
        content: fields.content,
        image_url: null,
        status: 'draft',
        brand_score: fields.brand_score ?? null,
        critique: fields.critique ?? null,
        scheduled_at: null,
        published_at: null,
        external_id: null,
        external_url: null,
        simulated: false,
        error: null,
        created_at: now(),
        updated_at: now(),
      };
      const { insertedId } = await posts.insertOne(doc);
      if (doc.calendar_item_id) {
        await calendar.updateOne(scoped({ _id: doc.calendar_item_id }), { $set: { post_id: insertedId } });
      }
      return out({ ...doc, _id: insertedId });
    },
    async getPost(id) {
      const _id = toId(id);
      return _id ? out(await posts.findOne(scoped({ _id }))) : null;
    },
    async listPosts(statuses) {
      const docs = await posts.find(scoped({ status: { $in: statuses } })).sort({ created_at: 1 }).toArray();
      return docs.map(out);
    },
    // With onlyIfStatus, the update is atomic: it applies only if the post is still in one of those statuses.
    // Returns the updated post, or null if nothing matched.
    async updatePost(id, fields, { onlyIfStatus } = {}) {
      const _id = toId(id);
      if (!_id) return null;
      const filter = scoped(onlyIfStatus ? { _id, status: { $in: onlyIfStatus } } : { _id });
      const doc = await posts.findOneAndUpdate(filter, { $set: { ...fields, updated_at: now() } }, { returnDocument: 'after' });
      return out(doc);
    },
    async deletePost(id) {
      const _id = toId(id);
      if (!_id) return false;
      await calendar.updateMany(scoped({ post_id: _id }), { $set: { post_id: null } });
      const { deletedCount } = await posts.deleteOne(scoped({ _id }));
      return deletedCount > 0;
    },
    async countPostsByStatus() {
      const rows = await posts.aggregate([{ $match: scoped() }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
      return Object.fromEntries(rows.map((row) => [row._id, row.n]));
    },
    async upcomingPosts(limit) {
      const docs = await posts.find(scoped({ status: 'approved' })).sort({ scheduled_at: 1 }).limit(limit).toArray();
      return docs.map(out);
    },

    // ---- Scheduler: across all workspaces, each result carries its workspace_id ----
    async allDuePosts(nowIso) {
      const docs = await posts.find({ status: 'approved', scheduled_at: { $lte: nowIso } }).sort({ scheduled_at: 1 }).toArray();
      return docs.map(out);
    },
    // Videos are made in memory; after a restart, ones that were in progress will never finish.
    async failInterruptedVideos(message) {
      await posts.updateMany({ video_status: 'generating' }, { $set: { video_status: 'failed', video_error: message, updated_at: now() } });
    },
    async failInterruptedPosts(message) {
      await posts.updateMany({ status: 'publishing' }, { $set: { status: 'failed', error: message, updated_at: now() } });
    },
    async allAccountsForPlatform(platform) {
      return (await accounts.find({ platform }).toArray()).map(out);
    },

    // ---- Settings: app-wide (owner) and per workspace ----
    async getSettings() {
      const doc = await settings.findOne({ _id: 'app' });
      if (!doc) return {};
      const { _id, ...values } = doc;
      return values;
    },
    async saveSettings(values) {
      await settings.updateOne({ _id: 'app' }, { $set: values }, { upsert: true });
    },
    async getWorkspaceSettings() {
      const doc = await settings.findOne({ _id: `ws:${workspaceId()}` });
      if (!doc) return {};
      const { _id, ...values } = doc;
      return values;
    },
    async saveWorkspaceSettings(values) {
      await settings.updateOne({ _id: `ws:${workspaceId()}` }, { $set: values }, { upsert: true });
    },
    // MCP connector: the workspace whose settings hold this token hash, or null. Runs before any workspace is known.
    async workspaceIdForMcpToken(hash) {
      const doc = await settings.findOne({ mcp_token_hash: hash }, { projection: { _id: 1 } });
      return doc?._id.startsWith('ws:') ? doc._id.slice(3) : null;
    },

    // ---- Connected accounts (one per platform per workspace; credentials arrive already encrypted) ----
    async getAccount(platform) {
      return out(await accounts.findOne(scoped({ platform })));
    },
    async listAccounts() {
      return (await accounts.find(scoped()).sort({ platform: 1 }).toArray()).map(out);
    },
    async upsertAccount(platform, fields) {
      await accounts.updateOne(scoped({ platform }), { $set: { ...fields, platform, updated_at: now() } }, { upsert: true });
    },
    async updateAccount(platform, fields) {
      await accounts.updateOne(scoped({ platform }), { $set: { ...fields, updated_at: now() } });
    },
    async deleteAccount(platform) {
      await accounts.deleteOne(scoped({ platform }));
    },

    // ---- AI usage ----
    async logUsage(entry) {
      await usage.insertOne({ ...entry, workspace_id: workspaceId(), created_at: now() });
    },
    // Totals, plus calls per task and per day (UTC, last `days` days) for the usage panel.
    async usageTotals(days = 14) {
      const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const sums = {
        calls: { $sum: 1 },
        input_tokens: { $sum: { $ifNull: ['$input_tokens', 0] } },
        output_tokens: { $sum: { $ifNull: ['$output_tokens', 0] } },
        cost_usd: { $sum: { $ifNull: ['$cost_usd', 0] } },
      };
      const [result] = await usage
        .aggregate([
          { $match: scoped() },
          {
            $facet: {
              totals: [{ $group: { _id: null, ...sums, last_at: { $max: '$created_at' } } }],
              by_task: [{ $group: { _id: '$task', ...sums } }, { $sort: { calls: -1 } }],
              daily: [
                { $match: { created_at: { $gte: since } } },
                { $group: { _id: { $substrBytes: ['$created_at', 0, 10] }, calls: { $sum: 1 } } },
              ],
            },
          },
        ])
        .toArray();
      const totals = result.totals[0] || { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, last_at: null };
      const perDay = new Map(result.daily.map((d) => [d._id, d.calls]));
      const daily = Array.from({ length: days }, (_, i) => {
        const date = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
        return { date, calls: perDay.get(date) || 0 };
      });
      return {
        calls: totals.calls,
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        cost_usd: totals.cost_usd,
        last_at: totals.last_at,
        by_task: result.by_task.map(({ _id, ...rest }) => ({ task: _id || 'other', ...rest })),
        daily,
      };
    },

    // ---- Users ----
    async createUser(fields) {
      const doc = { ...fields, created_at: now(), updated_at: now() };
      const { insertedId } = await users.insertOne(doc);
      return out({ ...doc, _id: insertedId });
    },
    async getUser(id) {
      const _id = toId(id);
      return _id ? out(await users.findOne({ _id })) : null;
    },
    async getUserByEmail(email) {
      return out(await users.findOne({ email }));
    },
    async getUserByProvider(provider, subject) {
      return out(await users.findOne({ [`providers.${provider}`]: subject }));
    },
    async updateUser(id, fields, { unset } = {}) {
      const update = { $set: { ...fields, updated_at: now() } };
      if (unset) update.$unset = Object.fromEntries(unset.map((key) => [key, '']));
      return out(await users.findOneAndUpdate({ _id: toId(id) }, update, { returnDocument: 'after' }));
    },
    async deleteUser(id) {
      await users.deleteOne({ _id: toId(id) });
    },
    async countUsers(filter = {}) {
      return users.countDocuments(filter);
    },
    async listUsers() {
      const docs = await users.find({}).sort({ created_at: -1 }).toArray();
      return docs.map(out);
    },

    // ---- Workspaces ----
    async createWorkspace(fields) {
      const doc = { ...fields, created_at: now() };
      const { insertedId } = await workspaces.insertOne(doc);
      return out({ ...doc, _id: insertedId });
    },
    async getWorkspace(id) {
      const _id = toId(id);
      return _id ? out(await workspaces.findOne({ _id })) : null;
    },
    async updateWorkspace(id, fields) {
      return out(await workspaces.findOneAndUpdate({ _id: toId(id) }, { $set: fields }, { returnDocument: 'after' }));
    },
    // Removes a workspace and everything in it.
    async deleteWorkspace(id) {
      const workspace_id = String(id);
      await Promise.all([
        ...WORKSPACE_COLLECTIONS.map((c) => c.deleteMany({ workspace_id })),
        brand.deleteOne({ _id: workspace_id }),
        settings.deleteOne({ _id: `ws:${workspace_id}` }),
        workspaces.deleteOne({ _id: toId(id) }),
      ]);
    },
    // Per-workspace numbers for the admin user list.
    async workspaceStats() {
      const [postRows, usageRows, accountRows] = await Promise.all([
        posts.aggregate([{ $group: { _id: '$workspace_id', n: { $sum: 1 } } }]).toArray(),
        usage.aggregate([{ $group: { _id: '$workspace_id', calls: { $sum: 1 } } }]).toArray(),
        accounts.aggregate([{ $group: { _id: '$workspace_id', platforms: { $push: '$platform' } } }]).toArray(),
      ]);
      const stats = {};
      const get = (id) => (stats[id] ??= { posts: 0, ai_calls: 0, platforms: [] });
      for (const r of postRows) get(r._id).posts = r.n;
      for (const r of usageRows) get(r._id).ai_calls = r.calls;
      for (const r of accountRows) get(r._id).platforms = r.platforms;
      return stats;
    },
    // Data from before accounts existed has no workspace_id. Hand it to the first (owner) workspace once.
    async claimLegacyData(id) {
      const workspace_id = String(id);
      await Promise.all(
        WORKSPACE_COLLECTIONS.map((c) => c.updateMany({ workspace_id: { $exists: false } }, { $set: { workspace_id } })),
      );
      const legacyBrand = await brand.findOne({ _id: 'brand' });
      if (legacyBrand) {
        const { _id, ...fields } = legacyBrand;
        await brand.updateOne({ _id: workspace_id }, { $set: fields }, { upsert: true });
        await brand.deleteOne({ _id: 'brand' });
      }
    },

    // ---- Sessions (id = SHA-256 of the cookie token; the token itself is never stored) ----
    async createSession(fields) {
      await sessions.insertOne({ ...fields, created_at: now() });
    },
    async getSession(id) {
      return sessions.findOne({ _id: id, expires_at: { $gt: new Date() } });
    },
    async updateSession(id, fields) {
      await sessions.updateOne({ _id: id }, { $set: fields });
    },
    async deleteSession(id) {
      await sessions.deleteOne({ _id: id });
    },
    async deleteUserSessions(userId, { except } = {}) {
      const filter = { user_id: String(userId) };
      if (except) filter._id = { $ne: except };
      const { deletedCount } = await sessions.deleteMany(filter);
      return deletedCount;
    },
    async countUserSessions(userId) {
      return sessions.countDocuments({ user_id: String(userId), expires_at: { $gt: new Date() } });
    },

    // ---- One-time tokens for email verification and password reset (id = SHA-256 of the token) ----
    async createAuthToken(fields) {
      await authTokens.insertOne({ ...fields, created_at: now() });
    },
    // Single use: finding the token also deletes it.
    async takeAuthToken(id, type) {
      return authTokens.findOneAndDelete({ _id: id, type, expires_at: { $gt: new Date() } });
    },
    async deleteAuthTokens(userId, type) {
      await authTokens.deleteMany({ user_id: String(userId), ...(type ? { type } : {}) });
    },
  };
}
