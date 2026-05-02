# QA prompts — index

This directory contains two parallel QA-run prompts for the Cloud4Chrome
(or any browser-driving QA agent). Run them in **separate sessions** —
the wellness vertical and generic CRM have different sidebars, different
demo personas, different regression-test ticket numbers, and different
PRD scope guardrails.

## Which prompt to run when

| Vertical | Prompt | Tenant under test | Lands on | Roles |
|---|---|---|---|---|
| Wellness | [QA_WELLNESS_PROMPT.md](QA_WELLNESS_PROMPT.md) | Enhanced Wellness (`tenant.vertical=wellness`, tenantId=2, INR locale) | `/wellness` | 6 (Owner, Demo Admin, Manager, Doctor, Stylist, Telecaller) |
| Generic CRM | [QA_GENERIC_PROMPT.md](QA_GENERIC_PROMPT.md) | NovaCrest Technologies (`tenant.vertical=generic`, tenantId=1, USD locale) | `/dashboard` | 3 (ADMIN, MANAGER, USER) |

The two verticals share the same code-base + the same demo URL
(`https://crm.globusdemos.com`); they differ only by `tenant.vertical`
which drives sidebar layout, theme, landing route, and currency.

## Operator workflow

For each prompt:
1. Generate a GitHub fine-grained PAT (`Issues: read+write` on this repo only).
2. Confirm the demo URL is healthy: `curl https://crm.globusdemos.com/api/health`.
3. Paste the prompt body into Cloud4Chrome with `GH_TOKEN` exported.
4. Let it run for at least 30 minutes per role.
5. Bugs land on GitHub in batches of 5, deduped against existing issues.

Run **both** prompts before tagging a release. The
`.github/workflows/e2e-full.yml` Playwright suite covers the
deterministic UI flows; the QA prompts cover the long-tail manual
exploration the deterministic suite can't (visual regressions, copy
drift, 5xx-on-edge-case-input, weird browser-state interactions, etc.).

## What each prompt covers

### `QA_WELLNESS_PROMPT.md`
- 15 wellness pages (Owner Dashboard, Patients, Calendar, Reports, Recommendations, Telecaller Queue, Locations, Loyalty, Inventory, Public booking, Leads + Converted Leads + Routing, Estimates + Invoices + Payments with INR formatting, Inbox + Tasks + Staff + Settings, Patient Portal, Mobile viewport)
- 18+ recently-closed wellness regression targets to verify
- Real-looking Indian wellness data (clinic services, Hindi names, ₹ + Lakh/Crore)
- Wellness-specific PRD scope (Callified for voice/WA, AdsGPT for ads — not in CRM)

### `QA_GENERIC_PROMPT.md`
- 59 generic CRM pages organized by sidebar group (Core / Sales / Financial / Manager-only Sales / Marketing / Support / Admin)
- 8 generic-CRM regression targets (req.user.id sweep, approval state machine, deal stage migration, JWT revocation, 2FA, SLA breach cron, email tracking, stale-chunk recovery)
- Real-looking B2B SaaS / enterprise-customer data (Tata, Reliance, Acme, Maple — both Indian and US accounts)
- Same PRD scope guardrails (Callified, AdsGPT, login-chip product decision)

## Maintenance

- When the wellness sidebar changes (`renderWellnessNav` in `Sidebar.jsx`), update `QA_WELLNESS_PROMPT.md`'s test plan.
- When the generic sidebar changes (`renderGenericNav`), update `QA_GENERIC_PROMPT.md`'s test plan.
- When closing a P0/P1 bug, add it to the relevant prompt's regression-test list so the next QA run catches a re-regression.
- Both files have a "Maintenance notes" section at the bottom — keep them in sync as the codebase evolves.

## Coverage relative to e2e Playwright suite

Per-push CI runs **24 API specs (~1,146 tests)** + **22 vitest unit-test files (674 tests)** through `deploy.yml`. Release tags fire `e2e-full.yml` (full chromium project, sharded 4-way). The QA prompts complement these: they exercise UI flows + visual + cross-page state interactions that pure-API and pure-unit tests can't see. See the route ↔ spec coverage matrix in `TODOS.md` for the gap analysis between QA prompts, e2e specs, and the 91 backend route files.
