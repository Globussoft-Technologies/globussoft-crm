# Test Coverage Gaps — 2026-05-25 audit

> **2026-05-25 re-audit (this snapshot).** The 2026-05-06 baseline scored
> 46 of 92 routes (50%) without API specs and 9 of 19 cron engines without
> vitests. As of today's grep against `e2e/tests/`, `backend/test/cron/`,
> `backend/test/services/`, and `frontend/src/__tests__/`:
>
> | Class | 2026-05-06 baseline | 2026-05-25 actual | Delta |
> |---|---|---|---|
> | Backend routes without API spec | 46 open | **1 open** (admin.js — non-LLM endpoints) | 45 closed |
> | Cron engines without vitest | 9 open | **0 open** | 9 closed |
> | Section-A API-XX cards open | 46 | **1 (API-1 partial)** | 45 |
> | Section-B CRON-XX cards open | 9 | **0** | 9 |
> | Section-C FE-XX cards open | 6 | **3** (Omnibar / RouteErrorBoundary / Softphone) | 3 |
> | Section-D CAT-XX cards open | 11 | **11** (untouched class — needs separate push) | 0 |
> | **Total cards open** | **72** | **15** | **57 shipped** |
>
> **Current test inventory (live grep):** 256 files in `e2e/tests/`, 35 in
> `backend/test/cron/`, 16 in `backend/test/services/`, 151 in
> `frontend/src/__tests__/`. See [README.md "At a glance"](../README.md) for
> the authoritative running counts and the per-push gate's spec subset.
>
> **Naming-convention note:** the original master backlog presumed the
> `*-api.spec.js` suffix. Many specs shipped under bare `*.spec.js`
> names (e.g. `payments.spec.js`, `scim.spec.js`, `whatsapp.spec.js`,
> `marketplace-leads.spec.js`). These are real API-level specs covering
> the route's endpoints — not UI-only smoke tests — and are counted as
> shipped below. If you author a new spec, prefer `-api.spec.js`; the
> wiring-spec-into-gate skill assumes that suffix for the gate-spec list.

> **Phantom-carry-over warning** ([CLAUDE.md standing rule](../CLAUDE.md#standing-rules-for-new-code-do-not-skip-these)): 7+ confirmed instances where TODOS / gap-doc rows were dispatched on already-shipped scope. Always run [`verifying-issue-before-pickup`](../.claude/skills/verifying-issue-before-pickup/SKILL.md) before agent dispatch. This snapshot is more reliable than the 2026-05-06 baseline but the underlying drift mechanism remains; verify before pickup.

> **Audience:** any dev / agent who wants to grab a coverage gap and ship it.
> **Snapshot date:** 2026-05-25
> **Companions:** [TODOS.md](../TODOS.md), [docs/gaps/archive/](gaps/archive/) for closed parent backlogs.
> **Source of truth for current spec/test counts:** [README.md](../README.md).

## Why this doc still exists

The G-XX backlog ([E2E_GAPS.md](./E2E_GAPS.md), archived 2026-05-14) closed in full. The Section A/B/C/D classes the 2026-05-06 audit added have largely closed too — only Section D (test-category gaps: visual regression, perf, load, contract, mutation, etc.) and a thin Section C tail (3 untested components) remain. **If Section D gets a dedicated push in the next cycle, this doc can be archived under `docs/gaps/archive/` per the convention.** Until then it stays live for the remaining 15 open cards.

---

## How to pick a task

1. Scan the **Open cards** section below and grab the first unblocked card.
2. Each card has: ID, target file, spec name to create, effort, risk tier, pattern to copy, acceptance criteria.
3. Per [CLAUDE.md "Standing rules for new code"](../CLAUDE.md#standing-rules-for-new-code-do-not-skip-these): every new `*-api.spec.js` MUST be wired into BOTH [deploy.yml](../.github/workflows/deploy.yml) AND [coverage.yml](../.github/workflows/coverage.yml). Use the [`wiring-spec-into-gate`](../.claude/skills/wiring-spec-into-gate/SKILL.md) skill.
4. Every new `backend/lib|middleware|services|cron` module needs a vitest under `backend/test/<area>/<module>.test.js`. Use the [`writing-vitest-unit-test`](../.claude/skills/writing-vitest-unit-test/SKILL.md) skill.
5. PR title format: `test(<area>): <short>` — e.g. `test(visual): add Playwright toHaveScreenshot baseline for Login`.
6. Mark the card ☑ in the table when merged + add commit SHA.

## Pre-reqs (read once before starting)

- [ ] [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) — the gate-spec list. Every new spec lands here.
- [ ] [.github/workflows/coverage.yml](../.github/workflows/coverage.yml) — mirror the gate-spec list.
- [ ] [e2e/tests/notifications-api.spec.js](../e2e/tests/notifications-api.spec.js) — reference pattern for CRUD + auth + tenant scoping.
- [ ] [e2e/tests/wellness-clinical-api.spec.js](../e2e/tests/wellness-clinical-api.spec.js) — reference for wellness-tenant test setup.
- [ ] [backend/test/cron/recurringInvoiceEngine.test.js](../backend/test/cron/recurringInvoiceEngine.test.js) — reference vitest for cron engines (real Prisma where possible, not pure mocks).
- [ ] [.claude/skills/](../.claude/skills/) — reusable skills that encode the patterns.

---

## Open cards (current backlog — 15 items)

| ID | Target | Type | Effort | Risk if skipped | Status |
|---|---|---|---|---|---|
| **API-1** | `routes/admin.js` non-LLM endpoints | api spec | 2-3h | Med — LLM-spend slice covered by `admin-llm-spend-api.spec.js`; remaining `/api/admin/backup*` ops still ungated | ⬜ open |
| **FE-3** | `components/Omnibar.jsx` | RTL test | 3-4h | Low — global search bar | ⬜ open |
| **FE-4** | `components/RouteErrorBoundary.jsx` | RTL test | 2-3h | Med — silent-fail surface for entire SPA | ⬜ open |
| **FE-5** | `components/Softphone.jsx` | RTL test | 3-4h | Low — voice integration UI | ⬜ open |
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

**Recommended first batch:** CAT-4 (highest-value — `/api/v1/external/*` has external consumers), CAT-6 (backup-restore round-trip, smallest concrete extension), API-1 (small admin.js completion). These three are disjoint and ship-able by separate agents in parallel.

**Recommended second batch:** CAT-1 + CAT-7 (visual + a11y are mechanically similar — Playwright-based, configurable per-project). Then CAT-2 / CAT-3 / CAT-10 / CAT-11 as a Playwright-config cluster.

**FE component cluster:** FE-3 + FE-4 + FE-5 are 3 small RTL tests; bundle as a 1-day single-agent dispatch.

---

## Closed cards (audit trail — for verification before re-picking)

The following cards from the 2026-05-06 audit shipped between snapshot
and 2026-05-25. Spec name listed where it differs from the original
`*-api.spec.js` convention.

### Section A — API specs (45 closed)

| Original ID | Route | Where it shipped |
|---|---|---|
| API-2 | `routes/auth_2fa.js` | `e2e/tests/auth_2fa.spec.js` (8 tests) |
| API-3 | `routes/payments.js` | `e2e/tests/payments.spec.js` (17 tests) |
| API-4 | `routes/signatures.js` | `e2e/tests/signatures.spec.js` (12 tests) |
| API-5 | `routes/scim.js` | `e2e/tests/scim.spec.js` (10 tests) |
| API-6 | `routes/sso.js` | `e2e/tests/sso.spec.js` (9 tests) |
| API-7 | `routes/email_inbound.js` | `e2e/tests/email_inbound.spec.js` |
| API-8 | `routes/marketplace_leads.js` | `e2e/tests/marketplace-leads.spec.js` (15 tests) |
| API-9 | `routes/developer.js` | `e2e/tests/developer-api.spec.js` |
| API-10 | `routes/sandbox.js` | `e2e/tests/sandbox.spec.js` (7 tests; destructive endpoints skipped intentionally) |
| API-11 | `routes/calendar_google.js` | `e2e/tests/calendar_google.spec.js` (6 tests) |
| API-12 | `routes/calendar_outlook.js` | `e2e/tests/calendar_outlook.spec.js` (7 tests) |
| API-13 | `routes/calendar.js` | `e2e/tests/calendar.spec.js` (5 tests) |
| API-14 | `routes/zapier.js` | `e2e/tests/zapier.spec.js` (13 tests) |
| API-15 | `routes/whatsapp.js` | `e2e/tests/whatsapp.spec.js` (56 tests) |
| API-16 | `routes/telephony.js` | `e2e/tests/telephony.spec.js` (10 tests) |
| API-17 | `routes/voice.js` | `e2e/tests/voice.spec.js` (9 tests) |
| API-18 | `routes/chatbots.js` | `e2e/tests/chatbots.spec.js` (16 tests) |
| API-19 | `routes/live_chat.js` | `e2e/tests/live-chat.spec.js` (17 tests) |
| API-20 | `routes/staff.js` | `e2e/tests/staff.spec.js` (8 tests) |
| API-21 | `routes/approvals.js` | `e2e/tests/approvals.spec.js` (12 tests) + `approvals-flow.spec.js` |
| API-22 | `routes/audit_viewer.js` | `e2e/tests/audit_viewer.spec.js` (13 tests) |
| API-23 | `routes/email_templates.js` | `e2e/tests/email-templates.spec.js` (4 tests) |
| API-24 | `routes/email_scheduling.js` | `e2e/tests/email-scheduling-api.spec.js` |
| API-25 | `routes/ai.js` | `e2e/tests/ai.spec.js` (7 tests) |
| API-26 | `routes/sentiment.js` | `e2e/tests/sentiment.spec.js` (9 tests) |
| API-27 | `routes/data_enrichment.js` | `e2e/tests/data_enrichment.spec.js` (9 tests) |
| API-28 | `routes/shared_inbox.js` | `e2e/tests/shared_inbox.spec.js` |
| API-29 | `routes/support.js` | `e2e/tests/support.spec.js` (5 tests) |
| API-30 | `routes/tickets.js` | `e2e/tests/tickets.spec.js` (8 tests) |
| API-31 | `routes/playbooks.js` | `e2e/tests/playbooks.spec.js` (9 tests) |
| API-32 | `routes/quotas.js` | `e2e/tests/quotas.spec.js` (9 tests) |
| API-33 | `routes/pipelines.js` | `e2e/tests/pipelines.spec.js` (7 tests) |
| API-34 | `routes/pipeline_stages.js` | `e2e/tests/pipeline-stages.spec.js` (4 tests) |
| API-35 | `routes/dashboards.js` | `e2e/tests/dashboards.spec.js` (11 tests) |
| API-36 | `routes/custom_reports.js` | `e2e/tests/custom_reports.spec.js` |
| API-37 | `routes/funnel.js` | `e2e/tests/funnel.spec.js` (8 tests) |
| API-38 | `routes/win_loss.js` | `e2e/tests/win_loss.spec.js` |
| API-39 | `routes/web_visitors.js` | `e2e/tests/web_visitors.spec.js` |
| API-40 | `routes/deals_documents.js` | `e2e/tests/deals_documents.spec.js` |
| API-41 | `routes/document_views.js` | `e2e/tests/document_views.spec.js` |
| API-42 | `routes/industry_templates.js` | `e2e/tests/industry-templates.spec.js` (8 tests) |
| API-43 | `routes/currencies.js` | `e2e/tests/currencies.spec.js` (14 tests) |
| API-44 | `routes/territories.js` | `e2e/tests/territories.spec.js` (8 tests) |
| API-45 | `routes/tenants.js` | `e2e/tests/tenants.spec.js` (7 tests) |
| API-46 | `routes/sla.js` | `e2e/tests/sla.spec.js` (12 tests) + `sla-breach-api.spec.js` + `sla-flow.spec.js` |

### Section B — Cron-engine vitests (9 closed)

| Original ID | Engine | Where it shipped |
|---|---|---|
| CRON-1 | `workflowEngine.js` | `backend/test/cron/workflowEngine.test.js` |
| CRON-2 | `sequenceEngine.js` | `backend/test/cron/sequenceEngine.test.js` + `sequenceEngine-wellness-triggers.test.js` |
| CRON-3 | `reportEngine.js` | `backend/test/cron/reportEngine.test.js` |
| CRON-4 | `marketplaceEngine.js` | `backend/test/cron/marketplaceEngine.test.js` |
| CRON-5 | `scheduledEmailEngine.js` | `backend/test/cron/scheduledEmailEngine.test.js` |
| CRON-6 | `dealInsightsEngine.js` | `backend/test/cron/dealInsightsEngine.test.js` + `dealInsightsEngine-tick.test.js` |
| CRON-7 | `backupEngine.js` | `backend/test/cron/backupEngine.test.js` |
| CRON-8 | `lowStockEngine.js` | `backend/test/cron/lowStockEngine.test.js` |
| CRON-9 | `leadSlaEngine.js` | `backend/test/cron/leadSlaEngine.test.js` |

Plus 16 additional cron vitests landed beyond the original Section B list
(orchestratorEngine, retentionEngine, slaBreachEngine, leavePolicyEngine,
auditIntegrityEngine, demoHygieneEngine, sentimentEngine,
contactGreetingsEngine, religiousGuidanceEngine, travelDiagnosticAdvisorAlerts,
travelJourneyReminders, tripPaymentReminders, tripPostTripFeedback,
webCheckinScheduler, visaRiskFlagEngine, noShowRisk, etc.) for a current
inventory of **35 files** in `backend/test/cron/`.

### Section C — Frontend (3 closed of 6)

| Original ID | Component / util | Where it shipped |
|---|---|---|
| FE-1 | RTL infrastructure | 151 files in `frontend/src/__tests__/`; `frontend_unit_tests` is a mandatory deploy gate |
| FE-2 | `Sidebar.jsx` | `Sidebar.activeState.test.jsx` + `Sidebar.countersRefresh.test.jsx` (split into 2 focused files rather than one mega-file) |
| FE-6 | `utils/numberInput.jsx` | `frontend/src/__tests__/numberInput.test.jsx` (207 lines) |

Plus ~140 page-level component tests covering: Approvals, AuditLog, Billing, Channels, Contacts (duplicates + email validation), Dashboard, DealInsights, DealModal, Estimates, FieldPermissions, Forecasting, Inbox, Invoices, KnowledgeBase, Layout, Leads, Loyalty, NotificationBell, OwnerDashboard, Patients (#820 wave), PatientDetail, Payments, Pipeline (drag), PointOfSale, Privacy, Profile, Reports, RoleGuard, Settings, Sequences, Staff, Surveys, TelecallerQueue, TenantSettings, plus 30+ travel-vertical pages (TravelStallQuiz, TripBooking, ItineraryDetail, RfuCustomerProfile, VisaApplications, etc.), 8 stub-client surfaces (adsgpt, callified, ratehawk, bookingExpedia, etc.), and 12+ utility tests (currency, date, money, percent, i18n, pwa, pushSetup, lazyWithRetry, greeting, notify, useFormAutosave, security-token-storage, a11y-table-stability, ui-primitives). The Wave 1-11 long-tail page rollout described in the 2026-05-06 audit is functionally complete.

### Section D — Test categories (0 closed)

None of CAT-1 through CAT-11 have shipped. This whole class is the
biggest remaining work surface. See "Open cards" above for details.

### Other notable additions since the 2026-05-06 audit

- **8 cap-consumer stub clients shipped paired vitests** under `backend/test/services/`: adsGptClient, ratehawkClient, callifiedClient, bookingExpediaClient, bookingCom, haramainRailClient, zikrCabsClient, digilockerClient, googleDriveClient, razorpayService, pdfRenderer (12+ test cases each, including a CJS self-mocking-seam regression-pin per the writing-vitest-unit-test skill).
- **Travel-vertical Phase 1 shipped its full vitest + RTL stack**: 21 new Prisma models, 10 travel route files, 30+ page tests — none of which existed at the 2026-05-06 baseline.
- **Patients page (#820) shipped 26 vitest cases + 50+ backend supertest cases** across pagination, bulk-tag, CSV/XLSX export, template, tag-remove, and filter slices over the 14-commit incremental drain.

---

## Status legend

- ⬜ open — not started
- 🟡 in progress — assigned, agent running
- ☑ shipped — merged + gated (see "Closed cards" above)

## Updating this doc

When you ship a card:
1. Mark ☑ in the "Open cards" table and move the row down to the "Closed cards" section with the commit SHA / spec file path.
2. Update the top-of-file summary block's "open count" column.
3. If the card surfaced new findings (drift, contract bugs, missing endpoints), use [`capturing-wave-findings`](../.claude/skills/capturing-wave-findings/SKILL.md) to route them to the correct doc — usually TODOS.md or a new GitHub issue.
4. **When Section D closes** (the 11 CAT-XX cards), the remaining open work is small enough to move to TODOS.md; archive this file under `docs/gaps/archive/test-coverage-gaps-closed-<date>.md` per [docs/gaps/archive/README.md](./gaps/archive/README.md).

## Verification before pickup

Per the [`verifying-issue-before-pickup` skill](../.claude/skills/verifying-issue-before-pickup/SKILL.md), before any agent picks up a card:

1. Confirm the target file still exists at the path listed.
2. Grep `e2e/tests/`, `backend/test/`, or `frontend/src/__tests__/` for the target name AND any variant (`<name>.spec.js`, `<name>-api.spec.js`, bare/extended/split forms). The 2026-05-25 audit closed 45 API-XX cards purely because the original naming convention assumption (`*-api.spec.js`) missed the bare `*.spec.js` forms many specs actually shipped under.
3. Check `git log --since=<snapshot-date> <target>` — if the target was significantly refactored, re-scope the card.

This avoids the 50%+ phantom-work rate the 2026-05-06 snapshot was vulnerable to before the 2026-05-25 re-audit.
