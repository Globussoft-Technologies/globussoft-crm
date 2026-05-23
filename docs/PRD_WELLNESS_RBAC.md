# PRD — Wellness RBAC + Permission Scoping

**Status:** WRITTEN 2026-05-23 (autonomous cron tick #29).
**Owner:** Wellness platform / Globussoft.
**Coordinates:** GH #827 (Demo Admin = Owner surface), #829 (Demo User Patients silent-mask), #830 (Demo User POS dead-end).
**Sibling PRD:** [PRD_WELLNESS_POS_HARDENING.md](PRD_WELLNESS_POS_HARDENING.md) — POS sub-aspect of #830 is also covered there.

---

## §1 Background

The May 2026 demo QA audit surfaced three OPEN role/permission bugs that, taken together, form a single RBAC-design cluster, not three independent UX glitches:

- **#827** Demo Admin (`admin@wellness.demo`) renders the identical sidebar + landing page as Owner (Rishu). Every Owner-only surface — Commission Profiles, Revenue Goals, Channels, Plans & Billing — is reachable.
- **#829** Demo User (`user@wellness.demo`) on `/wellness/patients` sees `0 total` and `No patients match.` plus a red toast `You don't have permission to perform this action.` Owner-on-same-browser sees real patient data. This is permission-as-empty-list, which testers report as a data bug.
- **#830** Demo User can navigate to `/wellness/pos` but cannot complete a sale — Register select is empty, `Open shift` is non-functional, no in-product path exists to create a Register. Both ends of the journey (the role's permission to sell, and the configuration to enable it) are broken.

The root cause is shared across all three: the wellness vertical declares an orthogonal `User.wellnessRole` ∈ `{doctor, professional, telecaller, helper}` ([prisma/schema.prisma:351](../backend/prisma/schema.prisma#L351)) on top of the tenant-wide RBAC role `{ADMIN, MANAGER, USER}`, but the demo seed conflates Owner with ADMIN-role, and many UI surfaces gate on role alone (or not at all) rather than on the role × wellnessRole matrix. The result is that "Demo Admin" gets the Owner surface, "Demo User" gets a defensively-filtered empty surface, and POS — which is a sales-vertical role that doesn't yet have a first-class wellnessRole — has no path to being usable.

### §1.2 Existing infrastructure (do NOT rebuild)

| Component | Location | What it does |
|---|---|---|
| RBAC `verifyRole(['ADMIN','MANAGER'])` middleware | [backend/middleware/auth.js:115](../backend/middleware/auth.js#L115) | Tenant-wide role gate. Returns 403 with `RBAC_DENIED_MESSAGE` envelope. |
| `verifyWellnessRole([…])` middleware | [backend/middleware/wellnessRole.js](../backend/middleware/wellnessRole.js) | Orthogonal wellnessRole gate. Returns 403 with stable codes `WELLNESS_TENANT_REQUIRED` / `WELLNESS_ROLE_FORBIDDEN` + `allowed[]` array. Tenant-vertical aware (rejects non-wellness tenants even if ADMIN). |
| `phiReadGate` | [backend/routes/wellness.js:212](../backend/routes/wellness.js#L212) | `verifyWellnessRole(["doctor","professional","telecaller","admin","manager"])` — denies a `USER` with no wellnessRole. |
| `wellnessRole` column on User | [prisma/schema.prisma:351](../backend/prisma/schema.prisma#L351) | `String?` nullable. Values: `doctor / professional / telecaller / helper`. |
| Sidebar role-gated `Link` helper | [frontend/src/components/Sidebar.jsx:384](../frontend/src/components/Sidebar.jsx#L384) | Accepts `adminOnly`, `managerOnly`, `wellnessRoles` props. Hides items the role can't action. |
| `renderWellnessNav()` | [frontend/src/components/Sidebar.jsx:625](../frontend/src/components/Sidebar.jsx#L625) | Wellness sidebar branch — already passes `wellnessRoles={[…]}` per Link for clinical items. |
| `FieldPermission` model + `fieldFilter` middleware | [backend/middleware/fieldFilter.js](../backend/middleware/fieldFilter.js) | Field-level read/write masking; per-tenant configurable. |
| `RBAC_DENIED_MESSAGE` stable copy | [backend/middleware/auth.js](../backend/middleware/auth.js) | Shared denial string so 403 toasts look the same across `verifyRole` and `verifyWellnessRole`. |
| Demo quick-login seeds | [backend/prisma/seed-wellness.js](../backend/prisma/seed-wellness.js) | Provisions `admin@wellness.demo`, `user@wellness.demo`, doctor / professional / helper / telecaller users. |

The remediation is **a role taxonomy + seed alignment + UI affordance pass**, not new middleware. The gates already exist and are correctly written; the demo data and the sidebar-render decisions don't match them.

### §1.3 Source attribution

- Three GH issues filed by `nilimeshnayak-max` during the May 2026 Globussoft demo QA audit (filed across May 2026; all OPEN as of 2026-05-23).
- Prior session: `feedback_wellness_phi_policy` memory file — v3.4.14 closed the `role=USER` PHI gap (which is precisely why #829 now silent-masks instead of leaking) but explicitly deferred per-record ownership ("cross-professional edits stay open by design").
- Sibling PRD [PRD_WELLNESS_POS_HARDENING.md](PRD_WELLNESS_POS_HARDENING.md) covers the Register-configuration half of #830; this PRD covers the role-scoping half.
- Related historical context: PR #325 (tenant-vertical gate inside `verifyWellnessRole`); PR #590/#591 (RBAC denial copy unification — same neutral string across `verifyRole` and `verifyWellnessRole` to prevent role-taxonomy leakage in toast strings); PR #274 (structured 403 contract with `allowed[]` array). All shipped; this PRD builds on the resulting contract.

### §1.4 Anti-pattern observed (do NOT repeat)

The bugs share a single anti-pattern: **permission-as-empty-result instead of permission-as-403**. Concrete instance — `/wellness/patients` for USER-no-wellnessRole today returns `200` with an empty array AND a generic red toast `You don't have permission to perform this action.`. The intent was "fail safe" (don't leak data), but the UX cost is "this clinic has 0 patients" which testers (correctly) escalate as a data bug. The fix is structural: return `403` with the `WELLNESS_ROLE_FORBIDDEN` envelope, render the `<RoleAccessDenied>` component, full stop. The same anti-pattern surfaced in route audit cycles before — see also PR #268 (sources polluting reports — fixed at aggregation layer); the lesson is identical: never "fail-quiet-with-empty" on permission boundaries.

---

## §2 Use cases

- **UC-2.1** Owner (Rishu) logs in → lands on `/wellness` Owner Dashboard, sees full clinical + finance + admin + reports surface. (Current correct behavior — pin this.)
- **UC-2.2** Admin (Demo Admin, `admin@wellness.demo`) logs in → lands on Admin Dashboard (distinct route or scoped variant of Owner Dashboard), sees operational management but NOT owner-only items (Commission Profiles, Revenue Goals, Plans & Billing). (Currently broken — #827.)
- **UC-2.3** Doctor (`drharsh@enhancedwellness.in`) logs in → clinical-focused surface: Patients (own-assigned only), Calendar, Visits, Prescriptions, Treatment Plans. No POS, no Channels, no Settings.
- **UC-2.4** Professional logs in → service-execution surface: own visits, own service consumptions, Calendar (own column only). No patient-list-wide read.
- **UC-2.5** Telecaller logs in → Telecaller Queue, Lead Routing, WhatsApp Threads, disposition flow. No clinical PHI, no POS.
- **UC-2.6** Helper logs in → Check-in, Receipts, Inventory consumption, Visit completion. Limited PHI (current visit only, not full history).
- **UC-2.7** Demo User (USER role, no wellnessRole — `user@wellness.demo`) hits `/wellness/patients` → friendly access-denied state (NOT a fake-empty list). (Currently broken — #829.)
- **UC-2.8** Cashier (USER + `wellnessRole='cashier'` — new) logs in → POS, sales flow, receipts. No patient PHI. (Currently impossible — there is no cashier wellnessRole — #830.)
- **UC-2.9** Tenant Owner (Rishu) wants to provision a new front-desk hire → admin UI lets them pick wellnessRole at user-creation. Sidebar + access surface immediately match the picked role. (Aspirational — gates a clean rollout of FR-3.6.)
- **UC-2.10** An auditor (external compliance review of demo) navigates as Demo Admin → confirms admin-only items are visible and owner-only items are NOT — provides audit-grade evidence that the role taxonomy is enforced. (Required by Globussoft QA cadence.)

---

## §3 Functional requirements

### FR-3.1 Role taxonomy clarification

- **FR-3.1.a** Document the canonical role matrix: tenant-RBAC `{ADMIN, MANAGER, USER}` × `wellnessRole` ∈ `{doctor, professional, telecaller, helper, cashier, none}`. The combination — not either axis alone — determines surface area.
- **FR-3.1.b** Add a new `wellnessRole` value `'cashier'` for USER-tier sales staff who use POS without clinical access. (Phase 1; alternative deferred to DD-5.1.)
- **FR-3.1.c** Tighten the Owner ↔ Admin distinction in seed + UI. Owner is the tenant-superuser (singular per tenant, has billing + Plans access); Admin is operational-management (multi-allowed, no billing).
- **FR-3.1.d** Per-tenant role customization (admin can define custom role labels with permission bitmaps) is Phase 2; out of scope for this remediation.

### FR-3.2 Sidebar surfacing

- **FR-3.2.a** Every wellness sidebar `Link` must declare its required `wellnessRoles` (and `adminOnly` / `managerOnly` where applicable). The Sidebar already supports this — extend coverage to the items that currently render unconditionally (Channels, Commission Profiles, Revenue Goals, POS, Privacy, Audit Log).
- **FR-3.2.b** Owner sees: full clinical + admin + reports + finance + Owner-only (Plans & Billing, Commission Profiles, Revenue Goals).
- **FR-3.2.c** Admin sees: full operational, minus Owner-only items. Locations, Audit Log, Privacy, Settings remain visible; Plans & Billing, Commission Profiles, Revenue Goals hide.
- **FR-3.2.d** Doctor sees: Clinical group only (Patients, Calendar, Waitlist, Service Catalog, Service Categories, Visits, Working Hours).
- **FR-3.2.e** Professional sees: Own Calendar, Own Visits, Service Catalog (read), Service Categories (read).
- **FR-3.2.f** Telecaller sees: Unified Inbox, WhatsApp Threads, Telecaller Queue, All Leads, Routing Rules, Tasks.
- **FR-3.2.g** Helper sees: Check-in, Visits (today only), Inventory Receipts, Inventory Adjustments.
- **FR-3.2.h** Cashier sees: POS, Invoices (own register), Estimates, Receipts, Patient Wallets (lookup-only — no PHI fields), Gift Cards.

### FR-3.3 Page-level role gates

- **FR-3.3.a** Every wellness page route declares `requiredRoles` and `requiredWellnessRoles` as a frontend route-config attribute; missing-role nav redirects to a dedicated 403 page or to the role's landing route.
- **FR-3.3.b** Unauthorized direct-URL navigation produces a friendly `<RoleAccessDenied>` component (route + role-label visible), NOT a silent-mask empty list.
- **FR-3.3.c** `/wellness/patients` for a USER with no wellnessRole renders the `<RoleAccessDenied>` component with text "Patient records require a clinical role. Ask your admin to grant doctor/professional/telecaller access." (Replaces today's `0 total / No patients match.` + red toast — closes #829.)
- **FR-3.3.d** `/wellness/pos` for a USER without `wellnessRole='cashier'` (and without ADMIN/MANAGER) renders `<RoleAccessDenied>` with text "POS access requires a cashier role." Sidebar hides the entry for these users (FR-3.2.h). (Closes the visibility half of #830.)
- **FR-3.3.e** Backend API: every wellness route that returns sensitive data MUST be gated by `phiReadGate`, `verifyRole`, or `verifyWellnessRole`. No silent-success-with-empty-results — return 403 with a stable code.

### FR-3.4 Data scoping (per-record)

- **FR-3.4.a** Doctor on `/wellness/patients` sees only patients where `Patient.assignedDoctorId === req.user.userId` (existing field). The list-endpoint applies a `WHERE` clause; absent the field, default behavior is "all clinic patients" (current).
- **FR-3.4.b** Professional on `/wellness/visits` sees only `Visit.assignedProfessionalId === req.user.userId`. (Existing field per [routes/wellness.js:1223](../backend/routes/wellness.js#L1223).)
- **FR-3.4.c** Telecaller on `/wellness/leads` sees only leads where `LeadRoutingRule.assignedTelecaller === req.user.userId` or assigned to their team.
- **FR-3.4.d** Helper has no general clinical-history read — only the current-visit check-in / completion endpoints.
- **FR-3.4.e** Admin / Manager / Owner have no per-record scoping (full tenant read).
- **FR-3.4.f** Per-record write scoping (a doctor can only edit their own patients) stays OPEN per `feedback_wellness_phi_policy` — Rishu's product call is required first.

### FR-3.5 UI affordance per role

- **FR-3.5.a** Action buttons hide where the role cannot complete the action — "Complete Sale" hidden for non-cashier, "Approve Refund" hidden for non-admin, "Delete Patient" hidden for non-admin (already enforced backend).
- **FR-3.5.b** Read-only mode for view-but-not-edit roles. E.g., Professional on Service Catalog sees the list but no edit pencil.
- **FR-3.5.c** Disabled action shows a tooltip explaining the required role.
- **FR-3.5.d** Every blocked action attempt (frontend OR backend) writes an `AuditLog` row with `action='ROLE_DENIED'`, `actorId`, `targetResource`, `requiredRole`.

### FR-3.6 Demo seed alignment

- **FR-3.6.a** `admin@wellness.demo` seeded as `role=ADMIN, wellnessRole=null` (already is) — but the Owner-distinct dashboard route must NOT default to the Owner Dashboard for ADMIN. Currently both land on `/wellness`; rework the landing-route logic to discriminate.
- **FR-3.6.b** `user@wellness.demo` seeded as `role=USER, wellnessRole='cashier'` (new — currently `wellnessRole=null`). Demo cashier flow becomes functional end-to-end after this + a seeded Register (covered by sibling PRD).
- **FR-3.6.c** Doctor / professional / helper / telecaller demo users already correctly seeded with their wellnessRoles. Audit + pin in seed-wellness.js comments.
- **FR-3.6.d** Add a smoke-test that walks every demo role's first-login experience end-to-end — confirms each role sees the correct landing, sidebar, and at least one functional primary action.

---

## §4 Non-functional requirements

- **NFR-4.1** Role-aware page render < 300ms; no Owner-UI flash before downgrading to Admin scope.
- **NFR-4.2** Cache role manifest in session storage on login; do not re-fetch on every navigation.
- **NFR-4.3** Every role-blocked action attempt writes an audit log row (FR-3.5.d).
- **NFR-4.4** Backward compatibility: existing tokens / sessions continue to work. The wellnessRole='cashier' change is additive — no existing role values change.
- **NFR-4.5** Frontend `<RoleAccessDenied>` component is single-source-of-truth — every page's missing-role state imports it; no per-page bespoke "you don't have access" markup.
- **NFR-4.6** Migration to the new role taxonomy is reversible — a `feature_flag` toggle gates the demo-seed changes during rollout.
- **NFR-4.7** All wellness role gates surface a stable error `code` (not just a string) — `WELLNESS_ROLE_FORBIDDEN` / `WELLNESS_TENANT_REQUIRED` / `RBAC_DENIED` — so frontends and SDKs can branch on intent without parsing user-visible text. (Existing contract; pin it.)
- **NFR-4.8** Audit log retention for `ROLE_DENIED` events follows the tenant's standard retention policy ([backend/cron/retentionEngine.js](../backend/cron/retentionEngine.js)) — no special handling.

---

## §5 Hand-over requirements / design decisions

### Design decisions (REQUIRE PRODUCT INPUT before implementation)

- **DD-5.1** Cashier role: extend `wellnessRole` enum with `'cashier'` (cheaper, lives on existing column) OR introduce a separate `salesRole` column (cleaner, no enum conflation between clinical + sales semantics). **Recommended:** extend `wellnessRole` for v1 (single-column migration); revisit on Phase 2 if a tenant needs cashier-WITH-clinical role overlay.
- **DD-5.2** Owner singleton vs plural: today `Tenant.ownerId` is conceptually singular but not enforced. Multi-owner permits clinic-chain expansion but complicates billing access + audit-actor disambiguation. **Recommended:** keep singular for v1; revisit when Rishu requests multi-clinic ownership.
- **DD-5.3** Per-tenant role customization (admin defines custom role labels + permission bitmaps): Phase 2 only — explicit out-of-scope here (FR-3.1.d).
- **DD-5.4** Unauthorized-navigation handling: dedicated `/403?role=…&required=…` page OR redirect-to-role-landing OR `<RoleAccessDenied>` inline component? **Recommended:** inline component (FR-3.3.b, NFR-4.5) — clearer than a redirect chain, embeds the required-role explanation, no URL leak about which routes exist.
- **DD-5.5** Data scoping enforcement layer: middleware-only (cleaner, single source) vs middleware + frontend-render-time guard (defense-in-depth, UI doesn't briefly flash unauthorized data). **Recommended:** middleware-only for v1 — the existing `verifyWellnessRole` / `phiReadGate` chain is the canonical enforcement point; frontend guards are advisory only.
- **DD-5.6** USER-role × wellnessRole interaction: today `phiReadGate` whitelists `['doctor','professional','telecaller','admin','manager']` — a USER with NO wellnessRole is denied. If we extend wellnessRole with `'cashier'`, the cashier should NOT pass phiReadGate (cashier is a sales role, not clinical). Verify the gate already correctly omits `'cashier'`.

### Cred chase

- None external.

### Vendor docs

- N/A.

---

## §6 Acceptance criteria

- **AC-6.1** Demo Admin (`admin@wellness.demo`) login → lands on Admin Dashboard distinct from Owner Dashboard. Sidebar hides Plans & Billing, Commission Profiles, Revenue Goals.
- **AC-6.2** Demo User (`user@wellness.demo`) navigates to `/wellness/patients` → sees `<RoleAccessDenied>` component with the role-required text. NO `0 total / No patients match.` fake-empty list. (Closes #829.)
- **AC-6.3** Demo User updated to `wellnessRole='cashier'` → POS sidebar visible, POS page accessible, sale-flow end-to-end (depends on sibling PRD's Register seed). (Closes role half of #830.)
- **AC-6.4** Doctor login → `/wellness/patients` returns only patients assigned to that doctor (`assignedDoctorId === req.user.userId`).
- **AC-6.5** Professional login → `/wellness/visits` returns only visits assigned to that professional.
- **AC-6.6** Unauthorized backend API call returns 403 with stable code (`WELLNESS_ROLE_FORBIDDEN`); audit log row written.
- **AC-6.7** Role-aware sidebar render: hide every item the role cannot action (no "permission denied" toast on click).
- **AC-6.8** New demo-role smoke spec passes: each of OWNER / ADMIN / Doctor / Professional / Telecaller / Helper / Cashier / USER-no-role logs in, sees expected sidebar, completes one primary action without hitting a 403.

---

## §7 Out of scope

- External SSO role-mapping (existing SSO doesn't yet ingest wellnessRole — separate scope).
- Multi-tenant role sharing (each tenant maintains its own role-user assignments).
- Role-based pricing / plan tiers (billing-side concern; separate PRD).
- AI-suggested role for new users on signup (Phase 2 enhancement).
- Per-record write scoping for doctors / professionals — explicitly deferred per `feedback_wellness_phi_policy` until Rishu's product call.
- Custom-role bitmap configurator (FR-3.1.d).

---

## §8 Dependencies

- `verifyRole` middleware ([backend/middleware/auth.js](../backend/middleware/auth.js)) — existing.
- `verifyWellnessRole` middleware ([backend/middleware/wellnessRole.js](../backend/middleware/wellnessRole.js)) — existing.
- `phiReadGate` chain ([backend/routes/wellness.js:212](../backend/routes/wellness.js#L212)) — existing.
- Sidebar `Link` helper's `wellnessRoles` prop ([frontend/src/components/Sidebar.jsx:384](../frontend/src/components/Sidebar.jsx#L384)) — existing.
- `User.wellnessRole` Prisma column ([prisma/schema.prisma:351](../backend/prisma/schema.prisma#L351)) — existing; add `'cashier'` to the comment-documented value list.
- Demo seed alignment ([backend/prisma/seed-wellness.js](../backend/prisma/seed-wellness.js)) — modify per FR-3.6.
- Sibling [PRD_WELLNESS_POS_HARDENING.md](PRD_WELLNESS_POS_HARDENING.md) — supplies the Register-side of the POS journey (#830).
- `feedback_wellness_phi_policy` memory file — bounds the per-record-write deferral.

---

## §9 Open questions

- **OQ-9.1** Should Owner be enforced singular per tenant (DB unique + check) or remain conceptually-singular-but-soft? Decision needed for FR-3.1.c.
- **OQ-9.2** Does `'cashier'` live on `wellnessRole` (cheap, additive) or on a new `salesRole` column (cleaner separation)? Tied to DD-5.1.
- **OQ-9.3** Helper role: full PHI gate (current behavior — denied) or partial PHI on visit-completion-only? Today a helper can complete check-in but cannot see visit history. Verify with Rishu.
- **OQ-9.4** Telecaller role: write access to Lead Activity is clearly required, but should telecaller write to Contact PHI fields (name, phone)? Today they can — verify intent.
- **OQ-9.5** Backward-compat strategy: existing demo users — migrate in-place (`wellnessRole='cashier'` UPDATE on user@wellness.demo) or recreate seed? Either is fine; pick on implementation.
- **OQ-9.6** Should Admin's Audit Log surface include role-denied attempts by lower-tier users (for "who tried to access POS today" intel) or only successful actions?
- **OQ-9.7** Does the frontend `<RoleAccessDenied>` component need a "request access" button that opens a workflow (sends a notification to Admin)? Or is the message-only variant enough for v1?

---

## §10 Status snapshot

- **As of 2026-05-23:** 3 OPEN RBAC bugs from the May 2026 Globussoft demo QA audit (#827, #829, #830). Underlying infrastructure (RBAC + wellnessRole + phiReadGate + sidebar role-gating) is already correctly written and shipped.
- **This PRD:** WRITTEN 2026-05-23 (autonomous cron tick #29). Coordinates the role-scoping remediation across the three issues.
- **Sibling PRD:** [PRD_WELLNESS_POS_HARDENING.md](PRD_WELLNESS_POS_HARDENING.md) — covers the POS Register-configuration half of #830. Both PRDs ship in lockstep to close #830 end-to-end.
- **Path to remediation:** ~5–10 engineering days for FR-3.1 through FR-3.6, gated on product-call resolutions for DD-5.1, DD-5.2, OQ-9.3, OQ-9.4.
- **Phase 1 (this PRD):** Demo seed alignment, sidebar surfacing per role, `<RoleAccessDenied>` component, page-level role gates, cashier-role extension, data scoping for clinical roles.
- **Phase 2 (deferred):** Per-tenant custom roles + bitmaps (FR-3.1.d), per-record write scoping (out-of-scope per `feedback_wellness_phi_policy`), multi-owner support.

### §10.1 Implementation phasing (suggested order)

Sequencing matters because backwards-compat hinges on the demo seed change being deployable independently of the sidebar / page-gate changes:

1. **Foundation — landing route + `<RoleAccessDenied>` component** (1 day). Ship the component as a no-op import target. Add the `Tenant.ownerId` → Owner-Dashboard / ADMIN → Admin-Dashboard landing route discriminator. No surface changes yet — this is plumbing.
2. **Sidebar surfacing** (1.5 days). Add `wellnessRoles` / `adminOnly` props to the items currently rendering unconditionally (Channels, Commission Profiles, Revenue Goals, POS, Privacy, Audit Log). Visual diff only against demo; no API changes.
3. **Page-level gates** (1 day). Wire `<RoleAccessDenied>` into the routes that USER-no-wellnessRole was silent-masking on (Patients first — closes #829; then visits, leads, reports). Backend already returns 403; frontend just renders the structured response.
4. **Cashier role + demo seed** (0.5 day). Add `'cashier'` to the schema column comment + `seed-wellness.js` updates `user@wellness.demo` to `wellnessRole='cashier'`. Sibling PRD's Register seed lands in lockstep — only at this commit does #830 become functional end-to-end.
5. **Per-record clinical scoping** (1.5 days). Doctor/Professional list-endpoint `WHERE` clauses. Backend-only change; existing Owner/Admin paths unaffected.
6. **Demo-role smoke spec** (0.5 day). One Playwright spec per demo role, each completing one primary action. Pins regression on every future deploy.
7. **Audit log `ROLE_DENIED` events** (0.5 day). Middleware writes the log row on every 403. Reports surface in Admin's Audit Log.

Total: ~6.5 engineering days IF design-decision answers arrive cleanly. Add buffer of ~1-2 days for product-call cycles on DD-5.1 / DD-5.2 / OQ-9.3 / OQ-9.4. Final estimate range: 5-10 days as stated in the summary.

### §10.2 Test surface required

- Backend vitest unit tests for `verifyWellnessRole(['cashier'])` (new value).
- API spec `e2e/tests/wellness-rbac-api.spec.js` — every role logs in, hits its primary endpoint, expected status code.
- UI spec `e2e/tests/wellness-rbac-ui.spec.js` — every role's sidebar matches the FR-3.2 surface and primary action is reachable.
- Demo health spec extension — Demo Admin should NOT see Owner-only sidebar items, Demo User should NOT see fake-empty Patients list.
- Smoke spec for cashier role POS end-to-end (paired with sibling PRD's Register-seed coverage).

Per the CLAUDE.md "Standing rules for new code" — every new spec wires into BOTH `deploy.yml` and `coverage.yml` gate-spec lists. The `wiring-spec-into-gate` skill handles the boilerplate.

Refs #827 #829 #830.
