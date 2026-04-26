# CHANGELOG

## v3.2.1 — 2026-04-26 — Overnight QA + audit pass

A two-day deep-flow audit + fix sprint. Closed **22 GitHub issues + 9 architectural backlog items**. Surfaced and patched a class of latent bugs that smoke tests would never catch — only deep API exercise reveals them. No new features; this is hardening.

### Added

- **JWT revocation** (#180) — new `RevokedToken` model. `jti` minted on every login (register/signup/login/2fa-verify); `verifyToken` checks the table on every request, fail-open on DB error so a Prisma blip doesn't lock everyone out. New endpoints: `POST /auth/logout`, `GET /auth/sessions`, `DELETE /auth/sessions/:jti`. Pre-deploy tokens (no jti claim) keep working until natural 7d expiry.
- **wellnessRole RBAC gates** (#207 / #214 / #216) — new `middleware/wellnessRole.js` (`verifyWellnessRole(allowed)`, orthogonal to `verifyRole`). JWT now carries the `wellnessRole` claim. **18 backend endpoints gated** (Owner Dashboard, reports, recommendation approve/reject/edit, service catalog POST/PUT, location POST/PUT, prescription POST/PUT, consent POST/PUT, telecaller queue + dispose). Frontend: login redirects by wellnessRole; OwnerDashboard render-time guard; sidebar hides management modules from clinical staff. **20/20 RBAC e2e tests pass live.**
- **Audit log expansion** (#179) — new `backend/lib/audit.js` (`writeAudit` + `diffFields` helpers). ~50 audit calls added across contacts, estimates, tasks, billing, wellness (patient/visit/Rx/consent/loyalty/recommendation), notifications, auth (profile + role + password). Passwords NEVER written to details; PII recorded as `piiFieldsTouched: [...]` name list only.
- **Cross-resource soft-delete** (#167) — `deletedAt DateTime?` + `@@index([tenantId, deletedAt])` on Contact/Deal/Estimate/Task. DELETE flips `deletedAt` (admin-only); GET filters by default with `?includeDeleted=true` opt-in; new `POST /:id/restore` clears it. Audit rows written for SOFT_DELETE + RESTORE.
- **SLA breach cron + event** (#12) — `Ticket.breached/breachedAt` columns + new `cron/slaBreachEngine.js` (every 5 min). Emits `sla.breached` event; idempotency via `breached=false` precondition. New `POST /api/sla/check-breaches` (ADMIN) for manual trigger.
- **Sequence engine + step-list editor rebuild** (#7 / #9) — new `SequenceStep` model (kind ∈ {email, sms, wait, condition}, FK to EmailTemplate, optional smsBody / delayMinutes / conditionJson + branch positions + `pauseOnReply`). `cron/sequenceEngine.js` rebuilt (372 lines). New `frontend/src/pages/SequenceBuilder.jsx`. New API: `GET/POST /:id/steps`, `PUT/DELETE /steps/:id`. Legacy ReactFlow canvas preserved for sequences with empty `steps`. Reply detection: `processInboundReplies()` parses enrollmentId from `seq-<id>` threadIds and pauses on inbound.
- **Approvals state machine + DELETE + audit** (gaps #3 #4 #5) — terminal transitions return `422 INVALID_APPROVAL_TRANSITION`; idempotent re-approve/reject return `{ idempotent: true }`. New DELETE endpoint. Audit row on every transition.
- **Patient portal `surveys/public/:id`** (#184) — backend GET/POST in `openPaths`; frontend `SurveyPublic.jsx` mounted OUTSIDE the authenticated Layout (no admin sidebar leak). Wellness theme cascades via `data-vertical="wellness"`.
- **SMS drain endpoint** (#182) — `POST /api/sms/drain` (ADMIN). `resolveProviderConfig()` picks SmsConfig row first then env-var fallback (MSG91 → Twilio → Fast2SMS). No provider → fail-fast all QUEUED rows to FAILED with reason.
- **Workflow rule conditions** (#20) — `AutomationRule.condition` String column. JSON-array clauses AND-joined, ops `eq/neq/gt/gte/lt/lte/in/nin/contains/startsWith` with numeric coercion. Empty/null = always-fires. Bad JSON = fail-closed. POST/PUT validate via `validateCondition()` → 400 `INVALID_CONDITION`.
- **Approvals auto-create on threshold** (#1 + #2) — `create_approval` action wired into `workflowEngine.js`. Resolves `entityId` via `payload[entity.toLowerCase()+'Id']`; `reasonTemplate` rendered with mustache-style `{{path.to.field}}` lookups. New trigger types: `approval.created/approved/rejected`.
- **Last 3 dead workflow triggers wired** (#17) — `contact.updated` (with `changedFields`), `task.completed` (gated on `wasCompleted=false`), `lead.converted` (Lead → Customer/Prospect status flip).
- **Loyalty auto-credit on visit completion** — POST/PUT visits with status='completed' auto-credit 10% of `amountCharged` via `LoyaltyTransaction`; idempotent via lookup.

### Bug fixes

- **Portal login 500 on unknown email** — `findUnique({where:{email}})` against a non-`@unique` field threw and returned 500 instead of 401. Three sites fixed.
- **2FA login was unreachable** — `/auth/2fa/verify` was missing from the `openPaths` allowlist; the global guard 403'd before the tempToken could be read.
- **All form-encoded webhooks were broken** — `express.urlencoded()` was not mounted, so Twilio voice/SMS, WhatsApp, Mailgun, and Razorpay webhooks all 400'd silently on missing-field checks.
- **Accounting webhook unreachable** — `/accounting/webhook` not in `openPaths` so QuickBooks/Xero/Tally callbacks 403'd.
- **Setting a quota was impossible** — `POST /quotas` read `userId` from body, but `stripDangerous` middleware deletes `req.body.userId` (anti-injection). Now reads from query.
- **Portal OTP bypass** — legacy `POST /portal/login` accepted any 4-digit OTP without checking PatientOtp. Anyone with a phone could mint a 30-day portal JWT. Now validates against the OTP table the same way `/verify-otp` does.
- **`/sequences/debug/tick` open to any user** — implicitly auth-protected but any USER could fire the cron loop for every tenant. Now ADMIN-only.
- **P&L productCost stuck at ₹0** — visit `findMany` select omitted `id`, so the consumption-cost lookup always missed. One-line fix; cost rollups now correct.
- **P&L day-boundary desync** — joined consumptions through `consumption.createdAt` (drifts from revenue window). Now joins through `visit.visitDate`.
- **XSS sanitiser was half-done** (#213) — only stripped `<script|iframe|object|embed|svg>`. Now also strips `<img|video|audio|source|applet|base|input|textarea>` plus inline event handlers (`onclick=`, `onerror=`, etc.) and `javascript:`/`data:` URL schemes.
- **Estimate API breaking change** (#199) — POST silently rejected the legacy `{name, items}` shape after a rename. Now accepts both `{name|title, items|lineItems}` for the deprecation window.
- **Wellness patient name overflow** (#220) — `validatePatientInput` cap dropped from 200 → 191 to match the utf8mb4 VARCHAR(191) DB column.
- **Doctor dropdown empty in Log Visit form** (#221) — `/api/staff` GET select was missing `wellnessRole`; the wellness UI's filter `u.wellnessRole === 'doctor'` matched zero rows. Added to the select.
- **Case history rendered raw `ENC:v1:…` ciphertext** (#224) — `lib/prisma.js` `$extends` hooks only ran on the outer query model. Made `decryptRecord` recursive: walks every nested relation and decrypts any field whose name is in the union of encrypted-field names AND whose value passes `isEncrypted()`.
- **Public booking validation** (#218 / #219) — corrupt service rendering + booking validator hardening.
- **Service durationMin cap** — bumped from 480 to 720 min (real long procedures take 9–10h).
- **Login rate limiting** (#191) — two stacked `express-rate-limit` limiters on `POST /auth/login`: per-IP (5/15min, IPv6-safe via `ipKeyGenerator`) + per-username (10/1h keyed on email lowercase+trim). `skipSuccessfulRequests` so legitimate fat-finger flows refund the slot.
- **Security headers** (#186) — Helmet now sets HSTS / SAMEORIGIN / Referrer-Policy / nosniff / CORP same-site / baseUri+formAction 'self'. New `permissionsPolicyMiddleware` for camera/mic/geo/FLoC. `imgSrc` https-only in prod.
- **Deal stage data migration** (#190) — `scripts/migrate-deal-stage-lowercase.js` (idempotent). Production run: 32 deals scanned, 1 unmappable logged, no neg amounts.
- **Corrupt service cleanup** (#218) — `scripts/cleanup-corrupt-services.js`. Deleted 16 test-pollution rows.
- **Contact attachments POST 500** (#176) — root cause was unguarded req.body destructure with no multer middleware; route now validates JSON `{filename, fileUrl}` shape, returns 400 `UNSUPPORTED_CONTENT_TYPE` for multipart.
- **Color contrast on consent canvas** (#204) — scoped `[data-vertical="wellness"]` CSS override; canvas border + background now visible on cream theme.
- **CallLog scrub field naming** — script referenced wrong field names; CallLog has `notes`/`recordingUrl`, not `summary`/`transcriptUrl`.
- **+ 4 wellness QA bug batches** — batches 1–7 closed ~30 polish bugs (#107 #108 #109 #111 #112 #113 #114 #115 #116 #117 #118 #119 #120 #122 #123 #124 #125 #126 #127 #128 #129 #143 #149 #151 #154 #156 #181 #183 #185 #187 #188 #189 #192 #193 #194 #195 #196 #197 #198 #203 #205 #209 #210 #212 + #122-reopen).

### Engine improvements

- **Workflow engine** — `deal.stage_changed`, `ticket.created`, `invoice.paid` events now emit. Trigger/action whitelists are enforced (400 with `INVALID_*_TYPE`). `isActive` is updatable via PUT.
- **Sequences** — pause / resume / unenroll endpoints added. Delay regex now matches `Days?`/`Hours?`/`Mins?` (was missing days). Synthesised drip emails carry a deterministic `seq-<enrollmentId>` threadId so they're queryable.
- **SLA** — `responseMinutes: 0` is valid (instant SLA), `firstResponseAt` only stamps on Open → (In Progress | Pending | Replied), `/apply-all?force=true` re-applies a policy to in-flight tickets. Both `/api/tickets` and `/api/support` now share the SLA auto-apply path.
- **Wellness clinical no-delete policy** (#21) — Patient, Visit, Prescription, ConsentForm, AgentRecommendation, ServiceConsumption are PERMANENT. No DELETE endpoints, no `deletedAt`, no soft-delete. Corrections via PUT/PATCH (amendment trail in audit log). Policy block at top of Clinical section in `wellness.js` so future engineers don't accidentally add a DELETE. Compliance: HIPAA 164.312(c)(1), India MoHFW EMR Standards 2016, DPDP Act 2023.

### UI

- **238 native window.alert/confirm/prompt replaced** with HTML notify modals (consistent UX across wellness + generic).

### Test coverage

- **+64 new e2e specs** across 5 deep-flow modules (approvals, sequences, sla, workflows, wellness clinical journey)
- **Smoke specs covering all 89 mounted route files** — ensures every route is at minimum reachable + auth-gated correctly
- **Audit script** at `scripts/audit-e2e-routes.js` extracts every `/api/*` URL referenced in specs and matches against actual handlers — surfaces broken URLs and untested route files
- **2 deep-flow flakes resolved** + global-teardown extended to scrub `E2E_FLOW_<ts>` / `E2E_AUDIT_<ts>` tags
- **mysql2** installed as devDependency so global-teardown can connect to the dev DB

### Deferred (not in v3.2.1)

- **Frontend UI cluster** — 7 cron-skipped issues that need real frontend work: #206 (push registration noise), #229 (long-name table layout), #225 (form double-submit debounce), #226 (form refresh data loss), #215 (telecaller disposition consistency), #208 (`/portal` route collision), #217 (`/wellness/tasks` 404), #228 (mobile responsive overhaul), #227 (Reports CSV/PDF export).
- **41 pre-existing e2e brittleness failures** — non-blocking (93% pass rate); UI flow drift in legacy specs.
- **AdsGPT silent SSO** — impersonation flow live; "Back to CRM" link still pending with AdsGPT team.
- **Callified silent SSO + back-link + lead webhook** — pending with Callified team.
- **Backend line coverage tool** — wire `c8` to instrument PM2 (~3 hours, deferred).

---

## v3.2.0 — 2026-04-23 — Production-ready wellness vertical

The first production-cut of the wellness vertical. Built for **Enhanced Wellness** (Dr. Haror's Ranchi franchise, owner Rishu) but designed as a tenant configuration on the existing multi-tenant CRM — not a fork.

### Added

**Vertical foundation (v3.1)**
- Multi-tenant `Tenant.vertical` field (`generic` / `wellness`) drives sidebar, theme, and landing route
- 9 new Prisma models: `Patient`, `Visit`, `Prescription`, `ConsentForm`, `TreatmentPlan`, `Service`, `ServiceConsumption`, `AgentRecommendation`, `Location`
- `User.wellnessRole` (doctor / professional / telecaller / helper) — orthogonal to the existing RBAC role
- 106-service catalog mirroring drharorswellness.com (hair transplant, aesthetics, body contouring, etc.)
- Per-service `targetRadiusKm` for marketing geo-targeting
- Multi-location ready (Ranchi seeded; franchise-ready)

**Wellness-specific UI (v3.1)**
- Owner Dashboard with KPI tiles, 30-day revenue chart, location switcher
- Recommendations inbox (AI agent cards with Approve/Reject)
- Patients list + detail with 8 tabs: case history, prescription pad, consent canvas, treatment plans, log visit, photos, inventory, telehealth
- Service catalog with inline edit + Packages tab calculator
- Day-grid Calendar by doctor
- 4-tab Reports (P&L by Service / Per-Pro / Per-Location / Marketing Attribution)
- Locations admin
- Telecaller queue with SLA timer + 6 disposition codes + 30s auto-refresh
- Patient Portal (phone + SMS OTP login, view visits/Rx/treatment plan, download PDFs)
- Public booking page at `/book/:slug` (3-step, no auth)
- Embeddable lead-capture widget (`/embed/widget.js` + `/embed/lead-form.html`)
- Per-location side-by-side comparison dashboard

**Backend automations (v3.1+v3.2)**
- Real **orchestrator engine** — daily 07:00 IST cron, reads dashboard context, generates 1-3 prioritised recommendation cards via Gemini (rules-based fallback), action dispatcher fires on Approve
- **Junk-lead filter** with rules + optional Gemini fallback for ambiguous mid-band leads
- **Lead auto-router** — keyword → service category → assigned specialist (doctor/professional/telecaller round-robin)
- **Appointment SMS reminders** cron (15 min, T-24h + T-1h)
- **Wellness ops** cron (hourly NPS post-visit + 90-day junk retention)
- **Low-stock inventory alerts** cron (daily 09:00 IST, email + in-app to managers)
- **Waitlist auto-fill** on cancellation (offers slot to next waitlisted patient via SMS)
- **Deep retention enforcement** — anonymise inactive 24mo+ patients, hard-delete consent forms >7yr (DPDP), purge old call logs

**External Partner API (v3.1)**
- `/api/v1/external/*` — API-key authenticated endpoints for sister Globussoft products (Callified.ai voice/WhatsApp, AdsGPT for ad creation, Globus Phone for softphone)
- 12 endpoints: leads (POST + GET poll), calls (POST + PATCH), messages, appointments, contacts/lookup, patients/lookup, services, staff, locations, /me, /health
- Two demo keys auto-seeded
- Junk filter + auto-router run inline on POST /leads

**Compliance & security (v3.2)**
- AES-256-GCM **field encryption** on patient PII (`Patient.allergies`, `Visit.notes`, `Prescription.*`, `ConsentForm.signatureSvg`); transparent decrypt-on-read via Prisma extension; opt-in via `WELLNESS_FIELD_KEY` env var
- One-shot `scripts/encrypt-existing-pii.js` for backfilling pre-encryption rows
- Wellness retention enforcement (DPDP-aligned)

**Telehealth (v3.2)**
- Jitsi-based video consult tab on Patient Detail, room name auto-stored on `Visit.videoRoom`

**White-label branding (v3.2)**
- `Tenant.logoUrl` + `Tenant.brandColor` — uploadable via Settings → Branding
- Logo + accent applied to Sidebar header, owner dashboard, email templates, invoice PDFs

**Loyalty + referrals (v3.2)**
- `LoyaltyTransaction` + `Referral` models, manager UI at `/wellness/loyalty`
- Auto-link referrals when referred patient signs up via `source = "referral"`

**Currency**
- Tenant-driven currency: `Tenant.country`, `Tenant.defaultCurrency`, `Tenant.locale` feed a single `formatMoney()` helper
- Indian tenants see ₹ with Lakh / Crore notation; US sees $; full BCP-47 fallback otherwise
- India-aware Pricing page (timezone-detected)

**Documentation**
- `docs/wellness-client/PRD.md` — product requirements
- `docs/wellness-client/IMPLEMENTATION_PLAN.md` — phased build plan
- `docs/wellness-client/STATUS.md` — current build state + demo walkthrough
- `docs/wellness-client/EXTERNAL_API.md` — partner API reference
- `docs/wellness-client/EMBED_WIDGET.md` — website integration guide
- `docs/wellness-client/RISHU_TODOS.md` — items waiting on the client
- `PRODUCTION_RUNBOOK.md` — onboarding + ops procedures (this release)

### Test coverage

| Suite | Tests | Status |
|---|---|---|
| Frontend vitest (component + utility) | 28 | passing |
| E2E `wellness.spec.js` (route + page coverage) | 103 | passing |
| E2E `wellness-deep.spec.js` (PDF, cron, dispatcher, encryption, photos) | 28 | passing |
| E2E `wellness-ui-flows.spec.js` (real browser interactions) | 8 | passing |
| E2E `wellness-auth-edge.spec.js` (token/concurrent/error shape) | 9 | passing |
| E2E `wellness-a11y.spec.js` (axe-core, zero serious/critical) | 6 | passing |
| E2E `wellness-integration.spec.js` (race + webhook + AI gate) | 16 | passing |
| Cross-browser projects | Chromium + Firefox + WebKit + mobile-chrome | configured |
| Total | **520+ E2E + 28 vitest** | |

### Bug fixes (this release)

- `GET /wellness/patients/abc` → 500 → now 400 (numeric ID validation via router.param)
- Malformed JSON body → HTML error → now 400 JSON (global error handler)
- Wellness sidebar text was illegible (dark on dark) — scoped CSS variable override inside `aside.glass`
- Icon-only buttons missing accessible names (Logout, NotificationBell, Softphone, OwnerDashboard switcher) → aria-label
- Embed form inputs not associated with labels → `id` + `for` + autocomplete hints
- USD `$` leakage in generic Reports + AgentReports → `formatMoney()` everywhere
- `Survey.title` Prisma error in NPS engine → now `Survey.name` (model has no `title`)
- Color contrast on wellness theme — `--text-secondary` darkened from `#7A6E66` (3.8:1) to `#5C5046` (>7:1, passes WCAG AAA)

### Removed from wellness sidebar (don't apply to clinics)

`Pipeline`, `Deal Insights`, `Tickets`, `CPQ`, `Live Chat`, `Chatbots`, `Voice/SMS/WhatsApp config` (those live in Callified), `Booking Pages` (replaced by `/book/:slug`), `E-Signatures` (replaced by per-patient consent canvas), `Lead Scoring` (replaced by junk filter `aiScore`), `Web Visitors`, `Generic Reports / Forecasting / Funnel / Staff Reports`, `Expenses` (per Rishu's feedback)

### Deferred (not in v3.2)

- AdsGPT silent SSO + back-link → with AdsGPT team
- Callified silent SSO + back-link + lead webhook → with Callified team
- Superphone + Zylu CSV migration → waiting on client exports
- Android app Play Store resubmit → waiting on client docs
- Performance / load testing
- Hindi i18n
- Real provider integration tests (sandboxes)

---

## v3.1.0 — 2026-04-22

Initial wellness vertical build. See git history for detail.

## v3.0.0 — Pre-wellness

Generic enterprise CRM. 88 routes, 99 models, 76 pages, 12 cron engines.
