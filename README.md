# Content Agent MVP

Your AI content team: **Brand Brain → Strategist → Creator (with self-review) → your approval → Publisher**.

- **Brand Brain**: your goal, audience, tone, pillars, off-limit topics and best past posts. It goes into every AI call.
- **Strategist**: plans a week of posts (date, platform, pillar, format, hook idea).
- **Creator**: writes each post, then a second AI call scores it against your brand and rewrites it if needed (up to 2 times).
- **Approval**: nothing goes out until you approve it. Edit, rewrite with feedback, pick a time.
- **Publisher**: posts approved content at the scheduled time to X, your personal LinkedIn profile and your Facebook Page.
- **Instant mode**: topic in, on-brand drafts out, no calendar step.

## Setup

Requires Node 22.13+ and pnpm.

### 1. Database (MongoDB Atlas, free)

1. Create a free **M0** cluster at cloud.mongodb.com.
2. **Database Access**: add a database user with a password.
3. **Network Access**: add your IP address (or `0.0.0.0/0` while testing).
4. **Connect → Drivers**: copy the connection string, put your password in it, and set it in `backend/.env`:
   ```
   MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

### 2. Run

```powershell
pnpm install
pnpm dev
```

- App: http://localhost:3000
- API: http://127.0.0.1:4000

On first start the backend:
- creates `ENCRYPTION_KEY` in `backend/.env`. Keep it, because your saved keys are encrypted with it.
- copies any old keys still in `.env` into the database.

### 3. Create your account (you become the owner)

Open http://localhost:3000 and **sign up**. The **first account is the admin (app owner)** and keeps all data that existed before accounts (brand, posts, calendar, connections, settings). Everyone who signs up after that gets their own empty, private workspace.

Until an email provider is set up, the confirmation link is **printed in the backend terminal**: open it to verify your email.

### 4. Everything else: in the dashboard

**Settings** page (the owner sees everything; other users only see Publishing and Appearance):
- **Sign-in & email**: allow or close sign-ups, Resend key for real emails (verification, password reset), and "Continue with Google / LinkedIn".
- **AI**: pick a provider and paste its key, then click **Test connection**.
  - **Google Gemini** (free): key from aistudio.google.com
  - **Groq** (free): key from console.groq.com. OpenRouter and a local Ollama also work here.
  - **Claude** (paid, best quality): key from console.anthropic.com
- **Platform apps**: one-time developer app setup per platform, with step-by-step instructions and the Callback URL to copy.
- **Media**: free Cloudinary account, so Instagram and Facebook can download post images.
- **Publishing**: dry run, default posting times.

**Connections** page: one click per platform: log in, allow, done. Shows the connected account with photo, name and expiry. Platforms you don't connect are **simulated**: the post is marked "published (simulated)" and nothing is sent.

Then: **Brand Brain** → **Calendar** → *Plan this week* → *Write all drafts* → **Posts** → approve.

The scheduler runs inside the backend, so keep `pnpm dev` running for scheduled posts to go out. A post missed by more than 6 hours (app was off) is marked failed instead of going out late.

## Platform notes

Like "Sign in with Google", one-click connecting needs a developer app per platform, set up once by the app owner (you). Settings → Platform apps has the steps and the **Callback URL** for each. After that, **Connections** is one click.

| Platform | One-time app setup | Connection lasts | Images |
|---|---|---|---|
| **X** | console.x.com app: "Read and write" + Callback URL; Consumer Key + Secret. Posting needs X API credits (pay-per-use). | Doesn't expire | Not yet (text only) |
| **LinkedIn** (personal profile) | developer.linkedin.com app (needs a Company Page to register; posts go to your profile), products *Share on LinkedIn* + *Sign In with LinkedIn using OpenID Connect*, Callback URL; Client ID + Secret. | 60 days, then Reconnect (the dashboard warns you) | Not yet (text only) |
| **Facebook Page** | developers.facebook.com app, use case "Manage everything on your Page", Callback URL under Facebook Login; App ID + Secret. Personal profiles can't be posted to. | Doesn't expire | Optional |
| **Instagram** | Professional (Creator/Business) account; Meta app with "API setup with Instagram login", Callback URL, your account added as Instagram Tester; Instagram App ID + Secret. | 60 days, **renewed automatically** | Required (JPEG; cropped automatically) |

Apps in development mode work for your own accounts without review. Letting other people connect their accounts later would need Meta App Review.

Callback URLs use `http://localhost:4000`. On a server, set `PUBLIC_API_URL` (e.g. `https://api.yourdomain.com`) in `backend/.env` and update the URLs in each developer app.

## Project layout

```
backend/   Express API (plain JS)
  src/db/index.js          Picks the database driver (DB_DRIVER, default mongodb)
  src/db/mongo.js          MongoDB repository: all storage goes through here
  src/settings.js          Dashboard settings, encrypted secrets, import from .env
  src/llm/                 AI providers: gemini, openaiCompat (Groq/OpenRouter/Ollama), anthropic
  src/brandBrain.js        Brand Brain + the context injected into prompts
  src/agents/              strategist.js (calendar), creator.js (writer + self-review)
  src/oauth.js             One-click Connect: login → callback → saved account
  src/accounts.js          Connected accounts (encrypted tokens)
  src/media.js             Post images: Cloudinary, or local files served at /media
  src/publishers/          X, LinkedIn, Facebook, Instagram (+ account tests)
  src/scheduler.js         Checks every minute for due posts (all workspaces)
  src/context.js           The current workspace for a request or job
  src/auth/                Sign-up, login, sessions, passwords, Google/LinkedIn login, rate limits
  src/admin.js             Owner's user management
  src/email.js             Verification and password-reset emails (Resend)
frontend/  Next.js + Tailwind
```

### Switching databases later

- **Local MongoDB (e.g. on a VPS):** just change `MONGODB_URI` to `mongodb://127.0.0.1:27017`.
- **PostgreSQL:** add `src/db/postgres.js` exporting `connect()` that returns the same methods as `mongo.js`, register it in `src/db/index.js`, and set `DB_DRIVER=postgres`. Nothing else changes.

## Accounts and login (SaaS)

- **Sign up / sign in** with email + password, Google, or LinkedIn. Email sign-ups confirm their address before using the app. Forgot password sends a one-hour, single-use link and signs out every other device.
- **One workspace per user.** Brand Brain, calendar, posts, connected accounts, AI usage and publishing settings belong to the workspace; nobody can see another workspace. The data layer refuses any query that isn't inside a workspace (`src/context.js`).
- **Owner (admin)** sets the AI key, platform developer apps, media and sign-in options once for everyone, and manages users on **Admin → Users** (make admin, disable, delete). More owners: `ADMIN_EMAILS=a@x.com,b@y.com` in `backend/.env`, or "Make admin".
- **Security:** passwords hashed with scrypt; sessions are random tokens stored only as SHA-256, in an HttpOnly, SameSite=Lax cookie (Secure on https), 30 days sliding; writes from other websites are rejected (Origin check); login, sign-up, reset and verify are rate-limited; login errors don't reveal whether an email exists.
- **Account page:** change name or password, link/unlink Google and LinkedIn, sign out other devices, delete the account and its data.

**Login callback URLs** (Settings → Sign-in & email shows them): `http://localhost:3000/api/auth/google/callback` and `http://localhost:3000/api/auth/linkedin/callback`. They point at the frontend, which forwards `/api` to the backend (`frontend/next.config.mjs`), so the session cookie belongs to the app's own domain.

### Putting it on a server

1. Run the backend on the server with `HOST=127.0.0.1` (default) and put the frontend on your domain; the frontend's `/api` proxy reaches the backend (`API_PROXY_TARGET`, default `http://127.0.0.1:4000`; set it before `next build`).
2. In `backend/.env`: `FRONTEND_ORIGIN=https://app.yourdomain.com` and `PUBLIC_API_URL=https://app.yourdomain.com` (or your API domain). With https, the session cookie is sent only over https.
3. Update the callback URLs in the Google, LinkedIn, X and Meta developer apps.
4. Add a Resend key and verify your sending domain, or nobody can confirm their email.
5. Rate limits and pending logins live in memory: fine for one server. Several servers would need Redis.

## Not in the MVP (next: V2)

Images and an image editor, Instagram, curation and repurposing, analytics fetching, best-time heatmap, X threads.
