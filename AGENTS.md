# Globussoft Enterprise CRM — Agent Guide

> Read this first when starting work on this repository. It is written for AI coding agents and assumes no prior knowledge of the project. All paths are relative to the repository root unless stated otherwise.

## 1. Project overview

Globussoft Enterprise CRM is a full-stack, multi-tenant CRM built by Globussoft Technologies. It serves both generic B2B CRM users and verticalised configurations (wellness clinics/salons and a travel-agency vertical in progress) from a single codebase.

- **Live demo:** `https://crm.globusdemos.com`
- **Current version:** v3.9.3 (per `README.md` and `CHANGELOG.md`; canonical source of truth is `backend/package.json`)
- **Repository:** `https://github.com/Globussoft-Technologies/globussoft-crm`
- **Branching:** single-branch (`main`) workflow; releases are tagged `v*`
- **Persistent backlog:** read `TODOS.md` at the start of every session before picking up new work.

## Engineering backlog convention

The persistent backlog of multi-day / architectural work lives in **[TODOS.md](TODOS.md)** at repo root. It's grouped by priority bucket (ship-this-month, bigger investments, don't-patch-rethink) plus architectural cron-skipped issues, test debt, and PRD-gap analysis. Each item has the diagnosis, recommended approach, and effort estimate.

**On session start, read `TODOS.md` before picking up new work** so you don't duplicate something already triaged or skip an item that's already been planned.

### Closed gap-files live under `docs/gaps/archive/`

When a gap / backlog / regression-tracking file is **fully closed** (every entry shipped, zero `⬜` / `☐` / `TODO` / `open` markers remaining), it moves under `docs/gaps/archive/` rather than getting deleted — see [docs/gaps/archive/README.md](docs/gaps/archive/README.md) for the convention. Active backlogs (`TODOS.md`, `docs/E2E_GAPS.md`, `docs/regression-coverage-backlog.md`) stay at their root locations as long as ≥1 item is open. Don't archive a file just because most items are closed — cohesion of the original file beats archive cleanliness.

The product is large:

| Surface | Count | Location |
|---|---|---|
| API routes | ~196 | `backend/routes/*.js` |
| Cron/automation engines | ~50 | `backend/cron/*.js` |
| Prisma models | 211+ | `backend/prisma/schema.prisma` |
| Frontend pages | 260+ | `frontend/src/pages/` |
| Frontend components | 80+ | `frontend/src/components/` |
| E2E spec files | 282+ | `e2e/tests/*.spec.js` |
| Backend unit tests | 543+ | `backend/test/**/*.test.js` |
| Frontend unit tests | 258+ | `frontend/src/__tests__/**/*.test.{js,jsx}` |

## 2. Technology stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 18, Vite 5, React Router v7, React.lazy code-splitting, Recharts, ReactFlow, React Grid Layout, Socket.io-client, Lucide React, vanilla CSS with glassmorphism |
| **Backend** | Node.js, Express 4, Prisma ORM, MySQL 8, Socket.io, node-cron, express-rate-limit, express-validator, Helmet, csurf, sanitize-html, Swagger UI |
| **AI/LLM** | Google Gemini 2.5 (`@google/generative-ai`) for deal insights, lead scoring, sentiment, drafts, enrichment |
| **Auth** | JWT (`jsonwebtoken`/`bcryptjs`), RBAC (`ADMIN`/`MANAGER`/`USER`), 2FA (`speakeasy`), SSO/SCIM |
| **Payments** | Stripe, Razorpay |
| **Communications** | SendGrid (transactional email), Twilio (SMS/voice), MSG91/Fast2SMS (India SMS), WhatsApp Cloud API, Nodemailer, IMAP inbound email, Web Push (`web-push`) |
| **Files/PDF** | Multer, PDFKit, pdf-lib, xlsx, QRCode, Sharp, Tesseract |
| **Production** | PM2, Nginx reverse proxy, Certbot SSL, Sentry |
| **Testing** | Playwright (E2E), vitest (unit), jsdom (frontend unit), c8 (coverage) |
| **Vendored workspace** | `agentic-orchcrm/` — TypeScript multi-agent orchestration engine that powers the `/travel/brochure-engine` page |

## 3. Code organisation

```
backend/                 Node.js + Express API
  server.js              App bootstrap, middleware stack, route mounts, cron init
  routes/*.js            Express route modules (one per feature area)
  controllers/           Heavy route handlers factored out of routes
  middleware/            Auth, security, validation, field filtering, origin check
  lib/*.js              Pure-ish helpers (prisma client, eventBus, notification, dedup, etc.)
  services/            Outbound providers / renderers (SMS, WhatsApp, PDF, etc.)
  cron/*.js              Automation engines
  prisma/schema.prisma   MySQL schema (211+ models)
  prisma/seed.js         Generic CRM tenant seed
  prisma/seed-wellness.js Wellness tenant seed
  test/                  vitest unit + integration tests

frontend/                Vite + React SPA
  src/App.jsx            Router, AuthContext, Suspense/lazy page loading
  src/pages/             Page components (generic + wellness/ + travel/)
  src/components/        Shared components + UI primitives
  src/__tests__/         vitest component/page tests
  src/utils/api.js       fetchApi helper with Bearer token + 401 redirect
  src/theme/wellness.css Wellness vertical theme (scoped under [data-vertical="wellness"])
  nginx.conf             Production static-file + proxy rules

e2e/                     Playwright test suite
  tests/*.spec.js        E2E / API specs
  auth.setup.js          Authenticated-state setup
  playwright.config.js   Shard/reporter/project configuration

agentic-orchcrm/         Vendored TypeScript multi-agent workspace (brochure engine)
  packages/core          Agent loop + orchestrator
  packages/db            Postgres persistence via Drizzle
  apps/web               Web UI

scripts/                 Local-dev helpers and one-off operator scripts
```

### Verticals

`Tenant.vertical` is one of `{generic, wellness, travel}`.

- **Generic:** lands on `/dashboard`, full enterprise sidebar.
- **Wellness:** lands on `/wellness`, clinic-focused sidebar, teal/blush theme, extra models (`Patient`, `Visit`, `Prescription`, etc.).
- **Travel:** lands on `/travel`, navy/gold theme, sub-brand access per `User.subBrandAccess[]`.

## 4. Local development setup

### Option A — native (fastest iteration)

```bash
# Backend
$ cd backend
$ npm install
$ npx prisma generate
$ npx prisma db push
$ node prisma/seed.js          # generic tenant
$ node prisma/seed-wellness.js # wellness tenant
$ npm run dev                  # http://localhost:5000, Swagger at /api-docs

# Frontend (new terminal)
$ cd frontend
$ npm install
$ npm run dev                  # http://localhost:5173
```

### Option B — Docker Compose (fully containerised)

```bash
$ docker compose up --build -d
# Frontend: http://localhost:5173
# Backend API: http://localhost:3000
# MySQL: localhost:3307 root / local_dev_pw
```

Use the dev override for hot reload:

```bash
$ docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

### Local stack helpers (mirror CI gates)

```bash
# macOS / Linux / git-bash
$ ./scripts/test-local.sh --local
$ ./scripts/test-local.sh --local --keep-stack
$ ./scripts/test-local.sh --local --skip-build   # lint + api_tests + unit_tests only

# Windows PowerShell
$ .\scripts\test-local.ps1 -Local
$ .\scripts\local-stack-up.ps1
$ .\scripts\local-stack-down.ps1 -Wipe
```

These boot MySQL on `3307`, push the schema, seed both tenants, and run the backend on `:5000` with `DISABLE_CRONS=1`. Do **not** iterate route changes against the live demo — it runs already-deployed code.

## 5. Build and test commands

### Backend

```bash
$ cd backend
$ npm run dev                 # nodemon
$ npm start                   # node server.js
$ npm run lint                # ESLint flat config
$ npm run lint:strict         # --max-warnings 0 on lib/middleware/services/utils/test
$ npm run test                # vitest unit tests (no DB, no network)
$ npm run test:integration    # vitest integration config
$ npm run test:coverage       # vitest with coverage
$ npm run audit:check         # npm audit allowlist gate
```

### Frontend

```bash
$ cd frontend
$ npm run dev                 # Vite dev server
$ npm run build               # Production build
$ npm run lint                # ESLint flat config
$ npm run test                # vitest component/page tests (jsdom)
$ npm run check:bundle-size     # Compare chunks against .bundle-size-budget.json
```

### E2E / Playwright

```bash
$ cd e2e
$ npm install
$ npx playwright test --project=chromium
$ BASE_URL=https://crm.globusdemos.com npx playwright test --project=chromium
```

## 6. Testing strategy

There are three testing layers. **All new code must add tests in the correct layer.**

### Layer 1 — Backend unit tests (vitest)

Scope: pure functions in `backend/lib/`, `middleware/`, `services/`, `utils/`, `cron/`, `routes/`.

- **No real DB, no network.** Mock `../lib/prisma` via `vi.mock()`.
- Tests live at `backend/test/<area>/<module>.test.js`.
- `vitest.config.js` inlines `backend/{lib,middleware,services,utils,cron,scripts,routes}/` so `vi.mock` factories intercept CJS `require('./prisma')` calls.
- `test/setup.js` refuses to run if `DATABASE_URL` points at a non-local host unless `ALLOW_REMOTE_DB_IN_TESTS=1` is set.

### Layer 2 — Frontend unit tests (vitest + jsdom)

- Tests live as siblings under `frontend/src/__tests__/`.
- `vite.config.js` test config uses `environment: 'jsdom'`, `globals: true`, and `vitest.setup.js`.
- Stable mock references are required when a mocked hook return value lands in a `useCallback`/`useMemo` dependency array.

### Layer 3 — E2E / API specs (Playwright)

- Request-only API specs run against a CI-local backend in the per-push `api_tests` gate.
- Full UI/wellness/a11y suite runs in `e2e-full.yml` against the live demo on every `v*` tag push.
- Gated specs are listed explicitly in `.github/workflows/deploy.yml` (search "Run API-only specs").

### Adding tests for new code

| Code change | Required test action |
|---|---|
| New route in `backend/routes/*.js` | Add `e2e/tests/<route>-api.spec.js`, then wire it into **both** `.github/workflows/deploy.yml` and `.github/workflows/coverage.yml` spec lists. Clone `e2e/tests/notifications-api.spec.js` as a template. |
| New `backend/lib/`, `middleware/`, `services/` module | Add `backend/test/<area>/<module>.test.js`. Mock Prisma and external SDKs. |
| New frontend page/component | Add `frontend/src/__tests__/<Name>.test.jsx`. |
| New cron engine | Add `backend/test/cron/<engine>.test.js` and an E2E manual-trigger spec where applicable. |

## 7. Code style and project conventions

### Language and formatting

- **Backend:** CommonJS (`.js`). ESLint 9 flat config in `backend/eslint.config.js`.
- **Frontend:** ES modules (`.js`, `.jsx`). ESLint 9 flat config in `frontend/eslint.config.js`.
- No Prettier config is committed; follow the surrounding file's indentation and quote style.
- Code, identifiers, file paths, and technical terms stay in English, matching the existing codebase.

### Critical backend conventions

1. **JWT payload key is `userId`, never `id`.**
   - Use `req.user.userId`.
   - ESLint errors on `req.user.id` and on `const { id } = req.user`.
   - See commit `6b1470f` and issue `#936`.

2. **Request body dangerous fields are stripped globally.**
   - `stripDangerous` (mounted in `server.js`) deletes `id`, `userId`, `tenantId`, `createdAt`, `updatedAt` from `req.body` before any route handler runs.
   - ESLint errors on `req.body.{id,userId,tenantId,createdAt,updatedAt}` inside `routes/**/*.js`.
   - If a route legitimately needs a body-supplied user or tenant, use non-stripped names such as `targetUserId`, `siteTenantId`, or `previewTenantId`, and return `400` if missing.
   - See issue `#646`.

3. **Tenant isolation is mandatory.**
   - Every list query in a route must scope on `tenantId: req.user.tenantId` (or use a `tenantWhere(req)` helper).
   - ESLint warns (`gbscrm/tenant-scope-finder-heuristic`) on `prisma.<Model>.findMany({ where: { ... } })` inside `routes/` when the `where` has no `tenantId` or `id`.
   - Reference spec: `e2e/tests/tenant-isolation-api.spec.js` (29 resources, 93 assertions).

4. **JSON-string columns must be sanitised at the call site.**
   - Helper: `backend/lib/sanitizeJson.js` (`sanitizeText`, `sanitizeJson`, `sanitizeJsonForStringColumn`).
   - The helper is shape-preserving; the caller stringifies before storing.
   - Used by `sequences.js`, `lead_routing.js`, `ab_tests.js`, `marketing.js`, `report_schedules.js`.

5. **All API endpoints are prefixed with `/api/`.**
   - Swagger UI is at `/api-docs`.
   - Global `verifyToken` guards everything except `/auth/login`, `/auth/signup`, `/auth/register`, `/health`, `/marketplace-leads/webhook`.

6. **Use the canonical `{error, code}` envelope for failures.**

7. **Route mount order matters.**
   - Literal paths (e.g. `/invoices/customer-ledger`) must be mounted **before** parametric paths (e.g. `/invoices/:id`) when they share a prefix, or Express will treat the literal string as an `:id` value.

### Frontend conventions

1. **Primary CTAs use `var(--primary-color, var(--accent-color))`.**
   - Generic theme defines only `--accent-color`; wellness defines `--primary-color: #265855` and `--accent-color: #CD9481`.
   - Bare `var(--accent-color)` for primary actions renders salmon under wellness.

2. **Ellipsis on flex/grid children needs `min-width: 0` at every nesting level** (parent grid track via `minmax(0, ...)`, cell, and inner inline-block).

3. **Responsive grids without media queries:** prefer `gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))'`.

4. **JSX text content does not interpret `\u` escape sequences.** Use the actual Unicode character or an HTML entity.

5. **Build-time version injection:** `__APP_VERSION__` and `__APP_GIT_SHA__` are injected by `vite.config.js` reading `backend/package.json`.

### API response shape changes

Prefer additive envelopes with backward-compatible top-level fields. Example: multi-recipient email added `totalSent`/`totalFailed`/`results`/`failures` while keeping top-level `email`/`messageId`/`delivered` populated for single-recipient callers.

## 8. Deployment process

The only supported deploy path is GitHub Actions.

### Per-push gate (`.github/workflows/deploy.yml`)

Fires on every push to `main` (skipping docs/script-only changes). Six mandatory parallel gates:

1. **build** — `npm ci` + `prisma generate` + `node --check` on every backend `.js` + frontend `vite build` + bundle-size gate.
2. **lint** — ESLint backend + frontend + `npm audit` allowlist check.
3. **api_tests** — MySQL 8 container, seed both tenants, boot backend on `:5000`, run the gated Playwright API specs.
4. **unit_tests** — vitest over `backend/test/`.
5. **frontend_unit_tests** — vitest over `frontend/src/__tests__/`.
6. **migration_check** — Prisma schema-safety detector for `UNIQUE`, `NOT NULL`, column drop, and type-narrow changes. Waived by commit-message bless markers: `[allow-unique]`, `[allow-drop]`, `[allow-not-null]`, `[allow-narrow]`.

On all-green:

```
SSH pull → npm install → prisma generate → PM2 restart → /api/health poll
(auto-rollback to HEAD~1 on fail) → vite build → rsync to /var/www → smoke check
```

Manual hotfix bypass exists via `workflow_dispatch.skip_tests=true` only; a normal push cannot bypass gates.

### PR pre-merge checks (`.github/workflows/pr-checks.yml`)

Runs `vite build` + ESLint on every PR before merge. Also includes a silent-revert audit that warns when a PR touches files changed on `main` since the merge-base.

### Release validation (`.github/workflows/e2e-full.yml`)

```bash
$ git tag -a vX.Y.Z
$ git push origin vX.Y.Z
```

This triggers the full Playwright chromium suite (4-way sharded) against `https://crm.globusdemos.com`. If red, fix on `main` and retag.

### Demo monitoring

`.github/workflows/demo-monitor.yml` polls `/api/health` every 30 minutes and auto-files a tracker GitHub issue on failure.

## 9. Security considerations

- **JWT secrets:** production refuses to boot if `JWT_SECRET` is missing. `PORTAL_JWT_SECRET` should be separate.
- **Rate limiting:** 5000 req/15 min general, 1000 req/15 min on auth, stricter login limiters, forgot-password and check-email enumeration defences.
- **CSRF / origin / content-type:** `originCheck`, `csurf`, and a global `415` unsupported-content-type guard protect browser flows.
- **Helmet + strict CSP:** Report-Only CSP with per-request nonces; HSTS and other security headers.
- **Input sanitization:** `sanitize-html` strips dangerous tags globally; `sanitizeJson` handles JSON-string columns.
- **Cross-tenant scoping:** every route must filter on `req.user.tenantId`.
- **Secret scanning:** gitleaks runs on every push + scheduled full-history scan Mondays.
- **`npm audit` gate:** fails CI on new high/critical CVEs. Allowlist entries in `backend/.audit-allowlist.json` must include `sunsetBy` dates.
- **Output filtering:** `scrubResponse` strips `passwordHash`, `portalPasswordHash`, and `isAdmin` from every JSON response.
- **Audit logging:** `writeAudit` covers PHI reads; cron engines write audit rows even on no-op runs.
- **No real secrets in git:** `.env` files, PEM keys, and deploy scripts with credentials are gitignored. Rotate immediately if leaked.

## 10. Environment variables

Key variables the backend expects (see `docker-compose.yml` and `docker-compose.dev.yml` for defaults):

- `DATABASE_URL` — MySQL connection string
- `JWT_SECRET`, `PORTAL_JWT_SECRET`
- `NODE_ENV`, `PORT`
- `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`
- `GEMINI_API_KEY`, `OPENAI_API_KEY`
- `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
- `SENTRY_DSN`
- `WELLNESS_FIELD_KEY` — enables AES-256-GCM PII field encryption
- `WELLNESS_DEMO_OTP=1234` — demo OTP bypass for patient portal QA (test/non-prod only)
- `DISABLE_CRONS=1` — skips cron init at boot (used by local stack / side-by-side coverage)

The root `.env` and `backend/.env` are gitignored. Do not commit secrets.

## 11. Demo credentials (local / demo)

The Login page has quick-login buttons grouped by tenant.

**Generic CRM tenant (USD)**

| Role | Email | Password |
|---|---|---|
| Admin | `admin@globussoft.com` | `password123` |
| Manager | `manager@crm.com` | `password123` |
| User | `user@crm.com` | `password123` |

**Wellness tenant (INR, lands on `/wellness`)**

| Role | Email | Password |
|---|---|---|
| Owner | `rishu@enhancedwellness.in` | `password123` |
| Admin | `admin@wellness.demo` | `password123` |
| User | `user@wellness.demo` | `password123` |
| Doctor | `drharsh@enhancedwellness.in` | `password123` |

## 12. Common gotchas

- **`req.user.id` is undefined.** Always use `req.user.userId`.
- **`req.body.id` / `req.body.userId` / `req.body.tenantId` are deleted before route handlers run.** Use `targetUserId`, `siteTenantId`, etc.
- **Client-side aggregation over paginated endpoints is wrong.** If a frontend `reduce()`/`filter()` works on data from `?limit=N`, use a server-side `/stats` or aggregate endpoint instead.
- **Local-only specs must guard on `BASE_URL`.** Specs that touch disk or spawn child processes must skip under `e2e-full.yml` demo runs. Use `IS_LOCAL_STACK` or `probePrismaClient()` guards.
- **Demo-state-aware assertions:** target rows created by the test (via `RUN_TAG` or `_marker`), not aggregate counters, when running against `e2e-full.yml`.
- **Force-moving a release tag re-drafts its GitHub Release** until you run `gh release edit X --draft=false --latest`.
- **The brochure engine needs a one-time vendor setup.** See `docs/AGENTIC_ENGINE_SETUP.md`; the folder `agentic-orchcrm/` is gitignored.

## 13. Where to find more detail

- `README.md` — product overview, feature highlights, live counts
- `TODOS.md` — persistent engineering backlog; read before every session
- `CHANGELOG.md` — release history
- `docs/` — PRDs, integration guides, gap trackers, decision/credential trackers
- `backend/prisma/schema.prisma` — authoritative data model
- `backend/eslint.config.js` and `frontend/eslint.config.js` — lint rules (read them)
- `.github/workflows/deploy.yml` — canonical CI/CD gate list

## 14. Standing operational rules (migrated from legacy `CLAUDE.md`)

Historical cron learnings and operational patterns from the legacy `CLAUDE.md`
have been consolidated here as standing rules for agents. Older detail is
preserved in the git history of `CLAUDE.md`.

### Parallel-agent dispatch

- **Use `git commit --only <files>` for every parallel-agent commit.** Do not
  use bare `git commit` after `git add` in a multi-agent wave; `--only` scopes
  the commit to the listed paths regardless of what else is staged.
- **When ≥3 agents must edit `backend/prisma/schema.prisma` concurrently,**
  either dispatch a single "schema-only prep" PR with all field additions first,
  or require each agent to `git commit --only schema.prisma` as the very first
  commit step so sibling tree state cannot leak in.
- **Run `verifying-issue-before-pickup` on the dispatcher's prompt premise too,**
  not just inside the agent. Common phantom sources: claiming a test file is
  missing when it exists, claiming a feature is unshipped when it already
  landed, or claiming a file was lost after `git checkout HEAD -- <file>`
  (which restores HEAD content, not deletes it).

### Writing and debugging tests

- **Never trust a test-file header that says "this module can't be tested
  because X".** Verify with a 5-line probe before scoping the work.
- **When a frontend uses client-side aggregation over a paginated list,** check
  whether a server-side `/stats` or aggregate endpoint already exists for that
  resource. The fix is often adding fields, not adding endpoints.
- **CJS self-mocking seam:** when module `M` exports both `f` and `g`, and `f`
  internally calls `g`, the call site in `M` must use `module.exports.g(...)`
  so `vi.spyOn(M, 'g')` can intercept it. A local closure binding bypasses the
  spy.
- **Date-boundary assertions should use unambiguously-future dates** (e.g.
  `new Date(Date.now() + 86_400_000)`) rather than `today.setHours(0,0,0,0)`
  to avoid local-vs-UTC midnight overlap flakes.
- **TZ-label assertions are not portable across Node ICU builds.** `date-fns-tz`
  short names render differently on different ICU/tzdata versions. Pin the
  wall-clock prefix verbatim and assert TZ-label presence via a flexible regex.

### E2E specs

- **Any `test.describe` block where tests share a backend resource** (audit
  chain, sequential ID generators, the same tenant entity, ledger-style state)
  should default to `test.describe.configure({ mode: 'serial' })` at the
  describe level.
- **E2E helpers that allocate shared-DB resources must include a per-worker
  discriminator** such as `process.pid`, `test.info().workerIndex`, or an env
  var. Pure process-monotonic counters look correct in single-worker dev runs
  but collide when Playwright spawns multiple workers against the same backend.
- **Convergence helpers must re-fire the convergence action on every iteration**
  where the condition isn't met, not just on the first false reading. Under a
  demo with continuous background-cron writes, polling-without-acting loses.

### Issue and backlog hygiene

- **When a pen-test framing (non-determinism / flicker / varying numbers)
  doesn't reproduce, don't close.** Investigate what the framing was a symptom
  of — the bug underneath is often bigger than the filed issue.
- **Every failure-count claim in `TODOS.md` needs an inline citation** (workflow
  run id or `e2e/tests/<spec>.spec.js:<line>` refs) so the next reader can
  verify it in 30 seconds. Numbers without provenance rot fast.
- **Before dispatching a test-coverage drain task,** run
  `ls frontend/src/__tests__/ | sort` and cross-reference the candidate page
  against the existing test inventory. Only dispatch genuinely uncovered
  candidates.

### Express routing

- **Literal paths must mount before parametric `:id` paths when they share a
  URL prefix.** For example, `/invoices/customer-ledger` must be mounted before
  `/invoices/:id`, or Express will treat "customer-ledger" as the `:id` value.

### Infra/backend routing

- **When a route appears 404 or returns wrong content on demo but works
  locally, check Nginx config AND backend handler in parallel**, not
  sequentially. The fix often needs both layers.

### Windows path note

- **`/tmp/` paths fail on Windows git** in this development environment. Use a
  project-local file such as `.tmp-agent-XX-msg.txt` (already gitignored) for
  commit-message files when dispatching parallel agents on Windows.
