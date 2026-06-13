# PRD — Travel B2B Agent Portal + Corporate Portal

**Status:** DRAFT • **Owner:** Travel vertical squad • **Filed:** 2026-05-23 (tick #21)
**Refs:** GH #905 (P2 Travel Gap — B2B Agent Portal + Corporate Portal) • Travel Stall CRM Roadmap Tier P2 item 10
**Siblings:** [PRD_TRAVEL_BILLING.md](PRD_TRAVEL_BILLING.md) (commission ledger + TDS), [PRD_TRAVEL_QUOTE_BUILDER.md](PRD_TRAVEL_QUOTE_BUILDER.md) (sub-agent markup clone), [PRD_TRAVEL_SUPPLIER_MASTER.md](PRD_TRAVEL_SUPPLIER_MASTER.md) (supplier commission allocation)

---


## Implementation Status (audited 2026-06-13 against HEAD `043b9ab3`)

| Metric | Value |
|---|---|
| Total FRs | 34 |
| ✅ Shipped | **0 (0%)** |
| 🟡 Partial | 0 |
| 🔌 Stub | 0 |
| ❌ Missing | 34 |
| **Net gap** | **34 items (entire PRD)** |
| Primary blocker | **Phase 0** — 7 DD-5.* decisions unresolved (cookie shape, commission ledger schema, markup policy UX, corporate policy editor, approval-chain shape, theming strategy, SUB_AGENT/CORPORATE_USER actor types in audit log) |

No `SubAgent` model, no `CorporateAccount` model, no `/api/portal/b2b/*` route prefix, no `frontend/src/pages/b2b/` topology. Entire portal substrate absent by design — gated on a consolidated 7-DD design session per PRD §5.

**Single source of truth for all gap items + Wave 7 execution plan (post-DD resolution):** [TRAVEL_GAP_CLOSURE_TRACKER.md §5.B2B + §7 Wave 7](TRAVEL_GAP_CLOSURE_TRACKER.md).

---

## §1 Background + source attribution

### Current state (shipped)
- **Operator surface only.** Today the CRM exposes one logged-in surface — operators (admins, managers, reps, telecallers, doctors/professionals in the wellness vertical) — and one public surface, the Wellness PatientPortal (`/portal`, `frontend/src/pages/wellness/PatientPortal.jsx` + `backend/routes/wellness.js:5585-5800`, phone+OTP, scoped to one Patient's own visits/Rx/consents).
- **No B2B surface.** There is no sub-agent login, no corporate-account login, no commission ledger, no per-corporate travel-policy table, no multi-traveler-per-booking model. The Public Booking URL (`/book/:slug`) and Microsite infrastructure are anonymous-public (lead-capture only); they are NOT a logged-in B2B surface.
- **Tenant.subBrandConfigJson** (shipped tick #20, commit `621aab7`) holds 4-sub-brand routing — TMC / RFU / Travel Stall / Visa Sure — and a `subBrandAccess[]` array per User scoping which sub-brands an operator can see (per Q25 of the Travel PRD). This is the model the B2B portals will extend with two new principal types (sub-agent + corporate) outside the operator User table.
- **RBAC roles.** `User.role ∈ { ADMIN, MANAGER, USER }` (the standard CRM RBAC). Wellness vertical adds an orthogonal `wellnessRole ∈ { doctor, professional, telecaller, helper }`. No AGENT or CORPORATE_USER role exists.

### Why a PRD for what looks like a portal CRUD
GH #905's acceptance bullets read like five UI features ("sub-agents log in, see catalogue, book on commission, see ledger" / "corporates see only their bookings, 1-step approval, consolidated invoices"). Underneath are 7+ load-bearing design calls (DD-5.1 portal frontend topology, DD-5.2 tier model, DD-5.3 commission settlement timing, DD-5.4 corporate policy editor, DD-5.5 approval chain shape, DD-5.6 expense report format, DD-5.7 traveler-profile sharing). Pinning these in §5 saves a 3-5 day discovery cycle once implementation starts. Sub-agent and corporate are also two distinct sub-products that happen to share a portal-shell substrate — clarifying which features belong to which avoids accidental scope-merge during impl.

### Source attribution
- GH #905 issue body (verbatim ACs in §6 below).
- Travel Stall CRM — Implementation & Modification Roadmap (Google Doc) — Tier P2, item 10.
- Wellness PatientPortal (`backend/routes/wellness.js:5585-5800`) — canonical phone+OTP + portal-JWT + scoped-route pattern to mirror.

---

## §2 Use cases

### Sub-agent personas

#### 2.1 Sub-agent self-service login + dashboard
Vinay (TMC sub-agent in Pune, reseller for a school-trips operator) logs in via phone+OTP, lands on his B2B dashboard: his own pipeline (8 deals he's sourced), his commission ledger (₹47k accrued this month, ₹18k settled, ₹29k pending), his credit limit (₹2L, 65% used), his current tier (Gold — 10% commission rate). Last 3 monthly statements are downloadable as PDFs.

#### 2.2 Sub-agent quote with markup
Vinay searches the catalogue for "Bali 7N family", sees the wholesale package at ₹85k/pax. He hits "Apply my markup" → his tier-configured max-markup is 18%; he picks 12% → end-customer quote shows ₹95.2k/pax with NO wholesale price leak on the customer-facing PDF. Quote is sent to the school principal via WhatsApp+email; on accept, deal auto-attributes to Vinay's sub-agent account.

#### 2.3 Sub-agent commission accrual + monthly statement
On the 1st of every month, a cron run (`b2bCommissionEngine`) closes the prior month's ledger: confirmed-and-paid bookings accrue commission per the sub-agent's tier rate, TDS deducted if YTD > ₹15k (per Section 194H), statement PDF generated and emailed. Vinay's portal shows the new statement immediately; CRM operator sees the same statement in the Sub-Agent Detail view.

#### 2.4 Sub-agent lead self-creation
Vinay captures a walk-in lead in his portal — name, phone, package interest. Lead lands in the operator CRM tagged with `source=SUB_AGENT_VINAY` and `subAgentId=42`. Operator-side rep picks it up; on conversion, commission attribution is automatic via `subAgentId` foreign key.

### Corporate personas

#### 2.5 HR books for 5 employees (multi-traveler)
Priya (HR at Globussoft Bangalore) logs in via corp-email-OTP, books a 3-day Goa conference for 5 engineers. The portal renders a multi-traveler form: 5 named-employee slots, each linked to the corporate's cached employee directory. One booking envelope, 5 traveler-tickets. Invoice billed to Globussoft Corp; spend hits the "Engineering offsite" cost-center bucket.

#### 2.6 Travel-policy enforcement + approval
Priya picks a 5-star hotel for one of the 5 travelers (₹18k/night). Corporate policy caps hotel-class at 4-star OR ≤₹12k/night for non-leadership roles → portal blocks immediate booking, opens an Approval Request to the Finance approver (Suresh). Suresh sees the violation reason ("hotel-class cap exceeded for non-leadership traveler") + 1-click Approve / Decline. On approve, booking confirms; on decline, Priya gets a notification with reason.

#### 2.7 Corporate expense report
End of FY26-Q1, Priya pulls a per-employee report: 12 trips, ₹3.4L total spend, broken down by employee + cost-center. Exports to CSV in her corporate's standard column layout (DD-5.6). The report includes per-trip GST line for input-tax-credit reclamation.

#### 2.8 Corporate dashboard
Suresh (Finance lead) opens the corporate dashboard: ₹3.4L FY26-Q1 spend (against ₹5L Q1 budget — 68%), 4 bookings in-flight (1 awaiting approval), 12 confirmed traveler tickets across the next 30 days. KPI tile drill-downs surface per-employee and per-cost-center breakdowns.

### Hybrid / edge cases

#### 2.9 Sub-agent gets a corporate as a customer
Vinay sources a corporate lead (a school sending a teacher delegation). The deal converts; the corporate account is now linked to BOTH Vinay (as sub-agent receiving commission) and the corporate (as the end customer). Both portals show the booking from their respective angle — Vinay sees a commission accrual; HR at the school sees the booking in their corporate portal.

#### 2.10 Sub-agent operator-credit-limit hit
Vinay's outstanding payable to the operator (commissions accrued but not yet paid through to customer) exceeds his ₹2L credit limit. Portal blocks new bookings with a "settle pending invoices first" notice; operator gets a notification to chase or extend credit.

---

## §3 Functional requirements

### FR-3.1 Sub-agent core (account + auth)
- **FR-3.1.1** Sub-agent registration: operator-onboarded (default) OR self-signup with operator-approval queue. Pending sub-agents cannot log in.
- **FR-3.1.2** Sub-agent profile: business name, GSTIN, PAN, payment terms (Net 15 / 30 / 60), bank-account details (for commission payout), tier (silver / gold / platinum), per-tier commission rate, credit limit.
- **FR-3.1.3** Sub-agent login via phone+OTP — mirror `wellness.js:5630` `/portal/login` flow exactly. Issue a 30-day `B2B_PORTAL_JWT_SECRET`-signed token containing `{ subAgentId, phoneLast10, kind: 'SUB_AGENT' }`.
- **FR-3.1.4** Per-portal-user middleware `verifySubAgentToken` (mirror `verifyPatientToken`) — attaches `req.subAgent = { id, tenantId }`; all scoped routes use it.
- **FR-3.1.5** Sub-agent password-reset / phone-change flow via OTP-to-old-then-new-number challenge.

### FR-3.2 Sub-agent commission ledger
- **FR-3.2.1** Per-tier commission rate (silver = 5%, gold = 10%, platinum = 15%; configurable per tenant).
- **FR-3.2.2** Commission accrual: trigger fires on booking confirmation (Deal moves to "Booked"), creates a `SubAgentCommission` row with `status=ACCRUED`.
- **FR-3.2.3** Commission settlement: when customer pays in full, row flips to `SETTLED`; partial-payment increments `settledAmount` proportionally.
- **FR-3.2.4** Monthly commission statement: cron `b2bCommissionEngine` on 1st-of-month UTC, generates per-sub-agent PDF (operator branding + sub-agent business name + line-by-line bookings + commissions + TDS + net payable). PDF stored at `uploads/commission-statements/<subAgentId>/<YYYY-MM>.pdf` + emailed.
- **FR-3.2.5** TDS deduction: when YTD-commission > ₹15k (Section 194H threshold), deduct 5% TDS, surface in statement. Cross-ref to PRD_TRAVEL_BILLING §3 TCS module for shared 26AS reconciliation logic.
- **FR-3.2.6** Sub-agent can dispute a statement line within 7 days — opens a Ticket assigned to the operator finance team.

### FR-3.3 Sub-agent margin policy (markup)
- **FR-3.3.1** Configurable max-markup % per package-type (tenant-level), per-sub-agent override allowed.
- **FR-3.3.2** Sub-agent quote builder: read wholesale unit-price, apply markup %, generate customer-facing quote PDF. Wholesale price NEVER appears in customer PDF.
- **FR-3.3.3** Operator override: operator can mark a specific package "non-resellable" — sub-agents see it greyed in catalogue with an explanatory tooltip.
- **FR-3.3.4** Sub-agent quote-clone audit: every clone-with-margin operation writes an `AuditLog` entry recording `{originalQuoteId, subAgentId, marginPct, customerFacingTotal}`.

### FR-3.4 Corporate core (account + auth)
- **FR-3.4.1** Corporate account onboarding (operator-managed only — no self-signup). Profile: legal name, GSTIN, PAN, billing address, credit limit, primary contact, contract-end-date.
- **FR-3.4.2** Multiple users per corporate account, each with role `HR | FINANCE | APPROVER | TRAVELER`. Roles are orthogonal to CRM `User.role` (corporates are a separate principal type).
- **FR-3.4.3** Corporate login via corp-email-OTP (mirror PatientPortal OTP pattern but channel = email, not SMS — DD-5.1.b confirms email is acceptable for B2B persona).
- **FR-3.4.4** Per-portal-user middleware `verifyCorporateToken` — attaches `req.corporateUser = { id, corporateAccountId, role, tenantId }`.
- **FR-3.4.5** Traveler profile cache per corporate account: name, DOB, passport#, frequent-flyer numbers, dietary preferences. Reused across bookings; auto-fills the multi-traveler form. Editable by HR; auditable.

### FR-3.5 Travel policy enforcement
- **FR-3.5.1** Per-corporate policy table: hotel-class cap (1–5 star), max per-night INR cap, fare-class cap (economy / premium-economy / business / first), airline whitelist (array of IATA codes), per-trip cap, per-FY cap, per-traveler-role cap (leadership-vs-other).
- **FR-3.5.2** Policy editor surface — DD-5.4 chooses between in-app form / JSON upload / spreadsheet upload.
- **FR-3.5.3** On booking attempt, policy validator runs server-side. Violations either (a) block outright OR (b) trigger an Approval Request to the corporate's approver (DD-5.5 picks one).
- **FR-3.5.4** Approval workflow: approver receives notification (in-app + email + WhatsApp via existing Notification stack), 1-click approve/decline, decision audited.

### FR-3.6 Expense reporting
- **FR-3.6.1** Per-employee expense report: trip count, total spend, per-trip line items, GST line for ITC reclamation.
- **FR-3.6.2** Per-cost-center report: sum across all employees tagged to that cost-center.
- **FR-3.6.3** Per-FY summary: rolled-up totals + month-over-month trend.
- **FR-3.6.4** Export formats: CSV (default), JSON (for ERP integration), PDF (signed by operator for compliance).
- **FR-3.6.5** Optional per-corporate column-mapping template (DD-5.6) — corporate uploads their CSV header preferences, exports match those exactly.

### FR-3.7 Portal infrastructure (shared)
- **FR-3.7.1** Route prefix split: `/api/portal/b2b/sub-agent/*` and `/api/portal/b2b/corporate/*` — keeps the two sub-products' contracts disjoint.
- **FR-3.7.2** Two new Prisma models: `SubAgent` + `CorporateAccount` + `CorporateUser` + `SubAgentCommission` + `CorporatePolicy` + `CorporateTravelerProfile` + `CorporateExpenseReport`.
- **FR-3.7.3** Frontend topology — DD-5.1 picks new React app (`apps/b2b-portal/`) vs new route prefix in existing app (`/portal/b2b/sub-agent/*`, `/portal/b2b/corporate/*`).
- **FR-3.7.4** Per-portal-user audit log: every B2B portal action writes an `AuditLog` row with `actor=SUB_AGENT|CORPORATE_USER`, `actorId`, action, payload. Required for B2B contractual compliance (corporates audit our audit trail).
- **FR-3.7.5** Per-sub-brand theming (per #905 acceptance bullet 5) — portal reads sub-brand from sub-agent's parent-brand assignment / corporate's contracting brand and applies brand colors + logo + footer.

---

## §4 Non-functional requirements

- **NFR-4.1** Portal frontend mobile-responsive — HR personas commonly book from mobile, sub-agents from mid-range Android. Tested at 360px / 768px / 1280px viewports.
- **NFR-4.2** Sub-agent monthly commission run must process 10k agents in <30 min on the production database — that's the upper end of platinum tenant scale.
- **NFR-4.3** Per-portal-user session isolation: under no path may sub-agent A see sub-agent B's data; corporate X's HR may not see corporate Y's bookings. Enforced via middleware-attached `req.subAgent.id` / `req.corporateUser.corporateAccountId` on every scoped route.
- **NFR-4.4** Portal JWT scoped to B2B namespace only — must NOT be accepted by operator-side routes (and vice versa). Use a different `JWT_SECRET` env var (`B2B_PORTAL_JWT_SECRET`).
- **NFR-4.5** Per-portal-user audit log entries retained for 7 years (sub-agent contracts) / corporate-contract-duration (whichever is longer). Cross-ref retention engine.
- **NFR-4.6** Brute-force protection on OTP-verify: 10 attempts per 10 min per IP (mirror `portalVerifyOtpLimiter` at `wellness.js:5615`).
- **NFR-4.7** Sub-brand-theme switch must complete in <100ms (CSS variable swap, no full reload).

---

## §5 Hand-over reqs / cred chase / design decisions

### DD-5.1 Portal frontend topology — new React app vs new routes
- **Option A:** New React app under `apps/b2b-portal/` (or `frontend/b2b/`). Pros: clean separation, independent bundle, can be domain-routed (`b2b.crm.globusdemos.com`) for white-labelling. Cons: duplicated build pipeline + auth helpers + design-system copy.
- **Option B:** New routes inside existing app (`/portal/b2b/sub-agent/*`, `/portal/b2b/corporate/*`). Pros: shared design-system + auth utilities + build. Cons: bundle bloat for B2B users (they load operator-side code they'll never use), harder white-labelling.
- **Recommended:** Option B for v1 (lower MVP cost), with a future-fork plan documented if white-label sub-domain becomes a hard requirement. Mirrors how PatientPortal is currently a route inside the main app.
- **Owner:** Product + Frontend lead.

### DD-5.2 Sub-agent tier model — rule-based or operator-curated
- **Option A:** Rule-based (auto-tier on cumulative-volume thresholds: silver < ₹50L YTD, gold < ₹2Cr YTD, platinum >). Pros: automatic, no operator overhead. Cons: rigid, hard to reward newcomers strategically.
- **Option B:** Operator-curated (operator manually assigns tier per sub-agent). Pros: relationship-aware. Cons: operator overhead.
- **Recommended:** Hybrid — rule-based default with operator override field. Default cron suggests tier promotions monthly; operator approves.
- **Owner:** Business + Operator-leads.

### DD-5.3 Commission settlement timing
- **Option A:** At-booking (sub-agent gets commission as soon as deal moves to Booked). Risk: refund/cancellation later requires clawback.
- **Option B:** At-customer-payment (commission settles only when customer has paid in full). Safer; what most travel-industry contracts default to.
- **Option C:** At-month-end (commission accrues throughout the month, settles via the monthly statement run on the 1st).
- **Recommended:** Option B with Option C statement cadence — accrue at-booking, settle at-customer-payment, statement on 1st-of-month aggregates settled-during-prior-month.
- **Owner:** Finance + Operator-leads.

### DD-5.4 Corporate policy editor surface
- **Option A:** In-app form (operator-side UI, single page with field-by-field input).
- **Option B:** JSON upload (corporate uploads policy JSON; engineering provides a schema doc).
- **Option C:** Spreadsheet upload (Excel template, parsed server-side).
- **Recommended:** Option A for v1; add Option C in v2 once policy structure stabilizes.
- **Owner:** Product + Corporate-customer interviews.

### DD-5.5 Approval workflow chain shape
- **Option A:** Linear single approver — one approver receives the request, decides, done.
- **Option B:** Multi-stage (manager → finance → leadership) — sequential, each level approves.
- **Option C:** Configurable per corporate.
- **Recommended:** Option C, with Option A as the default template.
- **Owner:** Product + Corporate-customer interviews.

### DD-5.6 Expense report format
- **Option A:** Per-corporate template — each corporate uploads their CSV column-mapping; export matches exactly.
- **Option B:** Standard CSV — one canonical layout, corporates adapt downstream.
- **Recommended:** Option B for v1; Option A in v2.
- **Owner:** Product + Finance lead.

### DD-5.7 Traveler-profile sharing scope
- **Option A:** Corp-scoped — each corporate maintains its own traveler directory. Privacy-preserving but duplicate-data across corporates.
- **Option B:** Cross-corp shared — one master traveler-profile keyed by passport#. Better data quality but GDPR-equivalent concern.
- **Recommended:** Option A (per-corporate-scoped) — safer default; revisit if data quality becomes painful.
- **Owner:** Product + Privacy.

### Cred chase
- None external. All design calls are internal product / business decisions.

### Vendor docs
- None (internal feature).

---

## §6 Acceptance criteria

- **AC-6.1** Sub-agent at silver tier (5% commission rate) sees ₹2,500 commission accrued on a confirmed ₹50,000 wholesale-priced booking.
- **AC-6.2** Sub-agent applies 12% markup on ₹1,00,000 wholesale package → end-customer quote PDF shows ₹1,12,000 grand total with NO wholesale price visible anywhere in the PDF (verified via grep on the PDF text extract).
- **AC-6.3** HR at corporate X books 5 named employees for one conference → 1 booking envelope + 5 traveler-tickets renders correctly; per-traveler profiles auto-fill from cached directory.
- **AC-6.4** Booking exceeds corporate policy (hotel-class cap) → approval request sent to corporate's approver; on Approve, booking confirms within 10s; on Decline, HR sees decline-reason within 10s.
- **AC-6.5** Per-employee FY26-Q1 expense report exports to CSV with row count = sum of employee's confirmed bookings; total spend column = sum of per-booking grand totals; GST column = sum of per-booking IGST + CGST + SGST.
- **AC-6.6** Sub-agent monthly commission statement PDF generated on 1st-of-month UTC; statement total = sum of prior month's `SETTLED` commission rows minus TDS; sub-agent receives email with PDF attached within 1 hour of cron run.
- **AC-6.7** Sub-agent A's JWT, when used against a route scoped to sub-agent B, returns 404 (not 403 — don't leak existence of other sub-agents). Same for corporate-isolation.
- **AC-6.8** B2B portal JWT cannot be used to call operator-side routes — operator middleware rejects with 401 + `code: "WRONG_PRINCIPAL_TYPE"`.
- **AC-6.9** Per-sub-brand theming: sub-agent assigned to TMC sub-brand sees TMC logo + colors; switching sub-agent's parent-brand assignment to RFU updates the portal theme on next page load.
- **AC-6.10** Audit log: every B2B portal action (login, quote-clone, booking-attempt, policy-violation, approval-decision) creates an `AuditLog` row with `actor=SUB_AGENT|CORPORATE_USER` and the actor's ID; spec verifies 8 representative actions all generate audit entries.

---

## §7 Out of scope

- **OOS-7.1** White-label portal branding beyond sub-brand theme (custom domain, per-sub-agent custom CSS) — separate FR, Phase 2.
- **OOS-7.2** Sub-agent-to-sub-agent referral / sub-sub-agent hierarchy.
- **OOS-7.3** Corporate-to-corporate booking sharing (one corporate referring travel to another).
- **OOS-7.4** AI suggestions in the B2B portal ("recommend a package for this traveler profile") — separate AI feature.
- **OOS-7.5** Mobile native app (iOS/Android) — out of v1 scope; mobile-responsive web is the v1 surface.
- **OOS-7.6** Sub-agent training / certification module — separate feature.
- **OOS-7.7** Direct supplier-side commission split (e.g. hotel pays us 8%, we pay sub-agent 5%) — handled in PRD_TRAVEL_SUPPLIER_MASTER, not here.

---

## §8 Dependencies

- **D-8.1** PatientPortal pattern (`backend/routes/wellness.js:5585-5800`) — canonical phone+OTP login + portal-JWT + per-principal middleware + scoped routes. New B2B middleware (`verifySubAgentToken`, `verifyCorporateToken`) mirrors `verifyPatientToken`.
- **D-8.2** [PRD_TRAVEL_BILLING.md](PRD_TRAVEL_BILLING.md) — commission ledger persistence + TDS deduction + 26AS reconciliation logic shared between sub-agent commission and supplier TCS.
- **D-8.3** [PRD_TRAVEL_QUOTE_BUILDER.md](PRD_TRAVEL_QUOTE_BUILDER.md) — sub-agent markup-clone-with-margin flow (§2.6 of that PRD).
- **D-8.4** [PRD_TRAVEL_SUPPLIER_MASTER.md](PRD_TRAVEL_SUPPLIER_MASTER.md) — supplier-side commission attribution (when a sub-agent's booking has supplier-paid commission, both ledgers reconcile).
- **D-8.5** Notification service (`backend/services/notificationService.js` + WhatsApp + email + push) — approval-request notifications + statement-ready emails.
- **D-8.6** Audit log (`backend/lib/audit.js`) — already supports arbitrary `actor` strings; minor extension to surface `SUB_AGENT|CORPORATE_USER` actor types in the Audit Viewer.
- **D-8.7** PDF renderer (`backend/services/pdfRenderer.js`) — extended with two new templates: commission statement, expense report.
- **D-8.8** `Tenant.subBrandConfigJson` + `User.subBrandAccess[]` (shipped tick #20, `621aab7`) — per-sub-brand theming infrastructure.
- **D-8.9** New role `AGENT` in RBAC (per #905 AC bullet 1) — additive enum extension, deploy-gate-blessed via `[allow-enum-extend]` marker.

---

## §9 Open questions

- **OQ-9.1** Sub-agent privacy: if sub-agent A and sub-agent B both source leads from the same end-customer (e.g. the same school), can either see the other's lead? Likely no — leads are sub-agent-scoped. But: what happens when end-customer signs the same contract through both? Need a "duplicate-sub-agent attribution" policy.
- **OQ-9.2** Corporate traveler-profile data retention: GDPR-equivalent residency requirement for passport / frequent-flyer numbers? Default 7 years post-last-trip; corporates may want shorter.
- **OQ-9.3** Hybrid sub-agent + corporate principal: can the same legal entity be BOTH a sub-agent reselling our packages AND a corporate buying for own staff? If yes, do they get two logins or one unified portal?
- **OQ-9.4** Mobile vs desktop feature parity: do corporates need full feature parity on mobile (expense reports, policy editor) or is mobile booking-focused / desktop admin-focused?
- **OQ-9.5** Sub-agent onboarding training: do we ship in-app guided onboarding (interactive tour) or just docs + Loom videos? Affects scope by ~3-5 eng-days.
- **OQ-9.6** Corporate SSO: do enterprise corporates require SSO (SAML / OIDC) instead of email+OTP? Adds 5-8 eng-days if yes for v1.
- **OQ-9.7** Multi-tenancy of B2B portal: if our platform runs multiple Travel-vertical tenants (e.g. TMC's parent operator + a separate Travel Stall tenant), does a single sub-agent log in once and see all tenants they're attached to, or one login per tenant?

---

## §10 Status snapshot + path to implementation

### Current
- Zero B2B portal surface. No sub-agent login, no corporate login, no commission ledger, no policy table, no multi-traveler bookings.
- Operator-side surface only; PatientPortal provides the canonical portal-shell pattern to mirror.
- `Tenant.subBrandConfigJson` (shipped tick #20) provides the per-sub-brand theme infrastructure; B2B portal extends rather than reinvents.

### This PRD
- WRITTEN 2026-05-23 (tick #21).
- 7 design decisions (DD-5.1 through DD-5.7) require product calls before backend implementation begins.
- 7 open questions (OQ-9.1 through OQ-9.7) require business + privacy + product alignment.

### Path to implementation (very heavy — 25-45 engineering days)

| Phase | Scope | Days |
|-------|-------|------|
| Phase 0 — Design calls | Resolve DD-5.1 / 5.4 / 5.5 (load-bearing for impl topology); resolve OQ-9.6 (SSO scope) | 3-5 |
| Phase 1 — Sub-agent MVP | Sub-agent model + auth + dashboard + commission ledger (accrual only, no statement run yet) | 7-10 |
| Phase 2 — Sub-agent quote-clone + markup | Wire to Quote Builder; sub-agent markup PDF rendering | 4-6 |
| Phase 3 — Sub-agent monthly statement + TDS | Cron + PDF + email; reconciliation with Billing PRD's TCS logic | 4-6 |
| Phase 4 — Corporate MVP | Corporate account + multi-user + multi-traveler booking | 5-7 |
| Phase 5 — Travel policy + approval | Policy table + validator + approval workflow + notifications | 4-6 |
| Phase 6 — Expense reporting | Per-employee/cost-center/FY reports + CSV/JSON/PDF exports | 3-5 |
| Phase 7 — Per-sub-brand theming + audit + hardening | Sub-brand theme propagation + audit hooks + spec coverage | 3-5 |

### Sibling PRDs + cross-refs
- [PRD_TRAVEL_BILLING.md](PRD_TRAVEL_BILLING.md) — §3 commission ledger schema + TDS deduction.
- [PRD_TRAVEL_QUOTE_BUILDER.md](PRD_TRAVEL_QUOTE_BUILDER.md) — §2.6 sub-agent clone-with-margin flow.
- [PRD_TRAVEL_SUPPLIER_MASTER.md](PRD_TRAVEL_SUPPLIER_MASTER.md) — supplier-side commission allocation.

### Blocks
- Phase 1 blocked on DD-5.1 (frontend topology).
- Phase 5 blocked on DD-5.4 (policy editor) + DD-5.5 (approval chain).
- Phase 6 blocked on DD-5.6 (expense format).

### Next concrete action
Product + Frontend-lead 1:1 to resolve DD-5.1 (new app vs new routes) — this gates the implementation topology entirely and can be unblocked in a 30-min call.
