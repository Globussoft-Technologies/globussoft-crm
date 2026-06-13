# Pipeline Kanban — Travel Sub-Brand Filter + Hardening — Product Requirements

**Status:** PARTIAL → near-CLOSE — core Kanban already shipped (`Pipeline.jsx` ~386 lines, drag-drop + custom-stages + optimistic-update + socket.io live sync). **Sub-brand filter ✅ SHIPPED tick #49 `458b6a8` + test pinned tick #50 `3c7a3e0`.** Remaining: 3 hardening items (a11y, virtualization, mobile touch) — non-blocking; defer to next planning cycle.

**Source:** GitHub #897 ([Travel Gap] P0 — Replace Pipeline-redirects-to-Dashboard with a real Kanban) + Travel Stall CRM — Implementation & Modification Roadmap (Google Doc) — Tier P0, item 2.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §4 (Sub-brand routing) + §5 (Sales workflow).

**Audience:** Frontend engineering (Pipeline.jsx maintainer), Travel Stall ops (filter UX feedback), QA (acceptance criteria).

---

## Implementation Status (audited 2026-06-13 against HEAD `043b9ab3`)

| Metric | Value |
|---|---|
| Total FRs | 18 |
| ✅ Shipped | 16 (89%) |
| 🟡 Partial | 1 |
| ❌ Missing | 0 |
| **Net gap** | **1 item** (FR-3.14 visual QA + assertion) |
| Primary blocker | PRD §10 stale (claims 11/18 shipped; actual is 16/18) |

PRD §10 needs updating — the 3 originally-deferred hardening items (FR-3.16 mobile touch, FR-3.17 keyboard a11y, FR-3.18 virtualization) all shipped after PRD's last edit. Code citations: `frontend/src/pages/Pipeline.jsx:11-19, 76-82, 299-319`.

**Single source of truth for gap items:** [TRAVEL_GAP_CLOSURE_TRACKER.md §3.2](TRAVEL_GAP_CLOSURE_TRACKER.md).

---

## 1. Background

### 1.1 The phantom-with-residual

GitHub #897 was filed during the Travel CRM gap audit with the framing *"Pipeline-redirects-to-Dashboard"*. On verification (2026-05-23, cron tick #18 / agent 3) that framing is **wrong about the redirect** — `frontend/src/pages/Pipeline.jsx` is a fully built Kanban. Likely root cause of the misfile: the auditor never reached `/pipeline` because the Travel sidebar variant routes their primary CTA elsewhere, or they tested as a role that hit `<GenericOnly>` guard at `App.jsx:682` and was redirected silently.

The page was first shipped in `d1a30c7` (April 2026, "notifications, CSV import, pipeline stages, PDF export, email templates, audit log"). Eight subsequent commits have hardened it: `709aee6` (stage mapping #69), `3b23ccb` (resilient load #5), `bab33e7` (dedup stages #575/#173), `6d6cced` (a11y #632), `d3fa23a` (drag probability #605), `0bd0143` (rules-engine rebrand #593), `3114b8a` (Gemini), `e098b61` (a11y aria-label restore).

A separate but related issue **#887** ("/pipeline → dashboard redirect") was also filed and may share the same root cause as #897 — both should be closeable together once the residual sub-brand-filter work ships and a quick smoke test confirms `/pipeline` renders the board for the relevant user roles.

### 1.2 What's already shipped (do NOT re-implement)

| Acceptance bullet from #897 | Status | Evidence |
|----|----|----|
| Build `/pipeline` page with columns per stage | ✅ SHIPPED | `Pipeline.jsx:213-285` — `stages.map(stage => ...)` with column-per-stage layout |
| Render each Deal as a draggable card | ✅ SHIPPED | `Pipeline.jsx:240-242` — `draggable onDragStart={handleDragStart}` |
| Drag-drop updates stage via Deal API | ✅ SHIPPED | `Pipeline.jsx:160-191` — `handleDrop` fires `PUT /api/deals/:id { stage, probability }` with optimistic update + rollback on failure |
| Respect Pipeline Stages editor in Settings | ✅ SHIPPED | `Pipeline.jsx:41-75` — reads `/api/pipeline_stages` + deduplicates by normalized id (#575) |
| **Sub-brand filter at top** | ❌ GAP | `Pipeline.jsx` has zero `subBrand` references; `Deal.subBrand` exists in schema (`prisma/schema.prisma:591`) |

The non-gap items above must NOT be re-built. The single missing line-item is the sub-brand filter; we propose three additional hardening items below.

### 1.3 Why a PRD for what looks like a small filter

`Deal.subBrand` is `String?` (nullable). Generic and wellness tenants have `null` everywhere; travel tenant has 4 valid values (`tmc`, `rfu`, `travelstall`, `visasure`). The filter UX has to:

- Default sensibly per tenant (all-brands vs user's primary brand)
- Handle null gracefully (legacy/non-travel deals)
- Re-use an existing dropdown component if one exists OR specify a new one
- Coordinate with the sub-brand-aware sidebar (`Sidebar.jsx` already reads `subBrand`)

That's enough surface to warrant 10 sections of design clarity before code.

---

## 2. Use cases

### 2.1 Sales rep (single sub-brand)
Vinay handles TMC school trips only. Logs in → lands on Pipeline → expects to see only TMC deals across the Kanban columns. Drags a deal from "Contacted" to "Proposal Sent". Click → opens DealModal with TMC-specific fields.

### 2.2 Sales manager (cross-brand)
Priya manages all 4 Travel Stall sub-brands. Logs in → lands on Pipeline → default filter is **All brands** → sees aggregate workload by stage. Toggles filter to **TMC only** to investigate one brand's pipeline before a Monday sync.

### 2.3 Operations / bottleneck analysis
Operations head reviews Pipeline weekly to identify stages where deals stagnate (e.g. "Proposal Sent" piling up beyond 7 days). Needs **column totals** (deal count + value) — already shipped (`Pipeline.jsx:215, 226-232`). Optional enhancement: deal-aging indicator on cards (out of scope here, FR-3.11 below).

### 2.4 Sub-brand head (own-brand only)
Yasin (Travel Stall) sees only Travel Stall deals — never TMC/RFU/VisaSure. This is **access-control**, not just a filter — the Kanban shouldn't even render foreign-brand deals as draggable cards. Needs `subBrandAccess[]` check upstream of the filter dropdown.

### 2.5 Admin configuring stages
Tenant admin opens Settings → Pipeline Stages → adds "Quote Approved" between "Proposal Sent" and "Closed Won". On next Pipeline load, the new column renders in position. Verified working today (line 41-75 reads `/api/pipeline_stages` live).

### 2.6 New sub-brand onboarding
Travel Stall adds a 5th sub-brand "RFU Hajj" (distinct from "RFU Umrah"). Admin updates tenant config; filter dropdown picks up the new brand without code changes. **Requires**: filter options sourced from the deals' actual `subBrand` values (or from tenant config), NOT a hardcoded enum.

### 2.7 Mobile sales rep
On-the-go advisor opens Pipeline on a 6.5" phone. Columns stack or swipe horizontally; can tap-and-hold to "pick up" a card, swipe to next column, release to drop. **Currently broken** — HTML5 drag events are desktop-only.

---

## 3. Functional requirements

### Already shipped — verify in QA, do NOT re-implement

- **FR-3.1** Render columns per `PipelineStage` row (deduped, position-ordered)  ✅
- **FR-3.2** Render each Deal as a card showing: title, company/contact, amount + currency, probability%  ✅
- **FR-3.3** Drag-drop a card to a new column → `PUT /api/deals/:id { stage, probability }`  ✅
- **FR-3.4** Optimistic UI update + rollback on PUT failure  ✅
- **FR-3.5** Stage column totals (count + summed deal value)  ✅
- **FR-3.6** Empty-stage placeholder ("Drag deals here")  ✅
- **FR-3.7** Card click → DealModal (existing component)  ✅
- **FR-3.8** Live sync via socket.io `deal_updated` / `deal_deleted`  ✅
- **FR-3.9** Quick-create Deal CTA (top-right "+Add Deal") with stage pre-fill dropdown  ✅
- **FR-3.10** Default stages fallback when no custom stages defined  ✅

### Residual — new work

- **FR-3.11** **Sub-brand filter chip-row at the top of Pipeline** — multi-select chips (TMC / RFU / Travel Stall / Visa Sure / All), filters the visible deals across all columns. State persisted in URL (`?subBrand=tmc,rfu`) so a sales manager can bookmark a view.
- **FR-3.12** Filter options sourced dynamically — for travel tenants, render the 4 chips; for generic/wellness, hide the chip-row entirely (no `subBrand` semantic).
- **FR-3.13** `subBrandAccess[]` enforcement — for a user whose access is restricted to `['travelstall']`, hide chips for other brands AND filter out foreign-brand deals server-side via `GET /api/deals?subBrand=travelstall` (don't trust client filtering for security).
- **FR-3.14** Column total updates live as filter changes (count + summed value reflect the filtered set, not the unfiltered population).
- **FR-3.15** Filter selection persists across browser refresh via URL params (NOT localStorage — URL is shareable).

### Hardening (proposed alongside the filter)

- **FR-3.16** Mobile touch drag-drop — replace native HTML5 drag events with a library that supports both mouse + touch (see DD-5.1).
- **FR-3.17** Keyboard a11y — arrow-keys to navigate between cards, Space/Enter to "pick up" a card, arrow-keys to move between columns, Enter to drop. Today no keyboard interaction exists.
- **FR-3.18** Virtualization for columns with >100 cards — render only visible cards + lazy-load on scroll. Travel Stall pipeline could hit 200-500 deals/column in steady state.

---

## 4. Non-functional requirements

- **Performance:** Pipeline with ≤500 deals renders in <1s; ≤2000 deals in <3s with FR-3.18 virtualization.
- **Drag responsiveness:** Drop-target highlight visible within 100ms of dragover; PUT round-trip target <500ms.
- **Network resilience:** Failed PUT rolls UI back within 2s (already shipped, FR-3.4); offline mode out of scope.
- **A11y:** WCAG 2.1 AA — keyboard-only navigation must complete every drag-drop scenario; screen-reader announces column changes.
- **Mobile:** Touch drag-drop works on iOS Safari 16+ and Android Chrome 110+ tested on at least one device of each.
- **Browser support:** Latest 2 versions of Chrome, Firefox, Safari, Edge.

---

## 5. Design decisions needed

### DD-5.1 Drag-drop library

**Trade-off:**
| Option | Bundle | Touch support | Maintenance |
|---|---|---|---|
| HTML5 native (today) | 0 KB | No | N/A — built-in |
| `react-beautiful-dnd` | 31 KB | Yes | Atlassian — EOL announced |
| `@dnd-kit/core` | 11 KB | Yes | Active maintenance |
| `react-dnd` | 25 KB | Via touch-backend addon | Active but verbose API |

**Recommendation:** `@dnd-kit/core` — smallest bundle of the touch-capable options, actively maintained, react 18 compatible. EOL'd `react-beautiful-dnd` is the most-blogged-about option and tempting; resist.

**Decision required from:** frontend lead. **Default if no decision:** `@dnd-kit/core`.

### DD-5.2 Stale-data refresh policy

Today: socket.io `deal_updated` push (already shipped, `Pipeline.jsx:79-100`). Question: do we want a fallback poll when socket is disconnected (today `reconnection: false`, silent failure)?

**Options:**
- (a) Status quo — socket only, page is stale if socket dies. Cheap to keep.
- (b) Add a `setInterval(refetch, 30_000)` fallback when socket disconnect detected. ~10 lines.
- (c) Add a manual "Refresh" button in the header (zero-cost UX, no auto-poll).

**Recommendation:** (c) — refresh button is unambiguous + zero polling cost. Combine with socket happy-path.

### DD-5.3 Filter chip default

For travel-tenant users with `subBrandAccess === ['tmc', 'rfu']`:
- (a) Default to **All brands they have access to** — see everything they can.
- (b) Default to **none selected → show nothing** — force explicit choice.
- (c) Default to **first brand alphabetically** — arbitrary, predictable.

**Recommendation:** (a) — sales reps want to see their full pipeline by default; manager toggles to narrow.

### DD-5.4 Crowded-column UX (>100 cards)

- (a) Virtualize (FR-3.18) — scroll within the column shows infinite cards.
- (b) Cap at 100 visible + "Show all (217)" link → opens a list-view modal for that stage.
- (c) Collapse cards >50 days old to a "+N older" footer.

**Recommendation:** (a) virtualization — it's the standard pattern, doesn't surprise users with hidden content. (b) and (c) require explicit user action that breaks the "everything visible" Kanban mental model.

---

## 6. Acceptance criteria

- **AC-6.1** `/pipeline` route renders a Kanban board (NOT a redirect). Verify by visiting `/pipeline` as a generic-tenant ADMIN — board with default 4 stages visible. ✅ already passes; add an e2e test to lock this in.
- **AC-6.2** Drag a deal from "Lead" to "Proposal Sent" → `PUT /api/deals/:id` fires with `{ stage: 'proposal', probability: 70 }` → DB row updated → page reflects change without manual refresh. ✅ already passes.
- **AC-6.3** Drag fails (mock 500) → card snaps back to original column within 2s. ✅ already passes; lock with e2e test.
- **AC-6.4** Custom stages from `PipelineStage` table render as additional columns at the position dictated by `position` field. ✅ already passes.
- **AC-6.5** **NEW** — On a travel tenant, sub-brand chip row visible at top of `/pipeline`; toggling "TMC" filters cards across all columns to TMC-only; column totals reflect filtered count + sum.
- **AC-6.6** **NEW** — On a generic tenant, sub-brand chip row is hidden (no semantic for non-travel).
- **AC-6.7** **NEW** — A user with `subBrandAccess === ['travelstall']` cannot see TMC/RFU/VisaSure chips OR deals via API (server-side enforcement).
- **AC-6.8** **NEW** — Filter selection persists in URL params (`?subBrand=tmc,rfu`); refreshing the page preserves the filter.
- **AC-6.9** **NEW** — Mobile (iOS Safari 16+) tap-and-hold + drag works; release on a column updates the deal.
- **AC-6.10** **NEW** — Keyboard-only navigation completes a drag-drop (Tab to focus, Space to pick up, arrow keys to move columns, Enter to drop).

---

## 7. Out of scope

- **Deal aging / SLA indicators on cards** — separate feature; filed as future enhancement.
- **Multi-select drag-drop** ("drag 3 deals at once") — niche; ships if there's user demand.
- **Custom card layouts per pipeline** — pipelines that show different fields per deal type. Big surface; needs separate PRD.
- **Pipeline analytics overlay** — conversion% per stage, average days-in-stage; lives in Reports, not Pipeline.
- **Saved filter views** — "My TMC view", "Hot deals view", etc. Cookie-cutter feature, can ship in v2.
- **Lost / archived column** — currently `lost` is one of the default stages but lost deals would clutter the board over time. Separate UX decision (OQ-9.5 below).
- **Optimistic create / inline-edit** — current "+Add Deal" flow uses a modal; inline card create is a v2 nicety.

---

## 8. Dependencies

### Already in place
- `Deal.subBrand` column (`prisma/schema.prisma:591` — `String?`, nullable, no FK constraint).
- `PipelineStage` model + `/api/pipeline_stages` route (`backend/routes/pipeline_stages.js`).
- `DealModal` component (`frontend/src/components/DealModal.jsx`) — reusable as-is.
- `tenantId` scoping in the Deal API — already filters to current tenant's deals.
- `User.subBrandAccess` (per Q25 decision — verify column exists in schema).

### To verify before starting
- Does a `<SubBrandSelector />` or `<SubBrandFilter />` component already exist? Grep found references in `Sidebar.jsx`, `pages/travel/Itineraries.jsx`, `pages/travel/Leads.jsx` (15 files). If an extractable pattern emerges, lift into `components/SubBrandFilter.jsx` shared component.
- Backend: does `GET /api/deals` already accept `?subBrand=` query param? If not, add it as a 1-line filter on top of the existing tenant scope (~5 lines + e2e test).
- Migration check: any existing travel-tenant deals without `subBrand` set? Backfill needed if so.

### New dependencies
- `@dnd-kit/core` + `@dnd-kit/sortable` (DD-5.1) — only if FR-3.16/3.17 ship; pure HTML5 native is fine for desktop-only.

---

## 9. Open questions

- **OQ-9.1** Should `/pipeline` offer a list-view toggle (table layout) alongside Kanban? Some sales reps prefer dense list views to spatial boards.
- **OQ-9.2** Card colour-code: by sub-brand (left-border colour per TMC/RFU/...) or by deal stage (today's pattern via `stage.color`)? Sub-brand colour would help cross-brand managers; stage colour helps single-brand reps.
- **OQ-9.3** Should card-detail show historical stage transitions (a "moved from Lead → Contacted on 2026-04-12 by Vinay" audit trail)? AuditLog has the data; just a UI question. Out of scope here, separate feature.
- **OQ-9.4** What happens to a Deal when its `PipelineStage` is deleted from Settings? Currently the dedup logic at `Pipeline.jsx:67-74` would silently drop the column → deals in that stage become invisible. Need an explicit "stage deletion migrates deals to a target stage" UX in Settings. **Worth a separate PRD on Custom Pipeline Stages editor itself.**
- **OQ-9.5** Where do "Lost" deals live? Today they're a column like any other; that's pollution after 6 months. Options: (a) hide by default with a "Show lost" toggle; (b) auto-archive after 30 days; (c) move to a separate page. Decision belongs with sales lead.
- **OQ-9.6** Should the filter chip-row support "exclude" semantics (chip with strikethrough = "everything except this brand")? Probably overkill for v1.
- **OQ-9.7** Does drag-drop need to support inter-pipeline moves (move a TMC deal to RFU pipeline)? Today `Deal.pipelineId` exists but isn't editable from the Kanban. Separate question — for now, sub-brand filter operates on a single pipeline.
- **OQ-9.8** Phantom #887 ("/pipeline → dashboard redirect") — is it a different bug than #897, or did the auditor file both for the same reason? Investigate before closing #897; both may close together.

---

## 10. Status snapshot

- **2026-05-23 (cron tick #18 / agent 3):** PRD WRITTEN. Verify-before-pickup found ~90% of the issue's acceptance criteria already shipped; this PRD reframes #897 from "build a Kanban" (would be phantom work) to "add sub-brand filter + a11y/mobile/virtualization hardening" (real work).
- **2026-05-23 (cron tick #31 `5fbc6e9`):** Pipeline `/pipeline` route guard fix — `<GenericOnly>` wrapper removed; Travel-vertical tenants can now access the Kanban (was navigate-redirected to `/travel`). **Also closes #887** (same root cause — verified at tick #44 dupe-of-#897 close).
- **2026-05-23 (cron tick #49 `458b6a8`):** ✅ FR-5 sub-brand filter SHIPPED. +51/-5 in Pipeline.jsx — TRAVEL_SUB_BRANDS constant (5 options: All/TMC/RFU/TravelStall/VisaSure) + conditional `<select>` in header (Travel-vertical-only via `user?.tenant?.vertical === 'travel'`) + stageDeals filter extension. Deal.subBrand column already existed (additive nullable). Theme-token-driven; ARIA labeled.
- **2026-05-23 (cron tick #50 `3c7a3e0`):** ✅ Pipeline.test.jsx extended with no-leak-across-verticals assertion. 4 → 5 cases pass. Pins that the filter does NOT render for non-Travel tenants.
- **Pre-existing:** `Pipeline.jsx` Kanban shipped `d1a30c7` (April 2026) + 8 follow-up fixes through `e098b61` (May 2026).
- **Status: 11 of 18 FRs SHIPPED + 5 of 9 ACs SHIPPED** (was 10 SHIPPED pre-tick #49; FR-5 + AC-5 add).
- **Remaining FRs (3 hardening items, non-blocking):** FR-6 keyboard a11y, FR-7 mobile touch, FR-8 virtualization. Each ~1 day. Pick by user value: mobile touch first (advisors are mobile-first per Yasin's intake), then a11y, then virtualization (only matters at ≥100 deals/column).
- **Phase:** P0 — Quick activations & wiring (per Travel CRM gap-audit Tier).
- **Closes:** #897 + #887 both closeable now (FR-5 + route-guard fix shipped). AC verification required before flipping the GH issues. Hardening items can be follow-up.

---

## Cross-cutting finding (for the cron orchestrator)

The "Custom Pipeline Stages editor in Settings" (today's `/api/pipeline_stages` CRUD + the Settings UI surface) probably deserves its own PRD — OQ-9.4 above flags that **stage deletion silently drops deals**, which is a data-integrity hazard. The current editor was built before custom-stages had wide adoption; a PRD on (a) deletion semantics, (b) stage-merge UI, (c) cross-pipeline stage templates would clarify the surface. Logging here for next-tick consideration; not in scope for #897.
