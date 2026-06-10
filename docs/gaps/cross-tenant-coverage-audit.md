# Cross-tenant coverage audit — FR-3.4 (#918 / #919)

Active from 2026-06-09. Closes Travel-Security slice S2.

PRD reference: [PRD_TRAVEL_SECURITY_ARCHITECTURE.md §FR-3.4](../PRD_TRAVEL_SECURITY_ARCHITECTURE.md) + §AC-6.10. Companion ESLint rule: `gbscrm/tenant-scope-finder-heuristic` (defined inline in [backend/eslint.config.js](../../backend/eslint.config.js)). Companion gate spec: [e2e/tests/cross-tenant-coverage-audit.spec.js](../../e2e/tests/cross-tenant-coverage-audit.spec.js).

## What this audit covers

Every `.js` file under `backend/routes/` (~150 routes; the PRD's "102 routes" count was at PRD-write-time — the surface has grown since). The audit is a **review** of how each route file scopes its Prisma calls to the caller's tenant, layered with two automated checks:

1. **ESLint (write-time, warn).** The new `gbscrm/tenant-scope-finder-heuristic` rule fires when a `prisma.<Model>.findMany({ where: {…} })` call in a route handler has a non-empty literal `where` clause that's missing both `tenantId` and `id`. Narrow on purpose — see the limits section below.

2. **E2E gate spec (deploy-time, error).** [`cross-tenant-coverage-audit.spec.js`](../../e2e/tests/cross-tenant-coverage-audit.spec.js) probes the highest-risk PII / financial / security-sensitive models with a tenant-A Bearer token reading a tenant-B row. 200 with the cross-tenant row = leak. 404 / 403 / 400 = safe.

The two layers are complementary. The ESLint rule catches new code before it ships; the gate spec catches the runtime behavior across the actual deployed surface.

## Routes audited

The grouped list below reflects every file under `backend/routes/` as of 2026-06-09. Each file went through one of three pathways:

- **AUTO** — every Prisma call in the file uses an explicit `tenantId: req.user.tenantId` in the WHERE clause (or sits behind a `verifyRole(['ADMIN'])` guard on an admin-only cross-tenant route). The ESLint heuristic emits 0 warnings on these files OR all warnings sit on by-id update / delete patterns that follow a prior tenant-scoped fetch.
- **HEURISTIC-WARN** — the ESLint rule emits at least 1 warning. Each warning is either (a) a legitimate by-id lookup after a prior tenant-scoped fetch (false-positive), (b) an admin-only cross-tenant route (false-positive), or (c) a genuine missing-tenant-scope. Cases (c) need follow-up in a separate PR; cases (a)/(b) need an inline `// eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic` directive with a safety rationale.
- **PROBED** — covered by an explicit test case in the gate spec.

### Generic / sales-core (PROBED + AUTO)

`contacts.js`, `deals.js`, `pipelines.js`, `pipeline_stages.js`, `deal_insights.js`, `forecasting.js`, `quotas.js`, `win_loss.js`, `playbooks.js`, `funnel.js`, `cpq.js`, `lead_routing.js`, `territories.js`, `data_enrichment.js`.

- Probed: Contact (list + detail + ?tenantId override), Deal (detail).
- Heuristic warns surfaced: ~8 callsites. Sample audit findings:
  - `contacts.js:418` — `prisma.contact.update({ where: { id: existing.id }, … })` — SAFE (prior `findFirst` at line 230 scoped to `tenantId: req.user.tenantId`).
  - `contacts.js:504` — `prisma.tenant.findUnique({ where: { id: req.user.tenantId } })` — SAFE (Tenant row's id IS the tenant id).
  - `approvals.js:38` — `prisma.user.findMany({ where: { id: { in: userIds } } })` — REVIEW (userIds come from same-tenant approval requests, but a maliciously-crafted cross-tenant id in the approval request would leak User PII; warrants a tenantId scope add).

### Marketing & content (AUTO)

`marketing.js`, `sequences.js`, `ab_tests.js`, `attribution.js`, `web_visitors.js` (post-#646), `chatbots.js` (post-#646), `landing_pages.js`, `email_templates.js`, `social.js`.

### Communication (AUTO)

`communications.js`, `email.js`, `email_inbound.js`, `email_threading.js`, `email_scheduling.js`, `sms.js`, `whatsapp.js`, `whatsapp_webhook.js`, `whatsapp_onboard.js`, `telephony.js` (post-#646), `voice.js`, `voice_transcription.js`, `live_chat.js` (post-#646), `shared_inbox.js`, `push.js`, `notifications.js`.

### Financial (PROBED + AUTO)

`billing.js`, `estimates.js`, `expenses.js`, `contracts.js`, `payments.js`, `payment_gateways.js`, `currencies.js`, `accounting.js`, `wallet.js`, `wallet_rules.js`, `subscriptions.js`.

- Probed: Invoice (detail), Quote (detail).
- Heuristic warns surfaced: ~6 callsites — all by-id updates after tenant-scoped fetches.

### Service & support (AUTO)

`tickets.js`, `support.js`, `sla.js`, `lead_sla.js`, `canned_responses.js`, `surveys.js`, `knowledge_base.js`, `portal.js`.

### Documents (AUTO)

`document_templates.js`, `signatures.js`, `document_views.js`, `deals_documents.js`.

### Analytics (AUTO)

`reports.js`, `report_schedules.js`, `custom_reports.js`, `dashboards.js`.

- Heuristic warns surfaced: ~5 callsites in `dashboards.js` — list queries over derived metric rows. Each needs an audit-comment commit (`eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic // safe: derived from tenant-scoped findMany above`).

### Automation (AUTO)

`workflows.js`, `approvals.js`.

### AI (AUTO)

`ai.js`, `ai_scoring.js`, `sentiment.js`.

### Integrations (AUTO)

`integrations.js`, `marketplace_leads.js`, `zapier.js`, `calendar.js`, `calendar_google.js`, `calendar_outlook.js`, `sso.js`, `scim.js`, `voyagr.js`.

### Admin & platform (AUTO with ADMIN-only false-positives)

`auth.js`, `auth_2fa.js`, `auth_stepup.js`, `me.js`, `admin.js`, `staff.js`, `users.js`, `roles.js`, `developer.js`, `audit.js` (PROBED), `audit_viewer.js`, `gdpr.js`, `field_permissions.js`, `sandbox.js`, `industry_templates.js`, `tenants.js` (ADMIN-only cross-tenant — legitimate), `booking_pages.js`, `custom_objects.js`, `search.js`, `tasks.js`, `projects.js`, `tenant_settings.js`, `user_preferences.js`, `module_action_permissions.js`, `embassy_rules.js`, `widgets.js`.

- Admin-only cross-tenant routes (legitimate; `verifyRole(['ADMIN'])` gates them): `tenants.js`, parts of `developer.js`, parts of `sandbox.js`, parts of `gdpr.js`.

### Wellness vertical (PROBED + AUTO)

`wellness.js`, `wellnessCsv.js`, `drugs.js`, `service_categories.js`, `block-times.js`.

- Probed: Patient (detail).
- Heuristic warns surfaced: ~10 callsites in `wellness.js` — by-id and by-relation updates after tenant-scoped fetches.

### Travel vertical (PROBED + AUTO)

`travel.js`, `travel_diagnostics.js`, `travel_itineraries.js` (PROBED), `travel_itinerary_templates.js`, `travel_quotes.js` (PROBED), `travel_quotes_public.js`, `travel_trips.js` (PROBED), `travel_trip_billing.js`, `travel_invoices.js` (PROBED), `travel_microsites.js`, `travel_cost_master.js`, `travel_pricing.js`, `travel_suppliers.js`, `travel_rfu_profiles.js`, `travel_csv_io.js`, `travel_visa.js` (PROBED), `travel_visa_analytics.js`, `travel_dashboard.js`, `travel_engine_weights.js`, `travel_inbound_leads.js`, `travel_passport.js`, `travel_personalised_destinations.js`, `travel_reports.js`, `travel_religious_packets.js`, `travel_sightseeing.js`, `travel_tmc_catalogue.js`, `travel_travelstall.js`, `travel_webcheckin.js`, `travel_flyer_templates.js`, `travel_commission_profiles.js`, `brand_kits.js`, `sub_brand_themes.js`.

- Probed: TravelItinerary, TravelQuote, TravelInvoice, TmcTrip, VisaApplication, TripParticipant.
- Heuristic warns surfaced: ~20 callsites across the travel route surface — proportionally similar rate to generic routes (no vertical-specific gap pattern).

### Security / API gateway

`external.js` (API-key gated, scopes to `req.user.tenantId` via aliased middleware), `csp.js`, `roles.js`.

- Probed: ApiKey (list scope), AuditLog (list scope).

## Heuristic gaps the ESLint rule won't catch

The rule fires ONLY on:

```
prisma.<Model>.findMany({ where: {non-empty literal with no tenantId AND no id} })
```

It will NOT catch any of the following — each is documented here so the reviewer recognizes the pattern at code-review time and applies the secondary check manually.

### 1. Dynamic / spread WHERE clauses

```js
const where = { tenantId: req.user.tenantId, ...filterByQuery(req) };
prisma.contact.findMany({ where }); // ← heuristic doesn't see inside `where`
```

vs.

```js
prisma.contact.findMany({ where: { ...buildWhere(req) } }); // ← AST has no Property[key.name='tenantId'] in scope
```

The AST selector cannot follow a variable reference or a spread expression. The first form is safe (the builder is unit-tested elsewhere); the second is harder to verify. **Reviewer check:** every spread / variable-WHERE callsite needs a paired `tenantWhere(req)` helper call within the same scope.

### 2. `findFirst` / `findUnique` / `update` / `delete` / `count`

Intentional narrowing. By-primary-key calls are typically safe because a prior tenant-scoped fetch returned the id. The signal:noise from widening to `findFirst` was 1:25; from `findMany` only it's roughly 1:5.

**Reviewer check:** every by-id `update` / `delete` should sit BENEATH a prior tenant-scoped `findFirst({ where: { id, tenantId: req.user.tenantId } })` in the same handler.

### 3. Raw SQL via `$queryRaw` / `$executeRaw`

Not parsed by the AST selector. Currently 0 callsites in `routes/`; if any land in the future they need an explicit audit.

### 4. Computed model names

```js
const model = ['contact', 'deal'][type];
prisma[model].findMany({ where: { status: 'active' } }); // ← callee.object.object.name='prisma' AST shape doesn't match
```

The selector requires the dotted `prisma.<Model>.<finder>` shape literally. Computed access is invisible. Currently 0 callsites in `routes/`; if any land they need an explicit audit.

### 5. The "spread `tenantWhere(req)`" pattern (false-negative)

```js
const where = { ...tenantWhere(req), name: { contains: q } };
prisma.contact.findMany({ where });
```

The actual call has no literal `Property[key.name='tenantId']` in scope of the WHERE Object, but the spread does provide it at runtime. The heuristic flags this as a warning — **false positive**. The fix is either (a) an inline `// eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic // safe: tenantWhere(req) spreads tenantId` directive, or (b) inlining the literal:

```js
prisma.contact.findMany({ where: { tenantId: req.user.tenantId, ...filterByQuery(req) } });
```

### 6. ADMIN-only cross-tenant routes (false-positive)

```js
// routes/tenants.js — ADMIN only, lists ALL tenants
router.get('/', verifyRole(['ADMIN']), async (req, res) => {
  const tenants = await prisma.tenant.findMany({ where: { active: true } }); // ← warns (correctly, given selector)
  ...
});
```

`verifyRole(['ADMIN'])` legitimately permits cross-tenant reads. **Reviewer check:** every warning in an admin-only route gets an inline `eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic // safe: ADMIN-only via verifyRole guard` directive.

## Cron-callsite review (separate from this audit)

Per PRD §FR-3.4(e): **the 22 cron engines under `backend/cron/` are NOT covered by this audit**. They operate outside the request-handler context, so `req.user.tenantId` doesn't exist. Each engine MUST either:

- Loop per-tenant in an explicit outer loop (`for (const tenant of tenants) { ... }`), passing the tenant id into every Prisma call, OR
- Include `tenantId` in every WHERE clause when processing tenant-scoped work, OR
- Be documented as cross-tenant by design (audit hash chain, retention sweep, demo hygiene) and the lack-of-tenant-scope is intentional.

This audit pass is tracked as **#919 follow-up** — see TODOS.md.

Cron-engine catalogue (per CLAUDE.md): leadScoringEngine, sequenceEngine, marketplaceEngine, workflowEngine, campaignEngine, reportEngine, recurringInvoiceEngine, forecastSnapshotEngine, dealInsightsEngine, sentimentEngine, scheduledEmailEngine, retentionEngine, backupEngine, orchestratorEngine, appointmentRemindersEngine, wellnessOpsEngine, slaBreachEngine, leadSlaEngine, lowStockEngine, leavePolicyEngine, demoHygieneEngine, auditIntegrityEngine.

A separate cron-callsite audit will produce a table (engine | tenant-scope mechanism | verified-OK or fix-needed) when scheduled.

## Known false-positive patterns (catalogue)

Each pattern below maps to ≥1 ESLint warning in the current surface. The pattern is included here so future authors recognize the shape at review time and add the appropriate disable-line directive with a safety rationale.

| Pattern | Example callsite | Why it's safe | Suppression line |
|---|---|---|---|
| By-id after tenant-scoped fetch | `contacts.js:418` | Prior `findFirst({ where: { id, tenantId } })` at line 230 | `// eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic // safe: existing was tenant-scoped at L230` |
| Tenant table lookup by id | `contacts.js:504` | `Tenant.id` IS the tenant id | `// eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic // safe: prisma.tenant lookup by id IS the tenant filter` |
| ADMIN-only cross-tenant | `tenants.js` (every route) | `verifyRole(['ADMIN'])` at top | `// eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic // safe: ADMIN-only route, verifyRole guard at top` |
| Spread `tenantWhere(req)` | (no `tenantWhere` helper today; future PR) | Spread injects tenantId at runtime | `// eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic // safe: tenantWhere(req) spread injects tenantId` |
| Lookup table with no tenant scope | `Currency`, `IndustryTemplate` (global tables) | Tables are intentionally global | `// eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic // safe: <Model> is a global lookup table` |
| User table joined via tenant-scoped row | `approvals.js:38` | Userids come from same-tenant approval requests | NEEDS REVIEW — see below |

## Routes that need a follow-up tenantId-add PR

The ESLint heuristic flags 60-70 callsites across the route surface. Most are false-positives (per the patterns above). The ones below were **review-flagged** at S2 ship-time as potentially-real; all five were closed out in S36 with code-grounded dispositions:

- **`approvals.js:38`** — `prisma.user.findMany({ where: { id: { in: userIds } } })`. **RESOLVED in S36 (commit `5be509de`)** — GENUINE LEAK. The `userIds` come from approval requests of the current tenant, but the Prisma schema doesn't enforce a `(User.tenantId == ApprovalRequest.tenantId)` constraint, so a stale or maliciously-crafted cross-tenant id in `requestedBy` / `approvedBy` would leak User PII (name + email + role). Fix landed: `hydrateUsers(requests, tenantId)` now passes the caller's `tenantId` into the user lookup `where: { id: { in: userIds }, tenantId }`. All 9 existing callsites already passed `tenantId` to the helper; the function signature was the only change.
- **`auth.js:109`** — `prisma.tenant.findMany({ where: { isActive: true } })` on the PUBLIC `/api/auth/public/tenants` route. **RESOLVED in S36 (commit `5be509de`)** — FALSE POSITIVE. The route has NO `verifyToken` (it's the pre-registration tenant dropdown), so there is no `req.user.tenantId` to scope by; the cross-tenant response is by design. The S2 audit doc's "login + signup flows query the User table by email" framing was wrong about WHICH Prisma model this line is — the call lists Tenants, not Users. Suppressed with `// eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic` + rationale.
- **`auth.js:353`** — `prisma.tenant.findMany({ where: { isActive: true } })` on the PUBLIC `/api/auth/customer/tenants` route. **RESOLVED in S36 (commit `5be509de`)** — FALSE POSITIVE. Same shape as `auth.js:109` (the audit doc said "auth.js:350" — the actual ESLint-flagged line is 353 post-comment-block). Returns minimal display fields only (id, name, vertical) — no plan, owner, billing, or branding metadata exposed. Suppressed with inline rationale.
- **`dashboards.js:335` + `:379`** — `prisma.deal.findMany` (`chart-revenue-trend`) + `prisma.task.findMany` (`table-overdue-tasks`). **RESOLVED in S36 (commit `5be509de`)** — FALSE POSITIVE per the spread-pattern false-positive class (audit doc §"Heuristic gaps the ESLint rule won't catch" point 1). Both calls spread `...tenantWhere` (defined on L284 as `{ tenantId }` via the `resolveWidget(type, tenantId)` helper), which injects `tenantId` at runtime — but the AST selector can't see through the spread. Suppressed with inline rationale.
- **`reports.js:200-203`** — `prisma.deal.findMany` + `prisma.task.findMany` + `prisma.callLog.findMany` + `prisma.emailMessage.findMany` on `/api/reports/agent/:userId`. **RESOLVED in S36 (commit `5be509de`)** — FALSE POSITIVE per the spread-pattern class. All four calls spread `...baseWhere` where `baseWhere = buildWhere(req, startDate, endDate)` (the helper on L26-34 inlines `tenantId: req.user.tenantId` into the returned where object). The audit doc said "L200 + L201" but ESLint actually flagged L200-203 (4 lines, not 2) — corrected during S36. Suppressed with inline rationales on each of the 4 calls. **Defense-in-depth note:** the route ALSO does a tenant-scoped `prisma.user.findFirst({ where: { id: userId, tenantId } })` on L195 BEFORE the aggregations, so a cross-tenant `:userId` 404s before the spread calls run.

All five of the audit-flagged callsites are now closed. S36 also added 5 per-route cross-tenant probes to [`cross-tenant-coverage-audit.spec.js`](../../e2e/tests/cross-tenant-coverage-audit.spec.js) — `S36 approvals POST + cross-tenant list probe`, `S36 auth.js:109 /auth/public/tenants minimal-fields shape pin`, `S36 auth.js:353 /auth/customer/tenants minimal-fields shape pin`, `S36 dashboards widget data resolver`, `S36 reports.js:200-203 /reports/agent/:userId cross-tenant 404`.

**ESLint count delta (4 modified route files):** 8 warnings → 0 warnings. Whole-routes-tree count drops correspondingly; the remaining ~64 warnings on the broader surface are the catalogued false-positive patterns enumerated above.

## Tightening path

When a third instance of cross-tenant leak is surfaced in a model NOT currently covered by the gate spec:

1. Widen the heuristic to also flag `findFirst` and `findUnique` (drop the `id`-escape-hatch).
2. Promote severity from `warn` to `error`.
3. Sweep the surviving callsites with audit-backed `eslint-disable-next-line` directives, one per line, each with a safety rationale.
4. Add a new test case to [`cross-tenant-coverage-audit.spec.js`](../../e2e/tests/cross-tenant-coverage-audit.spec.js) for the leaked model.
5. Update this doc's "Routes that need a follow-up tenantId-add PR" section.

## Issue tracking

- **#918** — FR-3.4 Tenant-scope audit deliverable (this doc + ESLint rule + gate spec). Closed by slice S2.
- **#919** — Cron-callsite audit (deferred — see "Cron-callsite review" section above).
- **#646** — Original 4-route stripDangerous sweep (closed long ago; this audit builds on its discipline).
