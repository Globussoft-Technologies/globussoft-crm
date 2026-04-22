# Enhanced Wellness — Implementation Plan

**Companion to:** [PRD.md](PRD.md)
**Approach:** Multi-tenant configuration on existing Globussoft CRM (no fork)
**Today:** 2026-04-22 — demo was promised in 2–3 days from Apr 15 call → already 1 week overdue

---

## Strategy

**Don't fork. Configure.** The existing CRM is already multi-tenant (99 Prisma models, `tenantId` on everything). We provision a new tenant `enhanced-wellness`, add wellness-specific Prisma models alongside the existing 99, gate wellness UI behind tenant feature flags, and ship.

Why:
- Pulling core fixes back stays trivial (one branch, one repo)
- Other future verticals (clinics, salons, gyms) can reuse the wellness modules
- Demo can go live on existing infra (`crm.globusdemos.com`) with zero new ops

What this means for code:
- New backend routes under `backend/routes/wellness/` (patient.js, visit.js, prescription.js, consent.js, treatment.js, adsgpt.js, orchestrator.js)
- New frontend pages under `frontend/src/pages/wellness/`
- New `wellnessRole` field on User model
- Tenant feature flags decide which sidebar items render (extends the RBAC sidebar from commit `8061b34`)

---

## Phase 0 — Foundation (Day 1, ~6 hours)

Goal: provision the tenant, set the data model, prove the demo can render under a wellness brand.

| Task | Files touched | Owner |
|---|---|---|
| Add `Patient`, `Visit`, `Prescription`, `ConsentForm`, `TreatmentPlan`, `Service`, `ServiceConsumption`, `AdsGptCampaign`, `AdsGptCreative`, `AgentRecommendation` to Prisma | `backend/prisma/schema.prisma` | Backend |
| Add `wellnessRole` enum + field to User; add `vertical` enum to Tenant (`generic` / `wellness` / future) | same | Backend |
| Migration + `prisma generate` + `prisma db push` | — | Backend |
| Seed an `enhanced-wellness` tenant + Rishu admin + 3 doctors + 12 professionals + 2 helpers + service catalog (hair transplant, Botox, fillers, haircut, slimming, Ayurveda) with target radius and ticket tier | `backend/prisma/seed-wellness.js` (new) | Backend |
| Tenant theme: brand name "Enhanced Wellness", deep-teal/gold palette, medical icon set on sidebar | `frontend/src/components/Sidebar.jsx`, theme CSS vars | Frontend |
| Feature-flag wrapper: only show wellness modules when `tenant.vertical === 'wellness'` | `frontend/src/App.jsx`, Sidebar | Frontend |

**Exit criteria:** Log in as Rishu, see a sidebar branded "Enhanced Wellness" with placeholder routes for Patients / Visits / Consent / AdsGPT / Recommendations.

---

## Phase 1 — Clinical core (Days 2–3, ~12 hours)

Goal: replace paper. Patients, visits, prescriptions, consent forms work end-to-end.

| Task | Notes |
|---|---|
| `routes/wellness/patient.js` — full CRUD, search by phone, dedupe with existing Contact | Extends Contact, doesn't duplicate |
| `routes/wellness/visit.js` — create visit, attach photos (multer → `/uploads/visits/`), notes, vitals | Photos stored locally; S3 later |
| `routes/wellness/prescription.js` — CRUD + render PDF (pdf-lib, existing in stack) + WhatsApp send | Use existing WhatsApp route to deliver |
| `routes/wellness/consent.js` — template list, render PDF on tablet, capture signature canvas, store signed PDF | Reuse signature canvas from existing E-Signatures module |
| `routes/wellness/treatment.js` — multi-session plans, track session N of M, surface "next due" in patient view | — |
| Frontend: `pages/wellness/Patients.jsx`, `PatientDetail.jsx` (case history timeline), `PrescriptionPad.jsx`, `ConsentCapture.jsx` | Reuse existing UI components |
| Frontend: doctor's daily list — today's appointments → click → enter visit | New `DoctorToday.jsx` |
| Field-level encryption on `Patient.allergies`, `Visit.notes`, `Prescription.*` | Use Prisma middleware + `crypto` |

**Exit criteria:** A doctor can pull up a patient, log a visit with photos, write a prescription, and have the patient sign a consent form on a tablet. PDF copies stored and viewable.

---

## Phase 2 — Booking, scheduling, lead routing (Days 4–5, ~12 hours)

Goal: replace Zylu mini-site + chatbot, replace Superphone routing.

| Task | Notes |
|---|---|
| Public booking page per service: `/book/:tenantSlug/:serviceSlug` | Extends existing BookingPages module |
| WhatsApp chatbot flow: greeting → service inquiry → slot picker → confirmation → human handoff | Use existing chatbots route + WhatsApp Cloud API |
| Calendar view by professional / room / doctor | Use react-big-calendar or extend existing Calendar page |
| Appointment lifecycle (booked → confirmed → arrived → in-treatment → completed → no-show / cancelled) with state machine | New status field on existing Appointment model |
| Reminders: WhatsApp + SMS at booking, 24h before, 1h before — drive via existing cron + scheduledEmail engine pattern | Reuse `backend/cron/scheduledEmailEngine.js` shape |
| Lead capture endpoints: Meta lead form webhook, Google form webhook, WhatsApp inbound, public booking, walk-in | Most exist; add wellness-specific normalization |
| Junk-lead filter: rules engine (missing phone, foreign number, dup within 7d, gibberish name, geo-mismatch for service) + Gemini fallback for ambiguous cases | New `backend/lib/leadJunkFilter.js` |
| Auto-route by service interest: hair transplant → senior doctor; salon → professional pool by skill | Extends existing `lead_routing.js` |
| Telecaller queue UI with click-to-call (existing softphone), disposition codes, SLA timer | New `pages/wellness/TelecallerQueue.jsx` |

**Exit criteria:** A lead lands from a Meta ad, junk filter catches the obvious junk, the rest gets routed to the right telecaller within 5 min, who can call and book in one screen.

---

## Phase 3 — External product cross-links (DONE today; handshakes tomorrow)

**Scope correction from owner:** Two sister Globussoft products are involved, both separate teams, both cross-link only:

- **AdsGPT** (https://adsgpt.io) — ad creation
- **Callified.ai** (https://callified.ai) — voice + WhatsApp (replaces all CRM voice/WhatsApp/chatbot work)

| Task | Status |
|---|---|
| Add "AdsGPT" + "Callified" links in CRM sidebar (env vars `VITE_ADSGPT_URL`, `VITE_CALLIFIED_URL`) | **Done** — `frontend/src/components/Sidebar.jsx` |
| Coordinate with AdsGPT + Callified teams: provision-on-signup APIs | **Tomorrow** |
| Coordinate with both teams: add "Back to CRM" link in their sidebars | **Tomorrow** |
| CRM signup hook → call both provisioning APIs | **Pending contracts** |
| Callified → CRM webhook for arriving WhatsApp/call leads | **Pending contract** |
| Strip voice/WhatsApp/chatbot routes from the wellness sidebar (avoid demo confusion) | Pending — Phase 6 below |

**Exit criteria for today:** Demo audience clicks "AdsGPT" or "Callified" in the sidebar, lands on the right product. Owner sees the whole suite feels like one stack.

---

## Phase 4 — Orchestration agent (Days 8–9, ~8 hours)

Goal: the "boss agent" Rishu wants. Daily-firing recommendations, not a chat.

| Task | Notes |
|---|---|
| `backend/cron/orchestratorEngine.js` — runs every morning at 7 AM tenant local time | Reuses node-cron pattern |
| Recommendation generator: reads occupancy goal, current bookings, ad performance, lead pipeline → uses Gemini to draft a proposal (e.g., "boost hair transplant campaign by ₹500/day, expected +3 bookings, ROAS 4.5x") | Gemini already in stack |
| `routes/wellness/orchestrator.js` — list recommendations, approve, reject, snooze | — |
| Frontend: "Recommendations" inbox card on owner dashboard with one-click Approve/Reject | — |
| On Approve: agent dispatches the action (campaign budget bump, creative push, staff reassignment) by calling the same internal APIs as a human | — |
| Audit log every recommendation + action | Existing AuditLog |

**Exit criteria:** Rishu opens the app at 9 AM, sees 1–3 recommendation cards, taps Approve on one, the campaign is updated, audit log records it.

---

## Phase 5 — Owner dashboard + reporting (Day 10, ~6 hours)

Goal: the page Rishu opens every morning.

| Task | Notes |
|---|---|
| `pages/wellness/OwnerDashboard.jsx` — today's snapshot, yesterday actuals, pending approvals, 30-day trends | Reuses existing dashboard widgets |
| Per-service P&L report (revenue – ad spend – product cost – labor cost) | Extends existing reports |
| Per-professional report (appointments, revenue generated, satisfaction) | Extends agent reports |
| Mobile-first layout — Rishu opens on his phone | Existing CSS already responsive; verify on actual device |

**Exit criteria:** Rishu's full picture is one scrollable page on his phone.

---

## Phase 6 — Demo prep + polish (Day 11, ~4 hours)

| Task |
|---|
| Seed realistic demo data — 50 patients, 200 visits over last 90 days, 30 active leads, 5 campaigns with realistic ROAS spread |
| Walkthrough script for the 6 demo points in PRD §14 |
| Record a Loom backup in case of live-demo wifi failure |
| Pre-stage 2–3 orchestrator recommendations so Rishu sees the wow moment immediately |

---

## Phase 7 — Migration + Android app (post-demo, Week 3)

Only after Rishu signs:

- Pull historical Superphone leads + call dispositions (CSV) → import script
- Pull Zylu WhatsApp threads + booking history (CSV) → import script
- Android app: help resubmit to Play Store with Aadhaar/PAN photos (Globussoft commitment from call); after approval, point the app at the new tenant URL

---

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **AdsGPT has no public API** | High | Confirm with vendor on Day 1; if no API, build Phase 3 as scraping + manual export/import; ship demo with mocked data |
| **Meta API access — clinic doesn't own a Business Manager** | Medium | Confirm with Rishu in next call; if needed, request access during demo prep |
| **WhatsApp Business Cloud API not yet provisioned for the new brand** | Medium | Apply for verification Day 1; takes 2–5 business days |
| **Patient PII compliance pushback** | Low | Field-level encryption + audit log + DPDP consent in Phase 1; document for Rishu |
| **Rishu wants a chatbot interface for the orchestrator, not cards** | Medium | Phase 4 ships cards; chat layer is a Phase 8 add-on if requested |
| **Demo slips again** | Already realized | Ship Phases 0–2 + a stubbed AdsGPT screen by Day 5; do the demo with that; fill in Phases 3–5 in week 2 |

---

## What I'd recommend cutting if we have to ship faster

If we need a demo in **3 days instead of 11**, ship only:

1. Phase 0 (tenant + brand)
2. Phase 1 abbreviated (Patient + Visit + Prescription only — skip ConsentForm canvas, skip TreatmentPlan)
3. Phase 5 owner dashboard with **mocked numbers**
4. AdsGPT screen as a **clickable mockup** (no real API)
5. Orchestrator with **2 hand-crafted recommendation cards** (no engine)

That's a credible "vision demo" Rishu can react to. Real engine work continues after he signs.

---

## Open decisions needed from client / internal before kicking off

1. **Codebase strategy** — confirm "configure on main" (recommended) vs fork
2. **AdsGPT API access** — does Globussoft have an account? Vendor docs?
3. **Brand assets** — logo, colors, photos — who provides?
4. **Hosting** — `crm.globusdemos.com/wellness` subpath or vanity domain?
5. **Demo deadline** — full 11-day plan or 3-day cut-down?
6. **Commercial scope** — what's Globussoft charging Rishu for the CRM platform? (Sumit to confirm)
