# Test Coverage Gaps — 2026-05-06 audit

> **⚠️ Snapshot is 2026-05-06. Counts and item-status are stale (8+ days
> of active work since).** Before picking up any card here:
>
> 1. Run [`.claude/skills/verifying-issue-before-pickup/SKILL.md`](../.claude/skills/verifying-issue-before-pickup/SKILL.md) — many cards have shipped since the audit.
> 2. Cross-check the [README.md "At a glance" table](../README.md) for current spec / vitest file counts.
> 3. E2E_GAPS.md (G-1..G-25) is **fully closed** as of 2026-05-14 — archived
>    under [docs/gaps/archive/](gaps/archive/). The G-XX system this doc
>    cross-references is therefore historical.
>
> **Phantom-carry-over warning** ([CLAUDE.md standing rule](../CLAUDE.md#standing-rules-for-new-code-do-not-skip-these)): 7+ confirmed instances where TODOS / gap-doc rows
> were dispatched on already-shipped scope. Verify before dispatch.

> **Audience:** any dev / agent who wants to grab a coverage gap and ship it.
> **Snapshot date:** 2026-05-06 (stale — see warning above)
> **Companions:** [TODOS.md](../TODOS.md), [docs/gaps/archive/](gaps/archive/) for closed parent backlogs.
> **Source of truth at snapshot time:** 68 `*-api.spec.js` + 42 vitest files. **Current counts:** see [README.md](../README.md).

## Why this doc exists

The G-XX backlog ([E2E_GAPS.md](./E2E_GAPS.md)) is essentially closed — only **G-21 frontend RTL setup** remains. A full audit on 2026-05-06 surfaced four NEW classes of gap that the G-XX backlog never tracked:

| Class | Count | Section |
|---|---|---|
| Backend routes with NO partner API spec | 46 of 92 (50%) | [Section A](#section-a--backend-route--api-spec-gaps) |
| Cron engines with NO vitest | 9 of 19 (47%) | [Section B](#section-b--cron-engine-vitest-gaps) |
| Frontend pages with NO component test | 94 of ~97 (97%) | [Section C](#section-c--frontend-coverage-g-21-expansion) |
| Entire test categories that don't exist at all | 11 (5 absent + 6 partial) | [Section D](#section-d--missing-test-categories) |

This doc is designed to be picked from top-down by parallel-agent waves (per the [`dispatching-parallel-agent-wave`](../.claude/skills/dispatching-parallel-agent-wave/SKILL.md) skill) and individual closer agents.

---

## How to pick a task

1. Scan the **Master priority backlog** below and grab the first unblocked card.
2. Each card has: ID, target file, spec name to create, effort, risk tier, pattern to copy, acceptance criteria.
3. Per [CLAUDE.md "Standing rules for new code"](../CLAUDE.md#standing-rules-for-new-code-do-not-skip-these): every new `*-api.spec.js` MUST be wired into BOTH [deploy.yml](../.github/workflows/deploy.yml) AND [coverage.yml](../.github/workflows/coverage.yml). Use the [`wiring-spec-into-gate`](../.claude/skills/wiring-spec-into-gate/SKILL.md) skill.
4. Every new `backend/lib|middleware|services|cron` module needs a vitest under `backend/test/<area>/<module>.test.js`. Use the [`writing-vitest-unit-test`](../.claude/skills/writing-vitest-unit-test/SKILL.md) skill.
5. PR title format: `test(<area>): <short>` — e.g. `test(payments): add Stripe + Razorpay api spec`.
6. Mark the card ✅ in the table when merged + add commit SHA.

## Pre-reqs (read once before starting)

- [ ] [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) — the gate-spec list. Every new spec lands here.
- [ ] [.github/workflows/coverage.yml](../.github/workflows/coverage.yml) — mirror the gate-spec list.
- [ ] [e2e/tests/notifications-api.spec.js](../e2e/tests/notifications-api.spec.js) — reference pattern for CRUD + auth + tenant scoping.
- [ ] [e2e/tests/wellness-clinical-api.spec.js](../e2e/tests/wellness-clinical-api.spec.js) — reference for wellness-tenant test setup.
- [ ] [backend/test/cron/recurringInvoiceEngine.test.js](../backend/test/cron/recurringInvoiceEngine.test.js) — reference vitest for cron engines (real Prisma where possible, not pure mocks).
- [ ] [.claude/skills/](../.claude/skills/) — 10 reusable skills that encode the patterns. Especially `writing-api-gate-spec`, `writing-vitest-unit-test`, `wiring-spec-into-gate`, `verifying-issue-before-pickup`, `dispatching-parallel-agent-wave`.

---

## Master priority backlog

| ID | Target | Type | Effort | Risk if skipped | Status |
|---|---|---|---|---|---|
| **API-1** | `routes/admin.js` | api spec | 3-4h | High — admin-only gate validation; blast radius across tenants | ⬜ open |
| **API-2** | `routes/auth_2fa.js` | api spec | 4-6h | High — 2FA enrollment/disable; account-takeover surface | ⬜ open |
| **API-3** | `routes/payments.js` | api spec | 6-8h | High — Stripe/Razorpay flows + webhook signing already in `stripe-webhook.test.js`, route CRUD untested | ⬜ open |
| **API-4** | `routes/signatures.js` | api spec | 4-6h | High — e-signature contract + signed-document audit trail | ⬜ open |
| **API-5** | `routes/scim.js` | api spec | 4-6h | High — enterprise SSO user provisioning; cross-tenant risk | ⬜ open |
| **API-6** | `routes/sso.js` | api spec | 4-6h | High — SSO config + login surface | ⬜ open |
| **API-7** | `routes/email_inbound.js` | api spec | 3-4h | High — webhook ingestion (Mailgun/SendGrid); often unauthenticated | ⬜ open |
| **API-8** | `routes/marketplace_leads.js` | api spec | 3-4h | High — webhook ingestion from IndiaMART/JustDial/TradeIndia (unauthenticated per server.js global guard exception) | ⬜ open |
| **API-9** | `routes/developer.js` | api spec | 3-4h | High — API key creation/revocation; auth bypass surface | ☑ shipped — e2e/tests/developer-api.spec.js |
| **API-10** | `routes/sandbox.js` | api spec | 2-3h | High — destructive admin tooling (snapshot/restore) | ⬜ open |
| **API-11** | `routes/calendar_google.js` | api spec | 3-4h | Med — OAuth flow + token storage | ⬜ open |
| **API-12** | `routes/calendar_outlook.js` | api spec | 3-4h | Med — OAuth flow + token storage | ⬜ open |
| **API-13** | `routes/calendar.js` | api spec | 2-3h | Med — calendar event CRUD | ⬜ open |
| **API-14** | `routes/zapier.js` | api spec | 3-4h | Med — third-party webhook fan-out | ⬜ open |
| **API-15** | `routes/whatsapp.js` | api spec | 3-4h | Med — WhatsApp Cloud API send + webhook | ⬜ open |
| **API-16** | `routes/telephony.js` | api spec | 3-4h | Med — click-to-call (MyOperator/Knowlarity) | ⬜ open |
| **API-17** | `routes/voice.js` | api spec | 2-3h | Med — voice session CRUD | ⬜ open |
| **API-18** | `routes/chatbots.js` | api spec | 3-4h | Med — conversational AI surface | ⬜ open |
| **API-19** | `routes/live_chat.js` | api spec | 3-4h | Med — chat widget + session | ⬜ open |
| **API-20** | `routes/staff.js` | api spec | 3-4h | Med — generic-tenant user mgmt; RBAC layer | ⬜ open |
| **API-21** | `routes/approvals.js` | api spec | 3-4h | Med — workflow approvals state machine | ⬜ open |
| **API-22** | `routes/audit_viewer.js` | api spec | 2-3h | Med — compliance read surface | ⬜ open |
| **API-23** | `routes/email_templates.js` | api spec | 2-3h | Med — template CRUD | ⬜ open |
| **API-24** | `routes/email_scheduling.js` (route CRUD) | api spec | 2-3h | Med — cron engine has spec, route layer does not | ⬜ open |
| **API-25** | `routes/ai.js` | api spec | 3-4h | Med — Gemini integration; prompt-injection surface | ⬜ open |
| **API-26** | `routes/sentiment.js` | api spec | 2-3h | Med — AI sentiment analysis | ⬜ open |
| **API-27** | `routes/data_enrichment.js` | api spec | 2-3h | Med — third-party enrichment | ⬜ open |
| **API-28** | `routes/shared_inbox.js` | api spec | 3-4h | Med — collaborative inbox | ⬜ open |
| **API-29** | `routes/support.js` | api spec | 2-3h | Med — help widget | ⬜ open |
| **API-30** | `routes/tickets.js` | api spec | 3-4h | Med — support-ticket CRUD | ⬜ open |
| **API-31** | `routes/playbooks.js` | api spec | 2-3h | Low — sales playbook automation | ⬜ open |
| **API-32** | `routes/quotas.js` | api spec | 2-3h | Low — KPI/quota mgmt | ⬜ open |
| **API-33** | `routes/pipelines.js` | api spec | 2-3h | Low — pipeline config | ⬜ open |
| **API-34** | `routes/pipeline_stages.js` | api spec | 2-3h | Low — stage config | ⬜ open |
| **API-35** | `routes/dashboards.js` | api spec | 2-3h | Low — dashboard layout CRUD | ⬜ open |
| **API-36** | `routes/custom_reports.js` | api spec | 2-3h | Low — custom report builder | ⬜ open |
| **API-37** | `routes/funnel.js` | api spec | 2-3h | Low — funnel analytics | ⬜ open |
| **API-38** | `routes/win_loss.js` | api spec | 2-3h | Low — win/loss reasons | ⬜ open |
| **API-39** | `routes/web_visitors.js` | api spec | 2-3h | Low — visitor tracking | ⬜ open |
| **API-40** | `routes/deals_documents.js` | api spec | 2-3h | Low — deal-attached docs | ⬜ open |
| **API-41** | `routes/document_views.js` | api spec | 2-3h | Low — document tracking | ⬜ open |
| **API-42** | `routes/industry_templates.js` | api spec | 2-3h | Low — config templates | ⬜ open |
| **API-43** | `routes/currencies.js` | api spec | 2-3h | Low — currency config | ⬜ open |
| **API-44** | `routes/territories.js` | api spec | 2-3h | Low — territory mgmt | ⬜ open |
| **API-45** | `routes/tenants.js` | api spec | 3-4h | Low — tenant CRUD (admin-only) | ⬜ open |
| **API-46** | `routes/sla.js` (CRUD layer) | api spec | 2-3h | Low — sla-breach engine has spec, policy CRUD does not | ⬜ open |
| **CRON-1** | `cron/workflowEngine.js` | vitest | 4-6h | High — automation backbone, event-driven core | ☑ shipped — test/cron/workflowEngine.test.js |
| **CRON-2** | `cron/sequenceEngine.js` | vitest | 4-6h | High — drip sequences (sequence-engine-api spec exists for trigger; logic untested) | ☑ shipped — test/cron/sequenceEngine-wellness-triggers.test.js |
| **CRON-3** | `cron/reportEngine.js` | vitest | 3-4h | High — scheduled report generation + email dispatch | ☑ shipped — test/cron/reportEngine.test.js |
| **CRON-4** | `cron/marketplaceEngine.js` | vitest | 3-4h | Med — IndiaMART/JustDial/TradeIndia polling logic | ☑ shipped — test/cron/marketplaceEngine.test.js |
| **CRON-5** | `cron/scheduledEmailEngine.js` | vitest | 3-4h | Med — engine logic (api spec covers trigger only) | ☑ shipped — test/cron/scheduledEmailEngine.test.js |
| **CRON-6** | `cron/dealInsightsEngine.js` | vitest | 3-4h | Med — AI insight gen (api spec covers trigger only) | ☑ shipped — test/cron/dealInsightsEngine-tick.test.js |
| **CRON-7** | `cron/backupEngine.js` | vitest | 2-3h | Med — mysqldump invocation (api spec covers trigger only) | ☑ shipped — test/cron/backupEngine.test.js |
| **CRON-8** | `cron/lowStockEngine.js` | vitest | 2-3h | Low — inventory alerts (api spec covers trigger only) | ☑ shipped — test/cron/lowStockEngine.test.js |
| **CRON-9** | `cron/leadSlaEngine.js` | vitest | 2-3h | Low — lead SLA enforcement | ☑ shipped — test/cron/leadSlaEngine.test.js |
| **FE-1** | Frontend RTL setup + first 5 page tests | infra + tests | 3-5 days | Med — 94 of 97 pages untested at component level | ☑ shipped — 76 files in frontend/src/__tests__/; frontend_unit_tests is a mandatory deploy gate |
| **FE-2** | `components/Sidebar.jsx` | RTL test | 4-6h | Med — affects every page; nav failure silent | ⬜ open |
| **FE-3** | `components/Omnibar.jsx` | RTL test | 3-4h | Low — global search bar | ⬜ open |
| **FE-4** | `components/RouteErrorBoundary.jsx` | RTL test | 2-3h | Med — silent-fail surface for entire SPA | ⬜ open |
| **FE-5** | `components/Softphone.jsx` | RTL test | 3-4h | Low — voice integration UI | ⬜ open |
| **FE-6** | `utils/numberInput.jsx` | vitest | 1-2h | Low — used in invoice/quote/expense numeric inputs | ⬜ open |
| **CAT-1** | Visual regression (Playwright `toHaveScreenshot()` or Percy/Chromatic) | new category | 2-3 days | Med — glassmorphism UI drift goes undetected | ⬜ open |
| **CAT-2** | Performance / Lighthouse-CI | new category | 1-2 days | Med — no bundle-size or page-load SLAs | ⬜ open |
| **CAT-3** | Load / stress (k6 or autocannon) | new category | 2-3 days | Med — rate-limit middleware never load-tested | ⬜ open |
| **CAT-4** | OpenAPI / Swagger contract validation | new category | 2-3 days | High — `/api/v1/external/*` has third-party consumers (Callified.ai); breaking changes silent | ⬜ open |
| **CAT-5** | Mutation testing (Stryker.js, one-shot baseline) | new category | 1-2 days | Low — verifies tests would catch broken code | ⬜ open |
| **CAT-6** | Backup→restore round-trip in `backup-engine-api.spec.js` | category extension | 4-6h | Med — dump tested; restore never exercised | ⬜ open |
| **CAT-7** | Generic-tenant a11y suite (extend `wellness-a11y.spec.js` pattern) | category extension | 2-3 days | Med — only wellness has axe coverage | ⬜ open |
| **CAT-8** | Cron-engine real-DB integration (scheduler picks up + dispatches) | category extension | 2-3 days | Med — current vitests mock Prisma | ⬜ open |
| **CAT-9** | i18n / locale rendering tests (LanguageSwitcher → strings render) | new category | 1-2 days | Low — i18n surface exists; never tested | ⬜ open |
| **CAT-10** | Mobile / responsive viewport coverage (Playwright `devices` projects) | new category | 1-2 days | Low — `min(100%, 240px)` standing rule never exercised under viewport stress | ⬜ open |
| **CAT-11** | Multi-browser (firefox + webkit) | new category | 4-6h | Low — only chromium runs in CI | ⬜ open |

**Recommended first parallel batch (5 disjoint, P0-P1, no inter-spec collisions):** API-1, API-2, API-3, API-7, API-8. All security-critical, independent route files, no shared seed dependencies. Use [`dispatching-parallel-agent-wave`](../.claude/skills/dispatching-parallel-agent-wave/SKILL.md).

**Recommended second batch:** API-4, API-5, API-6, API-9, API-10 (auth/admin cluster).

**Recommended cron batch:** CRON-1, CRON-2, CRON-3 (high-traffic engines first; disjoint files; no rate-limit issues).

---

# Section A — Backend route → API spec gaps

## Pattern to copy for every API-XX card

**Reference spec:** [e2e/tests/notifications-api.spec.js](../e2e/tests/notifications-api.spec.js) (clean CRUD + auth gate + tenant scoping + dual-token + `_teardown_` cleanup).

**Standing rules every spec needs** (encoded in [`writing-api-gate-spec` skill](../.claude/skills/writing-api-gate-spec/SKILL.md)):
- JWT key is `userId` not `id`
- Body strips `id`/`createdAt`/`updatedAt`/`tenantId`/`userId` via global `stripDangerous`
- Header JSDoc with closes-issue list + standing-rule preamble
- `RUN_TAG` constant linked to [e2e/test-data-patterns.js](../e2e/test-data-patterns.js)
- `afterAll` cleanup with `_teardown_` prefix
- No `Co-Authored-By` in commits

**Default acceptance criteria for every API-XX card:**
- [ ] Each endpoint: happy path + 401 (no token) + 400 (bad input where applicable) + 404 (missing id)
- [ ] Tenant isolation: tenant A cannot read/update/delete tenant B's resource
- [ ] RBAC: USER cannot perform MANAGER-only ops; MANAGER cannot perform ADMIN-only ops
- [ ] Wired into `deploy.yml` AND `coverage.yml` spec lists
- [ ] If route writes to JSON-string columns ([standing rule on JSON-string columns](../CLAUDE.md#standing-rules-for-new-code-do-not-skip-these)), assert sanitization at the storage boundary

## Detailed cards (P0 — security-critical)

### ⬜ API-1 — admin-api spec
- **File:** `e2e/tests/admin-api.spec.js`
- **Route:** [backend/routes/admin.js](../backend/routes/admin.js)
- **Why first:** Admin-only routes have the largest blast radius. Any RBAC slip = cross-tenant data leak.
- **Cover:** Every endpoint exposed by admin.js. Identify each via `router.METHOD(...)` grep. Assert ADMIN-required, MANAGER+USER both 403.
- **Effort:** 3-4h

### ⬜ API-2 — auth-2fa-api spec
- **File:** `e2e/tests/auth-2fa-api.spec.js`
- **Route:** [backend/routes/auth_2fa.js](../backend/routes/auth_2fa.js)
- **Why:** 2FA enrollment/verify/disable is the account-takeover surface. The `auth-security-api.spec.js` exists but does NOT cover 2FA — confirm by grepping for `2fa` in that file.
- **Cover:** enroll → returns secret + QR; verify with valid TOTP → 200; verify with invalid → 401; disable requires password re-confirmation; recovery codes single-use.
- **Effort:** 4-6h

### ⬜ API-3 — payments-api spec
- **File:** `e2e/tests/payments-api.spec.js`
- **Route:** [backend/routes/payments.js](../backend/routes/payments.js)
- **Why:** Stripe/Razorpay payment intents + status transitions. Webhook signing is covered by `backend/test/integration/stripe-webhook.test.js` but the route CRUD is not.
- **Cover:** create payment intent (Stripe + Razorpay), status webhooks, refund flow, idempotency keys, tenant isolation on payment lookups.
- **Effort:** 6-8h
- **Blocker:** may need Stripe test-mode key in `.env`. If unavailable in CI, gate Stripe-specific cases on `STRIPE_TEST_KEY` env var.

### ⬜ API-4 — signatures-api spec
- **File:** `e2e/tests/signatures-api.spec.js`
- **Route:** [backend/routes/signatures.js](../backend/routes/signatures.js)
- **Why:** E-signature requests have legal/compliance weight. Tampering risk + signed-document audit trail.
- **Cover:** create signature request → emails sent (mock); recipient signs → audit trail entry; signed PDF generated (assert magic bytes); tenant isolation.
- **Effort:** 4-6h

### ⬜ API-5 — scim-api spec
- **File:** `e2e/tests/scim-api.spec.js`
- **Route:** [backend/routes/scim.js](../backend/routes/scim.js)
- **Why:** SCIM 2.0 user provisioning from enterprise IdPs. Cross-tenant provisioning bug = catastrophic.
- **Cover:** SCIM token auth (vs JWT), `/Users` POST/GET/PATCH/DELETE, `/Groups`, ETag handling, schema-conformant response shape, tenant scoping on the SCIM token.
- **Effort:** 4-6h

### ⬜ API-6 — sso-api spec
- **File:** `e2e/tests/sso-api.spec.js`
- **Route:** [backend/routes/sso.js](../backend/routes/sso.js)
- **Why:** SAML/OIDC config + login surface.
- **Cover:** SSO config CRUD (admin-only), SP metadata endpoint, IdP-initiated login flow simulation, tenant isolation on configs.
- **Effort:** 4-6h

### ⬜ API-7 — email-inbound-api spec
- **File:** `e2e/tests/email-inbound-api.spec.js`
- **Route:** [backend/routes/email_inbound.js](../backend/routes/email_inbound.js)
- **Why:** Webhook ingestion for inbound email. Likely unauthenticated (check global guard exceptions in `server.js`). DoS + spoof risk.
- **Cover:** valid Mailgun/SendGrid signature → ingested as EmailMessage; invalid signature → 401; oversized payload rejected; rate-limit fires; HTML sanitization on body.
- **Effort:** 3-4h

### ⬜ API-8 — marketplace-leads-api spec
- **File:** `e2e/tests/marketplace-leads-api.spec.js`
- **Route:** [backend/routes/marketplace_leads.js](../backend/routes/marketplace_leads.js)
- **Why:** Webhook ingestion from IndiaMART/JustDial/TradeIndia. **Confirmed unauthenticated** per `server.js` global guard exception list. Spoof = lead poisoning.
- **Cover:** valid provider payload → MarketplaceLead row; invalid payload → 400; provider mismatch → reject; phone normalization (per `utils/deduplication.js`) → existing contact deduped.
- **Effort:** 3-4h

### ⬜ API-9 — developer-api spec
- **File:** `e2e/tests/developer-api.spec.js`
- **Route:** [backend/routes/developer.js](../backend/routes/developer.js)
- **Why:** API key creation/revocation. Bypasses JWT auth; high blast radius.
- **Cover:** key create returns `glbs_…` plaintext once; subsequent GETs return masked; revoke kills the key (verify with X-API-Key request → 401); admin-only.
- **Effort:** 3-4h

### ⬜ API-10 — sandbox-api spec
- **File:** `e2e/tests/sandbox-api.spec.js`
- **Route:** [backend/routes/sandbox.js](../backend/routes/sandbox.js)
- **Why:** Snapshot/restore tooling is destructive admin surface. Wrong-tenant restore = data wipe.
- **Cover:** snapshot create (admin-only), list, restore requires `confirmDestructive:true` body guard (per existing pattern in [GDPR retention](../backend/routes/gdpr.js)), tenant isolation.
- **Effort:** 2-3h

## Bulk cards (P1-P3 — apply default pattern)

For API-11 through API-46, use the default acceptance criteria from [Pattern to copy](#pattern-to-copy-for-every-api-xx-card). Each file is independent; safe to dispatch in parallel waves of 4-5 (the disjoint-files invariant from [`dispatching-parallel-agent-wave`](../.claude/skills/dispatching-parallel-agent-wave/SKILL.md)).

**Notes on specific cards:**
- **API-11/API-12 (calendar OAuth):** OAuth flows are notoriously hard to test end-to-end. Mock the IdP token exchange; assert the token-storage path encrypts (uses `lib/fieldEncryption.js`).
- **API-15 (whatsapp):** WhatsApp Cloud API has signature verification on inbound webhooks; test signature validation explicitly.
- **API-25 (ai):** Gemini integration. Test prompt-injection on user-supplied input (e.g. lead notes that say "ignore prior instructions"). The route should sanitize OR neutralize control tokens.
- **API-45 (tenants):** Tenant CRUD is super-admin-only. Likely needs a bootstrap super-admin token outside normal seed; check seed.js.

---

# Section B — Cron engine vitest gaps

## Pattern to copy

**Reference test:** [backend/test/cron/recurringInvoiceEngine.test.js](../backend/test/cron/recurringInvoiceEngine.test.js) (real Prisma where possible, not pure mocks per the [`feedback_parallel_wave_discipline`](https://...) memory).

Per [`writing-vitest-unit-test`](../.claude/skills/writing-vitest-unit-test/SKILL.md) skill — mock external SDKs (Stripe, Mailgun, Twilio, Gemini), but keep Prisma real against the local stack DB where possible.

**Default acceptance for cron vitests:**
- [ ] Engine processes pending rows correctly (happy path)
- [ ] Idempotency: running twice doesn't double-process
- [ ] Tenant isolation: engine respects `tenantId` scoping
- [ ] Failure recovery: external SDK failure → row marked failed, not stuck pending
- [ ] State machine: status transitions match documented contract (e.g. `pending → sent / pending → failed`)

## Detailed cards

### ⬜ CRON-1 — workflowEngine vitest
- **File:** `backend/test/cron/workflowEngine.test.js`
- **Engine:** [backend/cron/workflowEngine.js](../backend/cron/workflowEngine.js)
- **Why first:** Event-driven automation backbone. Every workflow rule across the platform runs through this. The api-spec `workflows-api.spec.js` covers route CRUD; engine logic (rule evaluation, action dispatch) is untested in isolation.
- **Cover:** trigger event → matching rule fires; non-matching rule does not; action chain executes in order; failure on action N does not block action N+1; tenant scoping; cron-tick vs eventBus dispatch parity.
- **Effort:** 4-6h

### ⬜ CRON-2 — sequenceEngine vitest
- **File:** `backend/test/cron/sequenceEngine.test.js`
- **Engine:** [backend/cron/sequenceEngine.js](../backend/cron/sequenceEngine.js)
- **Why:** Drip-sequence step execution = customer-journey core. The `sequence-engine-api.spec.js` covers the trigger; step state machine is untested.
- **Cover:** enrollment → step 1 dispatched at scheduled time; conditional step (per `conditionJson` JSON-string column) evaluates correctly; pause/resume; unsubscribe halts further steps.
- **Effort:** 4-6h

### ⬜ CRON-3 — reportEngine vitest
- **File:** `backend/test/cron/reportEngine.test.js`
- **Engine:** [backend/cron/reportEngine.js](../backend/cron/reportEngine.js)
- **Why:** Scheduled report generation + email delivery. The `report-schedules-api.spec.js` covers route CRUD; engine generation logic is untested.
- **Cover:** scheduled report fires at correct cron-tick; metrics computed correctly; recipient list parsed from JSON-string column; email dispatched (mock Mailgun); failure on dispatch → schedule entry marked failed.
- **Effort:** 3-4h

### ⬜ CRON-4 — marketplaceEngine vitest
- **File:** `backend/test/cron/marketplaceEngine.test.js`
- **Engine:** [backend/cron/marketplaceEngine.js](../backend/cron/marketplaceEngine.js)
- **Why:** IndiaMART/JustDial/TradeIndia polling. Frequency: every 5 min — high cron-budget impact.
- **Cover:** poll happy path (mock provider); deduplication via phone normalization; provider error → retry/backoff; per-tenant API key scoping; idempotency on lead-id collision.
- **Effort:** 3-4h

### ⬜ CRON-5 through CRON-9
- **CRON-5** scheduledEmailEngine — engine logic (api spec exists for trigger only)
- **CRON-6** dealInsightsEngine — heuristic + Gemini fallback
- **CRON-7** backupEngine — mysqldump invocation; assert PII encryption on dump if `WELLNESS_FIELD_KEY` set
- **CRON-8** lowStockEngine — threshold semantics; idempotency
- **CRON-9** leadSlaEngine — SLA breach detection on leads (note: `slaBreachEngine` is a SEPARATE engine, already tested)

All follow the default acceptance pattern. Effort: 2-3h each.

---

# Section C — Frontend coverage (G-21 expansion)

This section EXPANDS the existing G-21 ("Frontend vitest + RTL setup + first 5 component tests") from [E2E_GAPS.md](./E2E_GAPS.md). G-21 is multi-day and not parallel-friendly until infrastructure decisions land.

## Current state

- ✅ vitest + jsdom + @testing-library/react + jest-dom installed (per `frontend/package.json`)
- ✅ 76 frontend vitest files exist (as of 2026-05-18)
- ✅ 8 of 12 components have RTL tests
- ✅ 11 of 13 utils/hooks have unit tests
- ❌ 94 of ~97 pages have ZERO component-level tests (only `OwnerDashboard`, `PatientDetail`, `Services` — all wellness)
- ❌ 4 of 12 components untested
- ❌ No Storybook
- ❌ No Percy/Chromatic
- ❌ No `axe`/`jest-axe` for generic CRM (wellness has `wellness-a11y.spec.js`)

## ⬜ FE-1 — RTL infrastructure + first 5 page tests

**Decisions needed before starting:**
- [ ] MSW vs `vi.mock('utils/api')` for API mocking? (Recommend MSW — closer to real shape.)
- [ ] React Router test wrapper helper (recommend a shared `frontend/src/test-utils.jsx` exporting `renderWithRouter`).
- [ ] Auth context wrapper helper (`renderWithAuth({ user: { role: 'ADMIN' } })`).

**First 5 pages to cover (highest-traffic, lowest-coupling):**
1. `pages/Login.jsx` — quick-login buttons render, submit happy path, 401 error path
2. `pages/Dashboard.jsx` — widgets render, filter by date range
3. `pages/Contacts.jsx` — list renders, search filters, role-based action visibility
4. `pages/Settings.jsx` — settings sections render per role
5. `pages/Inbox.jsx` — message list renders, detail modal opens (per `cd30f7a` consolidation)

**Effort:** 3-5 days (infra + 5 pages). Per [E2E_GAPS.md G-21](./E2E_GAPS.md).

## ⬜ FE-2 — Sidebar.jsx RTL test

- **File:** `frontend/src/components/Sidebar.test.jsx`
- **Why:** Affects every page; vertical-aware (generic vs wellness); RBAC-aware. Silent failure breaks navigation across the app.
- **Cover:** generic vertical → renders 50+ items; wellness vertical → renders ~25 items + provider integration chip row (per #437); RBAC: USER role hides admin items; active-route highlight; collapse/expand toggle.
- **Effort:** 4-6h

## ⬜ FE-3 — Omnibar.jsx, FE-4 — RouteErrorBoundary.jsx, FE-5 — Softphone.jsx, FE-6 — utils/numberInput.jsx

Default RTL acceptance: render without crashing, prop-driven branches all exercised, accessibility labels present (`aria-label` on interactive elements).

## Long-tail page rollout (after FE-1 lands)

After FE-1 establishes infra, the remaining 89 pages can be batched into parallel agent waves of 4-5 pages per wave. Recommended grouping by feature area to reduce mock collisions:

- **Wave 1 (Sales):** Pipeline, Pipelines, Forecasting, Quotas, Funnel
- **Wave 2 (Contacts):** Leads, Clients, LeadScoring, LeadRouting, Territories
- **Wave 3 (Marketing):** Marketing, Sequences, AbTests, Social, Chatbots
- **Wave 4 (Comms):** SharedInbox, LiveChat, Channels
- **Wave 5 (Financial):** Invoices, Estimates, Expenses, Contracts, Payments
- **Wave 6 (Service):** Tickets, Support, Surveys, KnowledgeBase, SLA
- **Wave 7 (Documents):** DocumentTemplates, DocumentTracking, Signatures
- **Wave 8 (Analytics):** Reports, AgentReports, CustomReports, Dashboards
- **Wave 9 (Admin):** Staff, Developer, AuditLog, Privacy, FieldPermissions, Sandbox
- **Wave 10 (Wellness):** Recommendations, Patients, PatientPortal, PublicBooking, Calendar, Locations, TelecallerQueue, Reports
- **Wave 11 (Wellness deep):** PerLocationDashboard, Inventory, Loyalty, Waitlist, the 7 PatientDetail tabs

Each wave: 1-2 days. Total: ~10-15 dev-days for full page coverage.

---

# Section D — Missing test categories

## Categories that are 100% ABSENT

### ⬜ CAT-1 — Visual regression
- **Why for this app:** Glassmorphism UI + 80 pages × 2 verticals (generic blue + wellness teal/blush) → CSS drift very easy to ship undetected. The v3.4.12 `--primary-color` fix (#489 #490 #491) was the canonical example: 12+ instances of off-brand purple shipped over months.
- **Recommended tool:** Playwright `toHaveScreenshot()` (free, in-tree) for the first wave. Upgrade to Percy or Chromatic later if review-on-PR workflow is wanted.
- **First targets:** Login (both verticals), Dashboard, Sidebar (both verticals), 5 most-touched wellness pages.
- **CI gate:** new `visual-regression.yml` workflow, run on PR + tag (NOT every push — runtime would balloon).
- **Effort:** 2-3 days for setup + first 10 snapshots.

### ⬜ CAT-2 — Performance / Lighthouse-CI
- **Why:** No frontend bundle-size or page-load SLAs. The React.lazy() code-splitting is in place but never measured.
- **Recommended tool:** `@lhci/cli` GitHub Action against deployed demo.
- **Budgets to enforce:** First Contentful Paint < 2s, Total JS < 500KB gzipped per lazy chunk, accessibility score ≥ 90.
- **CI gate:** new `lighthouse.yml` workflow, run on tag (e2e-full sibling).
- **Effort:** 1-2 days.

### ⬜ CAT-3 — Load / stress
- **Why:** Rate-limit middleware exists (5000 req/15min general, 1000 on auth). `auth-security-api.spec.js` tests login rate-limit but no general endpoint stress.
- **Recommended tool:** k6 or autocannon. Start with autocannon (single-binary, simpler).
- **Targets:** `/api/contacts` (50 concurrent for 30s), `/api/auth/login` (verify rate-limit fires), `/api/wellness/dashboard`.
- **CI gate:** nightly cron, NOT per-push. Capture p50/p95/p99 latency in artifact.
- **Effort:** 2-3 days.

### ⬜ CAT-4 — Contract validation (OpenAPI / Swagger)
- **Why CRITICAL for this app:** `/api/v1/external/*` is consumed by Callified.ai, AdsGPT, Globus Phone. Breaking changes go undetected until a sister product breaks. Internal Swagger spec exists at `/api-docs` — nothing asserts response shapes match it.
- **Recommended tool:** `dredd` or `schemathesis` against the Swagger doc. Or hand-rolled JSON Schema snapshot tests for `/api/v1/external/*` only.
- **Phase 1:** Lock the v1/external contract with snapshot tests. Phase 2: full Swagger validation.
- **Effort:** 2-3 days.

### ⬜ CAT-5 — Mutation testing (Stryker.js)
- **Why:** Verifies tests would CATCH broken code, not just that current code passes. The 2,468-test gate is large; some tests may be vacuous.
- **Recommended tool:** Stryker.js (`@stryker-mutator/core`).
- **Run:** one-shot baseline now → identify weakest 20 tests → fix → shelve until next big refactor. Not a continuous gate (too slow for per-push).
- **Effort:** 1-2 days (config + interpretation of report).

### ⬜ CAT-9 — i18n / locale rendering
- **Why:** `LanguageSwitcher.jsx` exists; nothing tests strings render in non-en locales. `Tenant.locale` (en-IN/en-US/etc.) drives `formatMoney()` and date helpers.
- **Recommended tool:** RTL render with i18n provider per locale; assert key strings present.
- **First targets:** Login, Dashboard, Pipeline (in en-IN, en-US, then any third locale shipped).
- **Effort:** 1-2 days.

### ⬜ CAT-10 — Mobile / responsive viewport
- **Why:** The `min(100%, 240px)` standing rule (W1-B in v3.4.12) was added because 1024px-only testing missed 375px breakage. Currently nothing exercises mobile viewports automatically.
- **Recommended tool:** Playwright `devices` projects (iPhone 12, iPad, Pixel 5).
- **First targets:** Sidebar collapse on narrow viewports, Pipeline kanban scroll, wellness PatientPortal (mobile-first surface).
- **Effort:** 1-2 days.

### ⬜ CAT-11 — Multi-browser
- **Why:** Only chromium runs in CI. Firefox + Safari/webkit drift uncaught.
- **Recommended:** Add `firefox` + `webkit` projects in `playwright.config.js`. Run them in `e2e-full.yml` (tag-only, NOT per-push) to keep gate fast.
- **Effort:** 4-6h.

## Categories that are PARTIAL (some exists, gap noted)

### ⬜ CAT-6 — Backup→restore round-trip
- **Status:** PARTIAL — `backup-engine-api.spec.js` (G-15) tests dump creation + PII-safety check; restore is never exercised.
- **Risk:** A backup that can't be restored is worthless. Discovered too late = lost data.
- **Cover:** dump → drop a row → restore → assert row reappears. Use a throwaway database in the spec.
- **Effort:** 4-6h. Extension to existing spec.

### ⬜ CAT-7 — Generic-tenant a11y
- **Status:** PARTIAL — `wellness-a11y.spec.js` covers wellness module with `@axe-core/playwright`. Generic CRM has zero a11y checks.
- **Recommended:** Mirror the wellness pattern for Login, Dashboard, Contacts, Pipeline, Settings.
- **Why:** WCAG compliance + enterprise procurement requirements often demand a11y proof.
- **Effort:** 2-3 days for first 5 generic pages.

### ⬜ CAT-8 — Cron-engine real-DB integration
- **Status:** PARTIAL — 10 cron engine vitests exist, but they mock Prisma. No end-to-end test of "scheduler ticks → engine picks up rows → dispatches" against a real DB.
- **Risk:** Mock/prod divergence (per the `feedback_realistic_test_data` memory and the v3.4.10 cron-skipped-no-rows finding).
- **Recommended:** Pick 1-2 highest-traffic engines (workflowEngine, sequenceEngine), boot a real local stack, fire the engine, assert real rows transition.
- **Effort:** 2-3 days for first 2 engines.

### Other partial categories (not in the priority table; verified during audit)

| Category | Has | Missing |
|---|---|---|
| **Webhook delivery** | `webhookDelivery.test.js` unit tests retry logic | No signature-validation or replay-attack test |
| **Rate-limit** | `auth-security-api.spec.js` covers `/api/auth/login`; `sendLimiter.test.js` covers email/SMS | No general endpoint hammering; no concurrent-burst test |
| **External-API** | `external-api.spec.js` functional coverage | No version-pinned snapshot — see CAT-4 |
| **Email/SMS/WhatsApp delivery** | Provider unit mocks | No MSW interceptor in e2e proving the route → provider chain |
| **Concurrency** | Some engine tests run parallel mocks | No explicit double-submit / simultaneous-write conflict tests |
| **Encryption** | Round-trip in `fieldEncryption.test.js` | No key-rotation scenario |
| **GDPR deletion completeness** | `gdpr-dsar-export-api.spec.js` covers export | Nothing verifies retention engine fully removes all FK-related rows |
| **Snapshot tests** | Vitest supports them | Zero `toMatchSnapshot()` calls found |

---

# Section E — Recommended waves

## Wave plan (parallel-agent-friendly batches)

Each wave: 5 agents, disjoint files, max 4-5 concurrent per the [`dispatching-parallel-agent-wave` skill](../.claude/skills/dispatching-parallel-agent-wave/SKILL.md).

| Wave | IDs | Focus | Estimated time |
|---|---|---|---|
| 1 | API-1, API-2, API-7, API-8, API-9 | Security-critical routes (admin/2FA/webhooks/keys) | 1-2 days |
| 2 | API-3, API-4, API-5, API-6, API-10 | Auth + payment + signing + sandbox | 2 days |
| 3 | API-11, API-12, API-13, API-14, API-15 | OAuth + integration routes | 1-2 days |
| 4 | API-16, API-17, API-18, API-19, API-20 | Comms + chat + staff | 1-2 days |
| 5 | API-21..API-25 | AI + approvals + audit + email | 1-2 days |
| 6 | API-26..API-30 | Sentiment + enrichment + inbox + tickets | 1-2 days |
| 7 | API-31..API-35 | Pipelines + dashboards + playbooks | 1-2 days |
| 8 | API-36..API-40 | Reports + funnel + tracking | 1-2 days |
| 9 | API-41..API-46 | Long-tail config routes | 1-2 days |
| 10 | CRON-1, CRON-2, CRON-3 | Highest-traffic engines | 2 days |
| 11 | CRON-4..CRON-9 | Remaining engines | 2 days |
| 12 | FE-1 | RTL infrastructure (multi-day, NOT parallel) | 3-5 days |
| 13 | FE-2..FE-6 | Untested components | 1-2 days |
| 14 | FE long-tail page waves | 11 sub-waves of 4-5 pages each | 10-15 days |
| 15 | CAT-1, CAT-2, CAT-3 | Visual + perf + load infra | 4-6 days |
| 16 | CAT-4, CAT-5 | Contract + mutation | 3-4 days |
| 17 | CAT-6, CAT-7, CAT-8, CAT-9, CAT-10, CAT-11 | Long-tail categories | 5-7 days |

**Total estimated effort to close ALL gaps:** ~45-60 dev-days. Realistic delivery: 2-3 calendar months at typical pickup rate, faster with sustained parallel-wave dispatch.

## What this doc does NOT cover

- **Verifying issue claims before agent dispatch** — handled by the [`verifying-issue-before-pickup` skill](../.claude/skills/verifying-issue-before-pickup/SKILL.md). Apply to every API-XX card before assigning, especially the long-tail ones (some routes may have been refactored away).
- **Tracking newly-reported bugs** — those go into [TODOS.md](../TODOS.md), not here.
- **Issue numbers from closed bugs** — covered by [regression-coverage-backlog.md](./regression-coverage-backlog.md). This doc is forward-looking (gaps in coverage), not backward-looking (regressions).
- **Code quality gaps** (dead code, refactor candidates, complexity) — out of scope. Use a separate audit.

## Verification before pickup

Per the [`verifying-issue-before-pickup` skill](../.claude/skills/verifying-issue-before-pickup/SKILL.md), before any agent picks up an API-XX card:

1. Confirm the route file still exists at the path listed.
2. Grep for `*-api.spec.js` matching the route name — the spec may have shipped under a different name since this audit (2026-05-06).
3. Check `git log --since=2026-05-06 backend/routes/<name>.js` — if the route was significantly refactored, re-scope the card.

This avoids the 50% phantom-work rate documented in v3.4.8/v3.4.9 picks.

---

## Status legend

- ⬜ open — not started
- 🟡 in progress — assigned, agent running
- ☑ shipped — merged + gated, with commit SHA noted

## Updating this doc

When you ship a card:
1. Mark ✅ in the master priority table.
2. Add the commit SHA inline.
3. If the card surfaced new findings (drift, contract bugs, missing endpoints), use [`capturing-wave-findings`](../.claude/skills/capturing-wave-findings/SKILL.md) to route them to the correct doc — usually TODOS.md or a new GitHub issue.
4. When ALL items in a section are ✅, do NOT archive the file yet — keep it at root until ALL three sections are closed (per the archive convention in [docs/gaps/archive/README.md](./gaps/archive/README.md)).
