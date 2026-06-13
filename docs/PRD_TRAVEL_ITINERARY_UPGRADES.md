# PRD — Travel Itinerary Tooling Upgrades

**Status:** DRAFT • **Owner:** Travel vertical squad • **Filed:** 2026-05-23 (tick #25)
**Refs:** GH #907 (P2 Travel Gap — Itinerary upgrades) • Travel Stall CRM Roadmap Tier P2 item 12
**Siblings:** [PRD_AI_SURFACES.md](PRD_AI_SURFACES.md) (LLM task-class infra, AI Re-score precedent), [PRD_TRAVEL_QUOTE_BUILDER.md](PRD_TRAVEL_QUOTE_BUILDER.md) (cost-master + pricing engine), [PRD_TRAVEL_SUPPLIER_MASTER.md](PRD_TRAVEL_SUPPLIER_MASTER.md) (POI suppliers / activity vendors), [PRD_TRAVEL_BILLING.md](PRD_TRAVEL_BILLING.md) (itinerary-to-invoice handoff), [PRD_TRAVEL_MARKETING_FLYER.md](PRD_TRAVEL_MARKETING_FLYER.md) (shared visual-builder substrate)

---


## Implementation Status (audited 2026-06-13 against HEAD `043b9ab3`)

| Metric | Value |
|---|---|
| Total FRs | 39 |
| ✅ Shipped | 19 (49%) |
| 🟡 Partial | 9 |
| ❌ Missing | 11 |
| **Net gap** | **20 items** (~14 eng-days) |
| Primary blocker | `clonedFromTemplateId` lineage; `draftedByAi` provenance; template versioning + analytics metrics; conflict warnings; bulk-day-add; live re-pricing integration verify |

Shipped: 3-pane editor + Leaflet map preview + drag-drop across days + suggest endpoint with stub-fallback + POI catalogue + pending-approval queue.

**Single source of truth for all gap items + Wave 3 execution plan:** [TRAVEL_GAP_CLOSURE_TRACKER.md §3.7 + §7 Wave 3](TRAVEL_GAP_CLOSURE_TRACKER.md).

---

## §1 Background + source attribution

### Current state (itinerary builder is text-list + draftSummary regen)

`backend/routes/travel_itineraries.js` ships a working CRUD surface over `Itinerary` + `ItineraryItem` Prisma models with item polymorphism across `flight | hotel | transfer | activity | visa | insurance`. `frontend/src/pages/travel/ItineraryDetail.jsx` renders the items as a typed list. The operator's authoring loop today is: (a) create a blank itinerary against a diagnostic, (b) hand-type each item one row at a time, (c) hit `POST /draft/regen` to get an LLM-drafted prose summary persisted to `Itinerary.draftSummary`. This works — but it's a *blank-page* loop. There is no template library; there is no destination/sightseeing master; there is no day-by-day visual editor; there is no AI-generated *draft itinerary* (only an AI-generated *summary* of an operator-built itinerary).

The roadmap (Tier P2 item 12) prescribes a four-bullet uplift: (1) pre-loaded template library (~50, expand over time), (2) sightseeing master (destination → POIs as a 6th Cost Master category), (3) day-by-day visual editor with map preview, (4) LLM "Suggest itinerary" button consuming destination + days + budget + traveller profile. Each bullet maps to a discrete sub-surface; this PRD pins the shape of all four so they ship in lockstep rather than four mismatched mini-features.

### Why a PRD for what looks like "another visual builder"

GH #907's four ACs read like a routine library + editor + AI button. Underneath are **5 load-bearing design calls** (DD-5.1 template-library content sourcing model, DD-5.2 POI-master ownership — Cost Master vs separate model, DD-5.3 map-tile provider choice, DD-5.4 LLM-suggested-itinerary acceptance flow, DD-5.5 template marketplace governance) and **3 cred / data dependencies** (Q-IT-1 map tile provider key, Q-IT-2 LLM provider creds — overlaps Q11, Q-IT-3 POI seed-data licensing). Picking the POI master wrong (e.g. modeling it as a 6th `TravelCostMaster.category` when it actually has different attributes — image URL, lat/lng, duration, suitability) creates a 3-4 week refactor downstream. Pinning these in §5 makes the impl team's first sprint a decision-execution sprint.

### Source attribution
- GH #907 issue body (verbatim ACs in §6 below).
- Travel Stall CRM — Implementation & Modification Roadmap (Google Doc) — Tier P2, item 12.
- `backend/routes/travel_itineraries.js` lines 632-727 — existing `/draft/regen` LLM consumer pattern; `lib/llmRouter.js` precedent.
- `backend/routes/travel_cost_master.js` line 28 — current 5-category enum (`hotel | flight | transport | visa | insurance`); the 6th category lives here.
- `frontend/src/pages/travel/ItineraryDetail.jsx` — current text-list editor; visual upgrade target.
- `frontend/src/pages/LandingPageBuilder.jsx` — block-builder pattern shared with sibling `PRD_TRAVEL_MARKETING_FLYER.md`.
- Tick #20 commit `621aab7` — `Tenant.subBrandConfigJson` per-sub-brand brand kit (controls template visual defaults).

### §1.2 Existing infrastructure (do NOT rebuild)

| Surface | Path | What it provides | How Itinerary Upgrades consumes |
|---|---|---|---|
| Itinerary CRUD | `backend/routes/travel_itineraries.js` | List / create / patch itinerary + per-item polymorphic CRUD | EXTEND — add `/templates`, `/sightseeing`, `/suggest` sub-routes; preserve existing item shape |
| Prisma `Itinerary` + `ItineraryItem` | `prisma/schema.prisma:4170-4242` | Per-tenant per-sub-brand itinerary header + ordered polymorphic items with `detailsJson` | EXTEND — add `dayNumber`, `latitude`, `longitude` to `ItineraryItem`; add `clonedFromTemplateId` to `Itinerary`; new `ItineraryTemplate` model mirrors `Itinerary` shape with `usageCount`, `category`, `previewImageUrl` |
| Cost Master | `backend/routes/travel_cost_master.js` (5 categories) | Per-supplier rate sheet keyed by `routeOrSku` + `attributesJson` | EXTEND — add `sightseeing` as the 6th category; POI-specific attributes (image URL, lat/lng, duration, family-friendly flag) land in `attributesJson` — no new model. DD-5.2 confirms this path. |
| LLM router | `backend/lib/llmRouter.js` | Task-classed LLM dispatcher (existing classes: `lead-junk-classify`, `deal-insight`, `itinerary-draft-summary`, etc.) | EXTEND — add `itinerary-suggest` task class (Gemini 2.5 Flash; 2K in / 4K out — bigger out budget than `upsell-suggest` because full itinerary returned) |
| AI Re-score precedent | `backend/routes/ai.js` + `lib/leadScoring.js` | Existing "AI Re-score" button on Contacts page — operator-triggered LLM call that returns a structured suggestion the operator can accept / edit / discard | MIRROR — `Suggest itinerary` button on `Itineraries.jsx` follows the same accept-edit-discard UX |
| Per-sub-brand branding | `Tenant.subBrandConfigJson` (621aab7) | Per-sub-brand logo, primary/secondary colors, font stack | CONSUME — template library filters per sub-brand; visual editor respects brand colors |
| Pricing engine | `backend/lib/travelPricing.js` + season calendar + markup rules | Re-prices an item set against season + markup config | CONSUME — when items are added/removed in the visual editor, live-reprice the total |
| `draftSummary` regen | `routes/travel_itineraries.js` POST `/draft/regen` | LLM-summarizes the existing item list to prose | UNCHANGED — runs on the *output* of the new editor; the suggest-itinerary flow is upstream of it |
| Cost Master CSV importer | `routes/travel_csv_io.js` | Bulk CSV upload for `TravelCostMaster` rows | EXTEND — sightseeing CSV import path; ~50 seed templates land via CSV too |
| Sub-brand RBAC | `subBrandAccess[]` on `User` | Per-operator sub-brand scoping | CONSUME — template library filtered to operator's accessible sub-brands |
| PDF render | `backend/services/pdfRenderer.js` `renderTravelItineraryPdf` | Itinerary-to-PDF | UNCHANGED — consumes upgraded item list as-is |

---

## §2 Use cases

### 2.1 TMC operator builds Europe school-trip from template
Asha (TMC operator) opens the new Itinerary Templates library, filters to `TMC / Europe / 10-14 days`, picks the "Paris + Rome + Barcelona — 12N" template (used 47 times, ★4.6). Clicking "Use template" creates a new itinerary pre-populated with 12 day-rows: each day has the hotel item, the flight/transfer items, and 2-3 sightseeing items pulled from the sightseeing master (Eiffel Tower, Louvre, Trevi Fountain, etc.). Asha tweaks: swaps Day 5's Trevi for a Vatican-museums excursion, adjusts Day 7's hotel from Hilton to Marriott. Map preview redraws to reflect the changes. Total trip price live-updates from `lib/travelPricing.js`. End-to-end 14 minutes vs the old 90-minute hand-build.

### 2.2 RFU operator builds Umrah package from LLM suggest
Hassan (RFU operator) opens a blank itinerary, hits "Suggest itinerary", fills the prompt form: destination `Makkah + Madinah`, days `10`, budget `₹85k/pax`, traveller profile `Indian family, 4 pax, dietary halal-strict, mobility moderate`. LLM returns a draft 10-day itinerary: 4 nights Makkah Hilton (Haram-facing), 4 nights Madinah Anwar Al Madinah (Masjid Nabawi 3-min walk), Day 1 arrival via MAA-JED, Day 10 departure via JED-MAA, Ziyarat sightseeing items for Days 4-6 (Jabal Al-Noor, Quba Mosque, Uhud — all sourced from sightseeing master), day-by-day breakfast/transfer notes. Hassan accepts with two tweaks (swaps Day 3's restaurant to a Hyderabadi place, removes Quba on Day 5 since the family wants a rest day). One-shot full-package authoring in 7 minutes.

### 2.3 Travel Stall operator authors weekend-getaway from template
Priya (Travel Stall operator) gets a lead from a Goa weekend inquiry. Opens templates, filters `Travel Stall / Goa / 2-3 days / family`, picks "Goa Family Weekend ₹14,999" template (used 312 times, the highest-converting template in the library). Two-click clone, lead-context-fills the pax count (4) and dates (next Sat-Sun). Map preview shows the day-1 beach activities (Baga / Anjuna) vs day-2 cultural (Old Goa basilicas / Fort Aguada). Two minutes to a ready-to-send itinerary.

### 2.4 Operator builds custom itinerary day-by-day in visual editor
Anjali (Travel Stall operator) has a customer wanting a fully-custom 8-day Kerala trip. No template fits. She opens the day-by-day editor blank, drags 8 day-card containers, drags POIs from the sightseeing master sidebar onto each day (Munnar tea estates Day 2, Periyar wildlife sanctuary Day 4, Alleppey houseboat Day 6), drags hotel items in (filtered by Cost Master), drags transfer items in. The map preview shows the route in sequence (Cochin → Munnar → Thekkady → Alleppey → Kovalam → Trivandrum) with per-day pins. Live total updates with every drag. End-to-end 28 minutes for a one-off custom itinerary that used to take 2+ hours.

### 2.5 Operator publishes a frequently-built itinerary as a template
Hassan has built the same Umrah 14-night package 11 times this quarter, each time slightly different. He picks the most-converted version, clicks "Save as template", names it "RFU Umrah Premium 14N (peak)", selects category `RFU / Premium`, uploads a hero image. The new template appears in the library for himself + all RFU operators (subject to sub-brand RBAC). Usage count starts at 0; the template tracks usage / conversion-rate / avg-revised-price over time so the library auto-surfaces the best-performing templates.

### 2.6 LLM suggest with iterative refinement
Sales rep gets a high-touch lead: "₹2L budget, 5 days, foodie-focused, ideally somewhere with great street food". Hits Suggest itinerary, gets Thailand (Bangkok + Chiang Mai). Customer pushes back ("we've been to Thailand twice"). Operator hits "Suggest different destination, same profile", LLM returns Vietnam (Hanoi + Hoi An). Customer accepts. Re-prompting the LLM through the same panel without rebuilding everything from scratch is the load-bearing UX call.

### 2.7 Sightseeing master grows from operator usage
Sajid (RFU operator) is building an itinerary and types "Jeddah Corniche" in the activity search — no match. He hits "Add new POI", fills the form (Jeddah Corniche, lat/lng, 2-hour duration, ₹0 entry fee, image URL, description), and submits as a Cost Master row with `category: sightseeing`. Future operators searching "Jeddah" or "corniche" find it. This is the master-data-grows-from-usage loop that prevents a stale 50-POI seed from being the ceiling.

---

## §3 Functional requirements (grouped)

### FR-3.1 Pre-loaded itinerary template library

- (a) **Library surface** at `/travel/itinerary-templates` (new page). Grid of template cards with hero image, name, sub-brand chip, day count, base price, usage count, ★ rating.
- (b) **Per-sub-brand scoping.** Templates respect `subBrandAccess[]`; ADMIN can mark a template as `shared: true` to make it cross-sub-brand visible.
- (c) **Filter facets:** sub-brand, destination, day-range, budget-tier (under ₹50k / ₹50k-1L / ₹1L-2L / ₹2L+), category (family / honeymoon / adventure / religious / school-group / business).
- (d) **Template detail page** showing all day-by-day items + map preview before clone.
- (e) **One-click clone.** Creates a new `Itinerary` with `clonedFromTemplateId` pointer; bumps `ItineraryTemplate.usageCount`.
- (f) **Save-as-template** action on any operator-built itinerary (FR-3.1g triggers from the visual editor). Captures the full item list + day-by-day map data.
- (g) **Initial seed:** ~50 templates spanning all 4 sub-brands (12 TMC / 14 RFU / 18 Travel Stall / 6 Visa Sure). CSV-import path supports the seed + ongoing additions.
- (h) **Library metrics:** per-template `usageCount`, `acceptedCount` (clones that became `status: accepted`), `avgFinalPrice`, `lastUsedAt` — surfaced on cards for operator ranking.

### FR-3.2 Sightseeing master (6th Cost Master category)

- (a) **Cost Master enum extended.** `VALID_CATEGORIES` in `travel_cost_master.js` adds `"sightseeing"` as the 6th value. DD-5.2 confirmed — no new Prisma model.
- (b) **POI-specific attributes** live in `TravelCostMaster.attributesJson` per existing pattern: `imageUrl`, `latitude`, `longitude`, `durationMinutes`, `category` (cultural / nature / adventure / religious / shopping / food / family), `entryFee`, `bestSeason`, `description`, `accessibility` (mobility-friendly flag), `kidsAppropriate`.
- (c) **POI search** API: `GET /api/travel/sightseeing?destination=Paris&category=cultural` — substring + category filter, returns top-50 by usage count.
- (d) **POI seed data.** Sourced from a curated free-license POI dataset (DD-5.3 picks WikiVoyage CSV export vs OpenTripMap free tier — both viable, both Q-IT-3-blocked on licensing review). Initial seed ~500 POIs across top-20 destinations.
- (e) **Add-POI operator path** (FR-3.7 below). Master data grows from usage.
- (f) **POI deduplication.** New POIs check for ±50m lat/lng + same destination + 70% name-similarity; flag as potential duplicate for ADMIN approval.

### FR-3.3 Day-by-day visual editor with map preview

- (a) **Editor surface** at `/travel/itineraries/:id/edit` (new — current `/travel/itineraries/:id` stays as the read view).
- (b) **Layout:** left sidebar (POI / hotel / flight / transfer search-and-filter) | center canvas (day-by-day vertical timeline with drag-drop) | right pane (map preview + price summary).
- (c) **Day cards.** Each day card has a date, a "Day N" label, drop targets for items. Drag-reorder days (swaps `dayNumber` on contained items).
- (d) **Drag-drop within and across days.** ItineraryItem gets a new `dayNumber` field; items can be dragged across day-boundaries with auto-renumber.
- (e) **Map preview** renders all items with lat/lng (hotels + POIs primarily) with day-numbered pins + route polyline between consecutive days. Map provider behind a thin adapter (DD-5.4 — Mapbox vs Leaflet/OSM; Q-IT-1 cred-blocked on Mapbox if chosen).
- (f) **Live re-pricing.** Every drag-drop fires `lib/travelPricing.js` re-compute; price summary in right pane updates within 500ms.
- (g) **Bulk-day-add.** "Extend by N days" inserts blank day cards at a chosen position.
- (h) **Conflict warnings.** Same item appearing on two days, items with `bestSeason` outside trip dates, hotels with check-in/out date mismatches all surface inline.

### FR-3.4 LLM "Suggest itinerary" button

- (a) **Trigger:** "Suggest itinerary" button on `Itineraries.jsx` (list page) and on the blank-itinerary state in the visual editor.
- (b) **Prompt form:** destination(s) (free text + autocomplete from Cost Master destinations), days (number), budget (per-pax INR), traveller profile (free text — e.g. "family of 4, dietary halal, mobility moderate, prefers cultural over adventure"), sub-brand context (auto-from operator's active sub-brand).
- (c) **LLM call** via `lib/llmRouter.js` new task class `itinerary-suggest`. Model: `gemini-2.5-flash` (per AI_SURFACES §3 table). Budget: 2K in / 4K out (larger out than `upsell-suggest` to fit full itinerary JSON).
- (d) **Returned shape:** structured JSON `{ summary, days: [{ dayNumber, items: [{ itemType, description, suggestedSupplierName, estimatedCost, latitude?, longitude? }] }] }`. Items materialise into `ItineraryItem` rows on accept.
- (e) **Validation.** Suggested items are SUGGESTED — no auto-write. The operator reviews the draft on a preview pane and accepts / edits / rejects per-day. Mirrors the AI-Re-score-on-Contacts UX precedent.
- (f) **Re-prompt option.** "Suggest different destination" / "Suggest different budget tier" buttons re-call the LLM with adjusted parameters without losing the current draft.
- (g) **Stub-mode fallback** when `GEMINI_API_KEY` env not set: return a deterministic stub itinerary (echoes destination + days + a fixed item set) so demo/dev environments can exercise the UX without the cred. Mirrors the existing `/draft/regen` stub pattern.
- (h) **AI-source provenance** on accepted itineraries — `Itinerary.draftedByAi: Boolean` so analytics can compare AI-drafted vs template-cloned vs operator-built conversion rates.

### FR-3.5 Cross-cutting

- (a) **Versioning.** Templates have `version: Int` and `isLatest: Boolean`; editing a published template creates a new version, preserves usage history of the prior version.
- (b) **Soft-delete.** Templates aren't hard-deleted; `archivedAt: DateTime?` hides from library but preserves historical usage.
- (c) **Analytics export.** Per-template performance CSV: `templateId, name, subBrand, usageCount, acceptedCount, avgFinalPrice, conversionRate, lastUsedAt`.
- (d) **Sub-brand RBAC.** All four feature surfaces filter through `subBrandAccess[]` on the operator's User.
- (e) **Audit log.** Template create / edit / archive + per-itinerary clone-from-template event written to `AuditLog` per existing route patterns.

### FR-3.6 Operator-facing UX

- (a) **Cloning a template** is one click + an optional rename / change-dates dialog.
- (b) **Editing days** is drag-drop primary, type-to-search secondary.
- (c) **Saving as template** captures the current item list + day structure + a preview screenshot of the map.
- (d) **Pricing transparency** always visible in the right pane — per-item, per-day subtotal, trip total, currency-aware.
- (e) **Keyboard shortcuts:** `D` add day, `Shift+D` delete day, `Cmd+S` save, `Cmd+Z` undo (last 20 ops).

### FR-3.7 Master-data-grows-from-usage

- (a) **Add POI inline.** Operator can add a new POI to the sightseeing master without leaving the editor (modal form).
- (b) **Add hotel / activity inline.** Same pattern for hotels + activities not yet in Cost Master.
- (c) **Per-tenant vs shared.** New items default to tenant-private; ADMIN can promote to "shared" (visible to all tenants of the SaaS — applies to genuinely-non-proprietary data like POI coordinates, not commercial hotel rates).
- (d) **Pending-approval queue.** New items added inline land in a `pendingApproval: true` state; ADMIN approves to set `pendingApproval: false` before the item appears in other operators' searches (prevents typo-pollution).

---

## §4 Non-functional

- **Template library load:** <2s for the top-50 templates page including hero images.
- **Visual editor responsiveness:** drag-drop op completes in <100ms; map preview re-renders in <800ms; live re-price in <500ms.
- **Suggest itinerary latency:** Gemini Flash returns in <8s P95 for a 7-day request; <15s P95 for a 14-day. Stub mode returns in <100ms.
- **Map tile cost ceiling:** at projected 200 ops/day issuing 50 map-tile-fetches/op, daily fetch ~10k — well within Mapbox/OSM free-tier ceilings. Aggressive client-side caching of tile URLs.
- **POI master size projection:** 500 seed + ~50/month operator additions = ~1k POIs at year 1 / ~3k at year 3. Cost Master indexed on `(tenantId, subBrand, category, isActive)` — sightseeing inherits the index.
- **Mobile:** visual editor is desktop-first (drag-drop UX is unsuitable for phone). Template library + suggest-itinerary work on mobile (read + tap-clone).
- **Concurrent-edit:** itinerary edits are last-write-wins per existing `updatedAt` shape (no row-level lock); two operators editing the same itinerary will see warnings about stale data on save. Out of scope: real-time collaborative editing.
- **Accessibility:** keyboard-navigable for the day-by-day editor (drag-drop has keyboard equivalents: arrow keys + space-to-pick / drop).

---

## §5 Hand-over reqs / cred chase / design decisions

### Design decisions (pin BEFORE engineering starts)

- **DD-5.1 Template-library content sourcing model.** Three options: (a) hand-curated by Globussoft (we author all 50 seed templates), (b) operator-contributed marketplace (operators publish; Globussoft moderates), (c) hybrid (Globussoft seeds 20-25, operators expand). Strong recommendation: **(c) hybrid**. Operators have the best knowledge of what sells; Globussoft has the discipline for the seed. Marketplace governance (FR-3.1g) means operator-published templates default to per-sub-brand visibility; cross-tenant sharing requires Globussoft moderation.

- **DD-5.2 POI master ownership — Cost Master vs separate model.** Confirmed: **extend Cost Master (6th category)**. POI shares 90% of Cost Master's shape (per-supplier rate, per-route-or-sku key, attributes JSON, tenant-sub-brand scoping). A separate `TravelPOI` model would duplicate the index + scope + audit infrastructure for no semantic gain. POI-specific attributes (image, lat/lng, duration, suitability) fit cleanly in `attributesJson` per existing pattern. Re-evaluate if POI volume exceeds ~10k rows per tenant.

- **DD-5.3 POI seed-data source.** Two viable: WikiVoyage CSV export (CC-BY-SA, ~80k POIs worldwide, includes descriptions) or OpenTripMap free tier (CC-BY, ~3.4M POIs, includes lat/lng + categories, 5k req/day rate limit). **Pick OpenTripMap** for the seed because the lat/lng coverage is comprehensive and the import is a one-time bulk fetch (rate-limit only matters for live queries, which we don't do). Cred chase Q-IT-3 confirms the CC-BY attribution requirement is acceptable (link in `Tenant.brandingSettings.attributions[]`).

- **DD-5.4 Map tile provider.** Two viable: Mapbox (paid above 50k tile-loads/month; richer styling) or Leaflet + OSM tiles (free; less polished). **Default to Leaflet + OSM** for v1 (no cred dependency, ships immediately); cred chase Q-IT-1 keeps Mapbox as a pluggable upgrade if/when polish-tier matters. Tile-provider behind a thin adapter so the swap is single-file.

- **DD-5.5 LLM-suggested-itinerary acceptance flow.** Two options: (a) accept-all-or-nothing, (b) per-day accept/edit/reject. **Pick (b) — per-day**. AI suggestions are 60-80% useful on average; forcing all-or-nothing wastes the partial-correctness signal. UX mirrors the proven AI Re-score per-contact accept flow.

### Cred chase (blocks demo go-live)

- **Q-IT-1 Map tile provider key (Mapbox).** Optional — DD-5.4 defaults to OSM + Leaflet, no key needed. If Globussoft Travel team picks Mapbox for polish-tier maps later, Q-IT-1 unlocks ~10 lines of provider-swap code.

- **Q-IT-2 Gemini API key for `itinerary-suggest` task class.** Already overlapping with PRD_AI_SURFACES Q-AI-1 (same key, different task class). Resolution lands when Q11 (env-creds-for-LLM-providers) resolves cross-PRD.

- **Q-IT-3 POI seed-data licensing review.** OpenTripMap CC-BY attribution acceptable per DD-5.3 — Yasin to confirm before the bulk-import job lands. ~1 hour of his time.

### Vendor docs needed

- OpenTripMap API quickstart (https://opentripmap.io/docs) — POI seed import scripting.
- Leaflet plugin guide (Leaflet.markercluster, Leaflet.draw) — visual editor map layer.
- Gemini structured-output (JSON-mode) docs — `itinerary-suggest` task class.

---

## §6 Acceptance criteria

- **AC-6.1** Operator opens `/travel/itinerary-templates`, sees ≥50 templates across all 4 sub-brands, can filter by sub-brand / destination / day-range / budget-tier, clones a template in one click and lands on the visual editor with the cloned itinerary populated.

- **AC-6.2** Sightseeing master `GET /api/travel/sightseeing?destination=Paris` returns ≥10 Paris POIs from the seed; each POI carries `imageUrl`, `latitude`, `longitude`, `durationMinutes`, `category`, `description`. Cost Master `category=sightseeing` filter returns the same set.

- **AC-6.3** Visual editor: operator drags a POI from the sidebar onto a day card, the item appears in the day's item list within 100ms, the map preview adds a numbered pin within 800ms, the trip total in the right pane updates within 500ms.

- **AC-6.4** Operator clicks "Suggest itinerary", fills prompt form (destination + days + budget + traveller profile), the LLM-drafted itinerary returns in <8s P95, renders in a preview pane, the operator accepts per-day (or rejects with re-prompt option). Accepted days materialise as `ItineraryItem` rows; `Itinerary.draftedByAi = true`.

- **AC-6.5** Operator builds a custom itinerary, clicks "Save as template", names it, sets sub-brand + category. New template appears in the library at usage count 0; cloning it bumps usage to 1.

- **AC-6.6** New POI added inline (FR-3.7) lands in `pendingApproval: true` state; ADMIN approves; POI then appears in other operators' search results within the same sub-brand.

- **AC-6.7** Pricing engine: visual editor drag-drop fires `lib/travelPricing.js` re-compute; subtotals + grand total reflect markup rules + season calendar correctly. Verified against existing pricing test suite (`backend/test/lib/travelPricing.test.js`) — no regressions.

- **AC-6.8** Stub-mode acceptance: with `GEMINI_API_KEY` unset, "Suggest itinerary" returns a deterministic stub within 100ms; UX flow exercises end-to-end against the stub for demo-mode operation.

- **AC-6.9** Sub-brand RBAC: TMC operator cannot see RFU-only templates / POIs unless they have `subBrandAccess: ['tmc', 'rfu']`. Verified by gate spec `e2e/tests/travel-itinerary-templates-api.spec.js` cross-sub-brand probe.

- **AC-6.10** Audit log entries for template create / edit / archive / clone-from + sightseeing-POI add-inline / approve.

---

## §7 Out of scope (Phase 2+)

- Real-time multi-operator collaborative editing of the same itinerary (last-write-wins is sufficient for v1).
- Per-customer AI personalisation ("learn from this customer's past 3 trips") — Phase 2 once we have ≥3 itineraries per repeat customer to learn from.
- 3D/VR map preview (current map is 2D top-down).
- Cross-tenant template marketplace ("Globussoft Public Templates" visible to all tenants of the SaaS). Phase 3, gated on moderation pipeline.
- Auto-rebooking on supplier rate change (out of scope; covered by PRD_TRAVEL_SUPPLIER_MASTER's PO-update flow).
- POI booking-API integrations (GetYourGuide / Viator) — Phase 2; current scope is POI as Cost Master row with manual operator booking.
- Multi-language template translation (English-only v1; multi-language tied to `Tenant.locale` once we have a Hindi/Arabic operator).
- Loyalty-tier template gating ("Gold-tier customers see premium-only templates") — Phase 2.

---

## §8 Dependencies

- **`Itinerary` + `ItineraryItem`** (`prisma/schema.prisma:4170-4242`) — extended with `clonedFromTemplateId`, `draftedByAi` on Itinerary; `dayNumber`, `latitude`, `longitude` on ItineraryItem.
- **New `ItineraryTemplate` Prisma model** — mirrors `Itinerary` shape + `usageCount`, `acceptedCount`, `avgFinalPrice`, `lastUsedAt`, `previewImageUrl`, `version`, `isLatest`, `archivedAt`.
- **`TravelCostMaster`** — enum extension to 6 categories (5 existing + `sightseeing`).
- **`lib/travelPricing.js`** — consumes the upgraded item list unchanged; verified via existing test suite.
- **`lib/llmRouter.js`** — new task class `itinerary-suggest` (Gemini 2.5 Flash, 2K in / 4K out).
- **PRD_AI_SURFACES.md** — task-class infra + AI Re-score precedent + per-task budget / model assignment.
- **PRD_TRAVEL_QUOTE_BUILDER.md** — Cost Master + pricing-engine substrate (already shipped per tick-#20).
- **PRD_TRAVEL_SUPPLIER_MASTER.md** — supplier-id wiring on cloned templates' supplier-linked items.
- **PRD_TRAVEL_MARKETING_FLYER.md** — shared visual-builder substrate (extract `<VisualBuilder/>` from `LandingPageBuilder.jsx` once; both PRDs consume).
- **PRD_TRAVEL_BILLING.md** — accepted itineraries flow into invoice generation (unchanged contract).
- **`Tenant.subBrandConfigJson`** (tick #20 `621aab7`) — per-sub-brand brand-kit defaults for templates.
- **`subBrandAccess[]`** on User — sub-brand RBAC filtering.
- **`backend/routes/travel_csv_io.js`** — extended to import sightseeing CSVs + initial template seed.
- **OpenTripMap** (CC-BY) — POI seed data source per DD-5.3.
- **Leaflet + OSM** — map preview default per DD-5.4.

---

## §9 Open questions

- **OQ-9.1** Should the LLM-suggested itinerary be billable as an AI cost line to the customer (e.g. ₹50/itinerary) or absorbed by Globussoft as a value-add? Cost analysis: Gemini Flash @ ~$0.0005 per suggest call × 200 ops/day = ~$3/day = ~$90/month. Absorb-as-value-add seems right; needs Yasin's call.

- **OQ-9.2** Per-sub-brand vs cross-sub-brand POI sharing. Should the Eiffel Tower POI added by a TMC operator be visible to a Travel Stall operator? Recommendation: yes (POI coords + descriptions are non-proprietary), but the per-sub-brand pricing override stays per-sub-brand. Confirm.

- **OQ-9.3** Template versioning: when a published template is edited and bumps version, do already-cloned itineraries from the old version get a "new version available" notice? Or do clones permanently fork? Default: permanently fork (lower cognitive load).

- **OQ-9.4** Operator-published template moderation timeline. ADMIN-approval before cross-sub-brand visibility — what's the SLA? 24h? Self-approval with post-hoc audit? Recommendation: 24h with auto-approve + audit-only path for v1, tighten later.

- **OQ-9.5** Suggest-itinerary prompt hygiene. Should we filter the customer's `travellerProfile` free text for PII / inappropriate content before passing to the LLM? Recommendation: yes — pass through `sanitizeJson` first, also gate on prompt-injection patterns. Risk-mitigation also for compliance: customer PII shouldn't fly to an external LLM unredacted.

- **OQ-9.6** Map provider switch trigger. At what scale (tile-loads/month? customer-tier?) do we flip from OSM + Leaflet (free) to Mapbox (paid, richer)? Need a "polish event" decision criterion — likely tied to a high-touch sub-brand launching (Visa Sure premium maps would be the trigger).

- **OQ-9.7** "Suggest itinerary" cold-start with no Cost Master data for the requested destination. Recommendation: LLM still produces a draft (it knows Paris exists even if our Cost Master doesn't); a follow-up step pulls live OpenTripMap data for the destination + offers operator a one-click "import as Cost Master rows" flow.

- **OQ-9.8** Mobile experience for the visual editor — confirm desktop-first is acceptable. Travel ops are predominantly desktop today; if Yasin wants mobile-first for field reps, scope grows ~50%.

---

## §10 Status snapshot

### 2026-06-09 refresh — template library + sightseeing master LIVE; visual editor + suggest-itinerary pending

**Current state:** Itinerary CRUD + `/draft/regen` LLM summary + the template library + sightseeing master + typed-list editor are SHIPPED. The prior "no template library; no sightseeing master" claim is OBSOLETE. The visual day-by-day editor + LLM suggest-itinerary task class remain pending.

**SHIPPED:**
- ✅ `backend/routes/travel_itinerary_templates.js` — full CRUD + by-month/quarter/year + stats
- ✅ `frontend/src/pages/travel/ItineraryTemplates.jsx` + tests
- ✅ `backend/routes/travel_sightseeing.js` — CRUD + stats + by-period
- ✅ `frontend/src/pages/travel/SightseeingMaster.jsx`
- ✅ Itinerary CRUD + items polymorphic CRUD (`travel_itineraries.js` ~2800+ LOC with `/accept`/`/reject`/`/share`/PDF/public flows)
- ✅ `frontend/src/pages/travel/Itineraries.jsx` + `ItineraryDetail.jsx` typed-list editor
- ✅ `/draft/regen` LLM summary via `backend/lib/llmRouter.js` (commit `583c06b`)
- ✅ `backend/lib/travelPricing.js` engine

**Pending (in-PRD work):**
- ⬜ `/travel/itineraries/:id/edit` day-by-day visual editor with drag-drop + map preview (FR-3.3) — ~6d
- ⬜ `dayNumber` + `latitude`/`longitude` on `ItineraryItem` — ~½d
- ⬜ LLM "Suggest itinerary" task class (`itinerary-suggest` not registered — only `/draft/regen` summary exists) — ~3d
- ⬜ OpenTripMap POI seed import — ~1d
- ⬜ Leaflet+OSM map provider integration — ~1d
- ⬜ Inline Add-POI modal with `pendingApproval` queue (FR-3.7) — ~1d
- ⬜ Brand-kit-aware template defaults from `subBrandConfigJson` — ~½d

**Blocked / deferred:**
- 🔵 Q-IT-2 Gemini API key (overlaps Q11) — stub-mode OK for dev
- 🔵 Q-IT-3 OpenTripMap licensing review (Yasin ~1hr)
- 🔵 Q-IT-1 Mapbox optional — DEFERRED (OSM default ships fine)

**Net remaining: ~13 engineering days** + Yasin's licensing call. Template + sightseeing + LLM summary (the immediate prereqs) are off the critical path. Visual editor + suggest-itinerary task class are the next high-value slices.

- **Status flag:** DRAFT — pending product-owner sign-off (Yasin) on DD-5.1 / DD-5.3 / OQ-9.1 / OQ-9.5 / OQ-9.8.
- **Sibling PRDs:** PRD_AI_SURFACES (task-class infra), PRD_TRAVEL_QUOTE_BUILDER (cost-master substrate), PRD_TRAVEL_SUPPLIER_MASTER (supplier-id wiring), PRD_TRAVEL_BILLING (invoice handoff), PRD_TRAVEL_MARKETING_FLYER (shared `<VisualBuilder/>` substrate).
- **Refs:** GH #907 • Travel Stall CRM Roadmap Tier P2 item 12.
