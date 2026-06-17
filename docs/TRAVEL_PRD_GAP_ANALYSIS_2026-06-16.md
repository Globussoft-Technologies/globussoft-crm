# Travel CRM — Consolidated PRD ↔ Codebase Gap Analysis — 2026-06-16

> **Supersedes** [TRAVEL_PRD_GAP_ANALYSIS_2026-06-15.md](TRAVEL_PRD_GAP_ANALYSIS_2026-06-15.md).
> **Scope:** the **entire travel vertical** — all 4 sub-brands (TMC · RFU · Travel
> Stall · Visa Sure) + shared infra (sales/itinerary/quote, finance/supplier/GST,
> integrations, branding, security). Visa Sure has a companion deep-dive:
> [VISA_SURE_PHASE_3_GAP_ANALYSIS_2026-06-16.md](VISA_SURE_PHASE_3_GAP_ANALYSIS_2026-06-16.md).
>
> **Method:** fresh code-verification sweep against the current working tree
> (≈HEAD `043b9ab3`) across 6 areas (TMC, RFU+Travel Stall, sales/itinerary/quote,
> finance/supplier/GST, integrations/cross-cutting, Visa Sure) + first-hand audit
> of this cycle's customer-portal/auth work. Cross-checked vs
> [CREDS_TRACKER.md](CREDS_TRACKER.md), [DECISIONS_TRACKER.md](DECISIONS_TRACKER.md),
> [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md).
>
> **Legend:** ✅ SHIPPED · 🟡 PARTIAL (core shipped, pieces missing) · 🔌 STUB
> (code complete, blocked on external cred/decision) · ❌ MISSING (no code) ·
> ⏭️ DEFERRED (out of Phase 1 per contract)

---

## 1. Executive summary

The travel vertical is **broadly built**: TMC, the shared sales/itinerary/quote
stack, finance/supplier core, and Visa Sure are largely shipped; RFU core
(profiles, packets, hotel-prefs) is done with ground-services in stub/missing;
Travel Stall is an intentional Phase-2 shell; integrations are mostly
stub-or-decision-gated; and a few cross-cutting builds (B2B portal, security
hardening) are early.

**Delta since 2026-06-15** (this cycle's work): Visa Sure FR-5/FR-6 lifecycle
(checklist seed→verify→auto-advance, quotation-template admin), customer
self-serve portal ("My Visa": start/upload/cancel/multiple apps), unified login
(portal fallback), and email-OTP registration all landed.

**The gaps that matter most (engineering-actionable, no external blocker):**

| | Gap | Where | Why it matters |
|---|---|---|---|
| 🔴 1 | **Visa documents stored UNENCRYPTED** | `lib/visaDocStore.js:33-43` | Passport/bank scans in plaintext; PRD NFR requires AES-256-GCM. Security. |
| 🔴 2 | **GST rates hardcoded (no `TaxRateMaster`)** | `lib/gstCalculation.js:57-66` | Rate change needs a redeploy; no operator CRUD. (Also DD-5.2.) |
| 🔴 3 | **TCS Form 27EQ export missing** | billing FR-3.4.d / AC-6.12 | TCS is computed but there's no govt-spec filing report. |
| 🔴 4 | **Auto-PO on quote→booking missing** | supplier FR-3.2.a | POs are manual; supplier-ledger integrity gap. |
| 🟠 5 | Visa FR-5.2 **quote-template consumer** + FR-3.2 rejection-history not populated + FR-3.1(c) `familySize` not consumed | see §2 Visa Sure | Risk engine + quotation are admin-only/partial. |

**Highest-fan-out external blocker:** **Q22 (Yasin brand pack)** — one cred
unblocks 4 PRDs (per-sub-brand branding, theme, billing PDF, marketing flyer).
**Q9 (Wati WhatsApp)** and **Q11 (LLM keys)** are the next two highest-fanout.

**Entirely-unbuilt big rocks (decision/cred-gated):** B2B agent portal (0%),
Flight-plugin Chrome extension (backend shipped, extension repo not created),
RFU 5-portal Saudi hotel scraper, Booking/Expedia cancellation-normalizer +
inventory-sync.

---

## 2. Status by area

### 2.1 TMC (school trips) — ✅ largely shipped
| Feature | Status | Evidence / gap |
|---|---|---|
| 12-Q public readiness diagnostic → engine + lead-quality + LLM A/B + guardrail + report + PDF | ✅ | `lib/tmcDiagnosticEngine.js`, `lib/tmcLeadQuality.js`, `services/tmcDiagnosticPrompts.js`, `lib/tmcReportGuard.js`; `travel_diagnostics.js:2188/2430/2608`; `TmcReadiness.jsx`/`TmcReadinessReport.jsx` |
| Curriculum mapping + FR-5 diagnostic recommendations | ✅ (data pending) | `TravelCurriculumMapping` `schema:7317`; `travel_curriculum.js`; engine integration `travel_diagnostics.js:2268-2282`; **V1 rows authored by Yasin's academic team (PC-1)** |
| TMC trip catalogue + human-verify gate | ✅ | `TmcTripCatalogue` `schema:7496`; `travel_tmc_catalogue.js`; 5 seed trips w/ **placeholder curriculum-hook copy** |
| TMC microsites + OTP | ✅ (SMS cred pending) | `travel_microsites.js`; `PublicTripMicrosite.jsx`/`TmcMicrositePreview.jsx` |
| School term calendar | 🟡 | model + `travel_school_terms.js` shipped; **`SchoolTermCalendar.jsx` frontend NOT FOUND** |
| **Open:** SchoolTermCalendar UI (eng, ~½d); curriculum rows + hook copy + Google-Meet creds + 6 OQ / 3 DD (Yasin) | | |

### 2.2 RFU (Umrah) — ✅ core; 🔌/❌ ground services
| Feature | Status | Evidence / gap |
|---|---|---|
| Pilgrim/lead profiles | ✅ | `RfuLeadProfile` `schema:6297`; `travel_rfu_profiles.js` (+stats/by-month/quarter/year, dup-passport 409); `RfuCustomerProfile.jsx` |
| Religious guidance packets | ✅ | `ReligiousGuidancePacket` `schema:6355`; `travel_religious_packets.js`; `ReligiousPackets.jsx`; `cron/religiousGuidanceEngine.js` |
| Hotel-preference attrs (haram/kaaba facing, floor, room) | ✅ | `travel_cost_master.js:33-156` |
| Zikr Cabs ground transfer (FR-3.1) | 🔌 STUB | `services/zikrCabsClient.js` (quote stub); **booking/cancel/track/webhook/markup/audit MISSING**; `TravelGroundTransfer` model MISSING — Q-RFU-1 |
| 5-portal Saudi hotel scraper (FR-3.2) | ❌ MISSING | no orchestrator/adapters/cache cron; `SaudiHotelRateCache`/`TravelContractedRate` MISSING — Q-RFUG-1 decision + 5 vendor creds; ~8-10d build |
| Haramain HSR pricing (FR-3.3) | 🔌 STUB | `services/haramainRailClient.js` (quote stub); booking/cancel/ticket MISSING — Q-RFU-7/Q-RFUG-8 |

### 2.3 Travel Stall (family holidays) — ⏭️ Phase-2 shell
| Feature | Status | Evidence / gap |
|---|---|---|
| Dashboard | 🔌 shell | `TravelStallDashboard.jsx` (4 quick-action cards → existing surfaces with `?subBrand=travelstall`) |
| Personalised-destination PDF | 🔌 STUB | `travel_travelstall.js` (LLM prose via llmRouter; placeholder branding) — Q11 + Q22 |
| Family travel quiz + quiz-to-lead + booking surface | ❌ MISSING | not built — **DEFERRED to Phase 2 per contract** (Phase 1 = TMC + RFU) |

### 2.4 Visa Sure — ✅ largely shipped (see companion doc)
Highlights: advisor list/detail/checklist-admin/quotation-template-admin, document
checklist lifecycle (seed→verify→auto-advance), recovery program, analytics (3+bonus),
customer self-serve portal, email-OTP all SHIPPED. **Gaps:** FR-6.4 encryption
(❌ plaintext), FR-5.2 consumer (❌), `visa-summary` LLM (❌, Q11), rejection-history
population (🟡), `familySize` consumption (🟡), high-rejection-rate destination (🟡,
PC-3), embassy-rule consumption breadth (🟡, PC-1..5), retention rows (❌),
Reports sidebar link (🟡), PDF/theme branding (🟡, Q22). Full detail in
[VISA_SURE_PHASE_3_GAP_ANALYSIS_2026-06-16.md](VISA_SURE_PHASE_3_GAP_ANALYSIS_2026-06-16.md).

### 2.5 Shared — sales / itinerary / quote — ✅ shipped
| Feature | Status | Evidence / gap |
|---|---|---|
| Pipeline kanban + travel sub-brand filter (+touch/keyboard/virtualization) | ✅ | `Pipeline.jsx` (TRAVEL_SUB_BRANDS, URL-persisted filter) |
| Itinerary builder + templates + day-editor + Leaflet map + suggest + versioning + sightseeing master + POI dedup | ✅ | `travel_itineraries.js`, `travel_itinerary_templates.js`, `travel_sightseeing.js`, `lib/poiDedup.js`; `ItineraryEditor.jsx`/`ItineraryTemplates.jsx`/`SightseeingMaster.jsx` |
| Quote builder (3-pane, line dims, pricing-preview/markup, accept/reject/counter, snapshots, convert-to-invoice) | ✅ | `travel_quotes.js`/`travel_quotes_public.js`; `QuoteBuilder.jsx`/`QuoteCounterReview.jsx` |
| Flight quote plugin endpoint + agent fallback | ✅ | `travel_flight_quotes.js`; `FlightQuoteAgent.jsx` |
| **Open:** quote **send via WhatsApp** (🔌 Q9); itinerary **suggest LLM** (🔌 Q11, deterministic stub today); OpenTripMap POI seed (licensing review ~1h) | | |

### 2.6 Shared — finance / supplier / GST — ✅ core; key gaps
| Feature | Status | Evidence / gap |
|---|---|---|
| Invoice + line model, GST split (CGST/SGST/IGST), place-of-supply | ✅ | `TravelInvoice`/`TravelInvoiceLine`; `lib/gstCalculation.js`; `travel_invoices.js` tax-persist |
| GSTR-1 / GSTR-3B / HSN-summary exports | ✅ | `travel_invoices.js:597/3309/3002` |
| Customer-ledger / TDS-register / commission-ledger | ✅ | `travel_invoice_ledgers.js:74/260/329` |
| Tally-XML + CA-CSV + Excel invoice export | ✅ | `lib/travelAccountingExport.js` |
| Payment schedule + milestone reminders + anchor dates + settlement Gantt | ✅ | `TravelPaymentSchedule`; `cron/travelMilestoneRemindersEngine.js`; `travel_settlement_timeline.js` |
| Supplier master + credential vault + KYC + disputes + commissions + reconciliation + payable batches + POs | ✅ | `travel_suppliers.js`, `travel_supplier_commissions.js`, `travel_supplier_reconciliation.js`, `travel_payable_batches.js`, `travel_purchase_orders.js` |
| TCS auto-detect + apply | ✅ | `lib/tcsCalculation.js`; `travel_invoices.js:/apply-tcs` |
| **`TaxRateMaster` model + admin CRUD** | ❌ MISSING | rates hardcoded `gstCalculation.js:57-66` — **DD-5.2** |
| **TCS Form 27EQ export** | ❌ MISSING | AC-6.12 — TCS computed, no filing report |
| **Auto-PO on quote→booking** | ❌ MISSING | supplier FR-3.2.a — POs manual |
| GSTIN validator gated on write | 🟡 | `lib/gstinValidator.js` exists but not enforced at route layer |
| Payment-schedule **templates** library, **receipt PDF numbering**, overdue escalation, per-brand invoice PDF | 🟡 | partial; per-brand PDF blocked on Q22 |

### 2.7 Integrations + cross-cutting
| PRD | Status | Evidence / gap |
|---|---|---|
| RateHawk | 🔌 STUB | `services/ratehawkClient.js` + `routes/ratehawk.js` + `lib/quoteRanker.js` shipped; `/quote/unified-search` real-mode blocked on **Q19** |
| Booking.com / Expedia direct | 🔌 STUB | `bookingExpediaClient.js` + routes shipped; Booking=Phase 1.5, Expedia=Phase 2 (503 gated); cancellation-normalizer + inventory-sync cron ❌ |
| Flight-plugin Chrome extension | 🟡 | **backend `/api/v1/flight-plugin/*` SHIPPED**; **extension repo NOT created** (DC-1/DC-2 pending) |
| Multichannel lead capture | 🟡 (~25%) | `travel_inbound_leads.js` intake + Touchpoint + phone-dedup + cooldowns SHIPPED; routing rules 🔌 stub; `/settings/lead-capture` UI ❌; path-mismatch vs spec (G015 alias) |
| Per-sub-brand branding | 🟡 | `BrandKit` model + `/api/brand-kits` CRUD SHIPPED; **consumer wiring (PDF/email/portal/microsite/sidebar) mostly ❌** — Q22 |
| B2B / corporate agent portal | ❌ MISSING | **entire PRD 0%** — 7 design calls (DD-5.1..5.7) unresolved |
| Security architecture | 🟡 (~32%) | httpOnly-cookie groundwork + cross-tenant interceptor + ESLint guard SHIPPED; opaque `publicId` IDs ❌, list-PII reduction ❌, CSP `unsafe-inline` removal 🔌, full cookie-only auth 🟡 — DD-5.1/5.2/5.5 |

### 2.8 This-cycle customer-portal / auth (verified first-hand)
| Feature | Status | Evidence |
|---|---|---|
| Customer self-serve "My Visa" (preview, start, upload, cancel, **multiple** apps) | ✅ | `TravelCustomerPortal.jsx` `VisaApplicationCard`; `portal.js` GET/POST/DELETE `/travel/visa/applications` + `/checklist-preview` + `/documents/:itemId/upload` |
| Unified login (staff `/login` → portal fallback) + standalone portal login retired | ✅ | `Login.jsx` `performLogin`→`tryPortalLogin`; `TravelCustomerPortal.jsx` unauth→`/login` |
| Email-OTP registration (org signup + customer) | ✅ | `lib/emailOtp.js`; `auth.js /email-otp/{request,verify}`; `EmailOtpField.jsx`; `emailVerifiedAt` on Tenant/User/Contact |
| **Open:** OTP is UI-hard-gated + records + rejects tampered tokens, but an absent-token raw-API register still succeeds (back-compat) — close with strict enforcement (~1h + ~5 test files) | | |

---

## 3. Consolidated PENDING — by blocker

### A. Engineering-actionable now (no external dependency)
| # | Item | Effort |
|---|---|---|
| A1 | **Encrypt visa documents at rest** (AES-256-GCM in `visaDocStore.js`) | ½d · **do first** |
| A2 | Visa **FR-5.2 quote-template consumer** (template → quote → Itinerary) | 1d |
| A3 | Visa **rejection-history population** at diagnostic submit + **`familySize`** rule in risk engine | 1d |
| A4 | **TCS Form 27EQ** export endpoint | 1d |
| A5 | **Auto-PO** hook on quote→booking confirm | ½d |
| A6 | **GSTIN validation** gated on Contact/Tenant write | ½h |
| A7 | Visa + finance **retention rows** (`VisaApplication`/`VisaDocumentChecklistItem` → retentionEngine ENTITY_MAP) | ½d |
| A8 | Diagnostic-report **email delivery** (SendGrid configured; WA stays Q9) | ½d |
| A9 | Visa **Reports sidebar link** + `SchoolTermCalendar.jsx` frontend | ½d |
| A10 | **Email-OTP strict server enforcement** (close raw-API bypass) | 1h + tests |
| A11 | Per-sub-brand **branding consumer wiring** (PDF/email/portal/microsite read BrandKit) | 2-3d |
| A12 | Multichannel **`/settings/lead-capture` UI** + finish routing-rule resolver | 1-2d |
| A13 | Security: **list-PII reduction** + **CSP `unsafe-inline` removal** | 1-2d |

### B. Decision-blocked (product call needed first)
- **Visa Sure PC-1..PC-8** — complex-case def, embassy-rule catalogue + maintainer, recovery-diagnostic reuse, cool-down gate, categories, region.
- **GST DD-5.2** — tax-rate source (operator CRUD vs hardcoded vs SaaS).
- **Billing DD-5.5 / DD-5.7** — TDS ownership boundary, brand handover; schedule-template policy.
- **Flight plugin DC-1/DC-2/DC-3** — repo topology, Chrome-store publisher.
- **B2B portal DD-5.1..DD-5.7** — entire PRD gated on 7 decisions.
- **Security DD-5.1/5.2/5.5** — cookie shape, opaque-ID migration, rollout cadence.
- **Itinerary OQ-9.x** — suggest-billing, cross-sub-brand POI sharing, prompt hygiene.
- **RFU ground services Q-RFUG-1..5/8** — scrape-vs-partner per portal, PNR model, cancellation cascade, HHR partner-program existence.

### C. Cred-blocked (code shipped in stub; flips on cred drop)
| Cred | Unblocks |
|---|---|
| **Q9 — Wati WhatsApp** | quote send, visa advisor alerts, diagnostic WA delivery, microsite OTP SMS |
| **Q11 — LLM keys** | `visa-summary`, itinerary-suggest, Travel Stall PDF prose, TMC LLM jobs |
| **Q19 — RateHawk API** | `/quote/unified-search` live mode |
| **Booking Partner Centre / Expedia EAN** | Booking (1.5) + Expedia (2) live |
| **Q-RFU-1..8** | Zikr Cabs, 5 Saudi hotel portals, Haramain HSR |
| **Q-GST-2 / Q-BILL-1** | GSTIN reverse-check, TCS filer verification |
| Passport OCR vendor | optional (on-box `tesseract.js` + MRZ shipped as interim) |

### D. Brand-asset-blocked (Yasin **Q22** — highest fan-out)
Per-sub-brand branding · theme palettes · billing PDF cover · Travel Stall PDF ·
marketing-flyer content · Visa Sure PDF/theme. **One drop unblocks all of these.**

---

## 4. Top blockers by blast radius (action list)

1. **Ship A1 (document encryption)** — only true security gap; no blocker. ½d.
2. **Q22 brand pack** (Yasin) — unblocks ~5 branding/PDF surfaces across sub-brands.
3. **Q9 WhatsApp + Q11 LLM** (creds) — flip ~6 stubbed flows to live across all sub-brands.
4. **GST: build `TaxRateMaster` + 27EQ + auto-PO** (after DD-5.2) — closes the finance compliance gaps.
5. **Decide the big-rock PRDs** (B2B portal, Flight-plugin repo, RFU hotel-scraper) — each is a multi-day build gated on a product/cred decision, not on engineering availability.

---

## 5. Notes
- Line numbers reflect the current working tree (~HEAD `043b9ab3`) on 2026-06-16.
- Phase scoping per contract: **Phase 1 = TMC + RFU**; Travel Stall + Visa Sure
  were Phase 2 — Visa Sure has since been largely built ahead of schedule.
- A handful of "shipped" claims in the sales/itinerary/quote sweep are inferred
  from route+schema presence; the **gaps** above are the high-confidence,
  actionable set. The finance/supplier/GST + integrations findings carry the
  strongest evidence.
- This supersedes 2026-06-15; the §A/B/C/D structure + per-PRD trackers
  (CREDS/DECISIONS/MANUAL_CODING) remain the operational source of truth.

*Generated 2026-06-16 from a 6-cluster parallel code-verification sweep + first-hand audit of this cycle's portal/auth work.*
