# System Test Plan

**Status:** Plan — execution pending
**Owner:** TBD
**Last updated:** 2026-05-03

---

## 1. Purpose

This document defines the **system-test layer** for the Globussoft CRM: what counts as a system test, where it sits relative to existing layers, what scenarios must be covered, and how the layer should be operated.

Execution (writing the specs, building the harness) is out of scope here — this is a contract for the engineer who picks that work up.

---

## 2. Test pyramid in this repo

| Layer | What it tests | Tooling | Where it lives | Runs when |
|---|---|---|---|---|
| **Unit** | Single function/module, all externals mocked | vitest | [backend/test/](../backend/test/), [frontend/src/__tests__/](../frontend/src/__tests__/) | Every push (`unit_tests` gate) |
| **API/contract** | One HTTP route against running backend + real DB | Playwright `request` | `e2e/tests/*-api.spec.js` | Every push (`api_tests` gate) |
| **UI/E2E** | One feature exercised through the React app in a real browser | Playwright `page` | `e2e/tests/*.spec.js` (non-`-api`) | On tag push (`e2e-full.yml`) |
| **System** *(this doc)* | ≥3 subsystems exercised together via a realistic user journey, with cross-module side-effects asserted | Playwright (request + page), in-process provider stubs, controlled clock | `e2e/tests/system/*.spec.js` (proposed) | Nightly + on tag (proposed) |

A test belongs in the **system** layer if and only if all of the following are true:

1. It exercises **three or more subsystems** (e.g. routes + cron + event bus + notification service + email provider).
2. The journey is **realistic**: a single actor (or a small cast of actors) doing something a real user would do, end-to-end.
3. **Cross-module side-effects** are explicitly asserted — not just "the API returned 200". Examples: an audit row was written, an SMS was queued in the stub, a dashboard widget reflects the new state, a workflow rule fired and created a task, a PDF landed on disk.
4. The DB is real and the backend is real. Only **true third-party network endpoints** are stubbed (Twilio, Mailgun, Stripe, WhatsApp Cloud, Gemini).
5. Browser participation is required when the journey crosses UI; pure backend orchestration journeys (cron → email → webhook) may run headless.

Tests that don't meet all five belong in a lower layer. Do not bloat the system layer with single-route assertions or single-page smoke tests.

---

## 3. Cross-cutting infrastructure

These are prerequisites the system-test layer needs before specs can be written productively. They are **infrastructure decisions**, not per-spec concerns — landing them once unblocks all scenarios in §4.

### 3.1 Controlled clock

Cron engines, sequences, SLA timers, recurring invoices, and reminder windows cannot be tested in real wall-clock time. The harness needs:

- A `TEST_CLOCK` env flag that, when set, replaces `Date.now()` and `new Date()` in cron schedulers and time-window queries with a controllable value.
- A test-only authenticated endpoint (e.g. `POST /api/test/advance-clock { ms }`) gated behind `NODE_ENV=test` + a separate `TEST_HARNESS_KEY` so it cannot exist in prod.
- A test-only endpoint to **manually invoke** a named cron engine once (`POST /api/test/run-cron { name }`), so specs don't have to wait for the next scheduled tick.

### 3.2 In-process provider stubs

Every external comms/payment provider needs a deterministic in-process fake the test harness can boot alongside the backend:

- **SMTP** — fake server that captures sent mail and exposes it via a query endpoint.
- **Twilio (SMS + Voice)** — captures sends, simulates delivery webhooks on demand.
- **WhatsApp Cloud API** — captures template sends, simulates inbound replies.
- **Stripe + Razorpay** — captures checkout creation, simulates `payment_intent.succeeded` webhook on demand.
- **Mailgun** — same shape as SMTP fake but exercises the Mailgun-specific API path.
- **Gemini (AI)** — returns deterministic canned responses keyed by prompt fingerprint, so AI-driven specs aren't flaky.
- **IMAP** — fake mailbox for inbound email threading specs.
- **Web push** — captures dispatched payloads.

The backend should wire these via env-var-driven base URLs (`SMS_PROVIDER_URL`, `STRIPE_API_BASE`, etc.) so swapping is config-only.

### 3.3 Per-spec tenant isolation

Each system test seeds its own throwaway tenant with a unique slug (`sys-<uuid>`) and tears down by tenant ID at the end. This makes the layer **safely parallelizable** and avoids ordering dependencies between specs. Helpers needed:

- `createSystemTenant({ vertical, currency, locale, seed: 'minimal' | 'full' })`
- `destroyTenant(tenantId)` — cascading delete across all 114 models.
- `loginAs(tenantId, role | wellnessRole)` — returns an authenticated Playwright context.

### 3.4 Tagging and CI placement

- All system specs live under `e2e/tests/system/` and are tagged `@system` in the spec title.
- A new Playwright project `system` runs only those specs.
- CI: **not** in the per-push deploy gate (too slow). Run nightly via a new workflow (`system-tests.yml`) and on every release tag inside `e2e-full.yml`. Failures open a tracker issue (mirroring `demo-monitor.yml`'s pattern).

### 3.5 Realistic data

Per project standing rule: real-looking names + scenarios, never `E2E Test User` placeholders. System specs should use the same naming taxonomy as the planned realistic-data refactor — patient names like "Asha Patel", deals like "Acme Logistics renewal Q3", etc.

### 3.6 What is explicitly out of scope for system tests

- Single-route correctness → contract layer.
- Single-page render correctness → UI/E2E layer.
- Pure logic (formatters, validators, encryption helpers) → unit layer.
- Load/performance benchmarks → separate perf suite (not yet built; see §6).
- Visual regression → not in scope; orthogonal concern.

---

## 4. Scenarios by domain

For each domain below: **journey** (what the actor does), **subsystems crossed**, **side-effects asserted** (the load-bearing checks), and **existing coverage** (cite a file if there's a partial start).

Coverage tags: ✅ already covered · 🟡 partially covered · 🔴 gap.

---

### 4.1 Tenant lifecycle & isolation 🔴

**Journey A — Signup to first value (generic).** Anonymous user signs up → tenant provisioned with USD + en-US + `vertical=generic` defaults → email verification → first login → lands on `/dashboard` → sees full enterprise sidebar → creates first contact → contact persists.

**Journey B — Signup to first value (wellness).** Same flow with `vertical=wellness` selected → tenant provisioned with INR + en-IN → first login → lands on `/wellness` → sees slim wellness sidebar → wellness theme applied (`[data-vertical="wellness"]` on body, teal palette).

**Journey C — Cross-tenant isolation sweep.** Tenant A seeds one row in each of N high-value models (Contact, Deal, Invoice, Patient, Visit, AuditLog, Notification, Webhook, Workflow, ScheduledEmail, …). Tenant B logs in and hits the corresponding `GET /api/...` list endpoints — every list returns zero rows from Tenant A. Direct-ID fetches return 404 (not 403).

**Journey D — 2FA enrollment + login.** User enrolls TOTP → logs out → next login requires the correct TOTP → wrong code is rejected → recovery code path works once.

**Journey E — SSO + SCIM provisioning.** SAML round-trip from a stub IdP → user lands authenticated → SCIM POST creates a second user with the right role → both can log in.

**Subsystems:** auth, tenants, RBAC, theming, sidebar layout, all CRUD route families.

**Side-effects to assert:** correct landing route, correct sidebar item count per vertical, correct currency on rendered pages, correct theme attribute on `<body>`, zero leakage on every isolation probe, audit rows for SSO + 2FA events.

**Existing:** none at the system level. `wellness.spec.js` smokes some of this but doesn't sweep isolation.

---

### 4.2 Sales pipeline — the canonical CRM journey 🔴

**Journey.** Inbound web form lead → lead-routing rule assigns to rep by territory → rep gets in-app + email notification → rep converts lead to contact → opens a deal → moves deal through 5 pipeline stages → workflow rule on entering "Negotiation" creates a task + sends an email → deal closed-won → invoice auto-generated → Stripe checkout link sent → checkout completed (stub) → payment webhook marks invoice paid → revenue recognized → dashboard "MRR this month" widget reflects the new payment → AI deal-insight cron summarizes the win and surfaces it on the rep's dashboard.

**Subsystems:** lead routing, contacts, deals, pipelines, workflows, sequences, notifications, email, billing, payments (Stripe), accounting sync, dashboards, AI insights, audit.

**Side-effects to assert:** notification row + email captured by stub; task created with correct due date; pipeline stage history written; invoice line items match deal value; Stripe session created with correct currency; webhook handled idempotently (replay does not double-pay); dashboard widget query returns the new total; deal-insight row exists with non-empty summary; audit log shows every state transition.

**Existing:** 🔴 zero end-to-end coverage. Individual pieces have contract specs.

---

### 4.3 Customer support full loop 🔴

**Journey.** Inbound email arrives at support@ (stub IMAP) → ticket auto-created → SLA policy starts the response timer → routing rule assigns by territory → assigned CSR sees ticket in shared inbox → CSR replies → email threading keeps the reply on the same conversation → KB article suggested by AI → ticket marked resolved → CSAT survey dispatched → respondent submits score → survey response stored → agent report reflects the CSR's CSAT delta.

**Subsystems:** email inbound + threading, tickets, SLA, lead routing, shared inbox, KB suggestions, AI, surveys, reports, notifications, audit.

**Side-effects to assert:** ticket SLA timer increments; SLA breach event fires correctly when clock advanced past the threshold; shared inbox shows correct unread count per CSR; reply email captured by SMTP stub with correct headers/threading; CSAT score persists and rolls into agent report aggregates.

**Existing:** 🔴 none end-to-end. `sla-flow.spec.js` covers a slice.

---

### 4.4 Marketing → revenue attribution 🔴

**Journey.** Marketer builds a segment → creates a campaign with email + SMS variants → AB test set up with 2 subject lines → campaign dispatched → tracking pixels return on open → click-through recorded → AB winner picked at end of window → recipient becomes a lead → converts to deal → deal closed-won → attribution report credits the originating campaign.

**Subsystems:** marketing, campaigns, AB tests, email, SMS, web visitors, attribution, tracking, leads, deals, reports.

**Side-effects to assert:** open-tracking pixel call updates `EmailTracking` row; AB variant selection deterministic given fixed seed; attribution row links revenue back to campaign ID; report aggregates are correct across multi-touch attribution.

**Existing:** 🔴 contract-only.

---

### 4.5 Wellness clinical journey 🟡 (deepen existing)

**Journey A — Walk-in to repeat-visit.** New patient walks in → consent signed via canvas → PHI fields encrypted at rest → visit logged → diagnosis entered → Rx PDF generated and stored → inventory deducted from `ServiceConsumption` → invoice in INR → loyalty credit applied → patient given portal OTP → patient logs into portal → sees Rx + invoice → recall scheduled → appointment-reminder cron queues T-24h + T-1h SMS → wellness-ops cron sends NPS survey at T+72h → patient responds → score on owner dashboard.

**Journey B — Telecaller to converted patient.** Marketplace lead arrives → junk filter passes → router assigns to telecaller → SLA timer visible → telecaller exercises each of the 6 dispositions across separate runs → "qualified" path converts lead to patient → first visit booked.

**Journey C — Multi-clinic isolation.** Doctor at Location A queries patients → sees only Location A patients. Owner queries → sees both. Switch user to Location B doctor → sees only Location B.

**Journey D — Public booking.** Anonymous visitor hits `/book/:slug` → submits booking → patient + visit row created → confirmation email + SMS dispatched (captured by stubs) → tenant owner notified.

**Subsystems:** patients, visits, prescriptions (PDF + encryption), consents, inventory, billing, loyalty, portal, appointment reminders cron, wellness-ops cron, surveys, junk filter, auto-router, telecaller queue, SLA, public booking, locations, notifications.

**Side-effects to assert:** PHI fields encrypted in DB row, decrypted on authorized read, returned redacted to unauthorized roles; PDF file written and parseable; inventory row decremented atomically (no race); loyalty credit row matches invoice total × rate; SMS reminders queued exactly once per visit (idempotent); NPS sent exactly at 72h ± harness tolerance; cross-location query returns zero rows for unauthorized doctor.

**Existing:** 🟡 [wellness-clinical-journey-flow.spec.js](../e2e/tests/wellness-clinical-journey-flow.spec.js), [wellness-real-user-journeys.spec.js](../e2e/tests/wellness-real-user-journeys.spec.js), [wellness-phi-audit.spec.js](../e2e/tests/wellness-phi-audit.spec.js). Closest to true system tests in the repo today. Gaps: cron-driven reminder + NPS verification, multi-location isolation, PDF content assertion.

---

### 4.6 Communication delivery (real side-effects) 🔴

**Journey A — Email round-trip.** Outbound email sent from CRM → captured by SMTP stub → delivery webhook simulated → tracking row updated → reply arrives via stub IMAP → email threading attaches reply to original conversation → notification fires.

**Journey B — SMS lifecycle.** SMS dispatched → captured by Twilio stub → delivery receipt simulated → `SmsMessage.status` flips through queued → sent → delivered.

**Journey C — WhatsApp two-way.** Template message sent → stub captures → inbound reply simulated → conversation row created → notification bell pings the recipient over Socket.io in real-time (verified in a second browser context).

**Journey D — Voice + transcription.** External API POSTs a call → CallLog created → transcript PATCHed 30s later (clock-advanced) → linked to contact → workflow rule on a keyword in the transcript fires.

**Journey E — Web push.** Browser subscribes → notification dispatched → stub receives payload with correct VAPID claims.

**Subsystems:** email + email-inbound + email-threading, SMS, WhatsApp, voice + voice-transcription, push, notifications, workflows, Socket.io, audit.

**Side-effects to assert:** message captured by correct stub with correct payload; delivery status transitions are recorded; threading associates reply with original `Conversation`/`EmailMessage`; Socket.io event observed in second context; workflow rule fires from transcript keyword.

**Existing:** 🔴 partial — `wellness-sms.spec.js`, `eventbus-emit.spec.js` cover narrow API-level slices but no provider-stub round-trip.

---

### 4.7 Cron engines under simulated time 🔴

For each of the 19 engines, a system spec that: (a) seeds the precondition, (b) advances the clock to the trigger window, (c) invokes the engine via the test-only endpoint, (d) asserts the side-effects, (e) re-runs the engine and asserts idempotency.

| Engine | Precondition | Side-effect to assert | Idempotency check |
|---|---|---|---|
| leadScoringEngine | 5 leads with mixed signals | scores recomputed, only changed rows touched | second run is a no-op |
| sequenceEngine | enrollment at step 0, interval = 1d | step 1 executes after clock+1d, not before | re-run within window does not re-fire step 1 |
| marketplaceEngine | 3 mock IndiaMART leads (1 dup, 1 spam, 1 clean) | clean lead created + routed; dup deduped; spam rejected | re-poll same payload creates nothing |
| workflowEngine | rule + matching event | rule action fires (task/email/webhook) | event replay does not double-fire |
| campaignEngine | scheduled campaign at T | dispatched at T, not before | re-tick does not re-dispatch |
| reportEngine | scheduled report | report generated + emailed | re-tick does not regenerate within window |
| recurringInvoiceEngine | active subscription, month-end | invoice created with correct prorating | re-run same day does not duplicate |
| forecastSnapshotEngine | open deals | weekly snapshot row written | re-run same week does not duplicate |
| dealInsightsEngine | deal with activity | insight row generated | re-run within 6h is a no-op |
| sentimentEngine | unprocessed comm rows | sentiment scored | re-run skips already-scored |
| scheduledEmailEngine | email scheduled at T | sent at T ± 1min, not before | re-run does not re-send |
| retentionEngine | rows older than policy | rows deleted, audit retained with PII redacted | re-run is a no-op |
| backupEngine | trigger | mysqldump file on disk, size > threshold | re-run creates new timestamped file (not idempotent by design — verify naming) |
| orchestratorEngine | wellness tenant with data | recommendation cards on owner dashboard | re-run replaces, does not duplicate |
| appointmentRemindersEngine | visit booked T+24h | T-24h SMS queued exactly once | re-run does not re-queue |
| wellnessOpsEngine | visit at T-72h | NPS survey sent | re-run skips already-surveyed |

**Subsystems:** every cron engine + downstream (notifications, email, SMS, AI, billing, audit).

**Existing:** 🔴 zero. Cron engines are completely untested at the journey level today.

---

### 4.8 Document & e-signature 🔴

**Journey.** Admin creates a contract template with merge fields → contract generated from a deal (fields populated from `Deal` + `Contact`) → sent for signature → signer receives email → opens browser link → signs in canvas → signed PDF stored → audit trail written → all parties notified → `DocumentView` records every open along the way.

**Subsystems:** document templates, signatures, deals, contacts, email, PDF rendering, document tracking, notifications, audit.

**Side-effects to assert:** generated PDF contains the merged values (parse-and-grep); signed PDF includes the signature image; `SignatureRequest.status` transitions correctly; `DocumentView` rows for every open with timestamp; notifications to all parties.

**Existing:** 🔴 contract-only.

---

### 4.9 External Partner API end-to-end 🟡

**Journey A — Callified.ai inbound.** Partner POSTs `/api/v1/external/calls` with X-API-Key → CallLog row → workflow rule on `call.created` fires → in-app notification → late PATCH adds transcript → sentiment cron processes → contact timeline reflects the call + sentiment.

**Journey B — AdsGPT lead.** Partner POSTs `/api/v1/external/leads` → junk filter → auto-router → assigned rep notified → SLA timer visible in CRM UI.

**Journey C — Globus Phone softphone.** Partner POSTs inbound call answered → CallLog created → notes attached via PATCH → contact updated.

**Journey D — Key revocation.** Mid-flow, admin revokes the API key → next partner request returns 401 → audit row written.

**Subsystems:** external auth, partner routes, contacts, leads, workflows, notifications, sentiment cron, audit.

**Side-effects to assert:** `req.user` aliasing works (tenantWhere helpers correctly scope); workflow rule sees the partner-originated event; revocation effective immediately (no cache staleness window).

**Existing:** 🟡 `wellness.spec.js` exercises the external API. Not at full journey depth.

---

### 4.10 Approvals & business policy 🟡

**Journey.** Sales rep applies a discount above the configured threshold → approval request created → manager notified → manager approves (or rejects) → outcome notification → deal updated with applied discount or reverted → audit row for the decision.

**Subsystems:** approvals, deals, notifications, audit, workflows (the rule that triggers the approval).

**Side-effects to assert:** approval row state machine transitions correctly; deal not updated until approval lands; rejection path leaves deal unchanged; audit captures approver identity + decision.

**Existing:** 🟡 [approvals-flow.spec.js](../e2e/tests/approvals-flow.spec.js).

---

### 4.11 Real-time (Socket.io) 🔴

**Journey A — Cross-user pipeline update.** Two browsers, two users in same tenant. User A creates a deal → User B's pipeline view reflects the new deal without refresh. User A moves the deal a stage → User B's column counts update.

**Journey B — Notification bell.** User A @-mentions User B in a deal note → User B's notification bell increments + toast shown without refresh.

**Journey C — Presence.** User A logs out → User B's presence indicator for User A flips to offline within N seconds.

**Subsystems:** Socket.io, notifications, deals, presence, auth.

**Side-effects to assert:** events received in the second browser context within a tolerance window; no events leak to a third browser logged in as a different tenant.

**Existing:** 🔴 zero. Socket.io is exercised only incidentally.

---

### 4.12 Compliance & security as journeys 🔴

**Journey A — GDPR data export.** User submits export request → `DataExportRequest` created → background job compiles all PII across models → download link emailed → file contains the expected sections (contacts, deals, comms, audit excerpts) and nothing from other tenants.

**Journey B — Right-to-erasure.** User submits erasure → cascading deletes across all PII-bearing models → audit rows preserved with PII fields redacted (not deleted) → re-query confirms no PII recoverable.

**Journey C — Field-level permission.** Doctor `GET /patients/:id` includes Rx field; telecaller's same call returns the Rx field stripped. Same row, two roles, two payload shapes.

**Journey D — Cross-tenant probe.** Token from Tenant A + ID from Tenant B → 404 (not 403, to avoid existence disclosure). Verify across 5+ resource families.

**Journey E — Rate limit.** 5,001 requests in 15min from one IP → 429 returned → rate-limit window resets after 15min (clock-advanced).

**Journey F — XSS probe.** Submit `<script>alert(1)</script>` into a rich-text field → stored sanitized → rendered safe in UI (verify in browser DOM, not just response body).

**Journey G — JWT tamper.** Modify one byte of a valid token → 401 → audit row written for the failed auth attempt.

**Subsystems:** GDPR, audit, field permissions, rate limiting, security middleware, sanitize-html, auth.

**Side-effects to assert:** export file contents; cascade completeness (no orphans); 404 vs 403 distinction; rate-limit math correct; sanitization stripped script tags; audit row on tamper.

**Existing:** 🔴 contract-only on most; no journey assertions on the export file contents or sanitization-in-rendered-DOM.

---

### 4.13 Financial multi-currency 🔴

**Journey.** Tenant in INR creates a quote → CPQ prices it in INR → estimate PDF shows ₹ formatting consistently → converted to invoice in INR → Stripe charge in INR → payment recorded in INR → dashboard aggregates payment correctly when other tenants on the platform are in USD/EUR (no cross-currency contamination in widgets).

**Subsystems:** quotes, CPQ, estimates, invoices, payments (Stripe), currencies, locale formatting, dashboards, PDF rendering.

**Side-effects to assert:** every monetary string in UI + PDF + email matches `formatMoney(amount, tenant.defaultCurrency, tenant.locale)`; Stripe session amount in smallest currency unit; dashboard query filters by tenant before aggregating.

**Existing:** 🔴 none.

---

### 4.14 Disaster paths 🔴

**Journey A — Health check + rollback.** Backend killed mid-deploy → `/api/health` returns red → deploy workflow rolls back to `HEAD~1` → next health check green → traffic served from rolled-back version. (Verify by harness, not by triggering a real deploy.)

**Journey B — DB connection drop.** Drop DB connection mid-request → backend returns 503 (not crash) → connection pool reconnects on DB restore → next request succeeds.

**Journey C — Sentry capture.** Force an uncaught error in a test-only route → Sentry stub receives the event with the right tags → audit row written.

**Subsystems:** health, deploy hooks, DB pool, Sentry, audit.

**Side-effects to assert:** correct HTTP codes during failure modes; no process crash (PM2 still alive); Sentry payload shape matches expected schema.

**Existing:** 🔴 none.

---

### 4.15 Vertical-specific theme & UX 🟡

**Journey A — Wellness tenant.** Login as wellness user → `[data-vertical="wellness"]` on `<body>` → teal palette applied → slim wellness sidebar (~25 items) → lands on `/wellness`.

**Journey B — Generic tenant.** Login as generic user → no `data-vertical` attribute → default theme → full enterprise sidebar (50+ items) → lands on `/dashboard`.

**Journey C — Add a new vertical (smoke).** Add a third vertical value (e.g. `gym`), seed a tenant, verify the fallthrough renders without crashing even before the gym-specific sidebar/theme exist. Guards against regressions when verticals proliferate.

**Subsystems:** auth, tenants, theming, sidebar layout, routing.

**Side-effects to assert:** body attribute, computed styles on key elements (sidebar bg color), sidebar item count, post-login redirect target.

**Existing:** 🟡 partial in `wellness.spec.js`.

---

## 5. Coverage matrix (subsystems × domains)

A grid of "is there at least one system test that exercises subsystem X in the context of domain Y" — to be filled in as specs land. Initial state is mostly red; each landed spec turns one or more cells green. The matrix should be regenerated from spec metadata (a `@subsystems: ...` tag in the spec title) so it does not rot.

The owning engineer should produce this matrix as the first artifact after the harness is in place — it becomes the source of truth for what is left to write.

---

## 6. Roll-out plan (priority order)

The 15 domains are not equally valuable. Recommended order:

| # | Domain | Why first |
|---|---|---|
| 1 | §3 cross-cutting infra (clock, stubs, tenant fixtures, tagging, CI placement) | Nothing else can be written productively without these |
| 2 | §4.1 Tenant lifecycle & isolation | Catches the highest-blast-radius bugs (data leakage); informs every other spec |
| 3 | §4.5 Wellness clinical journey (deepen) | Closest to existing coverage; easiest to extend; highest-revenue customer |
| 4 | §4.2 Sales pipeline canonical journey | Core CRM promise; currently zero end-to-end coverage |
| 5 | §4.7 Cron engines under simulated time | 19 engines with zero journey coverage today; highest-leverage gap |
| 6 | §4.6 Communication delivery | Provider stubs unlock a lot once built |
| 7 | §4.12 Compliance & security as journeys | High consequence on failure; compliance ask is growing |
| 8 | §4.11 Real-time | Recurring source of "works in dev, broken in prod" bugs |
| 9 | §4.3 Customer support full loop | Standalone journey; can land independently |
| 10 | §4.9 External Partner API | Already partially covered; deepening is incremental |
| 11–15 | Remaining domains | Order by current pain or upcoming product priorities |

A reasonable first milestone: **infra + §4.1 + §4.5 deepening** lands as a proof-of-pattern (1–2 weeks). Each subsequent domain is then ~3–5 days of work for one engineer.

---

## 7. Open questions for the executing engineer

These are decisions deferred to whoever picks this up. Document the choices made in this file when they're made.

1. **Clock library** — write our own time facade, or adopt `@sinonjs/fake-timers` server-side? Tradeoff: facade is invasive but explicit; sinon is drop-in but harder to reason about across async boundaries.
2. **Stub-server hosting** — single Node process exposing all stubs on different ports, or a separate process per provider? Single is simpler to start; per-process scales better as stubs grow.
3. **Tenant teardown depth** — soft-delete with periodic hard-delete sweep, or hard-cascade on every spec? Hard-cascade is cleaner but requires a maintained "delete in order" function across 114 models.
4. **CI runtime budget** — what's the acceptable nightly runtime for the system suite? This caps how parallel the harness needs to be (and how many tenants to seed in parallel).
5. **Failure-mode tests (§4.14)** — keep in the system suite, or split into a dedicated chaos/resilience suite? They have different infrastructure needs (forced kills, network partitions).

---

*End of plan.*
