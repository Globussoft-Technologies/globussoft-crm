# Engineering Backlog

**Read this on session start.** This is the persistent backlog of architectural / multi-day work that's been deferred from cron / overnight runs because it's too risky to ship without alignment. Each item has the diagnosis, the recommended approach, and an estimate. Pick from the top of each priority bucket; check items off (with the commit SHA) when shipped.

Last updated: 2026-04-26

---

## 🟡 Ship this month — small/medium effort, real product impact

### [ ] #1 + #2 — Approvals: auto-create on threshold + side effects
**Diagnosis:** `workflowEngine.js` has no `create_approval` action — high-value deals do NOT auto-trigger approvals. The user must manually POST `/api/approvals`. And `/approve` is a no-op on the deal itself: records the decision but doesn't mutate stage / apply discount / fire any side-effect event.
**Recommendation:** Don't tangle approve with deal mutation. Decoupled design:
- Add `create_approval` action type to `workflowEngine.js executeAction()` (1 new switch case). Threshold lives in the rule's `targetState`, e.g. `{ amountGt: 50000, reason: "High-value deal" }`.
- On `/approve` success, emit `approval.approved` event (1 line). Add to `TRIGGER_TYPES` whitelist.
- Any rule listening on `approval.approved` can mutate the deal — discount, stage, whatever. Configurable per tenant.
- No schema migration needed (uses existing `AutomationRule.targetState` JSON + `ApprovalRequest`).

**Effort:** ~3 hours. **Files:** `backend/cron/workflowEngine.js`, `backend/routes/approvals.js`, `backend/routes/workflows.js`.

---

### [ ] #20 — Workflow rule conditions
**Diagnosis:** `AutomationRule` has no `condition` column. Every rule fires on every matching event — "fire only if status=Lead" is impossible.
**Recommendation:** Add `condition String? @db.Text` JSON column to `AutomationRule`. Format: `[{field: "deal.amount", op: "gt", value: 50000}]` — array of clauses, AND-joined. Operators: `eq, neq, gt, gte, lt, lte, in, contains`. Engine evaluator is ~30 lines in `workflowEngine.js`. UI builder later.

**Effort:** ~3 hours + 1 schema migration. **Files:** `backend/prisma/schema.prisma`, `backend/cron/workflowEngine.js`, `backend/routes/workflows.js`. Prerequisite for productionizing #1.

---

### [ ] #12 — SLA breach cron + event
**Diagnosis:** No cron checks for breach. `breached` flag is computed on-read from `slaResponseDue < now()`. Reports/notifications/automations cannot subscribe to a "ticket just breached" event because none is emitted.
**Recommendation:** Add a 5-minute cron (mirror `appointmentRemindersEngine` pattern). Query `where: { slaResponseDue: { lt: now }, firstResponseAt: null, breached: false }`. Flip `breached: true` and emit `sla.breached` event. Add `breached Boolean @default(false)` column. Then existing workflow rules can react.

**Effort:** ~3 hours + 1 schema migration. **Files:** `backend/cron/slaBreachEngine.js` (new), `backend/server.js` (mount the cron), `backend/prisma/schema.prisma`, `backend/routes/sla.js`.

---

### [ ] #17 (remaining 3 of 6 dead workflow triggers)
**Status:** `deal.stage_changed`, `ticket.created`, `invoice.paid` shipped (commits c214099, _<pending>_).
**Still dead:** `contact.updated`, `task.completed`, `lead.converted`. Each is a 1-line `emitEvent` in the corresponding route. Lower demand — wire when a real rule needs them.

**Effort:** ~30 min for all 3 when needed. **Files:** `backend/routes/contacts.js`, `backend/routes/tasks.js`, `backend/routes/leads.js` (or wherever lead conversion lives).

---

## 🔴 Bigger investments — multi-day, may need legal/compliance signoff

### [ ] #21 — Clinical artefact soft-delete
**Diagnosis:** No DELETE for Patient/Visit/Prescription/ConsentForm/AgentRecommendation. Bug reports want delete capability; current state forces out-of-band SQL.
**Compliance constraint:** HIPAA + India MoHFW EMR rules generally REQUIRE permanent retention with amendment trail. Hard delete is forbidden. Need legal/compliance signoff before ANY engineering work.
**Recommendation if approved:** Add `deletedAt DateTime?` column to all 5 models. Every read query in `wellness.js` filters `deletedAt: null`. New `DELETE` endpoints set `deletedAt = now()`, write an audit row first, restrict to ADMIN. Add `POST /:id/restore` for un-delete (still ADMIN-only). Soft-delete preserves the audit trail; legal should accept this.

**Effort:** ~2 days + schema migration + every wellness.js findMany updated. **Blocker:** legal signoff.

---

### [ ] #7 — Sequence reply detection
**Diagnosis:** `sequenceEngine.js` never reads inbound EmailMessage rows. Replies don't pause drips. Customer replies, drip keeps firing.
**Recommendation:** Wait for #20 (conditions) to land first. Then:
- Mailgun inbound webhook should already exist at `/api/email/inbound` — verify.
- Engine watches for inbound EmailMessage rows whose `threadId` starts with `seq-` (the threadId convention shipped in commit c214099 via gap #10). When matched, look up enrollment by parsed enrollment id, set `status='Paused'`.
- Configurable per rule via condition: `pauseOnReply: true | false`.

**Effort:** ~1-2 days. **Prerequisite:** #20.

---

## 🚫 Don't patch — rethink

### [ ] #9 — Sequences ignore EmailTemplate; ReactFlow canvas is half-baked
**Diagnosis:** `sequenceEngine.js processNode()` synthesises hard-coded fake emails (`from: 'system@crm.com'`, body: "This is an automated drip email…"). No link to `EmailTemplate` rows. The ReactFlow canvas allows the user to design steps, but whatever they design is ignored at send time. Also missing: condition branches, A/B, drop-out tracking.
**Recommendation:** Don't patch. Rebuild the drip experience around an explicit step-list referencing `EmailTemplate` rows (which exist + already have variable interpolation). 1-2 weeks. Sets up clean foundation for #7 (reply detection) and unifies with the existing email template system.

**Effort:** ~1-2 weeks. **Trigger:** when a customer wants a real drip campaign.

---

## 🟫 Architectural cron-skipped issues (filed by the tester / Sumit overnight)

These were filed during cron runs and tagged `[cron-skip]` because they need design / schema / human review. Each links to a GitHub issue.

- [ ] **#167** Cross-resource hard-delete cleanup (Contacts, Deals, Estimates, Tasks). Same class as #122 (already fixed for invoices via soft-void). Plan: adopt the soft-void pattern across these 4 resources. Schema migration: `deletedAt` column on each. Frontend list endpoints filter `deletedAt: null`.
- [x] ~~**#176** `POST /api/contacts/:id/attachments` always 500. Multer config missing or wrong mime handler. Needs file-upload investigation.~~ **Closed in d00ac2f** — root cause was unguarded req.body destructure with no multer middleware; route now validates JSON {filename, fileUrl} shape, returns 400 UNSUPPORTED_CONTENT_TYPE for multipart (multer wiring deferred).
- [ ] **#179** Audit log only records Deal events. Need to wire `prisma.auditLog.create` calls in contacts/patients/invoices/estimates/tasks/pipelines/notifications/profile/destructive-deletes. ~2 days; tedious but mechanical.
- [x] ~~**#180** No JWT revocation. 7-day tokens are not revocable; no logout endpoint, no session listing.~~ **Closed in 5d9d47a** — RevokedToken model added, jti minted on every login (register/signup/login/2fa-verify), verifyToken checks the table on every request, fail-open on DB error so a Prisma blip doesn't lock everyone out. New endpoints: POST /auth/logout, GET /auth/sessions, DELETE /auth/sessions/:jti. Backwards compat: pre-deploy tokens (no jti claim) keep working until natural 7d expiry — no forced re-login.
- [x] ~~**#182** SMS queue stuck — 25 messages QUEUED with no provider configured.~~ **Closed in 5d9d47a** — POST /api/sms/drain (ADMIN). resolveProviderConfig() picks SmsConfig row first then env-var fallback (MSG91 → Twilio → Fast2SMS). No provider → fail-fast all QUEUED rows to FAILED with reason. *Follow-up*: per-tenant 1-min trickle cron (out of scope; admin drain + fail-fast closes the silent-accumulation bug for now).
- [x] ~~**#184** `/survey/:id` customer-facing route broken: blank content, shows admin sidebar to logged-in users.~~ **Closed in 5d9d47a** — backend GET/POST /api/surveys/public/:id (in openPaths), frontend SurveyPublic.jsx mounted OUTSIDE the authenticated Layout (no sidebar). Wellness theme cascades via `data-vertical="wellness"`.
- [x] ~~**#186** No security headers. Missing CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS, Permissions-Policy. `helmet` is mounted but underconfigured. ~30 min + check no inline scripts break.~~ **Closed in d00ac2f** — Helmet now sets HSTS / SAMEORIGIN / Referrer-Policy / nosniff / CORP same-site / baseUri+formAction 'self'. New `permissionsPolicyMiddleware` for camera/mic/geo/FLoC. imgSrc https-only in prod. unsafe-inline/unsafe-eval retained on scriptSrc — TODO for strict-CSP migration in a follow-up once SSR/nonce pipeline lands.
- [x] ~~**#190** Deal stage data migration. Existing rows with stage='Lead' (capitalized) cannot be PUT-updated after the validator was tightened.~~ **Closed in d00ac2f** — `backend/scripts/migrate-deal-stage-lowercase.js` is idempotent, coerces capitalized + suffixed + whitespace variants, clips negative amounts to 0. Production run: 32 deals scanned, 1 unmappable ('NotARealStage') logged, no neg amounts.
- [x] ~~**#191** Login rate limiting. Currently 30 wrong-password attempts in 3.2s all return 403 with no throttling. Add `express-rate-limit` per-IP-per-username on `/auth/login`.~~ **Closed in d00ac2f** — two stacked limiters on `POST /auth/login`: per-IP (5/15min, IPv6-safe via `ipKeyGenerator`) + per-username (10/1h keyed on email lowercase+trim, with noemail:<ip> fallback). `skipSuccessfulRequests` so legitimate fat-finger flows refund the slot. `standardHeaders: 'draft-7'` emits RateLimit-* + Retry-After. `/auth/2fa/verify` intentionally untouched.

---

## 🧪 Test debt

- [ ] **2 deep-flow specs still failing**:
  - `approvals-flow.spec.js:195` — deal create returns 500 inside `test.describe.serial` even though manual curl returns 201. Needs investigation; possibly a race with the workflow rule audit insert or a test fixture state issue.
  - `sequences-flow.spec.js:187` — "step 1 (Welcome) email must be materialised" assertion. After gap #10 fix (threadId on synthesized emails), the email IS in /email-threading/threads, but the assertion's parsing of the response shape doesn't catch it. Test-side fix.

- [ ] **41 pre-existing e2e failures** from the full-suite run on 2026-04-26 (`theme.spec`, `navigation.spec` sidebar/back-button, `audit-log`, `email-templates`, `notifications`, `pipeline-stages`, `pdf-export`, `csv-import`, `dashboard` percentage badges). Most are tests pinning old behavior (UI flow drift); a few may be real route contract drift. Not blocking — pass rate is 93%.

---

## 📋 Test infrastructure

- [ ] Add a backend coverage tool. Currently we have ~93% e2e pass rate but no real line coverage. Wire `c8` to instrument `pm2` on the dev server to get a coverage % during e2e runs. ~3 hours.
- [ ] `e2e/global-teardown.js` says "mysql2 not installed — skipping scrub." E2E rows tagged `E2E_FLOW_<ts>` are accumulating. `cd e2e && npm i -D mysql2` and re-test.

---

## 📜 PRD gap analysis (vs `docs/wellness-client/PRD.md` v1)

Status of each PRD section relative to what's actually shipped. Cross-checked against the route code on 2026-04-26.

### ✅ Mostly done (PRD intent met)
- **6.1 Patient & clinical** — Patient/Visit/Prescription/ConsentForm/TreatmentPlan/ServiceConsumption all live. PDF rx + branded invoice via `pdfRenderer.js`. Field encryption opt-in via `WELLNESS_FIELD_KEY`.
- **6.2 Service catalog & geo-targeting** — Service.targetRadiusKm + ticketTier shipped. Bounds tightened today (#209: max ₹50L price, max 480 min duration).
- **6.3 Booking & appointments** — Public booking page (`/book/:slug`), Calendar by doctor, status FSM (#197), SMS reminders T-24h/T-1h via `appointmentRemindersEngine`.
- **6.5 Callified cross-link** — Sidebar link + External Partner API at `/api/v1/external/*` with X-API-Key auth (16 handlers).
- **6.6 AdsGPT cross-link** — Sidebar link only. PRD explicitly says no data integration.
- **6.7 AI orchestration agent** — `orchestratorEngine.js` daily 07:00 IST → AgentRecommendation cards → Approve/Reject (state machine tightened in #195).
- **6.9 Reporting & franchise readiness** — P&L by service / per-professional / per-location / attribution. Multi-tenant via `Tenant.vertical = wellness`.
- **8. Branding & UX** — Wellness theme (teal/blush/cream), medical iconography, glassmorphism preserved.
- **9. Data model** — All 9 new models live. (PRD-listed `AdsGptCampaign`/`AdsGptCreative` correctly NOT built per the 6.6 scope clarification.)
- **10. Permissions** — ADMIN/MANAGER/USER + `User.wellnessRole` soft-role flag.

### ⚠️ Real gaps (engineering action needed)

- [ ] **PRD 6.4 — Lead-side SLA timer**: PRD says "first response in <5 min for high-ticket services". The SLA engine I worked on today is ticket-side (Ticket model). Lead-side SLA — does it exist? Verify; if not, build a `LeadSla` policy or extend the existing one to cover Lead model (`firstResponseDueAt` on Lead).
- [ ] **PRD 6.7 — Orchestrator depth**: "100% occupancy this week" / "maximize ROAS" / "zero missed leads" goals from PRD §6.7. Verify the engine actually computes occupancy gap → recommends ad budget → drafts campaign, vs being a single-recommendation stub. May need expansion.
- [ ] **PRD 6.8 — No-shows risk widget**: Listed in "today's snapshot" alongside appointments/revenue/occupancy. Check if Owner Dashboard renders a no-show prediction; likely stub.
- [ ] **PRD 11 — Audit log on patient record reads**: PRD requires "Audit log on every read of a patient record". Currently audit only covers Deal events (deferred gap #179). Wire `prisma.auditLog.create` calls in the Patient/Visit/Prescription/ConsentForm GET handlers.
- [ ] **PRD 14.3 — Demo: AdsGPT push to Meta**: PRD says "mocked OK if API not live". Verify the demo flow actually surfaces a creative or stub.
- [ ] **PRD 14.4 — Demo: WhatsApp chatbot booking → real appointment**: Requires Callified.ai webhook to be live end-to-end. Verify the integration ties an inbound WhatsApp lead to a CRM Appointment row.

### 🚧 Pending external/client deliverables (not engineering blocked)

- [ ] **PRD 6.5 + 6.6 — Silent SSO provisioning**: AdsGPT + Callified silent user provisioning + "Back to CRM" links. PRD says "tomorrow" but external teams haven't shipped.
- [ ] **PRD 7 — Superphone + Zylu CSV migration**: One-time data import. Waiting on client to provide CSV exports.
- [ ] **PRD 6.10 — Android app Play Store resubmission**: Needs Rishu's Aadhaar/PAN photos before resubmit. Per memory, still pending from client.
- [ ] **PRD 8 — Logo + brand assets**: Client to provide; placeholder wordmark live.

### ❓ PRD open questions (12.x — for the client, not engineering)

These are flagged in PRD §12 — track but don't act:

1. Brand assets ownership
2. AdsGPT API access
3. Hosting domain choice (`crm.globusdemos.com` subpath vs `app.enhancedwellness.in`)
4. Inventory CSV from client
5. Superphone + Zylu data export
6. Payment gateway preference (Razorpay confirmed in commercials section, but PRD §12 still flags)
7. Android dev continuity

---

## 📐 Conventions established this week

These are decisions made during the deep-flow audit that should be applied consistently:

1. **State machine error codes:** terminal-status transitions return `422` with `code: "INVALID_<RESOURCE>_TRANSITION"`. Idempotent re-applies return `200` with `{ idempotent: true }`. (Pattern: approvals, recommendations, visits.)
2. **Auth-gate consistency:** routes meant to be public must be in `server.js openPaths` array; otherwise the global guard returns 403, not 401, before the route's own middleware runs.
3. **Validator location:** shared validators live in `backend/lib/validators.js`. Per-route validators inline in route file with a comment referencing the GitHub issue number.
4. **Webhook bodies:** `express.urlencoded({ extended: true })` is mounted globally. Twilio/Mailgun/Razorpay webhooks send form-encoded bodies — they are parsed.
5. **Soft-delete pattern (when shipped):** never hard-delete user-facing rows. Set status field (e.g. `VOIDED`, `Unenrolled`) or `deletedAt` column. Audit row written first, then mutation.
6. **Event bus:** every state-changing route should `emitEvent(type, payload, tenantId, req.io)` after the mutation. Event names use `noun.verb` (e.g. `deal.stage_changed`, `invoice.paid`, `approval.approved`). Add to `TRIGGER_TYPES` in `workflows.js`.
7. **Test-data names:** all fixtures use realistic Indian names (Priya Sharma, Arjun Patel, Vikram Mehta, etc.). No "E2E Test User" placeholders. Tag every created row `E2E_<purpose>_<timestamp>` for the global-teardown scrubber.
