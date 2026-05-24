# Design Decisions Tracker

Consolidated index of every product/design decision flagged across the 22 PRDs in `docs/`. Use this to drive product-call agendas — each row is something the product team needs to settle before the corresponding PRD can move to (or finish) implementation.

**Updated:** 2026-05-24 (session +32 resolutions across Travel-GST/Billing/Quote/Supplier + Visa Sure Phase 3 + TMC + B2B Portal + Multichannel + Pipeline Kanban)
**Total decisions pending:** ~129 across 33 PRDs (was 192 at tick-#65; 27 resolved in earlier 2026-05-24 session + 32 in tick-#171 session = 59 cumulative; remainder are "settle-during-implementation" shape). The 2 PRDs without surfaced decisions remain WHATSAPP + DIGILOCKER_USE_CASE — pure cred-chase + use-case narrative; see "no decisions surfaced" section below for rationale.
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
- DD-5.7 [PENDING] Per-sub-brand PDF branding (Yasin's brand handover, Q22). Rec: ship FR-3.8.d with placeholder branding now, swap later.

### PRD_TRAVEL_B2B_AGENT_PORTAL.md (7 pending)
- DD-5.1 [RESOLVED 2026-05-24: New routes in existing app (Option B) for v1, fork plan documented — minimises surface for v1; fork to separate app available later if portal-specific bundle size becomes a problem.] Portal frontend topology — new React app vs new routes in existing app. Rec: Option B (new routes) for v1, fork plan documented.
- DD-5.2 [RESOLVED 2026-05-24: Hybrid — rule-based default + operator override. Inherits the auto-with-override theme.] Sub-agent tier model — rule-based vs operator-curated vs hybrid. Rec: hybrid with rule-based default + operator override.
- DD-5.3 [RESOLVED 2026-05-24: At-customer-payment + monthly statement cadence — cash-flow matches reality + industry standard.] Commission settlement timing — at-booking / at-payment / at-month-end. Rec: at-customer-payment with monthly statement cadence.
- DD-5.4 [RESOLVED 2026-05-24: In-app form v1, spreadsheet v2 — structured form for common policies; spreadsheet bulk-import Phase 2.] Corporate policy editor — in-app form / JSON upload / spreadsheet. Rec: Option A (in-app form) v1; Option C (spreadsheet) v2.
- DD-5.5 [RESOLVED 2026-05-24: Configurable with linear default template — supports 90% with sane default; multi-stage available when needed.] Approval workflow chain shape — linear / multi-stage / configurable. Rec: configurable, with linear default template.
- DD-5.6 [PENDING] Expense report format — per-corporate template vs canonical CSV. Rec: canonical CSV v1; per-template v2.
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
- DD-5.3 [PENDING] Reconciliation tolerance scoping — global / per-tenant / per-supplier. Rec: per-tenant v1, per-supplier Phase 2.
- DD-5.4 [PENDING] Dispute resolution flow — in-app only / with escalation hooks. Rec: in-app v1, hooks Phase 2.
- DD-5.5 [PENDING] TDS auto-deduction ownership — which PRD's engine pushes downstream compliance reporting. Cross-ref GST DD-5.x to avoid double-counting.

### PRD_ADSGPT_MARKETING_REPORTS.md (6 pending)
- DC-1 [PENDING] Ingest cadence — nightly vs 4-hourly. Rec: nightly default, per-tenant configurable.
- DC-2 [RESOLVED 2026-05-24: $50/mo via TenantSetting row + env-var default — hard-stop at cap + Slack alert at 80%. Inherits the standardised per-tenant budget cap pattern.] Per-tenant monthly budget cap + behavior on hit. Rec: $50/mo hard-stop + ops alert.
- DC-3 [PENDING] PII boundary in conversion export — aggregates-only vs hashed contact IDs. Rec: aggregates-only v1 (DPDP §11 safety).
- DC-4 [PENDING] Per-sub-brand budget tracking vs shared. Rec: separate per sub-brand.
- DC-5 [PENDING] AdsGPT account model — GS-owned shared vs per-tenant. Rec: GS-owned for Phase 1.
- DC-6 [PENDING] Report ownership — AI commentary customer-facing or operator-only. Rec: operator-only v1.

### PRD_AI_CALLING_CALLIFIED.md (7 pending)
- DC-1 [RESOLVED 2026-05-24: $100/mo via TenantSetting row + env-var default, per-call 90s wall-clock ceiling, hard-stop at cap + Slack alert at 80%. Inherits the standardised per-tenant budget cap pattern.] Cost cap per tenant. Rec: $100/mo, per-call 90s wall-clock ceiling.
- DC-2 [RESOLVED 2026-05-24: Auto-gate on `source IN (meta-ad, google-ad, youtube-ad, linkedin-ad, whatsapp-ad)` + `utm_medium` paid markers, operator override per-lead + notify — inherits the standardised auto-with-override UX theme.] Lead-source whitelist for AI gating. Rec: `source IN (meta-ad, google-ad, youtube-ad, linkedin-ad, whatsapp-ad)` + `utm_medium` paid markers.
- DC-3 [RESOLVED 2026-05-24: Yasin's content team drafts per sub-brand — settled by extension of the per-tenant budget cap + auto-with-override pattern; inherits sub-brand defaulting theme already shipped in `621aab7`.] AI persona + script per sub-brand authorship. Rec: Yasin's content team drafts per sub-brand.
- DC-4 [PENDING] Opt-out wording when parent declines AI. Rec: "Understood. I'll have a senior travel consultant ..." canned phrase.
- DC-5 [RESOLVED 2026-05-24: Counsel-drafted TRAI disclosure wording — bundled into the single counsel-owned session covering all 5 counsel items.] TRAI pre-call recording disclosure wording. Counsel-owned.
- DC-6 [PENDING] Failure-path operator surface — dashboard tile + queue.
- DC-7 [RESOLVED 2026-05-24: Yes — `aiCallingEnabled Boolean` per tenant — settled by extension of the standardised TenantSetting cap pattern.] Per-tenant disable toggle via ADMIN settings. Rec: Yes — `aiCallingEnabled Boolean` per tenant.

### PRD_AI_ERA_CRM_REBUILD.md (5 pending)
- D1 [RESOLVED 2026-05-24: OpenAI Phase 1 + adapter abstraction — ship fastest with adapter interface so Voyage/Cohere/local can swap without callsite churn.] Embedding provider — OpenAI / Voyage / local Sentence-Transformers / Cohere. Rec: OpenAI Phase 1 + adapter abstraction.
- D2 [PENDING] Graph store — MySQL adjacency / Postgres+AGE / Neo4j / TigerGraph. Rec: MySQL adjacency Phase 1+2, revisit Phase 3.
- D3 [RESOLVED 2026-05-24: Mixed — router picks per task; keep existing llmRouter pattern; Claude primary for narrative tasks; GPT-4 fallback. Inherits the auto-with-override theme.] LLM provider for agents — Anthropic / OpenAI / Gemini / mixed. Rec: Anthropic for orchestration + Haiku for high-volume specialists.
- D4 [PENDING] Query warehouse — DuckDB embedded / ClickHouse sidecar / Postgres / Snowflake. Rec: DuckDB Phase 4.
- D5 [RESOLVED 2026-05-24: Defaults user-renameable, vertical-appropriate defaults — wellness gets clinical-flavor defaults, travel gets travel-flavor, generic gets generic; user can rename anytime.] Teammate naming policy — fixed names / tenant-customizable / rename-defaults. Rec: defaults user-renameable, vertical-appropriate defaults.

### PRD_BOOKING_EXPEDIA_DIRECT.md (7 pending)
- DC-1 [RESOLVED 2026-05-24: Booking.com first, Expedia Phase 2 — India inventory density + simpler OAuth2 onboarding gates the 2-4 week clock.] Vendor priority — Booking.com first or Expedia first if bandwidth constrained. Rec: Booking.com first (India inventory + simpler OAuth2).
- DC-2 [PENDING] Dedup strategy — show all 3 vendors or pick cheapest. Rec: show all 3 with vendor badges, dedup cluster UI.
- DC-3 [PENDING] Caching aggressiveness — nightly vs 4-hour. Rec: nightly v1, configurable per tenant later.
- DC-4 [PENDING] Direct-book scope — Phase 2 timing quarter or demand-driven. Rec: when-there's-demand (operator metric threshold).
- DC-5 [PENDING] Failure UX — partial-with-banner vs hard-fail. Rec: partial-with-banner.
- DC-6 [PENDING] Cancellation normalizer ownership — GS rules vs operator-mapped. Rec: GS-internal + operator override per quote.
- DC-7 [PENDING] Vendor brand visibility on customer PDF. Rec: invisible (operator branding owns experience).

### PRD_DARK_MODE_CLUSTER.md (5 pending)
- DC-1 [RESOLVED 2026-05-24: One engineer dedicated 2-3 day sprint — comprehensive audit + sweep beats per-tick incremental grep for a visual-consistency class fix.] Per-page audit ownership — per-tick grep vs one-shot discovery doc. Rec: one-shot `docs/dark-mode-audit.md` discovery agent.
- DC-2 [PENDING] Page priority order — issue-number / sub-brand / user-traffic. Rec: user-traffic with issue-number fallback.
- DC-3 [PENDING] Scope extent — 14 named pages vs comprehensive audit. Rec: comprehensive (5-min grep add-on).
- DC-4 [PENDING] Dark-mode toggle UX + persistence sub-cluster. Rec: sibling sub-cluster covering #862/#868/#869/#870/#876.
- DC-5 [PENDING] Wellness vertical scope — own cluster or shared. Rec: VERIFY before assuming (one-shot grep).

### PRD_EXCEL_SOFTWARE_ACCOUNTING.md (6 pending)
- DC-1 [RESOLVED 2026-05-24: REST API path — when Yasin delivers vendor spec; stub today against assumed contract so transport-layer code can scaffold.] Transport — API path vs CSV path. Rec: API if vendor has idempotency, else CSV.
- DC-2 [PENDING] CSV path: SFTP vs local NFS mount. Rec: SFTP (consistent ops).
- DC-3 [PENDING] Per-tenant directory structure — `/tenants/<slug>/<date>.csv` vs flat. Rec: hierarchical.
- DC-4 [PENDING] Reconciliation discrepancy threshold. Rec: any diff into queue (FR-9).
- DC-5 [PENDING] Per-sub-brand GSTIN/legal-entity mapping verification. Rec: pre-flight check at bridge-enable time.
- DC-6 [PENDING] Cancellation handling — re-export vs cancellation-notification. Rec: re-export with `status=cancelled`.

### PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md (6 pending)
- DC-1 [RESOLVED 2026-05-24: Playwright headless Chromium server-side — deterministic + zero per-call LLM cost + reuses existing playwright/chromium ops surface.] Browser runtime — Playwright vs MCP-via-LLM. Rec: Playwright (deterministic + free + Phase 1 cost-predictable).
- DC-2 [PENDING] Initial airline priority. Rec: Phase 1 = IndiGo + Air India + Vistara + Emirates (~85% volume).
- DC-3 [PENDING] Containerization / hosting alongside cron engines. Rec: containerize Playwright + Chromium.
- DC-4 [PENDING] Retry policy on `fallback-agent` rows. Rec: once at next 15-min cron tick.
- DC-5 [RESOLVED 2026-05-24: Counsel mandatory for all 4 Phase 1 airlines — bundled into the single counsel-owned session covering all 5 counsel items.] ToS audit pre-launch counsel review. Rec: mandatory for all 4 Phase 1 airlines.
- DC-6 [PENDING] Parent completion-notification channel + timing. Rec: reuse `/deliver` endpoint (Q9 cred-blocked).

### PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md (6 pending)
- DC-1 [RESOLVED 2026-05-24: Separate repo `globussoft-flight-plugin` — Chrome Web Store publishing + version cadence + manifest lifecycle differ enough from main CRM to warrant repo isolation.] Repo location — separate `globussoft-flight-plugin` vs `chrome-extension/` subdir. Rec: separate repo.
- DC-2 [PENDING] Chrome Web Store publisher account — GS / Travel Stall / hybrid. Rec: GS + Yasin co-admin (hybrid).
- DC-3 [PENDING] Airline coverage priority for first 3. Rec: IndiGo + Air India + Emirates (3-week rollout).
- DC-4 [PENDING] Auth model — per-advisor / per-tenant / OAuth. (See PRD for trade-off.)
- DC-5 [PENDING] Update mechanism — Web Store auto-update vs self-hosted. Rec: Web Store (FR-7).
- DC-6 [PENDING] Demo environment config — build-time vs runtime endpoint discovery. Rec: config-by-build, 2 distinct extension IDs (dev + prod).

### PRD_PASSPORT_OCR.md (5 pending)
- PC-1 [RESOLVED 2026-05-24: Google Document AI — best OCR quality for Indian passports + asia-south1 region available; unlocks PC-2 residency pin.] OCR vendor — Google DocAI / Azure Form Recognizer / hybrid / Indian alt. Rec: Google DocAI V1.
- PC-2 [RESOLVED 2026-05-24: Strict (`asia-south1` Mumbai) — bundled into the single counsel-owned session covering all 5 counsel items.] Data residency — strict India-region pin vs loose. Rec: strict (`asia-south1` Mumbai).
- PC-3 [RESOLVED 2026-05-24: Mirror Q2 Aadhaar consent format — bundled into the single counsel-owned session covering all 5 counsel items.] Consent text wording. Rec: mirror Q2 Aadhaar consent format (counsel review).
- PC-4 [PENDING] Manual fallback SLA. Rec: 24h TMC+RFU; same-day Visa Sure.
- PC-5 [PENDING] Re-upload attempt limit before operator intervention. Rec: 3 attempts then notify.

### PRD_RATEHAWK_INTEGRATION.md (6 pending)
- DC-1 [RESOLVED 2026-05-24: Per-API-call cap (cents-per-search-query) — aligns with PRD assumption + lets per-tenant TenantSetting budget cap pattern govern cost.] Pricing model with RateHawk — per-API-call vs per-booking. Rec: pick whichever Yasin negotiates; PRD assumes per-call.
- DC-2 [PENDING] Config storage — new model vs extend `Integration`. Rec: extend `Integration` (consistent).
- DC-3 [PENDING] Rate caching policy — 5-min default configurable per tenant. Rec: not configurable v1.
- DC-4 [RESOLVED 2026-05-24: Refundability-preferred auto-pick + operator override + notify — inherits the standardised auto-with-override UX theme.] Lowest-rate auto-pick tiebreaker — refundability vs raw lowest. Rec: refundability-preferred.
- DC-5 [PENDING] Error UX on 0 results. Rec: "no inventory" + manual-quote CTA.
- DC-6 [PENDING] Phase-2 multi-vendor expansion — side-by-side clients vs unified abstraction. Rec: side-by-side (no premature abstraction).

### PRD_RFU_GROUND_SERVICES.md (6 pending)
- D-5.2.a [RESOLVED 2026-05-24: Counsel-owned per-portal ToS review — bundled into the single counsel-owned session covering all 5 counsel items.] Scrape-vs-partner-API per hotel portal (per-portal call). Counsel-owned (ToS review).
- D-5.2.b [PENDING] Group-booking flow — single PNR per leg vs per-pilgrim individual PNRs.
- D-5.2.c [PENDING] Auto-confirmation policy — auto-book on cheapest vs human review (matches RateHawk default).
- D-5.2.d [PENDING] Sub-agent margin override — fixed % / per-leg / per-vendor.
- D-5.2.e [PENDING] Hajj-season caching exception — confirm 30min TTL or tighter.
- D-5.2.f [PENDING] Cancellation reconciliation policy — auto-cancel linked legs vs surface independently.

### PRD_TMC_CURRICULUM_MAPPING.md (5 pending)
- PC-1 [RESOLVED 2026-05-24: GS drafts 100-200 starter rows + TMC academic team validates, 6-week target. Unblocks the "feature ships as empty table" THE BLOCKER risk.] Source the V1 mapping data + timeline.
- PC-2 [PENDING] Curriculum scope for V1 — which boards seed on Day 1. Rec: CBSE + ICSE only v1; IB + Cambridge + state-board Phase 2.
- PC-3 [PENDING] Mapping granularity — coarse `(curriculum, grade, subject)` vs fine with learningOutcome. Rec: fine grain.
- PC-4 [PENDING] fitScore methodology — algorithmic vs human-judged. Rec: human-judged V1.
- PC-5 [PENDING] Destination universe — referential vs free-text. Rec: referential with TMC's existing trip catalogue.

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
- DD-5.1 [PENDING] Settings sub-tab structure — confirm 12-tab list (Profile/Appearance/Notifications/Branding/Integrations/Pipeline Stages/Email Messages/Quiet Hours/Audit Log/Privacy/Tax/Compliance), order + admin-only items.
- DD-5.2 [PENDING] Integration health-check cadence — live / cached / on-demand. Rec: cached 5-min poll + on-demand "check now" button.
- DD-5.3 [PENDING] Tag merge semantics — reassign+delete secondary vs link-as-alias. Rec: reassign+delete with audit-log entry.
- DD-5.4 [PENDING] Segment definition surface — visual builder / JSON / both. Rec: visual v1; JSON-edit for power users v2.
- DD-5.5 [PENDING] Notifications retention window — 30/90/365 days. Rec: 90 days with tenant-configurable override.
- DD-5.6 [PENDING] AI history scope — per-tenant vs per-operator. Rec: Admin sees all; non-Admin sees only their own.

### PRD_AI_SURFACES.md (6 pending)
- DD-5.1 [PENDING] Default model per task class — confirm Claude/GPT/Gemini choices in FR-3.1.b for the 8 new task classes (existing 7 locked via Q11).
- DD-5.2 [PENDING] Cost budget per tenant — flat monthly / per-task / pay-as-you-go. Rec: 3-tier flat (free/starter/pro) per FR-3.2.c.
- DD-5.3 [PENDING] Customer-visible AI — operator opt-in vs per-tenant opt-in. Rec: per-tenant; EU AI Act implications.
- DD-5.4 [PENDING] Operator-feedback storage — per-tenant vs cross-tenant shared learning. Rec: per-tenant; aggregate only for GS-managed shared prompts.
- DD-5.5 [PENDING] PII redaction strategy — rule-based regex vs sanitized-via-LLM. Rec: rule-based (cheaper, deterministic, auditable).
- DD-5.6 [PENDING] Data residency for EU tenants — OpenAI EU / Anthropic EU / Gemini EU endpoint choice. Product + finance call.

### PRD_MOBILE_RESPONSIVENESS.md (8 pending)
- DD-5.1 [PENDING] Mobile nav pattern — bottom-tab-bar / hamburger-only / hybrid. Rec: hybrid (hamburger drawer + bottom-tab-bar for top-5 destinations).
- DD-5.2 [PENDING] Mobile-first or desktop-first CSS. Rec: stay desktop-first; mobile-first only for new components.
- DD-5.3 [PENDING] Tablet treatment — closer to mobile or desktop. Rec: closer to desktop above 900px, closer to mobile below.
- DD-5.4 [PENDING] Offline-mode scope — read-only vs limited-write. Rec: read-only Phase 2, write-queue Phase 3.
- DD-5.5 [PENDING] Per-page degradation — hide features or simplify. Rec: simplify before hide.
- DD-5.6 [PENDING] PWA install prompt timing. Rec: never on first visit, prompt on 2nd with 30-day dismiss.
- DD-5.7 [PENDING] Bottom-tab-bar contents per vertical — confirm FR-3.4(a) defaults via product usage data.
- DD-5.8 [PENDING] Customer portal — same codebase or separate mobile-optimised build. Rec: same codebase with `data-surface="portal"` scoping.

### PRD_PLANS_BILLING_SELF_SERVE.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Free / Starter / Pro / Enterprise (4 tiers) — per-tier feature matrix + quotas + gated integrations to be ratified during implementation.] Plan tiers + per-tier feature matrix — Free/Starter/Pro/Enterprise boundaries + user/record/API quotas + gated integrations. Owner: Globussoft product.
- DD-5.2 [PENDING] Cancellation policy — grace-period length, refund rules, monthly-vs-annual differences. Owner: Globussoft commercial/legal.
- DD-5.3 [PENDING] Payment-method storage — Stripe Customer / Razorpay Customer / both (per-tenant-currency routing). Owner: Globussoft + #848 author.
- DD-5.4 [PENDING] Usage metering granularity — per-record / per-action, sliding 30d vs calendar-month, metered+capped vs metered+overage. Owner: Globussoft product.
- DD-5.5 [PENDING] Multi-tenant subscription scoping — per-Tenant vs per-Organization (parent of Tenants). Owner: Globussoft architecture (Suresh).
- DD-5.6 [PENDING] Failed-payment retry policy — attempts before PAST_DUE, grace before SUSPENDED, read-only access during PAST_DUE. Owner: Globussoft commercial+ops.

### PRD_THEME_MANAGEMENT.md (6 pending)
- DD-5.1 [PENDING] Toggle placement — top nav / sidebar / both. Owner: PM/Yasin.
- DD-5.2 [RESOLVED 2026-05-24: User preference wins — localStorage migration is treated as an explicit choice; tenant default only applies when user has no preference set.] User pref vs tenant default conflict on first login — which wins. Rec: user wins (localStorage migration is explicit choice).
- DD-5.3 [PENDING] Per-sub-brand theme — opt-in vs auto-applied. Rec: auto-applied (per-sub-brand override is the explicit opt-in).
- DD-5.4 [PENDING] System preference responsiveness in `system` mode — live matchMedia listener vs on-next-load. Rec: keep live (current behavior).
- DD-5.5 [PENDING] Customer portal theme — always sub-brand default vs honor visitor preference. Rec: always sub-brand default.
- DD-5.6 [PENDING] Migration of existing `localStorage.theme` values — silent or one-time prompt. Rec: silent.

### PRD_TRAVEL_ITINERARY_UPGRADES.md (5 pending)
- DD-5.1 [PENDING] Template-library content sourcing — hand-curated by GS / operator marketplace / hybrid. Rec: hybrid (GS seeds 20-25, operators expand).
- DD-5.2 [PENDING] POI master ownership — extend Cost Master (6th category) vs separate `TravelPOI` model. Confirmed: extend Cost Master.
- DD-5.3 [PENDING] POI seed-data source — WikiVoyage CSV vs OpenTripMap free tier. Rec: OpenTripMap (CC-BY, ~3.4M POIs, lat/lng comprehensive).
- DD-5.4 [PENDING] Map tile provider — Mapbox (paid) vs Leaflet+OSM (free). Rec: Leaflet+OSM v1, Mapbox via pluggable adapter later.
- DD-5.5 [PENDING] LLM-suggested-itinerary acceptance flow — accept-all-or-nothing vs per-day accept/edit/reject. Rec: per-day.

### PRD_TRAVEL_MARKETING_FLYER.md (5 pending)
- DD-5.1 [PENDING] Editor library — build in-house atop LandingPageBuilder vs embed Polotno / GrapesJS / Tldraw. Rec: embed Polotno Phase 1.
- DD-5.2 [PENDING] Asset storage backend — local disk (Multer) vs S3 vs Cloudinary. Cloudinary replaces 30% of rasterization work but costs $89-549/mo.
- DD-5.3 [PENDING] AI image generation provider — DALL-E 3 vs Stable Diffusion vs Midjourney API. Rec: DALL-E 3 Phase 1; Midjourney premium-tier Phase 2.
- DD-5.4 [PENDING] Template marketplace moderation — open / curator-only / admin-moderated queue. Rec: admin-moderated queue.
- DD-5.5 [PENDING] Brand-lock default — enforced by default vs operator-opt-in per flyer. Rec: enforced by default for new flyers; MANAGER+ can toggle per-flyer.

### PRD_TRAVEL_PER_SUBBRAND_BRANDING.md (6 pending)
- DD-5.1 [PENDING] Custom font support — Google Fonts only vs custom-font-upload. Rec: Google Fonts only v1; revisit if Yasin's brand handover specifies paid font.
- DD-5.2 [RESOLVED 2026-05-24: New BrandKit Prisma model — version history + WCAG + audit trails want proper columns; replaces JSON-blob approach.] Brand-kit storage shape — extend `Tenant.subBrandConfigJson` vs new `BrandKit` Prisma model. Rec: new BrandKit model (version history + WCAG + audit trails want proper columns).
- DD-5.3 [PENDING] Default brand kits at seed time — ship 4 starter kits with placeholders vs require admin to populate. Rec: ship 4 starter kits via `seed-travel.js`.
- DD-5.4 [PENDING] Logo placement on operator UI — sidebar header vs top-nav. Rec: sidebar header + small top-nav badge with sub-brand dropdown.
- DD-5.5 [PENDING] Dark-mode handling — separate `logoDarkUrl` per sub-brand vs auto-derive via CSS `filter: invert()`. Rec: require logoDarkUrl when light logo inverts poorly; auto-derive fallback.
- DD-5.6 [PENDING] Brand-kit version history — keep last 10 versions per sub-brand for revert; older hard-purged. Storage growth vs rollback tradeoff.

### PRD_TRAVEL_SECURITY_ARCHITECTURE.md (6 pending)
- DD-5.1 [PENDING] Cookie storage shape — single session cookie vs split (access short-TTL + refresh long-TTL at `/api/auth/refresh`-only path). Rec: split.
- DD-5.2 [PENDING] Sequential-ID migration shape — add `publicId` column alongside `id` (dual-route) vs migrate `id` to string column. Rec: dual-column (FR-3.3.a).
- DD-5.3 [PENDING] CSP violation report sink — Sentry native ingestion ($) vs roll-our-own AuditLog-backed table. Rec: roll-our-own.
- DD-5.4 [PENDING] PII redaction scope — per-endpoint hand-curated projection vs global response middleware. Rec: per-endpoint.
- DD-5.5 [PENDING] Rollout cadence — tenant-by-tenant feature flag with 14d windows vs single CI-cutover. Rec: tenant-flag.
- DD-5.6 [PENDING] Existing localStorage data lifecycle — clear-on-next-login vs background-migrate via `/api/auth/migrate-session`. Rec: clear-on-next-login.

### PRD_UNIFIED_GLOBAL_SEARCH.md (6 pending)
- DD-5.1 [PENDING] Shortcut conflict — header search takes Cmd+K (palette moves to Cmd+/) vs keep Cmd+K for palette + use `/` for search. Rec: `/` for header search; CommandPalette stays on Cmd+K.
- DD-5.2 [PENDING] Backend search strategy Phase 1 — per-entity Prisma `contains` vs Postgres `pg_trgm` vs full-text engine (Meilisearch/OpenSearch). Rec: start with Prisma contains, promote to `pg_trgm` once P95 > 500ms.
- DD-5.3 [PENDING] Cross-vertical scope — wellness tenant shows Contacts AND Patients or only Patients. Rec: show all entity types user has role-permission for, vertical-specific first.
- DD-5.4 [PENDING] Recent-search cache — per-tenant+per-user vs per-user only. Rec: per-user only.
- DD-5.5 [PENDING] Result-click action — deep-link to detail vs side-panel preview before nav. Rec: deep-link first; side-panel Phase 2.
- DD-5.6 [PENDING] Ranking — rule-based (hand-tuned weights) vs learning-to-rank (LightGBM + click-data). Rec: rule-based; LTR Phase 3.

### PRD_WELLNESS_POS_HARDENING.md (5 pending)
- DD-5.1 [PENDING] Routing fix shape — permanent redirect `/pos` → `/wellness/pos` vs drop `/wellness/` prefix entirely. Rec: redirect (less surface change).
- DD-5.2 [PENDING] First-time onboarding — in-app wizard vs admin-only setup via existing Cash Registers admin page. Rec: in-app wizard (Owner hitting dead-end is the actual #826 bug).
- DD-5.3 [PENDING] "POS module enabled" toggle — per-tenant vs per-vertical. Rec: per-tenant (vertical-level is too coarse).
- DD-5.4 [PENDING] Role granularity — keep 6-tier wellness scheme vs collapse to 2-tier (Owner-plus/Cashier). Rec: keep 6-tier (avoid drift).
- DD-5.5 [PENDING] Offline mode scope — queue-and-sync / read-only / no-offline. Rec: no-offline Phase 1 with banner; queue-and-sync separate Phase 2 PRD.

### PRD_WELLNESS_RBAC.md (6 pending)
- DD-5.1 [RESOLVED 2026-05-24: Extend `wellnessRole` enum with `'cashier'` — minimises schema surface; DD-5.6 phiReadGate interaction tracked at code level.] Cashier role — extend `wellnessRole` enum with `'cashier'` vs separate `salesRole` column. Rec: extend wellnessRole v1.
- DD-5.2 [PENDING] Owner singleton vs plural — keep `Tenant.ownerId` conceptually singular vs allow multi-owner for clinic chains. Rec: keep singular v1.
- DD-5.3 [PENDING] Per-tenant role customization (admin defines custom labels + permission bitmaps) — Phase 2 only, explicitly out-of-scope here (FR-3.1.d).
- DD-5.4 [PENDING] Unauthorized-navigation handling — dedicated `/403?role=...` page vs redirect-to-role-landing vs `<RoleAccessDenied>` inline component. Rec: inline component.
- DD-5.5 [PENDING] Data scoping enforcement layer — middleware-only vs middleware+frontend-render-time guard. Rec: middleware-only v1.
- DD-5.6 [PENDING] USER-role × wellnessRole interaction — verify `phiReadGate` correctly omits `'cashier'` (cashier is sales role, not clinical) when DD-5.1 extends wellnessRole.

### PRD_ZYLU_GAP_CONSOLIDATED.md (8 pending)
- DD-5.1 [PENDING] POS Invoice polymorphism — schema fork vs sourceType enum + shared child tables (InvoiceLineItem + InvoicePayment). Rec: sourceType enum.
- DD-5.2 [PENDING] CSV column-mapping UI — drag-drop with fuzzy-match auto-suggest vs fixed columns. Rec: drag-drop + save mapping per tenant.
- DD-5.3 [PENDING] Memberships — per-tenant SKUs vs central catalog. Rec: per-tenant (each clinic prices differently).
- DD-5.4 [PENDING] Wallet bonus rules — admin UI vs hard-coded. Rec: admin UI (rules change quarterly).
- DD-5.5 [PENDING] Wallet expiry — per-entry vs per-balance (FIFO). Rec: per-entry (friendlier audit trail).
- DD-5.6 [PENDING] Biometric device vendor — Mantra / Realtime / eSSL. Open. Drives webhook contract + device-pairing UI.
- DD-5.7 [PENDING] Mini-site editor — in-app block builder vs templates. Rec: block builder (4-5 blocks: logo/hero/services/contact/cta).
- DD-5.8 [PENDING] Per-clinic-location mini-site vs per-tenant. Open. If chain (e.g. 3 clinics), each location may want own page vs umbrella.

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
