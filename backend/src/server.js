import express from 'express';
import cors from 'cors';
import { connectDatabase, repo } from './db/index.js';
import { importSettingsFromEnv, moveLegacySettingsToOwner } from './settings.js';
import { UPLOAD_DIR } from './media.js';
import { router } from './routes.js';
import { oauthRouter } from './oauth.js';
import { authRouter } from './auth/routes.js';
import { adminRouter } from './admin.js';
import { mcpRouter, mcpTokenRouter } from './mcp.js';
import { requireAdmin, requireAuth, sameOriginOnly } from './auth/session.js';
import { startScheduler } from './scheduler.js';
import { errorHandler } from './errorHandler.js';

const PORT = Number(process.env.PORT) || 4000;
// The browser talks to this API through the frontend (Next.js proxies /api), so by default it only listens on this computer.
const HOST = process.env.HOST || '127.0.0.1';

try {
  await connectDatabase();
} catch (err) {
  console.error(`\nCould not connect to the database: ${err.message}`);
  console.error('Check MONGODB_URI in backend/.env, and in MongoDB Atlas allow your IP under Network Access.\n');
  process.exit(1);
}
await importSettingsFromEnv();
await moveLegacySettingsToOwner();
if ((await repo.countUsers()) === 0) {
  console.log('No accounts yet: open the app and sign up. The first account becomes the admin (app owner) and keeps any existing data.');
}

const app = express();
// The frontend proxy runs on this machine; trust its X-Forwarded-For so rate limits see the real visitor IP.
// Behind a host's proxies (e.g. Hostinger) set TRUST_PROXY=true, or every visitor shares the proxy's IP in rate limits.
const TRUST_PROXY = process.env.TRUST_PROXY;
app.set('trust proxy', !TRUST_PROXY ? 'loopback' : TRUST_PROXY === 'true' ? true : /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000', credentials: true }));
// Large enough for an 8 MB image upload sent as base64.
app.use(express.json({ limit: '12mb' }));
// Files have unguessable names (128-bit) under a per-workspace folder; never listed, never sniffed as HTML.
app.use('/media', express.static(UPLOAD_DIR, {
  maxAge: '30d',
  index: false,
  dotfiles: 'deny',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  },
}));
// Called by Claude (claude.ai's servers), not the browser: the secret in the URL is the login.
app.use('/mcp', mcpRouter);
app.use('/api', sameOriginOnly);
app.use('/api/auth', authRouter);
app.use('/api/oauth', oauthRouter);
app.use('/api/admin', requireAuth, requireAdmin, adminRouter);
app.use('/api/mcp', requireAuth, mcpTokenRouter);
app.use('/api', requireAuth, router);

app.use(errorHandler);

app.listen(PORT, HOST, () => {
  console.log(`Content agent API running on http://${HOST}:${PORT}`);
  // SCHEDULER=off: for trying the app against a real database without publishing posts or running cleanup jobs.
  if (process.env.SCHEDULER === 'off') console.log('Scheduler is off (SCHEDULER=off): nothing is published and no cleanup runs.');
  else startScheduler();
});
