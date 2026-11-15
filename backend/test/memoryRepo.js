import { workspaceId } from '../src/context.js';

// An in-memory stand-in for the MongoDB repository, for tests. Same method names and the same workspace scoping.
// Every method runs to completion without awaiting, so single operations are atomic here the way a Mongo
// findOneAndUpdate is on the server; this proves the application logic, not MongoDB itself.

let counter = 0;
const newId = () => (++counter).toString(16).padStart(24, '0');
const now = () => new Date().toISOString();
const clone = (o) => (o == null ? o : structuredClone(o));

export function createMemoryRepo() {
  const posts = new Map();
  const calendar = new Map();
  const assets = [];
  const attempts = [];
  const audit = [];
  const accounts = new Map();
  const settings = new Map();
  const brands = new Map();
  const usage = [];
  const conversations = new Map();
  const ws = () => workspaceId();
  const mine = (doc) => doc && doc.workspace_id === ws();

  const repo = {
    _posts: posts,
    _assets: assets,
    _attempts: attempts,
    _audit: audit,
    _usage: usage,

    async getBrand() {
      return clone(brands.get(ws())) ?? null;
    },
    async saveBrand(fields) {
      brands.set(ws(), { ...(brands.get(ws()) || {}), ...clone(fields) });
    },

    async getSettings() {
      return clone(settings.get('app')) ?? {};
    },
    async saveSettings(values) {
      settings.set('app', { ...(settings.get('app') || {}), ...clone(values) });
    },
    async getWorkspaceSettings() {
      return clone(settings.get(`ws:${ws()}`)) ?? {};
    },
    async saveWorkspaceSettings(values) {
      settings.set(`ws:${ws()}`, { ...(settings.get(`ws:${ws()}`) || {}), ...clone(values) });
    },

    async getAccount(platform) {
      return clone(accounts.get(`${ws()}:${platform}`)) ?? null;
    },
    async listAccounts() {
      return [...accounts.values()].filter(mine).map(clone);
    },
    async upsertAccount(platform, fields) {
      accounts.set(`${ws()}:${platform}`, { ...(accounts.get(`${ws()}:${platform}`) || {}), ...clone(fields), platform, workspace_id: ws(), id: newId() });
    },
    async updateAccount(platform, fields) {
      const key = `${ws()}:${platform}`;
      if (accounts.has(key)) accounts.set(key, { ...accounts.get(key), ...clone(fields) });
    },
    async deleteAccount(platform) {
      accounts.delete(`${ws()}:${platform}`);
    },

    async getCalendarItem(id) {
      const item = calendar.get(id);
      return mine(item) ? clone(item) : null;
    },
    async insertCalendarItems(items) {
      for (const item of items) {
        const id = newId();
        calendar.set(id, { ...clone(item), id, workspace_id: ws(), post_id: null });
      }
    },
    async listCalendar(from, to) {
      return [...calendar.values()].filter((i) => mine(i) && i.date >= from && i.date <= to).map(clone);
    },

    async createPost(fields) {
      const id = newId();
      const doc = {
        id,
        workspace_id: ws(),
        calendar_item_id: fields.calendar_item_id || null,
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
      posts.set(id, doc);
      if (doc.calendar_item_id && calendar.has(doc.calendar_item_id)) calendar.get(doc.calendar_item_id).post_id = id;
      return clone(doc);
    },
    async getPost(id) {
      const p = posts.get(String(id));
      return mine(p) ? clone(p) : null;
    },
    async listPosts(statuses) {
      return [...posts.values()].filter((p) => mine(p) && statuses.includes(p.status)).map(clone);
    },
    async updatePost(id, fields, { onlyIfStatus } = {}) {
      const p = posts.get(String(id));
      if (!mine(p)) return null;
      if (onlyIfStatus && !onlyIfStatus.includes(p.status)) return null;
      Object.assign(p, clone(fields), { updated_at: now() });
      return clone(p);
    },
    async deletePost(id) {
      const p = posts.get(String(id));
      if (!mine(p)) return false;
      posts.delete(String(id));
      return true;
    },
    async countPostsByStatus() {
      const out = {};
      for (const p of posts.values()) if (mine(p)) out[p.status] = (out[p.status] || 0) + 1;
      return out;
    },
    async upcomingPosts(limit) {
      return [...posts.values()].filter((p) => mine(p) && p.status === 'approved').sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)).slice(0, limit).map(clone);
    },
    async allDuePosts(nowIso) {
      return [...posts.values()]
        .filter((p) => p.status === 'approved' && p.scheduled_at <= nowIso && (!p.next_attempt_at || p.next_attempt_at <= nowIso))
        .map(clone);
    },
    async stalePublishingPosts(nowIso) {
      return [...posts.values()].filter((p) => p.status === 'publishing' && (!p.lease_expires_at || p.lease_expires_at <= nowIso)).map(clone);
    },
    async allUncertainPosts() {
      return [...posts.values()].filter((p) => p.status === 'uncertain').map(clone);
    },
    async claimPost(id, { attemptId, leaseMs, fromStatuses }) {
      const p = posts.get(String(id));
      if (!mine(p) || !fromStatuses.includes(p.status)) return null;
      Object.assign(p, {
        status: 'publishing',
        publish_attempt_id: attemptId,
        lease_expires_at: new Date(Date.now() + leaseMs).toISOString(),
        next_attempt_at: null,
        error: null,
        publish_attempt_count: (p.publish_attempt_count || 0) + 1,
        updated_at: now(),
      });
      return clone(p);
    },
    async failInterruptedVideos() {},
    async recentPosts(platform, limit) {
      return [...posts.values()].filter((p) => mine(p) && p.platform === platform).slice(-limit).reverse().map(clone);
    },
    async countMediaReferences(url) {
      return [...posts.values()].filter((p) => mine(p) && [p.image_url, p.video_url, p.document_url].includes(url)).length;
    },

    async insertAsset(fields) {
      assets.push({ ...clone(fields), workspace_id: ws(), created_at: fields.created_at || now() });
    },
    async findAsset(filter) {
      const hit = assets.find((a) => mine(a) && Object.entries(filter).every(([k, v]) => a[k] === v));
      return clone(hit) ?? null;
    },
    async deleteAsset(url) {
      const i = assets.findIndex((a) => mine(a) && a.url === url);
      if (i >= 0) assets.splice(i, 1);
    },
    async assetsCreatedBefore(iso) {
      return assets.filter((a) => a.created_at < iso).map(clone);
    },

    async insertAttempt(fields) {
      attempts.push({ ...clone(fields), workspace_id: ws() });
    },
    async updateAttempt(attemptId, fields) {
      const a = attempts.find((x) => mine(x) && x.attempt_id === attemptId);
      if (a) Object.assign(a, clone(fields));
    },
    async listAttempts(postId) {
      return attempts.filter((a) => mine(a) && a.post_id === String(postId)).map(clone);
    },
    async logAudit(event) {
      audit.push({ ...clone(event), workspace_id: ws(), at: new Date() });
    },
    async listAudit(limit = 100) {
      return audit.filter(mine).slice(-limit).reverse().map(clone);
    },

    async logUsage(entry) {
      usage.push({ ...entry, workspace_id: ws() });
    },

    async createConversation({ title }) {
      const doc = { id: newId(), workspace_id: ws(), title, messages: [], created_at: now(), updated_at: now() };
      conversations.set(doc.id, doc);
      return clone(doc);
    },
    async getConversation(id) {
      const c = conversations.get(String(id));
      return mine(c) ? clone(c) : null;
    },
    async listConversations(limit = 50) {
      return [...conversations.values()]
        .filter(mine)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit)
        .map(({ messages, ...rest }) => clone(rest));
    },
    async saveConversation(id, messages) {
      const c = conversations.get(String(id));
      if (mine(c)) Object.assign(c, { messages: clone(messages), updated_at: now() });
    },
    async deleteConversation(id) {
      const c = conversations.get(String(id));
      return mine(c) ? conversations.delete(String(id)) : false;
    },
  };
  return repo;
}
