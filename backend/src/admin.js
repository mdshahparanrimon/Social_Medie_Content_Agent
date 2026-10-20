import { Router } from 'express';
import { repo } from './db/index.js';
import { httpError } from './errors.js';
import { deleteAccount } from './auth/users.js';

// For the app owner: everyone who signed up. Mounted behind requireAuth + requireAdmin.
export const adminRouter = Router();

async function otherUser(req) {
  const user = await repo.getUser(req.params.id);
  if (!user) throw httpError(404, 'User not found.');
  if (user.id === req.user.id) throw httpError(409, 'Use the Account page to change your own account.');
  return user;
}

const view = (user, stats) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  avatar_url: user.avatar_url || null,
  role: user.role,
  disabled: Boolean(user.disabled),
  email_verified: Boolean(user.email_verified),
  sign_in: [...(user.password_hash ? ['email'] : []), ...Object.keys(user.providers || {}).filter((p) => user.providers[p])],
  created_at: user.created_at,
  last_login_at: user.last_login_at || null,
  ...(stats || { posts: 0, ai_calls: 0, platforms: [] }),
});

adminRouter.get('/users', async (req, res) => {
  const [users, stats] = await Promise.all([repo.listUsers(), repo.workspaceStats()]);
  res.json(users.map((user) => view(user, stats[user.workspace_id])));
});

adminRouter.patch('/users/:id', async (req, res) => {
  const user = await otherUser(req);
  const fields = {};
  if (req.body.role !== undefined) {
    if (!['admin', 'user'].includes(req.body.role)) throw httpError(400, 'Role must be admin or user.');
    fields.role = req.body.role;
  }
  if (req.body.disabled !== undefined) fields.disabled = Boolean(req.body.disabled);
  const updated = await repo.updateUser(user.id, fields);
  // A disabled user is signed out everywhere right away.
  if (fields.disabled) await repo.deleteUserSessions(user.id);
  res.json(view(updated, (await repo.workspaceStats())[updated.workspace_id]));
});

adminRouter.delete('/users/:id', async (req, res) => {
  await deleteAccount(await otherUser(req));
  res.json({ ok: true });
});
