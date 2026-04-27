# Sandbox Infrastructure — External Integrations & Long-Running Jobs

> **Issue #137 closed by laying foundation; full sandbox is a multi-day follow-up.**
> See the inventory and stubs below. The mock servers in `backend/scripts/sandbox/`
> and the harness pattern in `e2e/sandbox-harness.md` are skeletons — they are
> intentionally not wired into CI or the default E2E run.

---

## Why this exists

QA passes (cron-skipped + overnight) routinely shrug off two whole classes of
bugs because the supporting infra isn't there:

1. **External integrations** — outbound calls hit real third-party APIs (Stripe,
   Mailgun, WhatsApp Cloud, etc.) so tests either short-circuit on missing creds
   or accidentally bill real money. Inbound webhooks (Callified, Globus Phone,
   Razorpay/Stripe) are simulated by hand-written `request()` calls inside spec
   files; nobody exercises the real payload shape.
2. **Long-running cron jobs** — 19 engines under `backend/cron/` only fire on a
   real wall-clock schedule. CI runs with `DISABLE_CRONS=1`, so anything that
   only manifests after a tick (sequence advance, marketplace lead pull,
   forecast snapshot, retention purge) is effectively untested end-to-end.

A "sandbox" here means: a parallel set of fake services + fixture data + manual
cron triggers that lets QA run a deterministic full-loop test without external
network or wall-clock dependencies.

---

## Section 1 — External integrations inventory

### 1a. Inbound webhooks (third party → CRM)

| Partner | Endpoint(s) | Auth | Real today? | Sandbox should provide |
|---|---|---|---|---|
| **Callified.ai** (voice / transcription / WhatsApp) | `POST /api/v1/external/leads`, `POST /api/v1/external/calls`, `PATCH /api/v1/external/calls/:id` (late transcript), `POST /api/v1/external/messages` | `X-API-Key: glbs_…` (ApiKey model) | Real key + real Callified instance. Demo key seeded in `seed-wellness.js`. | Outbound mock that posts canned lead/call/message payloads on demand. Confirms junk filter + auto-router fire. |
| **Globus Phone** (softphone) | `POST /api/v1/external/calls`, `PATCH /api/v1/external/calls/:id` | `X-API-Key: glbs_…` | Real key. Same `/calls` endpoint as Callified, distinguished by `provider:"globus-phone"`. | Mock that emits `INITIATED → RINGING → CONNECTED → COMPLETED` state-machine events. |
| **Stripe** | `POST /api/payments/stripe/webhook` (signature-verified) | Stripe webhook signature | Real Stripe test mode. | Local mock that signs payloads with the test secret + replays `payment_intent.succeeded`, `invoice.payment_failed`, etc. |
| **Razorpay** | `POST /api/payments/razorpay/webhook` | Razorpay webhook signature (HMAC-SHA256) | Real Razorpay test mode. | Same as Stripe — local signed-payload replayer. |
| **WhatsApp Cloud API** | `POST /api/whatsapp/webhook` (Meta verification + message events) | Meta verify token + `X-Hub-Signature-256` | Real Meta sandbox number. | Local mock that mirrors Meta's verification handshake + fires `messages`, `statuses` events. |
| **Mailgun inbound** | `POST /api/email/inbound` | Mailgun signature | Real Mailgun route. | Local mock that posts a multipart form mimicking a parsed inbound email. |
| **Google Calendar / Outlook push** | `POST /api/calendar/google/webhook`, `POST /api/calendar/outlook/webhook` | Google channel ID / Outlook subscription ID | Real OAuth + push subscription on the dev box. | Local mock that posts a `sync` notification; CRM then polls back. Polling target also needs a mock (see 1b). |

### 1b. Outbound API calls (CRM → third party)

| Partner | Direction | Where in code | Auth | Sandbox should provide |
|---|---|---|---|---|
| **AdsGPT** (ads creative push + silent SSO impersonation) | Outbound | `backend/cron/orchestratorEngine.js` (budget-bump task), `routes/integrations.js` (silent SSO) | Bearer token + impersonation JWT signed with shared secret | Mock campaign-create endpoint that returns a fake campaign ID + stubbed "back to CRM" URL. |
| **Mailgun outbound** | Outbound | `backend/services/` (via Nodemailer transport) | API key + domain | Mailgun-shaped mock that 200s and records what was "sent" to a JSON log so tests can assert. |
| **Twilio** (SMS + Voice) | Outbound | `backend/services/smsProvider.js`, `telephonyProvider.js` | Account SID + auth token | Twilio-shaped mock for `Messages.create` + `Calls.create`. |
| **Fast2SMS / MSG91** | Outbound | `backend/services/smsProvider.js` (config-selected) | API key | Mock 200 OK + record. |
| **WhatsApp Cloud (outbound)** | Outbound | `backend/services/whatsappProvider.js` | Meta token + phone number ID | Mock `messages` POST. |
| **Google Calendar / Outlook OAuth + sync** | Outbound | `backend/routes/calendar_google.js`, `calendar_outlook.js` | OAuth refresh token | Mock OAuth token endpoint + `events.list` + `events.insert`. |
| **Stripe / Razorpay** (creating payment intents, refunds) | Outbound | `backend/routes/payments.js` | Secret key | Use Stripe + Razorpay test keys against local Stripe-mock / Razorpay-mock if those exist; otherwise plain HTTP mock. |

### 1c. Auth mechanisms summary

- **External Partner API** (`/api/v1/external/*`): `X-API-Key: glbs_…`, validated
  against the `ApiKey` Prisma model in `middleware/externalAuth.js`. Aliases
  `req.user` so `tenantWhere()` keeps working downstream.
- **Webhooks (Stripe / Razorpay / WhatsApp / Mailgun)**: per-provider signature
  verification, generally HMAC over the raw request body with a shared secret
  stored in env.
- **OAuth (Google / Outlook)**: refresh-token + access-token flow per tenant,
  tokens stored encrypted on the user/tenant record.

---

## Section 2 — Long-running jobs that need sandbox coverage

### 2a. Cron engines (19 total)

The engines live in `backend/cron/`. CRM boots with `DISABLE_CRONS=1` in CI, so
none of them tick. Each needs:

1. A **trigger** (admin endpoint or direct module import + call).
2. **Fixture data** that's clearly junk-flagged so it gets cleaned up.
3. An **assertion** that the side-effect landed (DB row created, notification
   queued, etc.).

| Engine | File | Schedule | Side effect to assert | E2E coverage today |
|---|---|---|---|---|
| Lead Scoring | `leadScoringEngine.js` | every 10 min | `Contact.aiScore` updated | partial (scoring spec tests synchronous path) |
| Sequence | `sequenceEngine.js` | every 1 min | `SequenceEnrollment.currentStep` advances; outbound message queued | yes (`sequences-flow.spec.js`) |
| Marketplace | `marketplaceEngine.js` | every 5 min | new `Contact` rows from IndiaMART/JustDial/TradeIndia | partial (`marketplace-leads.spec.js` — webhook only, not poll) |
| Workflow | `workflowEngine.js` | event-driven | rule fires, action queued | yes (`workflows-flow.spec.js`) |
| Campaign | `campaignEngine.js` | every 5 min | `CampaignRecipient` status moves to SENT | **none** |
| Report | `reportEngine.js` | hourly + daily | `ScheduledReport.lastRunAt` + emailed PDF | partial (`report_schedules.spec.js` — schedule create only) |
| Recurring Invoice | `recurringInvoiceEngine.js` | daily | new `Invoice` row | **none** |
| Forecast Snapshot | `forecastSnapshotEngine.js` | weekly | `ForecastSnapshot` row | partial (`forecasting.spec.js` covers UI, not snapshot) |
| Deal Insights | `dealInsightsEngine.js` | every 6 hr | `DealInsight` rows | partial (`deal_insights.spec.js`) |
| Sentiment | `sentimentEngine.js` | every 15 min | `Contact.sentiment` updated | partial (`sentiment.spec.js`) |
| Scheduled Email | `scheduledEmailEngine.js` | every 1 min | queued email moves to SENT | **none** |
| Retention | `retentionEngine.js` | daily 03:00 | rows deleted per GDPR config | **none** |
| Backup | `backupEngine.js` | daily 02:00 | `mysqldump` artifact written | **none** |
| Orchestrator | `orchestratorEngine.js` | daily 07:00 IST | `OwnerDashboardCard` rows generated | yes (`wellness-orchestrator-depth.spec.js`) |
| Appointment Reminders | `appointmentRemindersEngine.js` | every 15 min | `WhatsAppMessage` / `SmsMessage` queued | **none** |
| Wellness Ops | `wellnessOpsEngine.js` | hourly | NPS surveys queued, junk leads purged | **none** |
| Lead SLA | `leadSlaEngine.js` | every 5 min | breach notification queued | partial (`lead-sla.spec.js`) |
| SLA Breach (ticket) | `slaBreachEngine.js` | every 5 min | ticket SLA breach flagged | partial (`sla-flow.spec.js`) |
| Low Stock | `lowStockEngine.js` | hourly | low-stock notification | **none** |

**E2E gap summary:** 8 engines have no E2E coverage at all
(campaign, recurringInvoice, scheduledEmail, retention, backup,
appointmentReminders, wellnessOps, lowStock). Several others cover only the
config UI, not the engine tick.

### 2b. Pattern needed

See `e2e/sandbox-harness.md` for the documented pattern. Short version:

```
DISABLE_CRONS=1 → seed fixture → POST /api/admin/cron/<engine>/run
                → wait for completion → assert DB state
```

The admin `cron/run` endpoint **does not exist yet**. Adding it is part of the
follow-up work.

---

## Section 3 — Mock servers (skeletons)

Three mock servers are stubbed under `backend/scripts/sandbox/`:

- `callified-mock.js` — port 5101 — accepts the same payloads Callified would
  push to the CRM and lets you POST to `/simulate/lead`, `/simulate/call`,
  `/simulate/message` to forward to your local CRM.
- `adsgpt-mock.js` — port 5102 — pretends to be the AdsGPT campaign-create API.
  Returns a fake campaign ID and impersonation back-link.
- `globusphone-mock.js` — port 5103 — pretends to be Globus Phone, can drive a
  `/simulate/call-lifecycle` that walks INITIATED → RINGING → CONNECTED →
  COMPLETED states against the CRM's `/api/v1/external/calls` endpoint.

Operator-driven only (no auto-start, no PM2). See
[`backend/scripts/sandbox/README.md`](../../backend/scripts/sandbox/README.md).

---

## Section 4 — What a future "real sandbox" pass would still need

1. **Wire the mock servers into E2E.** Either spawn them in
   `e2e/playwright.config.js` `globalSetup`, or run them under a
   `docker-compose.sandbox.yml`.
2. **Build the cron harness.** Specifically:
   - Admin endpoint `POST /api/admin/cron/:engine/run` that accepts a
     superuser JWT and invokes the engine's exported `run()` function.
     Already partially scaffolded in some engines (orchestrator, sequence) —
     others export only the cron handle.
   - Test helpers in `e2e/tests/helpers/cron.js` that POST to that endpoint.
   - One spec per uncovered engine (8 specs).
3. **Stripe / Razorpay signed-payload helper.** Sign with the test secret in
   env so the webhook signature middleware accepts the replay.
4. **Mailgun / Twilio / WhatsApp outbound capture.** Replace the provider
   modules' transports with a sandbox-only "log to file" transport when
   `SANDBOX=1`. Then assert against the log in tests.
5. **OAuth fake.** A 50-line Express server that issues Google/Outlook-shaped
   tokens for a hardcoded test user.
6. **CI integration.** A separate GitHub Actions job (`sandbox-e2e`) that runs
   only the sandbox-tagged specs nightly, with all mocks running.

---

## Section 5 — Risks

- **Mock drift.** The mocks here are hand-written from observed payload
  shapes, not from a partner-published OpenAPI spec. They will drift as
  Callified/AdsGPT/Globus Phone change their APIs. Mitigation: pin a contract
  test once partners publish schemas; until then, refresh the mocks every time
  a partner ships.
- **False green.** A test that passes against a mock but fails against the
  real partner is worse than no test. Need an explicit "partner-live"
  smoke-test pass that runs against actual sandboxes once a week.
- **Webhook signature replay.** If we generate signed Stripe payloads in
  test, the same secret needs to live in the test env — easy to leak. Use
  test-only secrets, never reuse live ones.
- **Cron idempotency assumptions.** Some engines assume "we won't be invoked
  twice in the same minute". Manually triggering them via an admin endpoint
  may surface bugs that only ever existed in production but happen to be
  benign there. That's actually a feature, not a risk — but worth flagging
  so the first triggered run is reviewed.
- **Fixture cleanup.** If sandbox-seeded data isn't tagged
  (`tenantId = 'sandbox'` or `source = 'sandbox-mock'`), it'll bleed into
  prod-like demo databases and confuse the next QA pass.

---

_Last updated: 2026-04-27 — closes #137 by establishing the foundation._
