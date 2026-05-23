# Design Decisions Tracker

Consolidated index of every product/design decision flagged across the 22 PRDs in `docs/`. Use this to drive product-call agendas — each row is something the product team needs to settle before the corresponding PRD can move to (or finish) implementation.

**Updated:** 2026-05-23 (tick #22, auto-aggregated by the overnight cron)
**Total decisions pending:** 118 across 20 of the 22 cron-tracked PRDs (the 2 without surfaced decisions are WHATSAPP, DIGILOCKER_USE_CASE — pure cred-chase + use-case narrative; see "no decisions surfaced" section below for rationale). Two additional adjacent docs (`DIGILOCKER_INTEGRATION_SPEC.md`, `TRAVEL_CRM_PRD.md`) also surveyed and listed there.
**Format note:** PRDs use three competing naming conventions for decisions — `DD-5.X` (newer Travel-vertical PRDs), `DC-N` (mid-cycle PRDs), `PC-N` / `D-N` (earliest PRDs). This tracker preserves the source ID so cross-references stay clickable; consider standardising to `DD-` in future PRDs.

---

## How to use this tracker

- **Drive product-call agendas** — group decisions by THEME (auth, billing, AI model selection, fork-vs-extend) and settle them in batches. Several themes have 3-4 decisions across sibling PRDs that interlock; deciding one in isolation leads to re-thrash.
- **Mark decisions RESOLVED inline** — when a call lands, edit the row from `[PENDING]` → `[RESOLVED 2026-MM-DD: <one-line rationale>]` and link the PR/commit that ratifies the decision. Keep the original recommendation text for context.
- **Link back to source PRD** — each entry references the source-PRD file. Open the PRD's §5 for full context (trade-off matrix, owner, blocking-relationships).
- **Don't promote without a third datapoint** — when adding new decision rows from a new PRD, follow the source PRD's existing convention (don't rename DC- → DD-). Standardisation is a separate exercise.
- **Cred-chase items are NOT in this tracker** — those are separate (e.g. Q9 WhatsApp creds, Q19 RateHawk key). This file is decisions-only. A sibling `docs/CREDS_TRACKER.md` could be authored if useful.

---

## Decisions by PRD

### PRD_TRAVEL_GST_COMPLIANCE.md (6 pending)
- DD-5.1 [PENDING] GSTN portal GSTIN reverse-check vendor (ClearTax / Masters India / GSTN direct / none-at-launch). Rec: Masters India low-volume.
- DD-5.2 [PENDING] Tax-rate maintenance UI vs hardcoded JSON vs ClearTax tax-engine SaaS. Rec: operator-maintained Admin UI.
- DD-5.3 [PENDING] RCM auto-flag policy per service category. Rec: operator-toggled per-invoice, audit-logged.
- DD-5.4 [PENDING] GSTR-1/3B delivery: direct GSTN portal / ClearTax connector / Excel Software handover (Q21). Rec: Excel handover at launch.
- DD-5.5 [PENDING] Backfill existing invoices without HSN/SAC. Rec: backfill via `ServiceCategory.defaultSacCode` where possible + default-18% for the rest.
- DD-5.6 [PENDING] GSTR-1 cadence — monthly vs QRMP quarterly. Rec: per-sub-brand election, monthly default.

### PRD_TRAVEL_BILLING.md (7 pending)
- DD-5.1 [PENDING] Fork `TravelInvoice` or extend in-place. Rec: FORK (sibling to Quote/Supplier fork decisions).
- DD-5.2 [PENDING] Schedule-template ownership: free-form operator vs admin-curated. Rec: admin-curated + operator override.
- DD-5.3 [PENDING] Reporting currency basis: operator-preferred / sub-brand home / tenant-global. Rec: sub-brand home + operator override.
- DD-5.4 [PENDING] TCS tax-filer verification source. Rec: manual + CSV bulk-import.
- DD-5.5 [PENDING] Reminder cadence + channel — hard-coded T-7/T-3/T-1 vs operator-configurable; channels mix. Rec: hard-coded cadence, all-channels with opt-out.
- DD-5.6 [PENDING] Cancellation-policy editor scope: admin-only / per-sub-brand-head / per-operator. Rec: admin-only (legal-contract risk).
- DD-5.7 [PENDING] Per-sub-brand PDF branding (Yasin's brand handover, Q22). Rec: ship FR-3.8.d with placeholder branding now, swap later.

### PRD_TRAVEL_B2B_AGENT_PORTAL.md (7 pending)
- DD-5.1 [PENDING] Portal frontend topology — new React app vs new routes in existing app. Rec: Option B (new routes) for v1, fork plan documented.
- DD-5.2 [PENDING] Sub-agent tier model — rule-based vs operator-curated vs hybrid. Rec: hybrid with rule-based default + operator override.
- DD-5.3 [PENDING] Commission settlement timing — at-booking / at-payment / at-month-end. Rec: at-customer-payment with monthly statement cadence.
- DD-5.4 [PENDING] Corporate policy editor — in-app form / JSON upload / spreadsheet. Rec: Option A (in-app form) v1; Option C (spreadsheet) v2.
- DD-5.5 [PENDING] Approval workflow chain shape — linear / multi-stage / configurable. Rec: configurable, with linear default template.
- DD-5.6 [PENDING] Expense report format — per-corporate template vs canonical CSV. Rec: canonical CSV v1; per-template v2.
- DD-5.7 [PENDING] Traveler-profile sharing scope — corp-scoped vs cross-corp shared. Rec: corp-scoped (privacy-safer).

### PRD_TRAVEL_MULTICHANNEL_LEADS.md (5 pending)
- DD-5.1 [PENDING] Cross-channel merge auto vs prompt. Rec: auto-merge + notify operator.
- DD-5.2 [PENDING] Within-channel cooldown duration (default 60min per FR-3.7.2). Per-channel override?
- DD-5.3 [PENDING] Routing-rule priority resolution — most-specific-wins vs last-created-wins. Rec: most-specific (industry pattern).
- DD-5.4 [PENDING] Per-channel notification cadence — per-intake vs per-rule-match. Rec: per-rule-match + ops-overview channel.
- DD-5.5 [PENDING] Idempotency window — 24h vs 7d. Rec: 24h covers vendor retries.

### PRD_TRAVEL_QUOTE_BUILDER.md (6 pending)
- DD-5.1 [PENDING] Fork `TravelQuote` vs extend `Quote` vs extend `Estimate`. Rec: FORK (matches Billing + Supplier symmetric decisions).
- DD-5.2 [PENDING] Pricing-engine UX — rule-based config vs formula-language. Rec: rule-based (config-driven). Formula-language as Phase 2 escape hatch.
- DD-5.3 [PENDING] Tax treatment default per sub-brand — inclusive vs exclusive. Rec: TMC + Visa Sure exclusive; RFU + Travel Stall inclusive.
- DD-5.4 [PENDING] FX-rate source + cadence — RBI / vendor (OXR/Fixer) / manual. Rec: RBI ref-rate, daily 09:00 IST cron.
- DD-5.5 [PENDING] Counter-offer flow — simple delta+reason vs rich line-edit. Rec: simple v1; rich v2 if usage shows demand.
- DD-5.6 [PENDING] PDF renderer ownership — extend `pdfRenderer.js` vs new `travelPdfRenderer.js`. Rec: extend existing.

### PRD_TRAVEL_PIPELINE_KANBAN.md (4 pending)
- DD-5.1 [PENDING] Drag-drop library — HTML5 native / `react-beautiful-dnd` / `@dnd-kit/core` / `react-dnd`. Rec: `@dnd-kit/core` (smallest touch-capable + actively maintained).
- DD-5.2 [PENDING] Stale-data refresh policy — socket only / interval fallback / manual button. Rec: manual button + socket happy-path.
- DD-5.3 [PENDING] Filter chip default for multi-brand users. Rec: all brands user has access to.
- DD-5.4 [PENDING] Crowded-column UX (>100 cards) — virtualize / cap+modal / collapse old. Rec: virtualization (FR-3.18).

### PRD_TRAVEL_SUPPLIER_MASTER.md (5 pending)
- DD-5.1 [PENDING] Extend `Vendor` model or fork to `TravelSupplier`. Rec: FORK (cross-ref Billing DD-5.1 + Quote DD-5.1 — mirror).
- DD-5.2 [PENDING] KYC document storage — S3-style / DigiLocker / Prisma `String?` paths.
- DD-5.3 [PENDING] Reconciliation tolerance scoping — global / per-tenant / per-supplier. Rec: per-tenant v1, per-supplier Phase 2.
- DD-5.4 [PENDING] Dispute resolution flow — in-app only / with escalation hooks. Rec: in-app v1, hooks Phase 2.
- DD-5.5 [PENDING] TDS auto-deduction ownership — which PRD's engine pushes downstream compliance reporting. Cross-ref GST DD-5.x to avoid double-counting.

### PRD_ADSGPT_MARKETING_REPORTS.md (6 pending)
- DC-1 [PENDING] Ingest cadence — nightly vs 4-hourly. Rec: nightly default, per-tenant configurable.
- DC-2 [PENDING] Per-tenant monthly budget cap + behavior on hit. Rec: $50/mo hard-stop + ops alert.
- DC-3 [PENDING] PII boundary in conversion export — aggregates-only vs hashed contact IDs. Rec: aggregates-only v1 (DPDP §11 safety).
- DC-4 [PENDING] Per-sub-brand budget tracking vs shared. Rec: separate per sub-brand.
- DC-5 [PENDING] AdsGPT account model — GS-owned shared vs per-tenant. Rec: GS-owned for Phase 1.
- DC-6 [PENDING] Report ownership — AI commentary customer-facing or operator-only. Rec: operator-only v1.

### PRD_AI_CALLING_CALLIFIED.md (7 pending)
- DC-1 [PENDING] Cost cap per tenant. Rec: $100/mo, per-call 90s wall-clock ceiling.
- DC-2 [PENDING] Lead-source whitelist for AI gating. Rec: `source IN (meta-ad, google-ad, youtube-ad, linkedin-ad, whatsapp-ad)` + `utm_medium` paid markers.
- DC-3 [PENDING] AI persona + script per sub-brand authorship. Rec: Yasin's content team drafts per sub-brand.
- DC-4 [PENDING] Opt-out wording when parent declines AI. Rec: "Understood. I'll have a senior travel consultant ..." canned phrase.
- DC-5 [PENDING] TRAI pre-call recording disclosure wording. Counsel-owned.
- DC-6 [PENDING] Failure-path operator surface — dashboard tile + queue.
- DC-7 [PENDING] Per-tenant disable toggle via ADMIN settings. Rec: Yes — `aiCallingEnabled Boolean` per tenant.

### PRD_AI_ERA_CRM_REBUILD.md (5 pending)
- D1 [PENDING] Embedding provider — OpenAI / Voyage / local Sentence-Transformers / Cohere. Rec: OpenAI Phase 1 + adapter abstraction.
- D2 [PENDING] Graph store — MySQL adjacency / Postgres+AGE / Neo4j / TigerGraph. Rec: MySQL adjacency Phase 1+2, revisit Phase 3.
- D3 [PENDING] LLM provider for agents — Anthropic / OpenAI / Gemini / mixed. Rec: Anthropic for orchestration + Haiku for high-volume specialists.
- D4 [PENDING] Query warehouse — DuckDB embedded / ClickHouse sidecar / Postgres / Snowflake. Rec: DuckDB Phase 4.
- D5 [PENDING] Teammate naming policy — fixed names / tenant-customizable / rename-defaults. Rec: defaults user-renameable, vertical-appropriate defaults.

### PRD_BOOKING_EXPEDIA_DIRECT.md (7 pending)
- DC-1 [PENDING] Vendor priority — Booking.com first or Expedia first if bandwidth constrained. Rec: Booking.com first (India inventory + simpler OAuth2).
- DC-2 [PENDING] Dedup strategy — show all 3 vendors or pick cheapest. Rec: show all 3 with vendor badges, dedup cluster UI.
- DC-3 [PENDING] Caching aggressiveness — nightly vs 4-hour. Rec: nightly v1, configurable per tenant later.
- DC-4 [PENDING] Direct-book scope — Phase 2 timing quarter or demand-driven. Rec: when-there's-demand (operator metric threshold).
- DC-5 [PENDING] Failure UX — partial-with-banner vs hard-fail. Rec: partial-with-banner.
- DC-6 [PENDING] Cancellation normalizer ownership — GS rules vs operator-mapped. Rec: GS-internal + operator override per quote.
- DC-7 [PENDING] Vendor brand visibility on customer PDF. Rec: invisible (operator branding owns experience).

### PRD_DARK_MODE_CLUSTER.md (5 pending)
- DC-1 [PENDING] Per-page audit ownership — per-tick grep vs one-shot discovery doc. Rec: one-shot `docs/dark-mode-audit.md` discovery agent.
- DC-2 [PENDING] Page priority order — issue-number / sub-brand / user-traffic. Rec: user-traffic with issue-number fallback.
- DC-3 [PENDING] Scope extent — 14 named pages vs comprehensive audit. Rec: comprehensive (5-min grep add-on).
- DC-4 [PENDING] Dark-mode toggle UX + persistence sub-cluster. Rec: sibling sub-cluster covering #862/#868/#869/#870/#876.
- DC-5 [PENDING] Wellness vertical scope — own cluster or shared. Rec: VERIFY before assuming (one-shot grep).

### PRD_EXCEL_SOFTWARE_ACCOUNTING.md (6 pending)
- DC-1 [PENDING] Transport — API path vs CSV path. Rec: API if vendor has idempotency, else CSV.
- DC-2 [PENDING] CSV path: SFTP vs local NFS mount. Rec: SFTP (consistent ops).
- DC-3 [PENDING] Per-tenant directory structure — `/tenants/<slug>/<date>.csv` vs flat. Rec: hierarchical.
- DC-4 [PENDING] Reconciliation discrepancy threshold. Rec: any diff into queue (FR-9).
- DC-5 [PENDING] Per-sub-brand GSTIN/legal-entity mapping verification. Rec: pre-flight check at bridge-enable time.
- DC-6 [PENDING] Cancellation handling — re-export vs cancellation-notification. Rec: re-export with `status=cancelled`.

### PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md (6 pending)
- DC-1 [PENDING] Browser runtime — Playwright vs MCP-via-LLM. Rec: Playwright (deterministic + free + Phase 1 cost-predictable).
- DC-2 [PENDING] Initial airline priority. Rec: Phase 1 = IndiGo + Air India + Vistara + Emirates (~85% volume).
- DC-3 [PENDING] Containerization / hosting alongside cron engines. Rec: containerize Playwright + Chromium.
- DC-4 [PENDING] Retry policy on `fallback-agent` rows. Rec: once at next 15-min cron tick.
- DC-5 [PENDING] ToS audit pre-launch counsel review. Rec: mandatory for all 4 Phase 1 airlines.
- DC-6 [PENDING] Parent completion-notification channel + timing. Rec: reuse `/deliver` endpoint (Q9 cred-blocked).

### PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md (6 pending)
- DC-1 [PENDING] Repo location — separate `globussoft-flight-plugin` vs `chrome-extension/` subdir. Rec: separate repo.
- DC-2 [PENDING] Chrome Web Store publisher account — GS / Travel Stall / hybrid. Rec: GS + Yasin co-admin (hybrid).
- DC-3 [PENDING] Airline coverage priority for first 3. Rec: IndiGo + Air India + Emirates (3-week rollout).
- DC-4 [PENDING] Auth model — per-advisor / per-tenant / OAuth. (See PRD for trade-off.)
- DC-5 [PENDING] Update mechanism — Web Store auto-update vs self-hosted. Rec: Web Store (FR-7).
- DC-6 [PENDING] Demo environment config — build-time vs runtime endpoint discovery. Rec: config-by-build, 2 distinct extension IDs (dev + prod).

### PRD_PASSPORT_OCR.md (5 pending)
- PC-1 [PENDING] OCR vendor — Google DocAI / Azure Form Recognizer / hybrid / Indian alt. Rec: Google DocAI V1.
- PC-2 [PENDING] Data residency — strict India-region pin vs loose. Rec: strict (`asia-south1` Mumbai).
- PC-3 [PENDING] Consent text wording. Rec: mirror Q2 Aadhaar consent format (counsel review).
- PC-4 [PENDING] Manual fallback SLA. Rec: 24h TMC+RFU; same-day Visa Sure.
- PC-5 [PENDING] Re-upload attempt limit before operator intervention. Rec: 3 attempts then notify.

### PRD_RATEHAWK_INTEGRATION.md (6 pending)
- DC-1 [PENDING] Pricing model with RateHawk — per-API-call vs per-booking. Rec: pick whichever Yasin negotiates; PRD assumes per-call.
- DC-2 [PENDING] Config storage — new model vs extend `Integration`. Rec: extend `Integration` (consistent).
- DC-3 [PENDING] Rate caching policy — 5-min default configurable per tenant. Rec: not configurable v1.
- DC-4 [PENDING] Lowest-rate auto-pick tiebreaker — refundability vs raw lowest. Rec: refundability-preferred.
- DC-5 [PENDING] Error UX on 0 results. Rec: "no inventory" + manual-quote CTA.
- DC-6 [PENDING] Phase-2 multi-vendor expansion — side-by-side clients vs unified abstraction. Rec: side-by-side (no premature abstraction).

### PRD_RFU_GROUND_SERVICES.md (6 pending)
- D-5.2.a [PENDING] Scrape-vs-partner-API per hotel portal (per-portal call). Counsel-owned (ToS review).
- D-5.2.b [PENDING] Group-booking flow — single PNR per leg vs per-pilgrim individual PNRs.
- D-5.2.c [PENDING] Auto-confirmation policy — auto-book on cheapest vs human review (matches RateHawk default).
- D-5.2.d [PENDING] Sub-agent margin override — fixed % / per-leg / per-vendor.
- D-5.2.e [PENDING] Hajj-season caching exception — confirm 30min TTL or tighter.
- D-5.2.f [PENDING] Cancellation reconciliation policy — auto-cancel linked legs vs surface independently.

### PRD_TMC_CURRICULUM_MAPPING.md (5 pending)
- PC-1 [PENDING] Source the V1 mapping data + timeline. **THE BLOCKER** — without content, feature ships as empty table. Rec: GS-drafted 100-200 starter rows + academic team validates, 6-week target.
- PC-2 [PENDING] Curriculum scope for V1 — which boards seed on Day 1. Rec: CBSE + ICSE only v1; IB + Cambridge + state-board Phase 2.
- PC-3 [PENDING] Mapping granularity — coarse `(curriculum, grade, subject)` vs fine with learningOutcome. Rec: fine grain.
- PC-4 [PENDING] fitScore methodology — algorithmic vs human-judged. Rec: human-judged V1.
- PC-5 [PENDING] Destination universe — referential vs free-text. Rec: referential with TMC's existing trip catalogue.

### PRD_VISA_SURE_PHASE_3.md (8 pending)
- PC-1 [PENDING] "Complex case" definition for risk-flag engine FR-3.1. Rec: applicationType ∈ {work, student, business, hajj} OR priorRejectionCount ≥ 1 OR family/dependents OR high-rejection-rate destination.
- PC-2 [PENDING] Rejection-recovery — new diagnostic or reuse original. Drives schema relation.
- PC-3 [PENDING] Per-destination embassy-quirk modeling — Phase 3 in-scope or advisor-head-only. Heavy schema work if (b).
- PC-4 [PENDING] Rejection-recovery time-window enforcement. Drives `createdAt > decidedAt + cool-down` check.
- PC-5 [PENDING] Visa categories in scope for Phase 1 — tourist/business/family/student baseline; transit/work/dependent/medical/journalism/religious-pilgrimage open.
- PC-6 [PENDING] Region focus — US-outbound only / India-outbound / any-to-any. Rec: India-outbound.
- PC-7 [PENDING] Embassy-quirk catalogue maintainer post-ship (rules change quarterly).
- PC-8 [PENDING] Family/dependents trigger source for FR-3.1(c) — VisaApplication column / Contact-level / drop from V1. Surfaced by tick #9 Agent 3. Risk-flag engine cannot ship faithful FR-3.1 until this resolves.

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

_(empty — populate as decisions land)_

| Date | PRD | DD/DC/PC ID | Decision | Ratified by |
|---|---|---|---|---|
| _example_ | _PRD_TRAVEL_QUOTE_BUILDER.md_ | _DD-5.1_ | _FORK_ | _commit XYZ + Suresh sign-off_ |

---

## Maintenance notes

- **Append new rows** whenever a PRD lands with new decisions. Use the source PRD's existing convention (DD- / DC- / PC- / D-) — don't rename for consistency. Cross-link via the PRD file path.
- **Move resolved decisions** to the Resolution log but leave the original row marked `[RESOLVED YYYY-MM-DD]` so cross-PRD references still resolve.
- **Re-audit every 5-10 ticks** — cron may surface decision drift (a PRD's recommendation rev's underneath without the tracker catching it).
- **Standardisation candidate** — future PRDs should default to `DD-5.X` (the newest convention). DC- + PC- + D-N are legacy formats kept for back-link stability.
