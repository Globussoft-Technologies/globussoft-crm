# CHANGELOG

## v3.2.3 — 2026-04-27 — P1 + P2 closure pass, fetchApi rewrite, demo polish

A focused day-long pass on user-reported QA bugs. **24 GitHub issues closed**: 8 P1 (demo-breaking), 11 P2 (functional gaps), 4 silent-failure cluster (#273-#276 + the systemic fetchApi fix), and 1 visit overflow (#277). P1 + P2 boards both at 0 open. No schema changes; backwards-compatible API changes only.

### Class fixes (most leverage)

- **`fetchApi` rewrite** ([frontend/src/utils/api.js](frontend/src/utils/api.js)) — every error toast across the app now surfaces the real server message, not the generic literal "API Request Failed". Root cause: `fetchApi` read `errData.message` but every backend route returns `{error, code}`. Fix: read `errData.error || errData.message`; 403 / 404 / 5xx / network fallbacks; auto-toasts via `_globalNotify` registered by `NotifyProvider` on mount; throws Error with `.status` / `.code` / `.data` attached so callers can branch. Pages opt out with `{silent: true}`. Closes the silent-failure class behind #273-#276.
- **Stale-chunk recovery for all lazy routes** (#249) — new `lazyWithRetry` helper wraps every `lazy()` import; on `Failed to fetch dynamically imported module` it auto-reloads once per session (sessionStorage guard prevents loops). New `RouteErrorBoundary` catches the residual case with a "Reload page" CTA. Affects all 80 lazy routes, not just `/marketplace-leads`.
- **Visit.amountCharged ₹50L cap** (#277) — POST + PUT `/api/wellness/visits` now reject `amountCharged > 5_000_000` with `code: AMOUNT_TOO_LARGE`. Matches `Service.basePrice` ceiling from #209. Cleanup script `backend/scripts/cleanup-overflow-visit-amounts.js` NULLed 2 polluted ₹1e15 rows on prod (residue from #218 era — Z-service polution).
- **Reports off-by-one date range** (#234) — `reportRange()` parsed `to=YYYY-MM-DD` as midnight UTC, dropping every visit/consumption later that day. Fix: when raw param is date-only, clamp `from` to start-of-day, `to` to end-of-day in UTC. Net effect: P&L productCost went ₹0 → ₹32,000; Reports counts up from 109 → 117 visits.
- **Reports tabs canonical totals** (#232) — P&L / Per-Pro / Per-Location were each silently filtering visits with different rules and reporting their per-row sums as totals. New `canonicalVisitTotals()` helper makes `totals.visits` + `totals.revenue` identical across the 3 tabs; new `totals.unbucketed` exposes the join-key-missing delta. Verified live: 117 / 117 / 117 visits, ₹12.9L / ₹12.9L / ₹12.9L revenue.

### Bug fixes — P1 (demo-breaking, 8)

- **#232** Reports tabs disagree on visit totals — see class fix above.
- **#235** Clinic locations not editable after creation — pencil icon added; PUT path was already accepted by backend.
- **#238** Patient portal OTP rejects every code — added `WELLNESS_DEMO_OTP` env-var bypass for QA flow; demo patient `+919876500001` seeded; documented in [PRODUCTION_RUNBOOK.md](PRODUCTION_RUNBOOK.md).
- **#247** Calendar grid drops visits without doctorId — visits now render in an "Unassigned" column; out-of-range visits clamp to boundary hour.
- **#249** /marketplace-leads stale-chunk error — see class fix above.
- **#253** Inbox Play Recording silent — wired native `<audio controls autoplay>`; falls back to "Recording not available" on load error.
- **#259** /api/wellness/dashboard 403 for Owner — closed not-reproducing; `verifyWellnessRole(["admin","manager"])` correctly admits ADMIN role.
- **#260** /leads rows have no click handler — row navigates to `/contacts/:id`; `e.stopPropagation` on interactive child cells.

### Bug fixes — P2 (11)

- **#230** Treatment plan Add rapid-click duplicates — closed as already fixed in #225 (90ff63f, debounced).
- **#231** Consent canvas strokes white on cream — `ctx.strokeStyle` now reads `--text-primary` at draw time.
- **#234** P&L productCost stuck at ₹0 — see class fix above.
- **#243** Invoices ledger column overflow — `table-layout: fixed` + `<colgroup>` widths + Contact ellipsis + opaque sticky Actions.
- **#246** Owner Dashboard expected revenue ₹0 — closed as already fixed by #277 cleanup.
- **#252** Inbox empty-state misleading on Emails tab — scoped to active tab with sub-line listing other-tab counts.
- **#257** Estimates Drafts/Sent pills don't filter — wired with `statusFilter` state + `aria-pressed`.
- **#258** Lead Routing Apply All silent — migrated from local toast to global notify for consistency.
- **#262** Calendar shows only 3 doctor columns — now shows ALL practitioners (16 staff: 3 doctors + 13 professionals); chip toggles between "with visits today" and "All N".
- **#264** Settings Dark Mode toggle no-op — disabled with "coming soon" copy until a real dark theme stylesheet ships (multi-day work, not in PRD §8).
- **#270** Calendar empty-slot click no-op — now opens a "New visit" modal seeded with (practitioner, date, hour). Patient required, status='booked'.

### Bug fixes — Silent-failure cluster (4)

- **#273** Estimates Convert silent no-op — added explicit success toast `Converted to invoice <num>`; 400 errors get a one-line hint about contact + line items.
- **#274** Services Save 403 silent — fetchApi now surfaces "Insufficient wellness role" directly; success path toasts `Saved <name>`.
- **#275** Meta: no toast container mounted — closed as misdiagnosis. NotifyProvider has been mounted at App root since launch; the toast container only mounts when toasts are active. The real fix was the `fetchApi` rewrite (see class fix).
- **#276** Recommendations Reject button unwired — was actually wired with a confirm modal that the user dismissed without realising; explicit success toasts added on Approve/Reject.

### Engine improvements

- None this release — UI + ops + class fixes only. Engine layer untouched.

### UI

- **17 redundant `notify.error('Failed: ${err.message}')` catches removed across 9 wellness pages** (`dfe94b7`); replaced with `catch (_err) { /* fetchApi already toasted */ }` and added missing success toasts on Locations create/update/toggle, Loyalty referral + reward, Patients create, Treatment plan create, Inventory consumption log, Services create, Waitlist add/status/remove, TelecallerQueue.
- New `RouteErrorBoundary` component with "Reload page" CTA for stale-chunk + uncaught render errors.
- Inbox empty-state copy scoped per tab.
- Estimates ledger pills are now real filter buttons.
- Settings Appearance section copy updated to flag dark mode as "coming soon".
- Calendar header chip surfaces practitioner count + filter; column headers show role tag.
- New visit modal seeded from grid cell click.

### Test coverage

- **3 new e2e specs (113 tests)** earlier in the day:
  - `routes/reports.js` (`4846adb`) — 52 tests, was 14.17%, forecast ~85%.
  - `routes/marketing.js` (`612617f`) — 41 tests, was 28.20%, forecast ~80%. Surfaced + fixed `/marketing/submit` openPaths bug.
  - `routes/voice_transcription.js` (`d7ed223`) — 20 tests. **⚠️ Retroactively flagged as PRD drift** — voice belongs to Callified per PRD §6.5. Tests stay; don't extend.
- **OpenPaths audit complete** — no further gaps (landing_pages mounted at `/p`, `/communications/tracking` and `/attribution/track` correctly require auth).
- **Combined coverage forecast: 64.76% → ~71-72% global lines.** Re-run on the server next session and bump `.c8rc.json` `60 → 70` if data supports it.

### PRD scope guardrails (added 2026-04-27)

A coverage push on `routes/voice_transcription.js` was flagged retroactively as drift. Added a §"PRD scope guardrails" block to TODOS.md: voice + WhatsApp routes belong to Callified.ai (PRD §6.5); ad creation belongs to AdsGPT (PRD §6.6); patient self-service portal extensions are not in PRD §5 personas. SMS coverage IS in PRD scope. Reports + Owner Dashboard + Lead management + Calendar + Multi-clinic ARE in PRD scope.

### Deferred (not in v3.2.3)

- **PRD §6.4 lead-side SLA timer** — current SLA engine is ticket-side; lead-side per PRD requires extending or new `LeadSla` policy.
- **PRD §6.7 orchestrator depth audit** — verify the engine actually computes occupancy gap → recommends budget → drafts campaign vs being a stub.
- **PRD §11 audit log on patient READS** — write-side is shipped (#179, v3.2.1); read-side `prisma.auditLog.create` calls in GET handlers are not.
- **#227 Reports CSV/PDF export** — backend export endpoints + per-tab export buttons. ~1-2 days. PDFKit already in stack.
- **#228 mobile responsive overhaul** — multi-day frontend rewrite.
- **AdsGPT silent SSO "Back to CRM" link** — pending with AdsGPT team.
- **Callified silent SSO + back-link + lead webhook** — pending with Callified team.

---

## v3.2.2 — 2026-04-26 (afternoon) — Form autosave, billing patch, telecaller polish, c8 coverage measured

A focused afternoon pass closing the remaining frontend UI cluster from the morning handoff plus the first real backend coverage measurement. **8 GitHub issues closed.** No schema changes; no breaking API changes.

### Added

- **Form autosave hook** (#226) — new `frontend/src/hooks/useFormAutosave.js`. Wraps any controlled form: rehydrates from `sessionStorage` on mount, debounced persist on every keystroke, `beforeunload` warning if dirty, active-tab persistence so a refresh inside Patient Detail's tabbed view doesn't blow away the half-typed prescription. Surfaces a "Restored from previous session" banner that the user can dismiss or accept. Wired into New Prescription, Log Visit, and Treatment Plan forms first; pattern is opt-in, drop-in for the rest.
- **Billing PATCH + mark-paid endpoints** (#202) — `PATCH /api/billing/:id` for partial updates and `POST /api/billing/:id/mark-paid` (idempotent — second call returns `{ idempotent: true }`). Both write audit rows. State-machine codes: terminal transitions return `422` with `code: "INVALID_INVOICE_TRANSITION"` (matches the v3.2.1 approvals pattern). Closes the long-standing "no update path on /api/billing" gap.
- **DISABLE_CRONS=1 env switch** — when set, `server.js` skips all cron initialisation. Lets us run a side-by-side coverage instance on `:5098` without cron jobs interfering with the primary `:5099` PM2 process.
- **Graceful SIGTERM/SIGINT shutdown** — `server.js` now flushes V8 coverage data via `process.on('SIGTERM')` / `process.on('SIGINT')` before exiting. Required for `c8` to write `.c8tmp/coverage-*.json` artefacts on shutdown — without it, killing the process hard means losing the coverage data.

### Bug fixes

- **Form refresh wipes input** (#226) — covered above; was previously losing data silently mid-prescription / mid-visit-log.
- **Telecaller queue inconsistent dispositions** (#215) — Booked / Callback / Interested fired silently; Wrong number / Junk showed a confirm. All 6 now confirm consistently. Booked / Callback / Interested also gain a follow-up form (date+time for Booked/Callback, notes for Interested) so the disposition captures real intent rather than a one-tap throwaway.
- **`/portal` route collision** (#208) — wellness patient portal moved to `/wellness/portal`; the generic CRM customer portal stays at `/portal`. Sidebar Link + redirect updated. Both routes now resolve to their intended page.
- **`/wellness/tasks` blank** (#217) — verified the shared `/tasks` and `/inbox` routes already render correctly under the wellness theme via the `data-vertical="wellness"` cascade. Sidebar Link rewritten to point at the canonical paths; the 404 was a stale prefix in the sidebar config, not a missing page.
- **Treatment plan Add not debounced** (#225) — submitting state on PlansTab + LogVisitTab + InventoryTab disables the button between click and server response. Sweep across the wellness-form components; pattern documented in the form-handler conventions.
- **Patient list table breaks on long names** (#229) — `table-layout: fixed` + `text-overflow: ellipsis` on the name cell + `title` tooltip showing the full name. Header row no longer disappears when a single patient has a 60-char display name.
- **Service Worker push registration spam** (#206) — `[push] setupPush error: AbortError` demoted from `console.error` to `console.debug`. AbortError on registration is normal when push isn't configured for the tenant; was producing noise on every navigation. Other error classes still log loudly.

### Engine improvements

- None this release. v3.2.1 covered the engine layer; this pass is UI + ops.

### UI

- Form autosave banner ("Restored from previous session — keep / discard") on the three highest-frequency wellness forms.
- Telecaller disposition confirm + follow-up modal (date/time picker for Booked, Callback; notes for Interested).
- Patient table layout no longer breaks on long names.

### Test coverage

- **Backend line coverage measured under the full suite: 64.76%** (21,484 / 33,170 lines) via `c8` against all 1,056 backend tests (14.5 min run, includes new eventBus + landingPageRenderer specs). Initial wellness-only baseline was 33.20%; the full-suite number lands materially higher.
- **Coverage targets set as policy this release:**
  - **Aspirational target: 100%** — everything tested, everything safe.
  - **CI gate: 60% lines / 45% branches** — set with ~5pt headroom over the 64.76% baseline; ratchets up each release.
  - **Critical-path floor: 70%** — `routes/auth.js`, `routes/external.js`, `routes/billing.js`, `routes/wellness.js`, all `middleware/*`, all `lib/*` (exempting `lib/eventBus.js` and `services/landingPageRenderer.js` until their dedicated test files land — both queued for this release).
- **13 pre-existing e2e flakes resolved** — admin/admin → admin@globussoft.com migration; SIDEBAR_ROUTES rebuild against the v3.2.1 sidebar; theme localStorage seed pattern. Pass rate now 96%+ on the navigation/notifications/theme cluster.

### Deferred (not in v3.2.2)

- **Mobile responsive overhaul** (#228) — multi-day frontend rewrite (breakpoints, hamburger drawer, ARIA, focus trap, all wellness pages tested at 375px). Not in this release.
- **Reports CSV/PDF export** (#227) — backend export endpoints + per-tab export buttons across the 4 Reports tabs. Estimated 1-2 days; deferred.
- **Login quick-login chips / pre-fill** (#211 / #201 / #200) — product decision pending: keep, env-gate (`NODE_ENV !== 'production'`), or remove entirely. Not a bug; documented as a UX/security tradeoff.
- **Full-suite c8 coverage measurement landed: 64.76% lines / 50.03% branches / 66.11% functions** across 1,056 backend tests. Top under-covered files queued for next release: `routes/reports.js` (14.17%), `routes/marketing.js` (28.20%), `routes/voice_transcription.js` (29.55%), `routes/sms.js` (31.05%), `cron/slaBreachEngine.js` (24.50%).
- **Dedicated test files for `lib/eventBus.js` (currently 20%) and `services/landingPageRenderer.js` (currently 2%)** — both targeted for this release; until they ship, the critical-path 70% floor exempts them.
- **AdsGPT silent SSO "Back to CRM" link** — still pending with AdsGPT team.
- **Callified silent SSO + back-link + lead webhook** — still pending with Callified team.

---

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
