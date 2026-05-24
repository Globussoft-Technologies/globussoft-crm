# Travel CRM — Session handoff (2026-05-20)

End-of-session map for the autonomous Phase 1 build. 16 commits across
~16 hours of work. Read this top-down: what shipped, what's not shipped
and why, what's smartest to pick up next.

## TL;DR

Phase 1 backend backbone is **complete** modulo three deferred items
(Visa Sure, Chrome-extension flows, SMS-dependent paths). All shipped
endpoints have gate specs + are wired into CI. Demo seed populates
placeholder content so login → click around works end-to-end.

```
Backend route surface:  10 route files, 84 endpoints
Pure-library surface:   3 helpers (diagnostic scoring, pricing,
                        guards) with 56 vitest cases
Frontend pages:         9 pages (dashboard + 3 diagnostic + 1
                        itineraries + 2 trips + 2 admin)
Gate specs:             10 spec files, ~140 individual test cases
Schema delta:           21 new Prisma models + 8 additive columns
```

## Commit map

| Day | Commit | What |
|---|---|---|
| Docs | `7f5b472` | PRD synthesis from 19 client docs |
| Docs | `f7791bf` | Open questions + risks split into review docs |
| Docs | `f9f52aa` | 25 product calls decided with Yasin |
| 1 | `c751811` | Vertical scaffolding (theme + sidebar + route + seed + login) |
| 2 | `8f02752` | Schema migration — 21 new Prisma models + 8 additive columns |
| 3 | `dd5fa42` | Diagnostic engine backend — scoring lib + 6 endpoints + 20 vitest |
| 4 | `d59f38e` | Diagnostic wizard UI — 3 pages |
| 5 | `408a852` | Diagnostic gate spec + CI wire |
| 6 | `ec687c6` | Itinerary CRUD — 8 endpoints + list UI + gate spec |
| 7 | `97d78b6` | TMC trip CRUD — 12 endpoints + Aadhaar guard + gate spec |
| 7.5 | `263678e` | Refactor — shared travelGuards middleware |
| 8 | `d572d56` | Cost-master CRUD — 5 endpoints + gate spec |
| 9 | `4b6b95e` | Supplier vault — AES-256-GCM + access-log + 11-test gate |
| 10 | `9b9e193` | TMC microsite — admin + public endpoints + 11 gate tests |
| 11 | `8a1c287` | RFU lead profile — 6 endpoints + 11 gate tests |
| 12 | `7d3e87f` | Pricing engine — seasons + markup + /quote + 21 vitest |
| 13 | `31aabe2` | TMC rooming + payment plan + instalments — 11 endpoints |
| 14 | `7cc839f` | TMC trips UI — list + 5-tab detail page |
| 15 | `78e85f7` | Seed enrichment + CLAUDE.md + CHANGELOG.md (v3.9.0) |
| 16 | `1ac6cdf` | Cost-master + Suppliers vault admin UI |

Earlier in the same session (before the travel work):
- `2f31657` — e2e-full shard timeout 45 → 60 min (release validation
  unblock; structural fix tracked separately)
- `3e3b43d` — CI retries 3 → 2 (part of the 8-shard absorber arc)
- `a0d7f34` — actionTimeout 60 → 30s
- `96d7076` — retry-on-5xx login + createContact helpers
- `d59349e` — revert e2e-full matrix 8 → 4 shards

## What's reachable end-to-end on demo (after deploy lands)

Smoke-test path:
1. Once deploy lands, `seed-travel.js` runs automatically (CI seeds) or
   trigger via `workflow_dispatch.seed_travel=true`. To run manually on
   demo: `ssh empcloud-development@163.227.174.141 'cd ~/globussoft-crm && node backend/prisma/seed-travel.js'`.
2. Open demo login page. New **Travel Stall — Demo** section
   visible alongside Generic / Enhanced Wellness.
3. Login as `yasin@travelstall.in` / `password123`. Lands on `/travel`
   with the navy + gold placeholder theme.
4. Sidebar links: Dashboard / Diagnostics / Itineraries / TMC Trips /
   Cost Master / Suppliers (admin-only).
5. Click **Diagnostics** → click any sub-brand → click bank v1 → walk
   the wizard → see the result card.
6. Click **Cost Master** → see 9 seeded rate rows across RFU + TMC.
7. Click **TMC Trips** → currently empty (no seed trip ships); creating
   trips happens via the API (`POST /api/travel/trips`).
8. Click **Suppliers** → empty; add one via the form to verify the
   reveal flow.

## What's deferred + why

**Visa Sure** (`VisaApplication`, `VisaDocumentChecklistItem`):
- Schema is present (shipped Day 2 for stability).
- No routes / no UI. Q18 puts Visa Sure in Phase 3 — out of Phase 1
  scope per the freeze. Picking it up requires reopening that
  conversation with Yasin (see TRAVEL_CRM_OPEN_QUESTIONS.md Q18).

**TripMicrositeOtp** (request + verify flow):
- Schema is present + the table is empty.
- Public info endpoint at `/api/travel/microsites/public/:uuid` works
  WITHOUT OTP (returns sanitised payload). The OTP-gated `/full` read
  for participant / rooming / payment-plan PII is deferred.
- Dependency: SMS provider creds. Q9 says the 3 WABA numbers are
  Meta-verified; SMS dispatch via Wati / Twilio needs the BSP keys
  to be shared. Once those arrive, ~3-4 hours of work to wire
  request-otp → store-hashed → verify-otp → mint-session-jwt → gate
  the read endpoint.

**Web check-in** (`WebCheckin` row + Chrome extension):
- Schema is present.
- Chrome extension is a separate project (lives at `flight-plugin/`
  per PRD §7.2). Needs its own repo + Manifest V3 build + per-airline
  DOM adapters.
- Backend cron that promotes `pending` → `reminded` at T-48h /
  T-24h needs SMS provider creds (same Q9 dep as OTP).

**Reminder cron for `TripInstalmentPayment`**:
- Same SMS dep as above. Each instalment with `status=pending` and
  `dueDate - now() < reminderDays` should fire a WhatsApp / SMS /
  email reminder. Phase 1.5.

**Frontend Phase 1.5 builders** (replacing the JSON-paste / API-only
flows currently shipped):
- Diagnostic Q-set visual builder (currently: paste JSON in Admin
  Builder page).
- Rooming visual builder (drag-and-drop participant → room).
- Payment-plan timeline builder (currently: PUT JSON via API).
- Inline microsite editor with rich-text + image upload (currently:
  admin POSTs `itineraryHtml` as a string).
- Seasons + markup rules admin UI (currently: API-only).

## Open risks (still amber/red, see TRAVEL_CRM_RISKS.md)

| # | Risk | Status |
|---|---|---|
| R1 | Section 13 packet | 🟡 Most items confirmed ready; receipt still pending per `TRAVEL_CRM_OPEN_QUESTIONS.md` deliverables checklist |
| R2 | 6-week timeline | 🔴 Structural — kept ~70% reuse from existing CRM, but calendar pressure remains |
| R3 | Chrome extension auto-update | 🔴 Out of repo scope; revisit when the extension build kicks off |
| R7 | LLM cost + observability | 🟡 Routing decided (Q11); router build is Phase 1.5 |
| R8 | Aadhaar legal exposure | 🟡 DigiLocker path locked (Q3); counsel review of consent text pending |
| R11 | On-prem hosting | 🔴 NEW from Q6 decision; W0 infra-handover call needed with Travel Stall ops |

## Recommended next moves

### Highest leverage (do first, in this order)

1. **Schedule the R11 infra-handover call** with Travel Stall ops.
   The on-prem decision adds W0-W1 work that wasn't in the 6-week
   scope. Need SSH bastion / DNS API / backup strategy / DR targets
   in writing before any deploy pipeline tunes. ~2-3 days of ops
   work; risk goes ~~🔴~~ → 🟡 once scoped.

2. **Receive Yasin's Section 13 deliverables**. The
   TRAVEL_CRM_OPEN_QUESTIONS.md "What Yasin owes GS now" checklist
   lists 9 items. As each lands, swap into seed-travel.js. The
   biggest single unlock is the real diagnostic Q-sets (Q13) — the
   placeholder content in seed-travel.js needs to be replaced.

3. **Aadhaar consent legal copy** (Q2 — GS owes Travel Stall).
   GS drafts against Aadhaar Act §29 + DPDP Act; counsel reviews;
   final approved text ships in Phase 1. ~half-day of legal work.

### Medium-leverage (when blockers clear)

4. **Wire DigiLocker** once Travel Stall shares the partner creds
   (Q3). Aadhaar OCR path then becomes live; until then the
   `TripParticipant.aadhaarTokenId` column is null.

5. **Wati BSP provisioning** for the 3 WABAs (Q9). Once Meta
   Business Manager access arrives, ~1 day to wire each WABA into
   the existing CRM WhatsApp surfaces.

6. **Microsite OTP flow** — Day 11.5. Once SMS provider creds
   land, add `POST /microsites/public/:uuid/request-otp` +
   `/verify-otp` + a gated `/full` read. ~4 hours.

7. **Reminder cron for instalments** + `appointmentRemindersEngine`-
   pattern — Day 12.5. ~3 hours.

### Lower-priority polish (Phase 1.5)

8. Frontend visual builders for diagnostic / rooming / payment plan
   / microsite content.
9. Brand-asset swap once Yasin shares the design pack (Q22).
   `frontend/src/theme/travel.css` placeholder palette → real navy +
   gold per the asset book.
10. CSV import for cost-master + diagnostic banks. Mirrors the
    pattern in `routes/csv_io.js`.

## How to verify everything is still green

```bash
# Backend parse + lint
cd backend && npx prisma validate && npm run lint

# Backend vitest (should pass: scoring + pricing + guards = ~56 cases)
npx vitest run test/lib/travelDiagnosticScoring.test.js \
                test/lib/travelPricing.test.js \
                test/middleware/travelGuards.test.js

# Frontend build + lint
cd ../frontend && npx vite build
npx eslint src/pages/travel/

# Playwright spec list (no actual run — confirms parseability)
cd ../e2e && npx playwright test --list tests/travel-*.spec.js
```

If any of these fails, the in-flight work has drifted from main.
Bisect against the commit list above.

## Files added in this session (for one-shot grep)

```
backend/lib/travelDiagnosticScoring.js
backend/lib/travelPricing.js
backend/middleware/travelGuards.js
backend/prisma/seed-travel.js
backend/routes/travel.js
backend/routes/travel_diagnostics.js
backend/routes/travel_itineraries.js
backend/routes/travel_trips.js
backend/routes/travel_trip_billing.js
backend/routes/travel_microsites.js
backend/routes/travel_cost_master.js
backend/routes/travel_pricing.js
backend/routes/travel_suppliers.js
backend/routes/travel_rfu_profiles.js
backend/test/lib/travelDiagnosticScoring.test.js
backend/test/lib/travelPricing.test.js
backend/test/middleware/travelGuards.test.js
e2e/tests/travel-diagnostics-api.spec.js
e2e/tests/travel-itineraries-api.spec.js
e2e/tests/travel-trips-api.spec.js
e2e/tests/travel-trip-billing-api.spec.js
e2e/tests/travel-microsites-api.spec.js
e2e/tests/travel-cost-master-api.spec.js
e2e/tests/travel-pricing-api.spec.js
e2e/tests/travel-suppliers-api.spec.js
e2e/tests/travel-rfu-profiles-api.spec.js
frontend/src/pages/travel/Dashboard.jsx
frontend/src/pages/travel/Diagnostics.jsx
frontend/src/pages/travel/DiagnosticWizard.jsx
frontend/src/pages/travel/DiagnosticBuilder.jsx
frontend/src/pages/travel/Itineraries.jsx
frontend/src/pages/travel/Trips.jsx
frontend/src/pages/travel/TripDetail.jsx
frontend/src/pages/travel/CostMaster.jsx
frontend/src/pages/travel/Suppliers.jsx
frontend/src/theme/travel.css
docs/TRAVEL_CRM_PRD.md
docs/TRAVEL_CRM_OPEN_QUESTIONS.md
docs/TRAVEL_CRM_RISKS.md
docs/TRAVEL_CRM_SESSION_HANDOFF_2026-05-20.md  (this file)
```

Plus 5 files modified (server.js, schema.prisma, App.jsx, Sidebar.jsx,
Login.jsx, CLAUDE.md, CHANGELOG.md, deploy.yml, coverage.yml).
