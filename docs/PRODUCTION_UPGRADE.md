# Production upgrade: what changed, how to run it, what is still open

This document accompanies the P0–P2 upgrade of the Social Media Content Agent. It says what was built, what was
actually executed, and what was **not** done or **not verified**. No audit report existed in the repository, so the
starting point was the code itself.

Verdict: the system is **safer and much better checked than before, but not "production-ready" on the strength of
these changes alone.** Nothing here was run against real MongoDB, Cloudinary, Google Drive, ffprobe, a PDF renderer, or
any social platform API. See [Remaining limitations](#7-remaining-limitations-and-unresolved-risks).

## 1. Summary of what was implemented

| Phase | Implemented |
|---|---|
| 1 Secure ingestion | `net/safeFetch.js` + `net/ipPolicy.js` + `mediaIngest.js`: https-only, no credentials in URLs, every hop re-validated, DNS resolved once and the connection **pinned to the validated IP** (SNI/cert checked against the hostname), IPv4/IPv6/IPv4-mapped/NAT64/metadata ranges blocked, redirect limit + loop detection, per-request and total timeouts, `AbortSignal` cancellation, streaming to a private temp file with a hard byte cap (also for chunked bodies), SHA-256 while streaming, magic-byte type detection (extension and Content-Type ignored), HTML/sign-in pages rejected, Drive virus-scan confirmation page followed only to Google hosts, structured `AppError` codes, temp files always removed, URLs logged without query strings. Authorization headers are dropped on cross-host redirects. |
| 2 Media QC | `mediaQc.js` + `mediaRules.js`: image decode (strict, catches truncation), pixel-bomb guard, formats/size/aspect per platform, alt text, non-destructive JPEG derivative (crop only when the platform hard-rejects the ratio, and it is flagged); PDF parse/pages/sizes/orientation/empty pages, optional `pdftoppm` rendering with blank-page detection; video via `ffprobe` when installed, otherwise a built-in MP4/MOV box parser (duration, resolution, fps, codecs, audio, truncation); carousel text limits + CTA check; rendered-slide checks (blank, size, text overflow/shrink). Every report lists `checks` as passed/failed/**unavailable**, so a missing tool is never shown as a pass. QC runs on import, at approval (cached) and again before publishing (fresh). |
| 3 Quality gate | `quality/lint.js` (deterministic rules), `quality/review.js` (independent AI reviewer, schema + zod validation, own prompt, optional different provider/model, verdict re-derived by code), `quality/score.js` (per-format weights, technical vs subjective kept apart, no total without an AI review), `quality/gate.js` (shared by dashboard, MCP, approval, scheduler; revision counting and limit; `reviseUntilReady` loop for dashboard generation). |
| 4 Brand Brain | `brandBrain.js`: schema v2 (segments, pain points, proof points, verified facts, claims needing review, banned phrases, prohibited topics, CTA per goal, link/UTM and hashtag policies, colours/fonts/logo, visual style, platform preferences, approved/rejected examples). Read-time defaults, input sanitising, nothing invented. |
| 5 Creative | `imagePrompt.js` (photo / illustration / text_graphic strategies, brand identity, crop-safe zones, alt text), `videoBrief.js` (structured brief; honest about what the video model cannot make), `slides.js`/`agents/carousel.js` (better slide rules, limits enforced, layout overflow detection, invisible Latin text layer + `/Lang`, PDF only attached after rendered pages pass). |
| 6 Publishing reliability | `postStates.js` (validated transitions), `publishing.js` (atomic claim with lease → preflight QC → publish → settle), `publishers/common.js` (timeouts, stage-aware error classification), `publishPolicy.js` (backoff with jitter, Retry-After, max attempts), new **`uncertain`** state, attempt records, remote ids saved as soon as they exist, reconciliation per platform where an API exists, manual resolve, stale-lease recovery (crash → `uncertain`, not `failed`). |
| 7 Storage | `media.js`: production refuses ephemeral local disk unless `ALLOW_LOCAL_STORAGE=true`; per-workspace folders; `assets` collection (owner, hash, provider); content-hash dedupe; originals kept beside derivatives; release on replace/remove/delete; Cloudinary delete; orphan sweep; storage errors logged + audited. |
| 8 Platforms | LinkedIn: real hashtags (previously `#` was escaped, which turned hashtags into plain text — confirmed against LinkedIn's Posts API docs), image `altText`, API-version age warning, explicit permission errors. Instagram: `alt_text`, Reel limits updated to the current Graph API docs (3 s–15 min, H.264/HEVC, 23–60 fps), container/rate-limit errors, reconciliation through container status + recent media. Facebook: richer guidance, classified errors, feed reconciliation (not for video). X: real counting (`twitter-text`), error classification, timeout wrapper, timeline reconciliation (needs read access). |
| 9 Tests/observability | 146 tests (below). `log.js`: JSON logs with token/URL redaction, counters (`GET /api/ops/metrics`), audit trail (`GET /api/ops/audit`, 90-day TTL), per-post attempts (`GET /api/posts/:id/attempts`). |

Not done: **P3** (analytics ingestion, performance history, experiments), image–caption vision review,
Instagram carousels, X threads, settings/brand UI for the new options. See section 7.

## 2. Files

Added (backend): `src/net/ipPolicy.js`, `src/net/safeFetch.js`, `src/mediaIngest.js`, `src/mediaQc.js`, `src/mediaRules.js`,
`src/log.js`, `src/postStates.js`, `src/publishPolicy.js`, `src/publishing.js`, `src/publishers/common.js`,
`src/quality/{lint,review,score,gate}.js`, `src/imagePrompt.js`, `src/videoBrief.js`, `src/errorHandler.js`;
tests in `backend/test/` (10 test files plus helpers).
Added (frontend): `components/QualityPanel.js`.
Modified (backend): `media.js` (rewritten), `posts.js`, `mcp.js`, `routes.js`, `scheduler.js`, `server.js`, `drive.js`, `brandBrain.js`,
`platforms.js`, `settings.js`, `slides.js`, `errors.js`, `llm/index.js`, `db/mongo.js`, `db/index.js`, `agents/{artist,carousel,creator}.js`,
`publishers/{index,linkedin,instagram,meta,x}.js`, `package.json`.
Modified (frontend): `components/PostCard.js`, `components/ui.js`, `app/page.js`, `app/posts/page.js`, `lib/api.js`.
`backend/src/auth/session.js` had an uncommitted change before this work and was not touched.

## 3. Database and compatibility notes

- **No destructive migration.** Old brand records get the new fields as defaults at read time; nothing is rewritten until a user saves.
- New post fields (all optional): `quality`, `media_qc`, `image_alt`, `publish_attempt_id`, `publish_attempt_count`, `lease_expires_at`, `next_attempt_at`, `remote_id`, `uncertain_reason`, `reconcile_*`, `approved_at`, `video_brief*`. Old posts work without them.
- New status **`uncertain`**. Anything that lists statuses must include it (dashboard, MCP and API were updated).
- New collections (indexes are created at startup): `assets`, `publish_attempts`, `audit_log` (TTL 90 days).
- **Behaviour change on first deploy:** posts found in `publishing` without a live lease (e.g. interrupted by the previous deploy) become `uncertain` instead of `failed`. Check them in the "Needs check" tab.
- Local media now lives in `UPLOAD_DIR/<workspace-id>/<name>`. Existing flat files and Cloudinary URLs keep working (`/media/<name>` still resolves). Existing files have no `assets` record, so they are never deduped; local legacy files are deleted when unused, legacy Cloudinary files are not (no public id recorded).
- Stricter behaviour users will notice: approval is refused for rule violations (length, markdown, banned phrases, media problems) and needs an explicit confirmation for flagged items (unverified figures, absolute claims, missing CTA on leads/sales goals). MCP `schedule_post` can never confirm; `create_post` no longer rejects over-limit text but saves a flagged draft; images with an aspect Instagram rejects are cropped on import instead of failing at publish time.

## 4. Configuration

Environment variables (all optional unless noted):

| Variable | Purpose | Default |
|---|---|---|
| `NODE_ENV=production` | enables the durable-storage requirement | – |
| `ALLOW_LOCAL_STORAGE=true` | allow local disk in production; only with `UPLOAD_DIR` on a **persistent volume** | refused in production |
| `UPLOAD_DIR` | where local media is stored | `backend/data/uploads` |
| `INGEST_TMP_DIR` | private temp dir for downloads | OS temp dir |
| `MEDIA_ALLOWED_HOSTS` | comma list; restricts direct (non-Drive) media links to these hosts | any public host |
| `MEDIA_REQUEST_TIMEOUT_MS` / `MEDIA_TOTAL_TIMEOUT_MS` | idle / overall download timeouts | 20000 / 120000 |
| `MEDIA_RULES_JSON` | override any platform media limit (deep-merged) | defaults in `mediaRules.js` |
| `QUALITY_WEIGHTS_JSON` | override score weights per format | defaults in `quality/score.js` |
| `PUBLISH_MAX_ATTEMPTS` | automatic attempts for retryable failures | 3 |
| `FFPROBE_PATH`, `PDFTOPPM_PATH` | tool locations if not on `PATH` | `ffprobe`, `pdftoppm` |

Workspace settings (saved with `PUT /api/settings`; **no screen for them yet**): `review_provider` (`''`=same as writer, `gemini`, `openai_compat`, `anthropic`), `review_model`, `quality_min_score` (85), `quality_max_revisions` (2), `quality_require_ai_review` (false).
With `ai_provider = mcp` there is no reviewer unless `review_provider` points at a provider with a key; the report then says "AI review not run" and no overall score is produced.

System packages (recommended on the server): `ffmpeg` (provides `ffprobe`) for frame-level video checks; `poppler-utils` (`pdftoppm`) for PDF page rendering; a Bengali font (e.g. `fonts-noto-core`/Noto Sans Bengali) for Bengali slides. Without them the features degrade as described and the reports say so.

## 5. New dependency

`twitter-text@3.1.0` (X's own tweet-length library): the only way to follow X's real counting rules (links = 23, emoji and many scripts = 2, NFC normalisation, bare domains). It pulls in the deprecated `core-js@2`; pnpm skipped its install script and nothing needed it. No other dependency was added.

## 6. Tests actually executed

Command: `pnpm --filter backend test` (Node's built-in runner, Windows 11, Node 24.22). Last full run:
**146 tests, 146 pass, 0 fail, ~9 s.** The frontend was compiled with `next build` (succeeds); it has no automated tests.

| File | Covers |
|---|---|
| `ipPolicy`, `ingest` (25) | IPv4/IPv6/mapped/NAT64/metadata ranges, URL validation, Drive URL forms, redirects to localhost/private/metadata/mixed DNS, loops, floods, pinning (single lookup), header drop on redirect, HTML pages, wrong types, corrupt data, expired/missing/denied/rate-limited, oversize incl. chunked, stalls, hangs, cancellation, temp-file cleanup, Drive confirmation page, sign-in page |
| `mediaQc` (19) | image decode/truncation/pixel limit/aspect/format/alt/flat image, derivative crop, PDF parse/empty/pages/sizes/blank render/render failure, slide limits and CTA (English+Bengali), rendered slides, video header parse/limits/codec/audio/truncation, ffprobe JSON mapping |
| `lint` (14), `units` (17) | all content rules; state machine; backoff/jitter; retry eligibility; HTTP/network/X/LinkedIn error classification; scoring; review validation; brand defaults; log redaction; prompts; video brief |
| `storage` (16) | per-workspace paths, dedupe, vanished files, traversal, production enforcement, storage failure reporting, release/replace/delete, orphan sweep, image/PDF/video import end-to-end with a mock server, duplicate detection |
| `publishing` (22) | success, uncertain (never retried), retry with Retry-After, retry exhaustion, auth failure, 6-way race (one publisher), crash → uncertain, reconciliation, manual resolution, preflight block, missing media, workspace isolation, DB error after remote success, real timeouts/429/401 against a local server |
| `gate` (18) | approval blocking, acknowledgement, edit re-check, revision counting/limit, AI reviewer success/malformed/out-of-range/outage/unavailable/different model, revision loop |
| `e2e` (6) | MCP via the SDK's in-memory transport: draft → fix report → Drive link image (mock Drive) → duplicate → HTML error → check → schedule → scheduler → final state + logs (no secret in logs); blocked drafts; Instagram video; PDF; uncertain flow; Brand Brain |
| `carousel` (4), `routes` (5) | PDF text layer, overflow warnings, Bengali, attach/refuse; the dashboard HTTP API end to end |

Also run once by hand: `safeGet` against the real internet (`example.com` over TLS with a pinned IP works; `localtest.me`, which resolves to 127.0.0.1, is blocked).

**Not executed anywhere:** MongoDB (tests use an in-memory stand-in that is atomic by construction, so they prove the application logic, not MongoDB's `findOneAndUpdate`), Cloudinary upload/delete, Google Drive API/OAuth, any LinkedIn/Instagram/Facebook/X API (all mocked), real `ffprobe`, real `pdftoppm`, Linux, the browser UI beyond `next build`.

## 7. Remaining limitations and unresolved risks

1. **No exactly-once publishing.** None of the four platforms gives an idempotency key. A timeout during the creating call leaves the post `uncertain`; it is never retried automatically. Automatic reconciliation exists for Instagram, Facebook (non-video) and X (needs read access / paid tier); **LinkedIn cannot be reconciled** (`r_member_social` is restricted) so a person confirms. "Not found" never auto-fails a post.
2. LinkedIn may accept a post (201) and fail processing later (`PUBLISH_FAILED`); this is not polled. Facebook video processing failures are not visible either.
3. Video checks without `ffprobe` read only the MP4/MOV header; corruption inside the media data is not detected. Black frames, caption accuracy and content quality are **not** checked. Thumbnails/frame sampling were not built.
4. PDF page rendering and blank-page detection need `pdftoppm`; without it only structure is checked and the report says so. Uploaded PDFs' text overflow/fonts are never machine-checked. Generated carousels are image pages: Latin text gets a hidden text layer, **Bengali text does not** (it would need an embedded font), so screen readers can't read those pages. The Bengali font check only looks for a font file/`fc-list`, it does not prove glyphs rendered.
5. Image–caption relevance with a vision model was **not** implemented: the provider layer is text-only.
6. The AI reviewer is an opinion. Thresholds (85) and weights are starting points, not validated against engagement. A reviewer from the same model family as the writer may share its blind spots (the report shows `independent`).
7. Deterministic claim detection is heuristic (figures with units, absolute words). The free-text "avoid" field cannot be enforced by rules; only the AI reviewer sees it.
8. SSRF hardening covers user-supplied **media links**. The AI "base URL" setting (`settings.js`, `PRIVATE_HOST` regex, then unpinned `fetch`) is still regex-based and is open to DNS tricks; treat that setting as admin-only or route it through `safeGet`.
9. Media served from local disk is protected by unguessable names only (no signed or expiring URLs); Instagram needs public URLs anyway. Cloudinary files uploaded before this change cannot be auto-deleted.
10. No UI yet for: review/quality settings, the new Brand Brain fields, video briefs, AI image style choice. They work through the API/MCP. The frontend's own X character counter is still the old approximation; the backend is authoritative.
11. P3 (analytics, history, experiments) was not started; it needs per-platform read permissions that may not be granted.
12. API limits in `mediaRules.js` are defaults. Instagram's were checked against the Graph API docs on 2026-10-23; others are conservative app limits that should be re-verified against current platform documentation before relying on them.
13. Multi-instance deployments rely on the database claim plus a 15-minute lease and on reasonably synchronised clocks.

## 8. Manual verification (suggested order)

1. `pnpm --filter backend test` → all green; `pnpm --filter frontend build`.
2. Start the app on a staging database with Cloudinary configured and **dry run on**. Settings → Media: confirm `GET /api/status` shows `storage.durable: true`. Remove Cloudinary, set `NODE_ENV=production`: confirm uploads are refused with `STORAGE_NOT_DURABLE`.
3. Through Claude/MCP: `create_post` with a "300%" claim → flagged; `schedule_post` is refused; fix → `schedule_post` works. In the dashboard, flagged items show a confirm dialog.
4. Attach an image, a PDF and a video from **real Drive links** (public and, with Drive connected, private). Try a folder link, a deleted file, an HTML page.
5. Install `ffmpeg` and `poppler-utils`; re-run "Re-check" on a post and confirm the video report says `inspectedWith: ffprobe` and the PDF `render: passed`.
6. With a throw-away account per platform, publish a short post; then simulate an outage (block the platform host with the firewall mid-publish) and confirm the post becomes **Needs check** and is not re-sent. Resolve it from the card.
7. Kill the server while a post is `publishing`; restart; confirm it becomes `uncertain`.
8. Check logs (`publish.*`, `ingest.*`, `quality.*`, `storage.*`) contain no tokens or signed URLs.

## 9. Deployment checklist

- [ ] Durable media: Cloudinary configured, **or** `ALLOW_LOCAL_STORAGE=true` with `UPLOAD_DIR` on a persistent disk.
- [ ] `ENCRYPTION_KEY` unchanged; `NODE_ENV=production`; `TRUST_PROXY` set correctly (existing).
- [ ] Install `ffmpeg`, `poppler-utils`, a Bengali font on the server image.
- [ ] Decide `MEDIA_ALLOWED_HOSTS` for direct links (or leave open to public hosts).
- [ ] Set workspace review settings (`review_provider`/`review_model`, `quality_require_ai_review`) via the API.
- [ ] LinkedIn API version in Settings is current (the app warns when it is ≥10 months old; 202511 sunsets 2026-11-16).
- [ ] Deploy once with scheduler paused or low traffic; review posts in "Needs check".
- [ ] Back up MongoDB before the first start (new indexes are built automatically).
- [ ] Watch `GET /api/ops/metrics` and `/api/ops/audit` for `publish.uncertain`, `storage.fail`, `ingest.fail.*`.

## 10. Recommended next steps

1. Run the manual checks above against staging and real (test) accounts; fix what real APIs reveal.
2. Add the Settings/Brand Brain/video-brief screens.
3. Add a Mongo integration test run (e.g. `mongodb-memory-server` or a CI service) for the atomic claim and indexes.
4. Route the AI base URL through `safeGet`; consider signed media URLs.
5. Add vision-based image/caption review once a provider accepts images.
6. Start P3 with read-only analytics for the platforms whose permissions allow it, then use the history to tune score weights.
