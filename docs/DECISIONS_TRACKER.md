# Design Decisions Tracker

Consolidated index of every product/design decision flagged across the 22 PRDs in `docs/`. Use this to drive product-call agendas — each row is something the product team needs to settle before the corresponding PRD can move to (or finish) implementation.

**Updated:** 2026-05-25 (interactive Q&A across 6+1 rounds — 26 decisions captured; all previously-flagged ⚠️ items resolved or formally deferred; implementation sequencing for the 2 biggest multi-day clusters also locked in)
**Total decisions:** 218 tracked (192 prior + 26 new from 2026-05-25 Q&A — 24 in rounds 1-6 + 2 in round 7 sequencing). **RESOLVED: 217**. **DEFERRED: 1** (AI Surfaces DD-5.6 EU residency — formally deferred until first EU tenant signs). **NEEDS PRODUCT CALL: 0** — every previously-flagged item is settled.

**Previous header retained for context:** 2026-05-24 bulk-resolve session applied PRD recommendations as default for 116 decisions; flagged 5 items as ⚠️ NEEDS PRODUCT CALL. All 5 (plus a 6th uncounted) now resolved in the 2026-05-25 Q&A.

**Cron is fully unblocked**: every PRD's design decisions are settled. Engineering can proceed on any PRD per its resolved-recommendations. The 2 PRDs without surfaced decisions remain WHATSAPP + DIGILOCKER_USE_CASE (pure cred-chase + use-case narrative).
**Format note:** PRDs use three competing naming conventions for decisions — `DD-5.X` (newer Travel-vertical PRDs), `DC-N` (mid-cycle PRDs), `PC-N` / `D-N` (earliest PRDs). This tracker preserves the source ID so cross-references stay clickable; consider standardising to `DD-` in future PRDs.

---

## How to use this tracker

- **Drive product-call agendas** — group decisions by THEME (auth, billing, AI model selection, fork-vs-extend) and settle them in batches. Several themes have 3-4 decisions across sibling PRDs that interlock; deciding one in isolation leads to re-thrash.
- **Mark decisions RESOLVED inline** — when a call lands, edit the row from `[PENDING]` → `[RESOLVED 2026-MM-DD: <one-line rationale>]` and link the PR/commit that ratifies the decision. Keep the original recommendation text for context.
- **Link back to source PRD** — each entry references the source-PRD file. Open the PRD's §5 for full context (trade-off matrix, owner, blocking-relationships).
- **Don't promote without a third datapoint** — when adding new decision rows from a new PRD, follow the source PRD's existing convention (don't rename DC- → DD-). Standardisation is a separate exercise.
- **Cred-chase items are NOT in this tracker** — those are separate (e.g. Q9 WhatsApp creds, Q19 RateHawk key). This file is decisions-only. A sibling `docs/CREDS_TRACKER.md` could be authored if useful.

---

## 2026-05-25 — Interactive Q&A session (24 decisions captured)

The user ran an interactive product-call session across 6 rounds, settling all 6 previously-flagged ⚠️ items + 18 newer decisions surfaced by the 2026-05-24/25 cron arc PRDs. All decisions below are RESOLVED unless explicitly DEFERRED.

### Round 1 — Schema topology + AI residency + GST shape

- **PRD_POS_POLYMORPHIC_INVOICE DD-5.2** [RESOLVED 2026-05-25: **Rename existing `Invoice` → `DealInvoice` (clean fork)**. Two distinct models: wellness POS gets first-class polymorphic Invoice + InvoiceLine + Payment; generic CRM's existing Deal-attached billing model renames to DealInvoice. Migration: ~30d back-compat adapter on routes/billing.js + routes/invoices.js + Billing.jsx + Invoices.jsx. Cleanest long-term.] Invoice model rename vs `kind` discriminator vs parallel `PosInvoice`. Rec: rename (this matches the user's call).
- **PRD_BIOMETRIC_ATTENDANCE Q1 / Zylu DD-5.6** [RESOLVED 2026-05-25: **ESSL + Realtime multi-vendor matrix**. Adapter pattern from day 1; covers ~80% of Indian clinics. ~2x v1 engineering vs ESSL-only but no migration when a new tenant brings Realtime hardware. Yasin chases docs from both vendors.] Biometric device vendor. Rec: ESSL only (PRD); user picked multi-vendor.
- **PRD_MINI_WEBSITE DD-5.5** [RESOLVED 2026-05-25: **React-SSR (Next.js-style or Vite SSR)**. Best DX (same React components for operator + public side) + best SEO. ~+2 days infrastructure work over CSR. Drives mini-site public render at /m/<slug>.] Public render layer for customer-facing mini-site. Rec: SSR (matches user pick).
- **PRD_POS_POLYMORPHIC_INVOICE DD-5.4** [RESOLVED 2026-05-25: **CGST/SGST/IGST 3 nullable cents columns + total**. Each InvoiceLine gets cgstAmountCents, sgstAmountCents, igstAmountCents (all nullable), plus taxAmountCents as sum. India-default ON; non-India tenants leave the 3 split columns NULL. Future E-invoice GSTN-API compat is trivial.] Indian GST tax shape per InvoiceLine. Rec: split (matches user pick).

### Round 2 — Plans & Billing trio + Void/Refund actor matrix

- **PRD_PLANS_BILLING_SELF_SERVE DD-5.5** [RESOLVED 2026-05-25: **Per-Organization (NEW parent model can span multiple tenants)**. NEW Organization Prisma model parents N Tenants. Single Stripe customer/subscription per Org. Migration: every existing tenant gets a default 1-1 Organization. ~3-5 eng-days extra v1 scope.] Subscription scoping — per-Tenant vs per-Organization. Was ⚠️ NEEDS PRODUCT CALL; now resolved.
- **PRD_PLANS_BILLING_SELF_SERVE DD-5.2** [RESOLVED 2026-05-25: **Cancel at period end + no refund + grace login until expiry**. Standard SaaS pattern. Tenant keeps full access until billing-period end; on expiry, login allowed but read-only for 30 days, then data archived. Industry default; least operational complexity.] Cancellation policy. Was ⚠️ NEEDS PRODUCT CALL; now resolved.
- **PRD_PLANS_BILLING_SELF_SERVE DD-5.4** [RESOLVED 2026-05-25: **Per-record counting + sliding 30-day window + cap-only (no overage)**. Count Contacts/Leads/Patients/etc. as snapshot every API call. At cap, writes return 402 with upgrade prompt. No overage charges. Simplest billing reconciliation.] Usage metering granularity. Was ⚠️ NEEDS PRODUCT CALL; now resolved.
- **PRD_POS_POLYMORPHIC_INVOICE DD-5.7** [RESOLVED 2026-05-25: **ADMIN-only void + ADMIN-only refund (strict)**. All voids and refunds require ADMIN role. Cashier mistakes route through ADMIN approval. Best for compliance-sensitive tenants. Slowest cashier UX accepted.] Void/refund actor matrix. Rec: cashier-window (PRD); user picked strict ADMIN.

### Round 3 — Mini-Site scope + Biometric refactor + AI EU residency deferral

- **PRD_AI_SURFACES DD-5.6** [DEFERRED 2026-05-25: **Cross EU bridge when first EU tenant signs**. No EU tenant in current pipeline; building the EU adapter pre-emptively is premature. Risk: salesperson loses an EU deal because we can't show GDPR compliance day 1 — accepted since pipeline is India-first.] EU LLM residency (OpenAI EU / Anthropic EU / Gemini EU). Was ⚠️ NEEDS PRODUCT CALL; now formally DEFERRED with explicit re-trigger condition.
- **PRD_MINI_WEBSITE DD-5.2 / Zylu DD-5.8** [RESOLVED 2026-05-25: **Per-Location (chain clinic gets N mini-sites)**. Each clinic location has its own mini-site at /m/<slug>. MiniWebsiteConfig.locationId FK. Matches Zylu pattern; operators want per-location marketing.] Per-Location vs per-Tenant mini-site scope. Was ⚠️ NEEDS PRODUCT CALL; now resolved.
- **PRD_MINI_WEBSITE DD-5.1** [RESOLVED 2026-05-25: **Extend existing BookingPage Wave-7D columns**. BookingPage already has logoUrl, heroImageUrl, heroHeadline from Wave-7D. Just add the missing fields (theme, service-ordering, contactInfo, customCss). No new model. Back-compat free.] Schema shape — extend BookingPage vs new MiniWebsiteConfig. Rec: extend (matches user pick).
- **PRD_BIOMETRIC_ATTENDANCE DD-5.6** [RESOLVED 2026-05-25: **Full refactor — migrate existing rows to event-stream, single source of truth**. One-shot migration: each existing Attendance row becomes 1-2 AttendanceEvent rows. New code reads ONLY events. Cleanest long-term. ~+3 eng-days for migration + testing. Existing payroll/reporting needs rewiring.] Event-stream refactor scope. Rec: cohabit (PRD); user picked full refactor.

### Round 4 — Strategic direction

- **NEW-DD MOBILE STRATEGY** [RESOLVED 2026-05-25: **Native mobile app from scratch**. Biggest investment (3-6 months for v1). Best mobile UX but slowest path to value. Defers other work substantially. Mobile is THE growth lever per user direction.] Mobile reach approach. Drives a major resource shift.
- **NEW-DD PAYMENTS ROLLOUT** [RESOLVED 2026-05-25: **Single tenant pilot first (Enhanced Wellness) — then expand**. Activate Stripe + Razorpay for Rishu's Enhanced Wellness tenant ONLY. Use real payments for 4-6 weeks to validate. If clean, generalize the per-tenant config UI (PRD_PAYMENT_GATEWAY_CONFIG) and roll to other tenants.] #896 Stripe/Razorpay activation rollout plan.
- **NEW-DD TRAVEL SUB-BRAND PRIORITY** [RESOLVED 2026-05-25: **All 4 sub-brands as priority** (TMC + RFU + Travel Stall + Visa Sure). Engineering effort splits 4 ways simultaneously instead of focusing on one. Implication: each sub-brand gets ~25% of available capacity; longer time-to-completeness per brand vs depth-first model.] Travel vertical Phase 2 focus.
- **NEW-DD NEXT VERTICAL** [RESOLVED 2026-05-25: **Stay in current 3 verticals — invest deeper in wellness + travel**. Don't dilute focus. Wellness has lots of headroom (POS, Memberships, Wallet, Biometric); Travel has 4 sub-brands to mature. Defer new verticals until current ones hit revenue inflection.] Future vertical roadmap.

### Round 5 — Mobile stack + Wellness Phase 2 + Travel Security + Free tier

- **NEW-DD MOBILE STACK** [RESOLVED 2026-05-25: **React Native (share types + business logic with existing web SPA)**. Same JS/TS ecosystem as the existing React SPA. Share API client + types + some utility code. Largest community + most CRM-suitable components. ~3-4 months for Phase 1 (login + leads + appointments + push).] Native mobile app framework choice (follow-up to Round-4 mobile strategy).
- **NEW-DD WELLNESS PHASE 2 SEQUENCE** [RESOLVED 2026-05-25: **Wallet Top-up (D16) ships first — customer-facing impact, ~4-6 days**. Customers can top up wallet at clinic, get bonus credits, redeem at next visit. Operator pitches 'pre-paid loyalty.' Quick revenue lift. Smallest scope of the 4 PRDs (PO/Wallet/Memberships/Mini-Site).] Wellness Phase 2 first implementation pick.
- **NEW-DD TRAVEL SECURITY PRIORITY** [RESOLVED 2026-05-25: **JWT storage + localStorage hardening (#914 + #915)** — first. Move JWT out of localStorage (httpOnly cookie or secure storage). XSS → account-takeover risk currently exists. Highest immediate threat. ~3-5 eng-days. Touches every authenticated request.] Travel Security cluster (#914-#921, 7 items) ordering.
- **PRD_PLANS_BILLING_SELF_SERVE NEW-DD FREE TIER** [RESOLVED 2026-05-25: **Free tier with strict caps (≤50 contacts, ≤5 users)**. Lower friction for tenants to try the CRM. Hard caps prevent abuse. Conversion-funnel pitch: 'try free, upgrade when you grow.' Accepts free-tier abuse + support burden from low-value tenants.] Free-tier strategy for acquisition.

### Round 6 — Commercial defaults

- **PRD_PLANS_BILLING_SELF_SERVE NEW-DD PRICING TIERS** [RESOLVED 2026-05-25: **3 tiers — Free / Starter ₹1999/mo / Pro ₹4999/mo**. Classic SaaS triangle. Free for trial + small clinics; Starter for single-location; Pro for chains. Higher tiers = higher caps. Clear conversion ladder.] Pricing tier shape + price points (INR).
- **NEW-DD MULTI-CURRENCY** [RESOLVED 2026-05-25: **INR-only for v1 — multi-currency v2**. All tenants invoice in INR. Existing Currency table + formatMoney() helper stay but no FX rate handling. Simplest. Fits India-first GTM. Some travel-tenant pain accepted (RFU bookings in SAR for hotels).] Multi-currency support priority.
- **NEW-DD AUDIT RETENTION** [RESOLVED 2026-05-25: **Indefinite (current default — never delete)**. Audit rows stay forever. Best for compliance + forensics. Storage cost grows linearly with tenant activity (~5-50 MB/year per active tenant). No code changes needed.] Audit log retention default.
- **NEW-DD NOTIFICATION DEFAULTS** [RESOLVED 2026-05-25: **In-app bell only (least noise)**. Default OFF for email + push + WhatsApp. User opts in to other channels per event-class. Lowest spam complaints. Risk accepted: critical events get missed if user isn't actively in the app.] Default channels when new event fires.

---

### Round 7 — Implementation sequencing (added 2026-05-25 follow-up after "why are issues open?" question)

User clarified that the cron's PRD-shipping mode has settled all DECISIONS but the open-issue list reflects engineering-capacity constraints. Two sequencing decisions captured to direct future focused implementation sessions:

- **NEW-DD TRAVEL-GAP IMPLEMENTATION ORDER** [RESOLVED 2026-05-25: **Spine-first sequencing**. #900 Quote Builder → #901 Travel-Grade Billing → #902 GST & Compliance → #903 Supplier Master → #904 Multi-channel lead capture → #905 B2B Agent Portal → #907 Itinerary upgrades → #908 Marketing flyer studio. Build the operator's daily workflow spine first (quote → invoice → tax) since all 4 sub-brands consume the same spine; cleanest schema; per-sub-brand value defers to implementation Phase 2 of each spine item.] Implementation order for Travel Gap P1-P2 issues (#900-#908). Cluster: previously "all 4 sub-brands as priority" (R4) reframed as "build spine first, layer sub-brand customization on top."
- **NEW-DD TRAVEL-SECURITY IMPLEMENTATION ORDER** [RESOLVED 2026-05-25: **Risk-ranked sequencing**. After #914 JWT/localStorage hardening (R5 first pick): #919 IDOR audit → #918 sequential IDs (UUID migration) → #920 PII pagination → #917 CSP hardening → #921 dapp injection blocking. Highest-blast-radius risk (IDOR) tackled first via audit, then UUID migration to make IDOR structurally impossible, then narrow PII surface, then browser-defense items. Total ~6-8 eng-weeks across the 5 follow-on items.] Implementation order for Travel Security cluster #917/#918/#919/#920/#921 (after #914 ships).

---

### Cascade implications surfaced by this Q&A

Several decisions cascade across multiple subsystems; engineering should treat these as interlinked when scoping the next session:

- **Per-Organization scoping (R2)** — adds NEW Organization Prisma model parent of Tenant. Affects: Plans & Billing UI, Stripe customer mapping, every multi-tenant query that joins on tenantId, the migration script that creates default 1-1 Organizations for existing tenants.
- **DealInvoice rename (R1)** — touches routes/billing.js + routes/invoices.js + Billing.jsx + Invoices.jsx + 30d back-compat adapter. Cross-cutting; do as a single dedicated session per `executing-cross-route-shape-sweep` skill.
- **AttendanceEvent full refactor (R3)** — migrates 793-LOC routes/attendance.js to event-stream. Existing payroll/reporting consumers must be rewired. Single-session focus.
- **Native mobile (RN, R4+R5)** — 3-6 month investment that defers other work. Recommendation: dedicated branch/sub-team if available; otherwise sequenced as a 3-month focused commit.
- **All 4 Travel sub-brands priority (R4)** — splits engineering 4 ways. Per-sub-brand velocity will be ~25%. Set expectations accordingly.

---

## Decisions by PRD

### PRD_TRAVEL_GST_COMPLIANCE.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Masters India — low-volume pricing + mature API + IRP-certified; best for v1 + occasional checks.] GSTN portal GSTIN reverse-check vendor (ClearTax / Masters India / GSTN direct / none-at-launch). Rec: Masters India low-volume.
- DD-5.2 [RESOLVED 2026-05-24: Operator-maintained Admin UI — keeps tax rates editable in-app without code deploys; ClearTax SaaS revisited if multi-tenant rate drift accelerates.] Tax-rate maintenance UI vs hardcoded JSON vs ClearTax tax-engine SaaS. Rec: operator-maintained Admin UI.
- DD-5.3 [RESOLVED 2026-05-24: Operator-toggled per-invoice, audit-logged — maximum operator flexibility given GST RCM rules change.] RCM auto-flag policy per service category. Rec: operator-toggled per-invoice, audit-logged.
- DD-5.4 [RESOLVED 2026-05-24: Excel Software handover — couples to Q8 cred-chase; defer full GSTN/ClearTax connector until vendor spec lands.] GSTR-1/3B delivery: direct GSTN portal / ClearTax connector / Excel Software handover (Q21). Rec: Excel handover at launch.
- DD-5.5 [RESOLVED 2026-05-24: Backfill via `ServiceCategory.defaultSacCode` where possible + default 9985/18% for orphans. One-time backfill script.] Backfill existing invoices without HSN/SAC. Rec: backfill via `ServiceCategory.defaultSacCode` where possible + default-18% for the rest.
- DD-5.6 [RESOLVED 2026-05-24: Per-sub-brand election, monthly default — matches CBIC's QRMP eligibility at sub-brand level.] GSTR-1 cadence — monthly vs QRMP quarterly. Rec: per-sub-brand election, monthly default.

### PRD_TRAVEL_BILLING.md (7 pending)
- DD-5.1 [RESOLVED 2026-05-23: FORK — `TravelInvoice` as new Prisma model; isolated from generic Invoice. Decided as part of the Quote/Billing/Supplier symmetric fork call.] Fork `TravelInvoice` or extend in-place. Rec: FORK (sibling to Quote/Supplier fork decisions).
- DD-5.2 [RESOLVED 2026-05-24: Admin-curated + operator override — Globussoft admin seeds 5-10 canonical templates; operators override per-quote or save tenant-specific ones.] Schedule-template ownership: free-form operator vs admin-curated. Rec: admin-curated + operator override.
- DD-5.3 [RESOLVED 2026-05-24: Sub-brand home currency + operator override — matches the per-sub-brand isolation pattern already shipped in `621aab7`.] Reporting currency basis: operator-preferred / sub-brand home / tenant-global. Rec: sub-brand home + operator override.
- DD-5.4 [RESOLVED 2026-05-24: DigiLocker PAN-fetch where available, manual fallback for non-DigiLocker customers — verified + free, opt-in.] TCS tax-filer verification source. Rec: manual + CSV bulk-import.
- DD-5.5 [RESOLVED 2026-05-24: Operator-configurable cadence + channel mix — per-tenant settings for both; multiplies test surface but matches per-sub-brand autonomy theme.] Reminder cadence + channel — hard-coded T-7/T-3/T-1 vs operator-configurable; channels mix. Rec: hard-coded cadence, all-channels with opt-out.
- DD-5.6 [RESOLVED 2026-05-24: Per-sub-brand-head — each sub-brand head can author own templates; reasonable autonomy bounded by role gate.] Cancellation-policy editor scope: admin-only / per-sub-brand-head / per-operator. Rec: admin-only (legal-contract risk).
- DD-5.7 [RESOLVED 2026-05-24: Ship FR-3.8.d with placeholder branding now (already done — tick #173 commit `464c48b2` generateTravelQuotePdf renders text placeholder logo); swap to real assets when Q22 Yasin brand pack lands — bulk-apply PRD rec.] Per-sub-brand PDF branding (Yasin's brand handover, Q22).

### PRD_TRAVEL_B2B_AGENT_PORTAL.md (7 pending)
- DD-5.1 [RESOLVED 2026-05-24: New routes in existing app (Option B) for v1, fork plan documented — minimises surface for v1; fork to separate app available later if portal-specific bundle size becomes a problem.] Portal frontend topology — new React app vs new routes in existing app. Rec: Option B (new routes) for v1, fork plan documented.
- DD-5.2 [RESOLVED 2026-05-24: Hybrid — rule-based default + operator override. Inherits the auto-with-override theme.] Sub-agent tier model — rule-based vs operator-curated vs hybrid. Rec: hybrid with rule-based default + operator override.
- DD-5.3 [RESOLVED 2026-05-24: At-customer-payment + monthly statement cadence — cash-flow matches reality + industry standard.] Commission settlement timing — at-booking / at-payment / at-month-end. Rec: at-customer-payment with monthly statement cadence.
- DD-5.4 [RESOLVED 2026-05-24: In-app form v1, spreadsheet v2 — structured form for common policies; spreadsheet bulk-import Phase 2.] Corporate policy editor — in-app form / JSON upload / spreadsheet. Rec: Option A (in-app form) v1; Option C (spreadsheet) v2.
- DD-5.5 [RESOLVED 2026-05-24: Configurable with linear default template — supports 90% with sane default; multi-stage available when needed.] Approval workflow chain shape — linear / multi-stage / configurable. Rec: configurable, with linear default template.
- DD-5.6 [RESOLVED 2026-05-24: Canonical CSV v1; per-corporate template Phase 2 — bulk-apply PRD rec.] Expense report format.
- DD-5.7 [RESOLVED 2026-05-24: Corp-scoped — each corporate has its own copy of traveler profile; privacy-safer + simpler RBAC.] Traveler-profile sharing scope — corp-scoped vs cross-corp shared. Rec: corp-scoped (privacy-safer).

### PRD_TRAVEL_MULTICHANNEL_LEADS.md (5 pending)
- DD-5.1 [RESOLVED 2026-05-24: Auto-merge + notify operator — inherits the standardised auto-with-override UX theme.] Cross-channel merge auto vs prompt. Rec: auto-merge + notify operator.
- DD-5.2 [RESOLVED 2026-05-24: Default 60min with per-channel override allowed — admin can configure (e.g. WhatsApp 15min, IndiaMART 24h).] Within-channel cooldown duration (default 60min per FR-3.7.2). Per-channel override?
- DD-5.3 [RESOLVED 2026-05-24: Most-specific wins — industry pattern; deterministic + predictable for operators authoring overlapping rules.] Routing-rule priority resolution — most-specific-wins vs last-created-wins. Rec: most-specific (industry pattern).
- DD-5.4 [RESOLVED 2026-05-24: Per-rule-match + ops-overview channel — each routing-rule match notifies its target operator; tenant-wide ops channel gets digest.] Per-channel notification cadence — per-intake vs per-rule-match. Rec: per-rule-match + ops-overview channel.
- DD-5.5 [RESOLVED 2026-05-24: 24h — covers vendor retries (IndiaMART/JustDial sometimes redeliver); same `external_lead_id` dedupe'd to existing within window.] Idempotency window — 24h vs 7d. Rec: 24h covers vendor retries.

### PRD_TRAVEL_QUOTE_BUILDER.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-23: FORK — `TravelQuote` as new Prisma model. Decided as part of the Quote/Billing/Supplier symmetric fork call.] Fork `TravelQuote` vs extend `Quote` vs extend `Estimate`. Rec: FORK (matches Billing + Supplier symmetric decisions).
- DD-5.2 [RESOLVED 2026-05-24: Hybrid — rule-based config UI for common cases + formula-language escape hatch for power users. Best UX, doubles QA cost.] Pricing-engine UX — rule-based config vs formula-language. Rec: rule-based (config-driven). Formula-language as Phase 2 escape hatch.
- DD-5.3 [RESOLVED 2026-05-24: TMC + Visa Sure exclusive (B2B + service-fee); RFU + Travel Stall inclusive (consumer-facing) — matches sub-brand commercial models.] Tax treatment default per sub-brand — inclusive vs exclusive. Rec: TMC + Visa Sure exclusive; RFU + Travel Stall inclusive.
- DD-5.4 [RESOLVED 2026-05-24: Operator picks per sub-brand — RBI / Fixer.io / manual per sub-brand; multiplies test surface but matches sub-brand autonomy theme.] FX-rate source + cadence — RBI / vendor (OXR/Fixer) / manual. Rec: RBI ref-rate, daily 09:00 IST cron.
- DD-5.5 [RESOLVED 2026-05-24: Rich line-edit + version-diff — operator can edit any line, customer sees track-changes; powerful but multi-week build.] Counter-offer flow — simple delta+reason vs rich line-edit. Rec: simple v1; rich v2 if usage shows demand.
- DD-5.6 [RESOLVED 2026-05-24: Extend `pdfRenderer.js` — single PDF lib path; operator branding via shared theme tokens.] PDF renderer ownership — extend `pdfRenderer.js` vs new `travelPdfRenderer.js`. Rec: extend existing.

### PRD_TRAVEL_PIPELINE_KANBAN.md (4 pending)
- DD-5.1 [RESOLVED 2026-05-24: `@dnd-kit/core` — smallest touch-capable bundle + actively maintained + best a11y story.] Drag-drop library — HTML5 native / `react-beautiful-dnd` / `@dnd-kit/core` / `react-dnd`. Rec: `@dnd-kit/core` (smallest touch-capable + actively maintained).
- DD-5.2 [RESOLVED 2026-05-24: Socket happy-path + manual button (auto-with-override) — inherits the standardised auto-with-override UX theme.] Stale-data refresh policy — socket only / interval fallback / manual button. Rec: manual button + socket happy-path.
- DD-5.3 [RESOLVED 2026-05-24: All brands user has access to — show everything; user filters manually.] Filter chip default for multi-brand users. Rec: all brands user has access to.
- DD-5.4 [RESOLVED 2026-05-24: Virtualization (react-window) per FR-3.18 — smooth scroll at any count.] Crowded-column UX (>100 cards) — virtualize / cap+modal / collapse old. Rec: virtualization (FR-3.18).

### PRD_TRAVEL_SUPPLIER_MASTER.md (5 pending)
- DD-5.1 [RESOLVED 2026-05-23: FORK — `TravelSupplier` as new Prisma model. Decided as part of the Quote/Billing/Supplier symmetric fork call.] Extend `Vendor` model or fork to `TravelSupplier`. Rec: FORK (cross-ref Billing DD-5.1 + Quote DD-5.1 — mirror).
- DD-5.2 [RESOLVED 2026-05-24: Local Multer disk + Prisma String paths — same pattern as wellness PatientPhoto + travel itinerary uploads; S3 swap-point deferred to Phase 2.] KYC document storage — S3-style / DigiLocker / Prisma `String?` paths.
- DD-5.3 [RESOLVED 2026-05-24: Per-tenant v1, per-supplier Phase 2 — bulk-apply PRD rec.] Reconciliation tolerance scoping.
- DD-5.4 [RESOLVED 2026-05-24: In-app v1, escalation hooks Phase 2 — bulk-apply PRD rec.] Dispute resolution flow.
- DD-5.5 [RESOLVED 2026-05-24: GST PRD owns TDS downstream reporting (per cross-ref GST DD-5.x to avoid double-counting); Supplier Master only captures TDS-applicable flag on Supplier model. Bulk-apply PRD cross-ref guidance.] TDS auto-deduction ownership.

### PRD_ADSGPT_MARKETING_REPORTS.md (6 pending)
- DC-1 [RESOLVED 2026-05-24: Nightly default, per-tenant configurable — bulk-apply PRD rec.] Ingest cadence — nightly vs 4-hourly.
- DC-2 [RESOLVED 2026-05-24: $50/mo via TenantSetting row + env-var default — hard-stop at cap + Slack alert at 80%. Inherits the standardised per-tenant budget cap pattern.] Per-tenant monthly budget cap + behavior on hit.
- DC-3 [RESOLVED 2026-05-24: Aggregates-only v1 — DPDP §11 safety; hashed contact IDs Phase 2 if attribution needs require.] PII boundary in conversion export.
- DC-4 [RESOLVED 2026-05-24: Separate per sub-brand — bulk-apply PRD rec; inherits sub-brand defaulting theme.] Per-sub-brand budget tracking vs shared.
- DC-5 [RESOLVED 2026-05-24: GS-owned for Phase 1 — bulk-apply PRD rec; per-tenant migration Phase 2 if needed.] AdsGPT account model.
- DC-6 [RESOLVED 2026-05-24: Operator-only v1 — bulk-apply PRD rec; customer-facing AI commentary deferred until quality/legal review.] Report ownership — AI commentary customer-facing or operator-only.

### PRD_AI_CALLING_CALLIFIED.md (7 pending)
- DC-1 [RESOLVED 2026-05-24: $100/mo via TenantSetting row + env-var default, per-call 90s wall-clock ceiling, hard-stop at cap + Slack alert at 80%. Inherits the standardised per-tenant budget cap pattern.] Cost cap per tenant. Rec: $100/mo, per-call 90s wall-clock ceiling.
- DC-2 [RESOLVED 2026-05-24: Auto-gate on `source IN (meta-ad, google-ad, youtube-ad, linkedin-ad, whatsapp-ad)` + `utm_medium` paid markers, operator override per-lead + notify — inherits the standardised auto-with-override UX theme.] Lead-source whitelist for AI gating. Rec: `source IN (meta-ad, google-ad, youtube-ad, linkedin-ad, whatsapp-ad)` + `utm_medium` paid markers.
- DC-3 [RESOLVED 2026-05-24: Yasin's content team drafts per sub-brand — settled by extension of the per-tenant budget cap + auto-with-override pattern; inherits sub-brand defaulting theme already shipped in `621aab7`.] AI persona + script per sub-brand authorship. Rec: Yasin's content team drafts per sub-brand.
- DC-4 [RESOLVED 2026-05-24: Canned phrase "Understood. I'll have a senior travel consultant follow up shortly." — bulk-apply PRD rec; soft + sub-brand-appropriate.] Opt-out wording when parent declines AI.
- DC-5 [RESOLVED 2026-05-24: Counsel-drafted TRAI disclosure wording — bundled into the single counsel-owned session covering all 5 counsel items.] TRAI pre-call recording disclosure wording. Counsel-owned.
- DC-6 [RESOLVED 2026-05-24: Dashboard tile + queue — bulk-apply PRD rec; failed/timed-out calls fall into an operator-actionable queue.] Failure-path operator surface.
- DC-7 [RESOLVED 2026-05-24: Yes — `aiCallingEnabled Boolean` per tenant — settled by extension of the standardised TenantSetting cap pattern.] Per-tenant disable toggle via ADMIN settings. Rec: Yes — `aiCallingEnabled Boolean` per tenant.

### PRD_AI_ERA_CRM_REBUILD.md (5 pending)
- D1 [RESOLVED 2026-05-24: OpenAI Phase 1 + adapter abstraction — ship fastest with adapter interface so Voyage/Cohere/local can swap without callsite churn.] Embedding provider — OpenAI / Voyage / local Sentence-Transformers / Cohere. Rec: OpenAI Phase 1 + adapter abstraction.
- D2 [RESOLVED 2026-05-24: MySQL adjacency Phase 1+2, revisit Phase 3 — bulk-apply PRD rec; no premature graph-DB dep until traversal patterns prove the need.] Graph store.
- D3 [RESOLVED 2026-05-24: Mixed — router picks per task; keep existing llmRouter pattern; Claude primary for narrative tasks; GPT-4 fallback. Inherits the auto-with-override theme.] LLM provider for agents.
- D4 [RESOLVED 2026-05-24: DuckDB Phase 4 — bulk-apply PRD rec; embedded analytics db, no separate sidecar maintenance until Phase 4 query-warehouse needs arise.] Query warehouse.
- D5 [RESOLVED 2026-05-24: Defaults user-renameable, vertical-appropriate defaults — wellness gets clinical-flavor defaults, travel gets travel-flavor, generic gets generic; user can rename anytime.] Teammate naming policy — fixed names / tenant-customizable / rename-defaults. Rec: defaults user-renameable, vertical-appropriate defaults.

### PRD_BOOKING_EXPEDIA_DIRECT.md (7 pending)
- DC-1 [RESOLVED 2026-05-24: Booking.com first, Expedia Phase 2 — India inventory density + simpler OAuth2 onboarding gates the 2-4 week clock.] Vendor priority — Booking.com first or Expedia first if bandwidth constrained. Rec: Booking.com first (India inventory + simpler OAuth2).
- DC-2 [RESOLVED 2026-05-24: Show all 3 with vendor badges, dedup cluster UI — bulk-apply PRD rec.] Dedup strategy.
- DC-3 [RESOLVED 2026-05-24: Nightly v1, configurable per tenant Phase 2 — bulk-apply PRD rec.] Caching aggressiveness.
- DC-4 [RESOLVED 2026-05-24: When-there's-demand (operator metric threshold) — bulk-apply PRD rec; Phase 2 timing demand-driven not calendar-driven.] Direct-book scope.
- DC-5 [RESOLVED 2026-05-24: Partial-with-banner — bulk-apply PRD rec; some vendor results > zero results.] Failure UX.
- DC-6 [RESOLVED 2026-05-24: GS-internal rules + operator override per quote — bulk-apply PRD rec.] Cancellation normalizer ownership.
- DC-7 [RESOLVED 2026-05-24: Invisible — operator branding owns experience. Bulk-apply PRD rec.] Vendor brand visibility on customer PDF.

### PRD_DARK_MODE_CLUSTER.md (5 pending)
- DC-1 [RESOLVED 2026-05-24: One engineer dedicated 2-3 day sprint — comprehensive audit + sweep beats per-tick incremental grep for a visual-consistency class fix.] Per-page audit ownership — per-tick grep vs one-shot discovery doc. Rec: one-shot `docs/dark-mode-audit.md` discovery agent.
- DC-2 [RESOLVED 2026-05-24: User-traffic with issue-number fallback — bulk-apply PRD rec.] Page priority order.
- DC-3 [RESOLVED 2026-05-24: Comprehensive (5-min grep add-on) — bulk-apply PRD rec; no point shipping partial dark-mode coverage.] Scope extent.
- DC-4 [RESOLVED 2026-05-24: Sibling sub-cluster covering #862/#868/#869/#870/#876 — bulk-apply PRD rec.] Dark-mode toggle UX + persistence sub-cluster.
- DC-5 [RESOLVED 2026-05-24: Verify before assuming (one-shot grep) — bulk-apply PRD rec; wellness pages may or may not need separate cluster, determine by audit.] Wellness vertical scope.

### PRD_EXCEL_SOFTWARE_ACCOUNTING.md (6 pending)
- DC-1 [RESOLVED 2026-05-24: REST API path — when Yasin delivers vendor spec; stub today against assumed contract so transport-layer code can scaffold.] Transport — API path vs CSV path. Rec: API if vendor has idempotency, else CSV.
- DC-2 [RESOLVED 2026-05-24: SFTP — consistent ops, no NFS mount-management burden. Bulk-apply PRD rec.] CSV path.
- DC-3 [RESOLVED 2026-05-24: Hierarchical `/tenants/<slug>/<date>.csv` — bulk-apply PRD rec; easier multi-tenant grep + retention.] Per-tenant directory structure.
- DC-4 [RESOLVED 2026-05-24: Any diff into queue (FR-9) — bulk-apply PRD rec; no silent discrepancies.] Reconciliation discrepancy threshold.
- DC-5 [RESOLVED 2026-05-24: Pre-flight check at bridge-enable time — bulk-apply PRD rec; operator must validate GSTIN/legal-entity mapping before activation.] Per-sub-brand GSTIN/legal-entity mapping verification.
- DC-6 [RESOLVED 2026-05-24: Re-export with `status=cancelled` — bulk-apply PRD rec; simpler than separate cancellation-notification channel.] Cancellation handling.

### PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md (6 pending)
- DC-1 [RESOLVED 2026-05-24: Playwright headless Chromium server-side — deterministic + zero per-call LLM cost + reuses existing playwright/chromium ops surface.] Browser runtime — Playwright vs MCP-via-LLM. Rec: Playwright (deterministic + free + Phase 1 cost-predictable).
- DC-2 [RESOLVED 2026-05-24: Phase 1 = IndiGo + Air India + Vistara + Emirates (~85% volume) — bulk-apply PRD rec.] Initial airline priority.
- DC-3 [RESOLVED 2026-05-24: Containerize Playwright + Chromium — bulk-apply PRD rec; alongside cron engines, no separate hosting topology.] Containerization / hosting.
- DC-4 [RESOLVED 2026-05-24: Once at next 15-min cron tick — bulk-apply PRD rec; predictable retry budget.] Retry policy on `fallback-agent` rows.
- DC-5 [RESOLVED 2026-05-24: Counsel mandatory for all 4 Phase 1 airlines — bundled into the single counsel-owned session covering all 5 counsel items.] ToS audit pre-launch counsel review.
- DC-6 [RESOLVED 2026-05-24: Reuse `/deliver` endpoint (Q9 cred-blocked) — bulk-apply PRD rec; uses existing notification machinery when Q9 lands.] Parent completion-notification channel + timing.

### PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md (6 pending)
- DC-1 [RESOLVED 2026-05-24: Separate repo `globussoft-flight-plugin` — Chrome Web Store publishing + version cadence + manifest lifecycle differ enough from main CRM to warrant repo isolation.] Repo location — separate `globussoft-flight-plugin` vs `chrome-extension/` subdir. Rec: separate repo.
- DC-2 [RESOLVED 2026-05-24: GS + Yasin co-admin (hybrid publisher) — bulk-apply PRD rec.] Chrome Web Store publisher account.
- DC-3 [RESOLVED 2026-05-24: IndiGo + Air India + Emirates (3-week rollout) — bulk-apply PRD rec.] Airline coverage priority for first 3.
- DC-4 [RESOLVED 2026-05-24: Per-tenant OAuth — bulk-apply PRD trade-off favored option; advisor logs in with tenant SSO, plugin uses scoped per-tenant token. Cleanest security story.] Auth model.
- DC-5 [RESOLVED 2026-05-24: Web Store auto-update (FR-7) — bulk-apply PRD rec; self-hosted update server adds ops surface for marginal benefit.] Update mechanism.
- DC-6 [RESOLVED 2026-05-24: Config-by-build with 2 distinct extension IDs (dev + prod) — bulk-apply PRD rec.] Demo environment config.

### PRD_PASSPORT_OCR.md (5 pending)
- PC-1 [RESOLVED 2026-05-24: Google Document AI — best OCR quality for Indian passports + asia-south1 region available; unlocks PC-2 residency pin.] OCR vendor — Google DocAI / Azure Form Recognizer / hybrid / Indian alt. Rec: Google DocAI V1.
- PC-2 [RESOLVED 2026-05-24: Strict (`asia-south1` Mumbai) — bundled into the single counsel-owned session covering all 5 counsel items.] Data residency — strict India-region pin vs loose. Rec: strict (`asia-south1` Mumbai).
- PC-3 [RESOLVED 2026-05-24: Mirror Q2 Aadhaar consent format — bundled into the single counsel-owned session covering all 5 counsel items.] Consent text wording. Rec: mirror Q2 Aadhaar consent format (counsel review).
- PC-4 [RESOLVED 2026-05-24: 24h TMC+RFU, same-day Visa Sure — bulk-apply PRD rec; tighter SLA for Visa Sure reflects time-sensitive visa-application context.] Manual fallback SLA.
- PC-5 [RESOLVED 2026-05-24: 3 attempts then notify operator — bulk-apply PRD rec.] Re-upload attempt limit before operator intervention.

### PRD_RATEHAWK_INTEGRATION.md (6 pending)
- DC-1 [RESOLVED 2026-05-24: Per-API-call cap (cents-per-search-query) — aligns with PRD assumption + lets per-tenant TenantSetting budget cap pattern govern cost.] Pricing model with RateHawk — per-API-call vs per-booking. Rec: pick whichever Yasin negotiates; PRD assumes per-call.
- DC-2 [RESOLVED 2026-05-24: Extend `Integration` model — bulk-apply PRD rec; consistent with existing integration storage.] Config storage.
- DC-3 [RESOLVED 2026-05-24: 5-min default, not configurable v1 — bulk-apply PRD rec; flat global TTL until tenant-specific demand surfaces.] Rate caching policy.
- DC-4 [RESOLVED 2026-05-24: Refundability-preferred auto-pick + operator override + notify — inherits the standardised auto-with-override UX theme.] Lowest-rate auto-pick tiebreaker.
- DC-5 [RESOLVED 2026-05-24: "No inventory" message + manual-quote CTA — bulk-apply PRD rec; never dead-end the operator.] Error UX on 0 results.
- DC-6 [RESOLVED 2026-05-24: Side-by-side clients (no premature abstraction) — bulk-apply PRD rec; unified hotel-search abstraction Phase 3 if needed.] Phase-2 multi-vendor expansion.

### PRD_RFU_GROUND_SERVICES.md (6 pending)
- D-5.2.a [RESOLVED 2026-05-24: Counsel-owned per-portal ToS review — bundled into the single counsel-owned session covering all 5 counsel items.] Scrape-vs-partner-API per hotel portal (per-portal call). Counsel-owned (ToS review).
- D-5.2.b [RESOLVED 2026-05-24: Single PNR per leg — bulk-apply default; simpler ops for Hajj groups (advisor manages legs not individuals); per-pilgrim PNRs Phase 2 if airline requires.] Group-booking flow.
- D-5.2.c [RESOLVED 2026-05-24: Auto-book on cheapest with refundability tiebreaker (matches RateHawk DC-4) — inherits standardised auto-with-override UX theme.] Auto-confirmation policy.
- D-5.2.d [RESOLVED 2026-05-24: Per-leg margin override (operator picks per leg) — bulk-apply most flexible default; per-vendor as Phase 2.] Sub-agent margin override.
- D-5.2.e [RESOLVED 2026-05-24: 30min TTL during Hajj season (Dhu al-Hijjah window) — bulk-apply PRD rec; tighter than the global 5-min RateHawk cache because supply churns faster.] Hajj-season caching exception.
- D-5.2.f [RESOLVED 2026-05-24: Auto-cancel linked legs with operator-cancellable revert — bulk-apply PRD rec; preserves itinerary coherence when one leg fails.] Cancellation reconciliation policy.

### PRD_TMC_CURRICULUM_MAPPING.md (5 pending)
- PC-1 [RESOLVED 2026-05-24: GS drafts 100-200 starter rows + TMC academic team validates, 6-week target. Unblocks the "feature ships as empty table" THE BLOCKER risk.] Source the V1 mapping data + timeline.
- PC-2 [RESOLVED 2026-05-24: CBSE + ICSE only v1, IB + Cambridge + state-board Phase 2 — bulk-apply PRD rec.] Curriculum scope for V1.
- PC-3 [RESOLVED 2026-05-24: Fine grain `(curriculum, grade, subject, learningOutcome)` — bulk-apply PRD rec; supports richer pitch decks but more content authoring upfront.] Mapping granularity.
- PC-4 [RESOLVED 2026-05-24: Human-judged V1, algorithmic Phase 2 — bulk-apply PRD rec.] fitScore methodology.
- PC-5 [RESOLVED 2026-05-24: Referential to TMC's existing trip catalogue — bulk-apply PRD rec; ensures mapping rows resolve to actual bookable trips.] Destination universe.

### PRD_VISA_SURE_PHASE_3.md (8 pending)
- PC-1 [RESOLVED 2026-05-24: PRD rec OR-combined — applicationType ∈ {work, student, business, hajj} OR priorRejectionCount ≥ 1 OR family/dependents OR high-rejection-rate destination. Most aggressive flagging.] "Complex case" definition for risk-flag engine FR-3.1.
- PC-2 [RESOLVED 2026-05-24: New fresh diagnostic linked to original via `priorDiagnosticId` FK — clean audit trail; supports pre/post-rejection answer diff.] Rejection-recovery — new diagnostic or reuse original. Drives schema relation.
- PC-3 [RESOLVED 2026-05-24: Phase 3 in-scope as structured rules (`EmbassyRule` model with rule_type/destination/condition/action) — heavy build but advisor dashboard surfaces actionable warnings.] Per-destination embassy-quirk modeling — Phase 3 in-scope or advisor-head-only. Heavy schema work if (b).
- PC-4 [RESOLVED 2026-05-24: Enforce per-destination cooldown via `createdAt > decidedAt + cooldown` check + show countdown to advisor; prevents wasted applications.] Rejection-recovery time-window enforcement. Drives `createdAt > decidedAt + cool-down` check.
- PC-5 [RESOLVED 2026-05-24: Tourist + Business + Family + Student baseline (PRD rec) — ~70% of Indian outbound volume; transit/work/dependent/medical/journalism/religious-pilgrimage all Phase 2.] Visa categories in scope for Phase 1.
- PC-6 [RESOLVED 2026-05-24: Any-to-any (truly global) — visa applications from any country to any country; maximum flexibility but explodes destination-rule maintenance + 10x QA burden.] Region focus — US-outbound only / India-outbound / any-to-any. Rec: India-outbound.
- PC-7 [RESOLVED 2026-05-24: Visa Sure advisor-head + admin UI — dedicated person owns; admin UI for CRUD. Best signal-source (they see rejections daily).] Embassy-quirk catalogue maintainer post-ship.
- PC-8 [RESOLVED 2026-05-24: New `VisaApplication.familySize Int?` column — additive nullable, no bless marker; per-application accuracy.] Family/dependents trigger source for FR-3.1(c) — VisaApplication column / Contact-level / drop from V1.

### PRD_ADMIN_SETTINGS_DISCOVERY.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Confirm 12-tab list (Profile/Appearance/Notifications/Branding/Integrations/Pipeline Stages/Email Messages/Quiet Hours/Audit Log/Privacy/Tax/Compliance) in PRD order; Tax + Compliance admin-only. Bulk-apply PRD rec.] Settings sub-tab structure.
- DD-5.2 [RESOLVED 2026-05-24: Cached 5-min poll + on-demand "check now" button — bulk-apply PRD rec.] Integration health-check cadence.
- DD-5.3 [RESOLVED 2026-05-24: Reassign+delete secondary with audit-log entry — bulk-apply PRD rec; cleaner data state than alias.] Tag merge semantics.
- DD-5.4 [RESOLVED 2026-05-24: Visual builder v1, JSON-edit for power users Phase 2 — bulk-apply PRD rec.] Segment definition surface.
- DD-5.5 [RESOLVED 2026-05-24: 90 days with tenant-configurable override — bulk-apply PRD rec.] Notifications retention window.
- DD-5.6 [RESOLVED 2026-05-24: Admin sees all; non-Admin sees only own — bulk-apply PRD rec; matches existing RBAC pattern.] AI history scope.

### PRD_AI_SURFACES.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Confirm PRD FR-3.1.b Claude/GPT/Gemini choices for the 8 new task classes — bulk-apply PRD rec; inherits mixed-router D3 pattern.] Default model per task class.
- DD-5.2 [RESOLVED 2026-05-24: 3-tier flat (free/starter/pro) per FR-3.2.c — bulk-apply PRD rec; aligns with Plans & Billing DD-5.1's 4-tier matrix.] Cost budget per tenant.
- DD-5.3 [RESOLVED 2026-05-24: Per-tenant opt-in (EU AI Act implications) — bulk-apply PRD rec.] Customer-visible AI.
- DD-5.4 [RESOLVED 2026-05-24: Per-tenant storage; aggregate only for GS-managed shared prompts — bulk-apply PRD rec.] Operator-feedback storage.
- DD-5.5 [RESOLVED 2026-05-24: Rule-based regex (cheaper, deterministic, auditable) — bulk-apply PRD rec.] PII redaction strategy.
- DD-5.6 [⚠️ NEEDS PRODUCT CALL] Data residency for EU tenants — OpenAI EU / Anthropic EU / Gemini EU endpoint choice. Product + finance call required (cost varies by ~20-40% across vendors). Settle when first EU tenant signs.

### PRD_MOBILE_RESPONSIVENESS.md (8 pending)
- DD-5.1 [RESOLVED 2026-05-24: Hybrid (hamburger drawer + bottom-tab-bar for top-5 destinations) — bulk-apply PRD rec.] Mobile nav pattern.
- DD-5.2 [RESOLVED 2026-05-24: Desktop-first CSS; mobile-first only for new components — bulk-apply PRD rec; minimal churn to existing pages.] Mobile-first or desktop-first CSS.
- DD-5.3 [RESOLVED 2026-05-24: Closer to desktop above 900px, closer to mobile below — bulk-apply PRD rec.] Tablet treatment.
- DD-5.4 [RESOLVED 2026-05-24: Read-only Phase 2, write-queue Phase 3 — bulk-apply PRD rec.] Offline-mode scope.
- DD-5.5 [RESOLVED 2026-05-24: Simplify before hide — bulk-apply PRD rec; feature parity wins over feature breadth on small screens.] Per-page degradation.
- DD-5.6 [RESOLVED 2026-05-24: Never on first visit, prompt on 2nd with 30-day dismiss — bulk-apply PRD rec.] PWA install prompt timing.
- DD-5.7 [RESOLVED 2026-05-24: PRD FR-3.4(a) defaults confirmed; revisit via product usage data after 30 days post-launch — bulk-apply PRD rec.] Bottom-tab-bar contents per vertical.
- DD-5.8 [RESOLVED 2026-05-24: Same codebase with `data-surface="portal"` scoping — bulk-apply PRD rec.] Customer portal codebase.

### PRD_PLANS_BILLING_SELF_SERVE.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Free / Starter / Pro / Enterprise (4 tiers) — per-tier feature matrix + quotas + gated integrations to be ratified during implementation.] Plan tiers + per-tier feature matrix — Free/Starter/Pro/Enterprise boundaries + user/record/API quotas + gated integrations. Owner: Globussoft product.
- DD-5.2 [⚠️ NEEDS PRODUCT CALL] Cancellation policy — grace-period length, refund rules, monthly-vs-annual differences. Owner: Globussoft commercial/legal. Settle before Plans & Billing self-serve goes live (real money-back implications).
- DD-5.3 [RESOLVED 2026-05-24: Both Stripe + Razorpay with per-tenant-currency routing (INR→Razorpay, USD/EUR→Stripe) — bulk-apply per existing payment infra patterns; routes auto-pick based on tenant.defaultCurrency.] Payment-method storage.
- DD-5.4 [⚠️ NEEDS PRODUCT CALL] Usage metering granularity — per-record / per-action, sliding 30d vs calendar-month, metered+capped vs metered+overage. Owner: Globussoft product. Settle before any plan-tier code touches usage limits (defines billing reconciliation model).
- DD-5.5 [⚠️ NEEDS PRODUCT CALL] Multi-tenant subscription scoping — per-Tenant vs per-Organization (parent of Tenants). Owner: Globussoft architecture (Suresh). Settle before subscription schema lands (changes Prisma model + multi-tenant billing UI).
- DD-5.6 [RESOLVED 2026-05-24: Stripe-default policy: 4 retries over 7 days before PAST_DUE, 14-day grace before SUSPENDED, read-only access during PAST_DUE — bulk-apply industry default; commercial/ops can tighten.] Failed-payment retry policy.

### PRD_THEME_MANAGEMENT.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Top nav + sidebar (both placements) — bulk-apply most-discoverable; users find toggle whichever surface they're on.] Toggle placement.
- DD-5.2 [RESOLVED 2026-05-24: User preference wins — localStorage migration is treated as an explicit choice; tenant default only applies when user has no preference set.] User pref vs tenant default conflict on first login.
- DD-5.3 [RESOLVED 2026-05-24: Auto-applied (per-sub-brand override is the explicit opt-in) — bulk-apply PRD rec.] Per-sub-brand theme.
- DD-5.4 [RESOLVED 2026-05-24: Keep live matchMedia listener (current behavior) — bulk-apply PRD rec.] System preference responsiveness.
- DD-5.5 [RESOLVED 2026-05-24: Always sub-brand default on customer portal — bulk-apply PRD rec; consistent brand experience for customers.] Customer portal theme.
- DD-5.6 [RESOLVED 2026-05-24: Silent migration — bulk-apply PRD rec; no user-facing prompt needed.] Migration of existing `localStorage.theme` values.

### PRD_TRAVEL_ITINERARY_UPGRADES.md (5 pending)
- DD-5.1 [RESOLVED 2026-05-24: Hybrid (GS seeds 20-25 templates, operators expand) — bulk-apply PRD rec.] Template-library content sourcing.
- DD-5.2 [RESOLVED 2026-05-24: Extend Cost Master (6th category) — bulk-apply PRD rec (already confirmed in PRD).] POI master ownership.
- DD-5.3 [RESOLVED 2026-05-24: OpenTripMap free tier (CC-BY, ~3.4M POIs, lat/lng comprehensive) — bulk-apply PRD rec.] POI seed-data source.
- DD-5.4 [RESOLVED 2026-05-24: Leaflet+OSM v1, Mapbox via pluggable adapter Phase 2 — bulk-apply PRD rec; free + adapter swap-point if paid tiles needed later.] Map tile provider.
- DD-5.5 [RESOLVED 2026-05-24: Per-day accept/edit/reject — bulk-apply PRD rec; gives operator granular control over LLM output.] LLM-suggested-itinerary acceptance flow.

### PRD_TRAVEL_MARKETING_FLYER.md (5 pending)
- DD-5.1 [RESOLVED 2026-05-24: Embed Polotno Phase 1 — bulk-apply PRD rec; mature canvas editor with React bindings, no in-house build cost.] Editor library.
- DD-5.2 [RESOLVED 2026-05-24: Local Multer disk v1, S3 Phase 2 if Cloudinary cost/benefit warrants — bulk-apply lowest-cost default; matches Travel Supplier KYC storage pattern.] Asset storage backend.
- DD-5.3 [RESOLVED 2026-05-24: DALL-E 3 Phase 1, Midjourney premium-tier Phase 2 — bulk-apply PRD rec.] AI image generation provider.
- DD-5.4 [RESOLVED 2026-05-24: Admin-moderated queue — bulk-apply PRD rec.] Template marketplace moderation.
- DD-5.5 [RESOLVED 2026-05-24: Enforced by default for new flyers; MANAGER+ can toggle per-flyer — bulk-apply PRD rec.] Brand-lock default.

### PRD_TRAVEL_PER_SUBBRAND_BRANDING.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Google Fonts only v1; revisit if Yasin's brand handover specifies paid font — bulk-apply PRD rec.] Custom font support.
- DD-5.2 [RESOLVED 2026-05-24: New BrandKit Prisma model — version history + WCAG + audit trails want proper columns; replaces JSON-blob approach.] Brand-kit storage shape.
- DD-5.3 [RESOLVED 2026-05-24: Ship 4 starter kits via `seed-travel.js` — bulk-apply PRD rec (already shipped tick #102 commit `df2271c`).] Default brand kits at seed time.
- DD-5.4 [RESOLVED 2026-05-24: Sidebar header + small top-nav badge with sub-brand dropdown — bulk-apply PRD rec.] Logo placement on operator UI.
- DD-5.5 [RESOLVED 2026-05-24: Require `logoDarkUrl` when light logo inverts poorly; auto-derive via CSS `filter: invert()` fallback — bulk-apply PRD rec.] Dark-mode handling.
- DD-5.6 [RESOLVED 2026-05-24: Keep last 10 versions per sub-brand for revert; older versions hard-purged — bulk-apply PRD rec.] Brand-kit version history.

### PRD_TRAVEL_SECURITY_ARCHITECTURE.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Split cookies (access short-TTL + refresh long-TTL at `/api/auth/refresh`-only path) — bulk-apply PRD rec; OWASP-recommended.] Cookie storage shape.
- DD-5.2 [RESOLVED 2026-05-24: Dual-column (add `publicId` String alongside numeric `id`, dual-route per FR-3.3.a) — bulk-apply PRD rec; preserves existing FK relations.] Sequential-ID migration shape.
- DD-5.3 [RESOLVED 2026-05-24: Roll-our-own AuditLog-backed CSP violation report table — bulk-apply PRD rec; avoids Sentry $$ + keeps reports in tenant-scoped storage.] CSP violation report sink.
- DD-5.4 [RESOLVED 2026-05-24: Per-endpoint hand-curated projection — bulk-apply PRD rec; explicit > implicit for PII redaction.] PII redaction scope.
- DD-5.5 [RESOLVED 2026-05-24: Tenant-by-tenant feature flag with 14d windows — bulk-apply PRD rec; safer rollout than CI-cutover for security changes.] Rollout cadence.
- DD-5.6 [RESOLVED 2026-05-24: Clear-on-next-login — bulk-apply PRD rec; cleanest invariant, accepts one-time forced re-login.] Existing localStorage data lifecycle.

### PRD_UNIFIED_GLOBAL_SEARCH.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: `/` for header search; CommandPalette stays on Cmd+K — bulk-apply PRD rec; preserves existing Cmd+K muscle memory.] Shortcut conflict.
- DD-5.2 [RESOLVED 2026-05-24: Start with Prisma `contains`, promote to `pg_trgm` once P95 > 500ms — bulk-apply PRD rec; no premature full-text-engine dependency.] Backend search strategy Phase 1.
- DD-5.3 [RESOLVED 2026-05-24: Show all entity types user has role-permission for, vertical-specific first — bulk-apply PRD rec.] Cross-vertical scope.
- DD-5.4 [RESOLVED 2026-05-24: Per-user only — bulk-apply PRD rec; privacy-safer.] Recent-search cache.
- DD-5.5 [RESOLVED 2026-05-24: Deep-link first; side-panel preview Phase 2 — bulk-apply PRD rec.] Result-click action.
- DD-5.6 [RESOLVED 2026-05-24: Rule-based (hand-tuned weights); learning-to-rank Phase 3 — bulk-apply PRD rec; no ML infra for Phase 1.] Ranking.

### PRD_WELLNESS_POS_HARDENING.md (5 pending)
- DD-5.1 [RESOLVED 2026-05-24: Permanent redirect `/pos` → `/wellness/pos` — bulk-apply PRD rec; less surface change.] Routing fix shape.
- DD-5.2 [RESOLVED 2026-05-24: In-app wizard — bulk-apply PRD rec; addresses the actual #826 Owner-dead-end bug.] First-time onboarding.
- DD-5.3 [RESOLVED 2026-05-24: Per-tenant toggle — bulk-apply PRD rec; vertical-level is too coarse.] "POS module enabled" toggle.
- DD-5.4 [RESOLVED 2026-05-24: Keep 6-tier wellness scheme — bulk-apply PRD rec; avoid role-drift.] Role granularity.
- DD-5.5 [RESOLVED 2026-05-24: No-offline Phase 1 with banner; queue-and-sync separate Phase 2 PRD — bulk-apply PRD rec.] Offline mode scope.

### PRD_WELLNESS_RBAC.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Extend `wellnessRole` enum with `'cashier'` — minimises schema surface; DD-5.6 phiReadGate interaction tracked at code level.] Cashier role — extend `wellnessRole` enum with `'cashier'` vs separate `salesRole` column. Rec: extend wellnessRole v1.
- DD-5.2 [RESOLVED 2026-05-24: Keep singular `Tenant.ownerId` v1; multi-owner for clinic chains Phase 2 if demanded — bulk-apply PRD rec.] Owner singleton vs plural.
- DD-5.3 [RESOLVED 2026-05-24: Phase 2 explicit out-of-scope per FR-3.1.d — bulk-apply PRD rec; per-tenant role customization is a P2 feature.] Per-tenant role customization.
- DD-5.4 [RESOLVED 2026-05-24: `<RoleAccessDenied>` inline component — bulk-apply PRD rec; keeps user in-context vs full-page redirect.] Unauthorized-navigation handling.
- DD-5.5 [RESOLVED 2026-05-24: Middleware-only v1, frontend-render-time guard Phase 2 if needed — bulk-apply PRD rec; backend is source of truth.] Data scoping enforcement layer.
- DD-5.6 [RESOLVED 2026-05-24: Verified at code level — `phiReadGate` per backend/routes/wellness.js excludes `'cashier'` from the PHI-allowed list since cashier is sales role, not clinical. Tracked in tick #92 commit comment.] USER-role × wellnessRole interaction.

### PRD_ZYLU_GAP_CONSOLIDATED.md (8 pending)
- DD-5.1 [RESOLVED 2026-05-24: `sourceType` enum + shared child tables (InvoiceLineItem + InvoicePayment) — bulk-apply PRD rec; preserves polymorphism without schema fork.] POS Invoice polymorphism.
- DD-5.2 [RESOLVED 2026-05-24: Drag-drop + save mapping per tenant — bulk-apply PRD rec; fuzzy-match auto-suggest reduces operator friction.] CSV column-mapping UI.
- DD-5.3 [RESOLVED 2026-05-24: Per-tenant SKUs — bulk-apply PRD rec; each clinic prices differently.] Memberships.
- DD-5.4 [RESOLVED 2026-05-24: Admin UI (rules change quarterly) — bulk-apply PRD rec.] Wallet bonus rules.
- DD-5.5 [RESOLVED 2026-05-24: Per-entry expiry (friendlier audit trail) — bulk-apply PRD rec.] Wallet expiry.
- DD-5.6 [⚠️ NEEDS PRODUCT CALL] Biometric device vendor — Mantra / Realtime / eSSL. Open. Drives webhook contract + device-pairing UI. Settle before #805 biometric+geofence attendance Phase 1 eng starts.
- DD-5.7 [RESOLVED 2026-05-24: In-app block builder (4-5 blocks: logo/hero/services/contact/cta) — bulk-apply PRD rec.] Mini-site editor.
- DD-5.8 [⚠️ NEEDS PRODUCT CALL] Per-clinic-location mini-site vs per-tenant. Open. For chain clinics (e.g. 3 clinics under one tenant), each location may want own page vs umbrella. Settle before #809 Mini-Website editor Phase 1 eng starts.

---

## PRDs with no decisions surfaced

- `docs/WHATSAPP_INTEGRATION_PRD.md` — pure cred-chase + setup spec; no design decisions surfaced. (Implicitly: Path A vs Path B for token generation, but framed as "Travel Stall picks one" not blocking.)
- `docs/DIGILOCKER_USE_CASE.md` — narrative use-case, no §5 decision block.
- `docs/DIGILOCKER_INTEGRATION_SPEC.md` — integration spec, decisions are downstream of cred drop (Q-DIGI-1 not in this tracker).
- `docs/TRAVEL_CRM_PRD.md` — meta-PRD for the Travel vertical; design decisions are deferred to the per-feature PRDs above.
- `docs/PRD_AI_ERA_CRM_REBUILD.md` has only the 5 D-N items listed (D6+ not surfaced as block-tier).

---

## Cross-cutting decision themes

These are interlocked decisions across sibling PRDs — settling them in isolation triggers re-thrash. Recommend grouping into single product calls.

### Theme: Fork-vs-extend (Travel-vertical schema cluster)
- PRD_TRAVEL_QUOTE_BUILDER DD-5.1 — fork `TravelQuote` vs extend `Quote`/`Estimate`
- PRD_TRAVEL_BILLING DD-5.1 — fork `TravelInvoice` vs extend `Invoice` (cross-ref Quote DD-5.1)
- PRD_TRAVEL_SUPPLIER_MASTER DD-5.1 — fork `TravelSupplier` vs extend `Vendor` (cross-ref Billing DD-5.1)
- **Recommended:** single design call covering all three; they should land symmetrically (all FORK or all EXTEND).

### Theme: Per-tenant feature flagging + budget cap
- PRD_ADSGPT_MARKETING_REPORTS DC-2 — $50/mo cap, hard stop
- PRD_AI_CALLING_CALLIFIED DC-1 — $100/mo cap, per-call 90s ceiling
- PRD_AI_CALLING_CALLIFIED DC-7 — per-tenant disable toggle
- PRD_RATEHAWK_INTEGRATION DC-1 — per-call vs per-booking cap design
- **Recommended:** standardise the per-tenant budget/cap pattern (env var name, `TenantSetting` row shape, alert channel) ONCE; downstream PRDs inherit.

### Theme: AI model + vendor selection
- PRD_AI_ERA_CRM_REBUILD D1 (embedding), D3 (LLM provider)
- PRD_AI_CALLING_CALLIFIED — Callified.ai vendor lock-in (no DC, but architectural)
- PRD_ADSGPT_MARKETING_REPORTS — AdsGPT vendor lock-in
- **Recommended:** decide D3 (Claude vs OpenAI vs mixed) first; cascading specialist agents inherit.

### Theme: Sub-brand defaulting
- PRD_TRAVEL_QUOTE_BUILDER DD-5.3 — tax treatment per sub-brand
- PRD_TRAVEL_BILLING DD-5.7 — per-sub-brand PDF branding (Q22)
- PRD_TRAVEL_B2B_AGENT_PORTAL DD-5.1 — sub-brand-aware portal theming
- PRD_ADSGPT_MARKETING_REPORTS DC-4 — per-sub-brand budget tracking
- PRD_AI_CALLING_CALLIFIED DC-3 — persona/script per sub-brand
- **Recommended:** consolidate per-sub-brand config schema (`Tenant.subBrandConfigJson.*`) BEFORE individual decisions land. Shipped 2026-05-22 (commit `621aab7`).

### Theme: Counsel-owned items
- PRD_PASSPORT_OCR PC-2 (residency), PC-3 (consent text)
- PRD_AI_CALLING_CALLIFIED DC-5 (TRAI disclosure)
- PRD_AIRLINE_WEBCHECKIN_AUTOMATION DC-5 (ToS audit)
- PRD_RFU_GROUND_SERVICES D-5.2.a (per-portal ToS)
- **Recommended:** single counsel review session covering all 5 (overlapping reading + faster lawyer-hours billing).

### Theme: Auto-vs-prompt UX defaulting
- PRD_TRAVEL_MULTICHANNEL_LEADS DD-5.1 — cross-channel merge auto vs prompt
- PRD_TRAVEL_PIPELINE_KANBAN DD-5.2 — socket stale-data refresh policy
- PRD_AI_CALLING_CALLIFIED DC-2 — lead-source auto-gating whitelist
- PRD_RATEHAWK_INTEGRATION DC-4 — lowest-rate auto-pick tiebreaker
- **Recommended:** consistent "auto-with-override" default across all four; document as a CRM-wide UX principle.

---

## Decisions by urgency

### Block immediate implementation (highest priority — settle before any Travel-vertical schema work)
- PRD_TRAVEL_QUOTE_BUILDER DD-5.1 — fork decision is the longest-tail schema dependency.
- PRD_TRAVEL_BILLING DD-5.1 — symmetric to Quote.
- PRD_TRAVEL_SUPPLIER_MASTER DD-5.1 — symmetric to Quote + Billing.
- PRD_TRAVEL_GST_COMPLIANCE DD-5.4 — gates Excel-Software handover Q21.
- PRD_TMC_CURRICULUM_MAPPING PC-1 — without content, feature ships as empty table (THE blocker).
- PRD_VISA_SURE_PHASE_3 PC-8 — risk-flag engine FR-3.1 cannot ship faithfully without this.

### Block per-PRD implementation (medium priority — settle before that PRD's engineering kicks off)
- PRD_BOOKING_EXPEDIA_DIRECT DC-1 (vendor priority — gates 2-4 week onboarding clock).
- PRD_AI_ERA_CRM_REBUILD D3 (LLM provider — cascades to D1 + every agent).
- PRD_AIRLINE_WEBCHECKIN_AUTOMATION DC-1 (Playwright vs MCP — gates engineering scope).
- PRD_FLIGHT_PLUGIN_CHROME_EXTENSION DC-1 (repo location — blocks scaffolding).
- PRD_DARK_MODE_CLUSTER DC-1 (audit ownership — gates discovery doc).
- PRD_EXCEL_SOFTWARE_ACCOUNTING DC-1 (API path vs CSV path — gates transport-layer code).
- PRD_PASSPORT_OCR PC-1 (OCR vendor — gates cred drop + client code).
- PRD_RATEHAWK_INTEGRATION DC-1 (pricing model — gates FR-10 cap design).

### Settle during implementation (medium priority — won't block kickoff)
- All DD-5.X / DC-N / PC-N items not listed above.
- Most "UX default" decisions (auto-vs-prompt, caching policy, retry policy).

### Defer to Phase 2 / 3 (low priority — explicit "v2" recommendations)
- PRD_TRAVEL_BILLING DD-5.7 (Yasin branding handover Q22 — ship placeholder now).
- PRD_BOOKING_EXPEDIA_DIRECT DC-4 (direct-book Phase 2 timing — demand-driven).
- PRD_TRAVEL_QUOTE_BUILDER DD-5.5 (counter-offer rich UI v2).
- PRD_TRAVEL_SUPPLIER_MASTER DD-5.3 (per-supplier reconciliation Phase 2).
- PRD_TRAVEL_SUPPLIER_MASTER DD-5.4 (dispute escalation hooks Phase 2).
- PRD_TRAVEL_B2B_AGENT_PORTAL DD-5.4 (spreadsheet policy upload v2).
- PRD_TRAVEL_B2B_AGENT_PORTAL DD-5.6 (per-corporate expense template v2).

---

## Resolution log

### 2026-05-24 — Product-call session (27 decisions resolved)

Trigger: User cron-prompt directive after viewing DECISIONS_TRACKER.md. 7 AskUserQuestion rounds × ~4 decisions each.

**Resolved (cross-cutting themes — all 6):**
- Fork-vs-extend: FORK all three (TravelQuote / TravelInvoice / TravelSupplier — logged 2026-05-23)
- Per-tenant budget cap: TenantSetting row + env-var default + hard-stop at cap + Slack alert at 80% (AdsGPT DC-2 $50/mo, AI_CALLING DC-1 $100/mo + 90s call ceiling, RateHawk DC-1 per-call cents-cap)
- AI model + vendor: mixed router; Claude primary for narrative, GPT-4 fallback; keep llmRouter pattern (AI_ERA_CRM_REBUILD D3); OpenAI Phase 1 for embeddings + adapter abstraction (D1)
- Counsel-owned items: single combined counsel session for all 5 (Passport OCR PC-2 + PC-3, AI Calling DC-5, Airline DC-5, RFU D-5.2.a)
- Auto-vs-prompt UX: auto-with-override + notify operator (Multichannel DD-5.1, Pipeline Kanban DD-5.2, AI Calling DC-2, RateHawk DC-4)
- Sub-brand defaulting: already shipped via `621aab7` (AI Calling DC-3 + AI Calling DC-7 settle by extension)

**Resolved (block-immediate implementation):**
- PRD_TRAVEL_GST_COMPLIANCE DD-5.4 — Excel Software handover (couples to Q8 cred-chase)
- PRD_TRAVEL_BILLING DD-5.3 — sub-brand home currency + operator override

**Resolved (block-per-PRD implementation):**
- PRD_BOOKING_EXPEDIA_DIRECT DC-1 — Booking.com first, Expedia Phase 2
- PRD_AIRLINE_WEBCHECKIN_AUTOMATION DC-1 — Playwright headless Chromium server-side
- PRD_FLIGHT_PLUGIN_CHROME_EXTENSION DC-1 — separate `globussoft-flight-plugin` repo
- PRD_DARK_MODE_CLUSTER DC-1 — one engineer dedicated 2-3 day sprint
- PRD_EXCEL_SOFTWARE_ACCOUNTING DC-1 — REST API path (stub today against assumed contract)
- PRD_PASSPORT_OCR PC-1 — Google Document AI

**Resolved (per-PRD details with downstream impact):**
- PRD_TRAVEL_GST_COMPLIANCE DD-5.2 — operator-maintained Admin UI for tax rates
- PRD_TRAVEL_PER_SUBBRAND_BRANDING DD-5.2 — new BrandKit Prisma model (replaces JSON-blob)
- PRD_TRAVEL_PIPELINE_KANBAN DD-5.1 — `@dnd-kit/core`
- PRD_TRAVEL_B2B_AGENT_PORTAL DD-5.1 — new routes in existing app (Option B v1, fork plan documented)
- PRD_TRAVEL_B2B_AGENT_PORTAL DD-5.2 — hybrid rule-based + operator override
- PRD_TRAVEL_MULTICHANNEL_LEADS DD-5.3 — most-specific routing rule wins
- PRD_PLANS_BILLING_SELF_SERVE DD-5.1 — 4 tiers (Free / Starter / Pro / Enterprise)
- PRD_WELLNESS_RBAC DD-5.1 — extend `wellnessRole` enum with `'cashier'`
- PRD_THEME_MANAGEMENT DD-5.2 — user preference wins on first-login conflict
- PRD_AI_ERA_CRM_REBUILD D5 — teammate-name defaults user-renameable, vertical-appropriate

**Still pending (~129 items):** PRD-internal implementation details — none gate immediate implementation work. Each PRD has 2-5 remaining DD-5.X rows that are settle-during-implementation shape.

### 2026-05-24 — Second product-call session (32 decisions resolved)

Trigger: User redirect after 30+ empty cron ticks — "Let's do the product decisions first." 8 AskUserQuestion rounds × 4 decisions each.

**Resolved (Travel-vertical schema + commercial):**
- GST DD-5.1 (Masters India GSTIN check), DD-5.3 (RCM operator-toggled), DD-5.5 (HSN backfill via ServiceCategory + 9985/18% default), DD-5.6 (per-sub-brand GSTR-1 election)
- Billing DD-5.2 (admin-curated templates + operator override), DD-5.4 (DigiLocker PAN-fetch + manual fallback), DD-5.5 (operator-configurable cadence + channel mix), DD-5.6 (per-sub-brand-head cancellation editor)
- Quote DD-5.2 (hybrid pricing UX), DD-5.3 (TMC/Visa-Sure exclusive + RFU/Travel-Stall inclusive), DD-5.4 (operator picks FX per sub-brand), DD-5.5 (rich line-edit + version-diff counter-offer), DD-5.6 (extend pdfRenderer.js)
- Supplier DD-5.2 (local Multer disk + Prisma paths)
- Pipeline Kanban DD-5.3 (all brands user has access), DD-5.4 (virtualization)
- Multichannel DD-5.2 (60min + per-channel override), DD-5.4 (per-rule + ops-overview), DD-5.5 (24h idempotency)
- B2B Portal DD-5.3 (commission at-payment + monthly), DD-5.4 (in-app form v1), DD-5.5 (configurable approval + linear default), DD-5.7 (corp-scoped profile)

**Resolved (Visa Sure Phase 3 deep-build — unblocks multi-week eng):**
- PC-1 (PRD-rec OR-combined complex case), PC-2 (new diagnostic linked to original), PC-3 (Phase 3 in-scope structured EmbassyRule), PC-4 (per-destination cooldown enforced), PC-5 (Tourist+Business+Family+Student baseline), PC-6 (any-to-any region scope), PC-7 (advisor-head + admin UI maintainer), PC-8 (`VisaApplication.familySize Int?`)

**Resolved (TMC blocker):**
- TMC Curriculum PC-1 (GS drafts 100-200 starter rows + academic team validates, 6-week target — clears THE BLOCKER)

**Still pending (~129 items):** Mostly AdsGPT/AI Calling/Booking Expedia/Excel Software/Airline/Flight Plugin/RateHawk/Theme/Mobile/POS/RBAC/Zylu/AI Surfaces/Admin Settings remaining DD-X / DC-N items — all "settle-during-implementation" shape per the urgency rating.

### 2026-05-24 — Bulk-resolve session (116 decisions resolved + 5 flagged ⚠️ for product call)

Trigger: User redirect — "Let's finish the product decisions so I can go to bed and the cron can work autonomously."

Approach: All PRD-internal "settle-during-implementation" decisions resolved by applying each PRD's `Rec:` recommendation verbatim as the [RESOLVED] entry. Bulk-apply rationale: every Rec was written by engineering as a defensible default; mid-implementation flips remain possible if usage data warrants. This unblocks ALL implementation work that was nominally "pending decision."

**Resolved (116 decisions applied as PRD rec):**
- AdsGPT DC-1, DC-3, DC-4, DC-5, DC-6 (all 5 remaining)
- AI Calling DC-4, DC-6 (2 remaining)
- AI Era D2, D4 (2 remaining)
- Booking Expedia DC-2..DC-7 (all 6 remaining)
- Dark Mode DC-2..DC-5 (all 4 remaining)
- Excel Software DC-2..DC-6 (all 5 remaining)
- Airline DC-2, DC-3, DC-4, DC-6 (4 remaining; DC-1, DC-5 prior)
- Flight Plugin DC-2..DC-6 (all 5 remaining)
- Passport OCR PC-4, PC-5 (2 remaining)
- RateHawk DC-2, DC-3, DC-5, DC-6 (4 remaining; DC-1, DC-4 prior)
- RFU Ground D-5.2.b..D-5.2.f (5 remaining)
- TMC Curriculum PC-2..PC-5 (4 remaining; PC-1 prior)
- Admin Settings DD-5.1..DD-5.6 (all 6 remaining)
- AI Surfaces DD-5.1..DD-5.5 (5 of 6; DD-5.6 flagged ⚠️)
- Mobile DD-5.1..DD-5.8 (all 8 remaining)
- Plans Billing DD-5.3, DD-5.6 (2 of 5; DD-5.2/5.4/5.5 flagged ⚠️)
- Theme DD-5.1, DD-5.3..DD-5.6 (5 remaining; DD-5.2 prior)
- Travel Billing DD-5.7 (Yasin branding placeholder — already shipped tick #173 commit `464c48b2`)
- Travel B2B Portal DD-5.6
- Travel Itinerary Upgrades DD-5.1..DD-5.5 (all 5)
- Travel Marketing Flyer DD-5.1..DD-5.5 (all 5)
- Travel Per-Sub-Brand Branding DD-5.1, DD-5.3..DD-5.6 (5 remaining; DD-5.2 prior)
- Travel Security DD-5.1..DD-5.6 (all 6)
- Travel Supplier Master DD-5.3, DD-5.4, DD-5.5 (3 remaining; DD-5.1 prior + DD-5.2 prior)
- Unified Global Search DD-5.1..DD-5.6 (all 6)
- Wellness POS Hardening DD-5.1..DD-5.5 (all 5)
- Wellness RBAC DD-5.2..DD-5.6 (5 remaining; DD-5.1 prior)
- Zylu Gap DD-5.1, DD-5.2, DD-5.3, DD-5.4, DD-5.5, DD-5.7 (6 of 8; DD-5.6, DD-5.8 flagged ⚠️)

**⚠️ NEEDS PRODUCT CALL (5 items — not blocking cron work):**
- Plans & Billing DD-5.2 — Cancellation policy (commercial/legal). Settle before self-serve goes live (real money-back impl).
- Plans & Billing DD-5.4 — Usage metering granularity (commercial/product). Settle before plan-tier usage-limit code touches Prisma.
- Plans & Billing DD-5.5 — Multi-tenant subscription scoping per-Tenant vs per-Organization (architecture/Suresh). Settle before subscription schema lands.
- AI Surfaces DD-5.6 — EU data residency vendor choice (product + finance). Settle when first EU tenant signs.
- Zylu Gap DD-5.6 — Biometric device vendor pick (Mantra / Realtime / eSSL). Settle before #805 biometric+geofence eng Phase 1.
- Zylu Gap DD-5.8 — Per-clinic-location mini-site vs per-tenant (Yasin call on clinic chain semantics). Settle before #809 Mini-Website editor Phase 1 eng.

**Cron status post-bulk-resolve:** Queue is now genuinely workable on EVERY PRD. No remaining decision blocks scaffold/SHELL work. The 5 ⚠️ items affect long-tail features whose engineering hasn't started yet. Autonomous cron can proceed with full P1/P2/P3/P5/P6 menu coverage; PRD-WRITER role remains exhausted (P3); architectural multi-day items remain cred/scope-bound separately.

**Next steps unblocked by this session:**
- Visa Sure Phase 3 multi-week eng: schema scope settled (familySize column + EmbassyRule model + cooldown enforcement); risk-flag engine FR-3.1 can ship faithful
- TMC Curriculum: content pipeline starts (6-week timeline, GS-drafted starter rows)
- Travel-vertical Quote/Billing/Supplier: all remaining shape decisions settled — implementation can proceed end-to-end
- B2B Agent Portal: commercial + workflow shape settled — Phase 1 eng can start
- Multichannel + Pipeline Kanban: UX defaults settled — frontend polish work unblocked

**Next steps unblocked by this session:**
- Travel-vertical schema cluster: 3 new Prisma models (TravelQuote / TravelInvoice / TravelSupplier) can scaffold
- Per-tenant budget cap helper: 1 backend lib module + TenantSetting model + admin UI (shared across AdsGPT + AI Calling + RateHawk)
- AI provider mixed-router: existing llmRouter.js validated; D1 OpenAI client adapter can scaffold
- BrandKit Prisma model: schema design unblocked (replaces JSON-blob approach)
- Travel B2B Agent Portal: routes-in-existing-app scaffolding unblocked
- Pipeline Kanban: `@dnd-kit/core` library pin unblocks frontend implementation
- Booking.com integration: vendor onboarding clock can start
- Passport OCR: Google Document AI client + asia-south1 residency pin unblocked
- Plans + Billing: 4-tier matrix work unblocked (commercial/legal still owns DD-5.2)
- Flight plugin: separate repo scaffold unblocked
- Counsel session: 5 items can batch into one billable session

| Date | PRD | DD/DC/PC ID | Decision | Ratified by |
|---|---|---|---|---|
| 2026-05-23 | PRD_TRAVEL_QUOTE_BUILDER.md | DD-5.1 | FORK `TravelQuote` | Product-call session |
| 2026-05-23 | PRD_TRAVEL_BILLING.md | DD-5.1 | FORK `TravelInvoice` | Product-call session |
| 2026-05-23 | PRD_TRAVEL_SUPPLIER_MASTER.md | DD-5.1 | FORK `TravelSupplier` | Product-call session |
| 2026-05-24 | PRD_TRAVEL_GST_COMPLIANCE.md | DD-5.2 | Operator-maintained Admin UI | 2026-05-24 session |
| 2026-05-24 | PRD_TRAVEL_GST_COMPLIANCE.md | DD-5.4 | Excel Software handover | 2026-05-24 session |
| 2026-05-24 | PRD_TRAVEL_BILLING.md | DD-5.3 | Sub-brand home + operator override | 2026-05-24 session |
| 2026-05-24 | PRD_TRAVEL_MULTICHANNEL_LEADS.md | DD-5.1 | Auto-merge + notify | 2026-05-24 session |
| 2026-05-24 | PRD_TRAVEL_MULTICHANNEL_LEADS.md | DD-5.3 | Most-specific wins | 2026-05-24 session |
| 2026-05-24 | PRD_TRAVEL_PIPELINE_KANBAN.md | DD-5.1 | `@dnd-kit/core` | 2026-05-24 session |
| 2026-05-24 | PRD_TRAVEL_PIPELINE_KANBAN.md | DD-5.2 | Socket + manual button | 2026-05-24 session |
| 2026-05-24 | PRD_TRAVEL_B2B_AGENT_PORTAL.md | DD-5.1 | Option B (new routes v1) | 2026-05-24 session |
| 2026-05-24 | PRD_TRAVEL_B2B_AGENT_PORTAL.md | DD-5.2 | Hybrid (rule-based + override) | 2026-05-24 session |
| 2026-05-24 | PRD_TRAVEL_PER_SUBBRAND_BRANDING.md | DD-5.2 | New BrandKit Prisma model | 2026-05-24 session |
| 2026-05-24 | PRD_ADSGPT_MARKETING_REPORTS.md | DC-2 | $50/mo TenantSetting cap | 2026-05-24 session |
| 2026-05-24 | PRD_AI_CALLING_CALLIFIED.md | DC-1 | $100/mo TenantSetting cap + 90s | 2026-05-24 session |
| 2026-05-24 | PRD_AI_CALLING_CALLIFIED.md | DC-2 | Auto-gate + override + notify | 2026-05-24 session |
| 2026-05-24 | PRD_AI_CALLING_CALLIFIED.md | DC-3 | Yasin content team drafts | 2026-05-24 session |
| 2026-05-24 | PRD_AI_CALLING_CALLIFIED.md | DC-5 | Counsel-drafted TRAI disclosure | 2026-05-24 session |
| 2026-05-24 | PRD_AI_CALLING_CALLIFIED.md | DC-7 | `aiCallingEnabled` per tenant | 2026-05-24 session |
| 2026-05-24 | PRD_AI_ERA_CRM_REBUILD.md | D1 | OpenAI + adapter abstraction | 2026-05-24 session |
| 2026-05-24 | PRD_AI_ERA_CRM_REBUILD.md | D3 | Mixed router (Claude primary + GPT-4) | 2026-05-24 session |
| 2026-05-24 | PRD_AI_ERA_CRM_REBUILD.md | D5 | User-renameable defaults | 2026-05-24 session |
| 2026-05-24 | PRD_BOOKING_EXPEDIA_DIRECT.md | DC-1 | Booking.com first | 2026-05-24 session |
| 2026-05-24 | PRD_DARK_MODE_CLUSTER.md | DC-1 | One eng 2-3 day sprint | 2026-05-24 session |
| 2026-05-24 | PRD_EXCEL_SOFTWARE_ACCOUNTING.md | DC-1 | REST API path | 2026-05-24 session |
| 2026-05-24 | PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md | DC-1 | Playwright headless | 2026-05-24 session |
| 2026-05-24 | PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md | DC-5 | Counsel batch | 2026-05-24 session |
| 2026-05-24 | PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md | DC-1 | Separate repo | 2026-05-24 session |
| 2026-05-24 | PRD_PASSPORT_OCR.md | PC-1 | Google Document AI | 2026-05-24 session |
| 2026-05-24 | PRD_PASSPORT_OCR.md | PC-2 | `asia-south1` pin (counsel batch) | 2026-05-24 session |
| 2026-05-24 | PRD_PASSPORT_OCR.md | PC-3 | Mirror Q2 Aadhaar (counsel batch) | 2026-05-24 session |
| 2026-05-24 | PRD_RATEHAWK_INTEGRATION.md | DC-1 | Per-call cents cap | 2026-05-24 session |
| 2026-05-24 | PRD_RATEHAWK_INTEGRATION.md | DC-4 | Refundability-preferred + override | 2026-05-24 session |
| 2026-05-24 | PRD_RFU_GROUND_SERVICES.md | D-5.2.a | Counsel batch (per-portal ToS) | 2026-05-24 session |
| 2026-05-24 | PRD_PLANS_BILLING_SELF_SERVE.md | DD-5.1 | 4-tier (Free/Starter/Pro/Ent) | 2026-05-24 session |
| 2026-05-24 | PRD_WELLNESS_RBAC.md | DD-5.1 | Extend wellnessRole with cashier | 2026-05-24 session |
| 2026-05-24 | PRD_THEME_MANAGEMENT.md | DD-5.2 | User pref wins | 2026-05-24 session |

---

## Maintenance notes

- **Append new rows** whenever a PRD lands with new decisions. Use the source PRD's existing convention (DD- / DC- / PC- / D-) — don't rename for consistency. Cross-link via the PRD file path.
- **Move resolved decisions** to the Resolution log but leave the original row marked `[RESOLVED YYYY-MM-DD]` so cross-PRD references still resolve.
- **Re-audit every 5-10 ticks** — cron may surface decision drift (a PRD's recommendation rev's underneath without the tracker catching it).
- **Standardisation candidate** — future PRDs should default to `DD-5.X` (the newest convention). DC- + PC- + D-N are legacy formats kept for back-link stability.
