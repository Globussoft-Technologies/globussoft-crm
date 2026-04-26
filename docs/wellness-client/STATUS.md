# Enhanced Wellness — Build Status

**Companion to:** [PRD.md](PRD.md), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), [EXTERNAL_API.md](EXTERNAL_API.md)
**Last updated:** 2026-04-26
**Live at:** https://crm.globusdemos.com
**Tenant:** `enhanced-wellness` (id 2, vertical `wellness`)
**Production HEAD:** `3e6e8292`

---

## TL;DR

The Enhanced Wellness tenant is **live and demo-ready**. Built as a configuration on the existing multi-tenant CRM (no fork). Rishu can log in, see his clinic's morning dashboard, click into any of 50 patients, write a prescription, capture a consent on a tablet, scan 106 services across every Dr. Haror's category, review 3 AI agent recommendations, and bounce out to AdsGPT or Callified.ai via single-click sidebar links.

---

## How to demo it

**Open:** https://crm.globusdemos.com/login

**Click any of these one-click buttons** (no typing required — they auto-submit and route to the right dashboard):

| Button | Email | Role | Lands on |
|---|---|---|---|
| Owner (Rishu) | `rishu@enhancedwellness.in` | ADMIN | `/wellness` |
| Demo Admin | `admin@wellness.demo` | ADMIN | `/wellness` |
| Demo User | `user@wellness.demo` | USER | `/wellness` |
| Generic CRM Admin | `admin@globussoft.com` | ADMIN | `/dashboard` (full sidebar) |
| Generic CRM Manager | `manager@crm.com` | MANAGER | `/dashboard` |
| Generic CRM User | `user@crm.com` | USER | `/dashboard` |

All passwords: `password123`

**Suggested 5-minute walkthrough as Rishu:**

1. **Owner Dashboard** — "16 visits today, ₹1.92L expected, 11% occupancy. That 11% is your real number from the call — same pain we're going to fix."
2. **Recommendations** — "Three things the agent thinks you should do today. Approve the hair-transplant boost — done, campaign queued."
3. **Patients → click any patient** — "Full case history. Click 'Capture consent' — the patient signs on the tablet, PDF saved. Click 'Write prescription' — fill it out, sent on WhatsApp."
4. **Service Catalog** — "All 106 services from your Dr. Haror's franchise. Each tagged with target marketing radius — salon 3 km, aesthetics 30 km, transplants 200 km."
5. **AdsGPT** in sidebar → opens adsgpt.io. **Callified** in sidebar → opens callified.ai. "These two are separate Globussoft products that will silently auto-provision your account tomorrow with each team."
6. **Locations (admin)** — "Today: just Ranchi. When you franchise to Delhi or Pune, add a row here and the dashboard rolls up per-clinic."

---

## What's live

### Infrastructure
- Same production server `163.227.174.141` and `crm.globusdemos.com` URL — zero new ops
- PM2 process `globussoft-crm-backend` carries the new wellness routes
- MySQL `gbscrm` database carries the new wellness tables
- Frontend served from `/var/www/crm.globusdemos.com/`

### Database (9 new Prisma models, 2 new fields on existing models)

| Model | Purpose |
|---|---|
| `Patient` | Demographics + medical fields (DOB, gender, blood group, allergies, photo). Optional `contactId` link back to CRM Contact. `locationId` for primary clinic. |
| `Visit` | Clinical encounter. status (booked → arrived → in-treatment → completed → no-show → cancelled), vitals JSON, notes, before/after photos, amountCharged. Links to patient/doctor/service/treatmentPlan/location. |
| `Prescription` | Drugs JSON array, instructions, optional PDF URL. Tied to a Visit. |
| `ConsentForm` | Template name (hair-transplant, botox-fillers, …), signed PDF URL, signature SVG/dataURL. Tied to a Patient + optional Service. |
| `TreatmentPlan` | Multi-session package (PRP 6-session, Laser 8-session, …). Tracks completedSessions vs totalSessions, nextDueAt. |
| `Service` | Catalog row: category, ticketTier (low/medium/high), basePrice, durationMin, **targetRadiusKm**, description. |
| `ServiceConsumption` | Inventory drawn down per visit (productName, qty, unitCost). |
| `AgentRecommendation` | Orchestrator-generated proposal cards. type, title, body, priority, status (pending/approved/rejected/snoozed), expectedImpact. |
| `Location` | Multi-clinic support: name, address, city/state/pincode, phone, lat/long, hours JSON, isActive. |
| `Tenant.vertical` | `generic` (default) or `wellness` — drives sidebar layout + landing route. |
| `User.wellnessRole` | Soft-role flag: `doctor` / `professional` / `telecaller` / `helper`. Orthogonal to existing RBAC role. |

All tables include `tenantId` + composite indexes for per-tenant queries.

### Backend routes — `/api/wellness/*`

Single file: [`backend/routes/wellness.js`](../../backend/routes/wellness.js)

| Endpoint | Purpose |
|---|---|
| GET/POST/PUT `/patients` | CRUD with search (name/phone/email) |
| GET `/patients/:id` | Detail + visits + prescriptions + consents + treatment plans |
| GET/POST/PUT `/visits` | List + filter (patient/doctor/status/date) + create/update |
| GET/POST `/prescriptions` | Per visit, drugs JSON |
| GET/POST `/consents` | Signature capture (SVG/dataURL stored) |
| GET/POST `/treatments` | Multi-session plan tracking |
| GET/POST/PUT `/services` | Service catalog management |
| GET `/recommendations` | Filter by status (pending/approved/rejected/all) |
| POST `/recommendations/:id/approve` and `/reject` | Action with audit |
| GET/POST/PUT `/locations` | Multi-clinic CRUD |
| GET `/dashboard?locationId=` | Owner dashboard aggregation: today/yesterday snapshots, 30-day revenue trend, pending approvals, occupancy % |

### Frontend pages

All under [`frontend/src/pages/wellness/`](../../frontend/src/pages/wellness/), React.lazy-loaded.

| Page | Route | Notes |
|---|---|---|
| Owner Dashboard | `/wellness` | Today snapshot, yesterday actuals, top recommendation, 30-day Recharts trend, quick links |
| Recommendations | `/wellness/recommendations` | Inbox of agent cards with Approve/Reject buttons + status filter |
| Patients | `/wellness/patients` | Search, add new patient, table view |
| Patient Detail | `/wellness/patients/:id` | 5 tabs: Case History timeline, New Prescription pad, Capture Consent (signature canvas), Treatment Plans, Log Visit |
| Service Catalog | `/wellness/services` | 106-card grid by tier, add new |
| Locations (admin) | `/wellness/locations` | Multi-clinic CRUD, activate/deactivate |

### Tenant-aware sidebar

- `tenant.vertical === 'wellness'` triggers a slim, clinic-focused layout
- Sections: **Daily Essentials** (Dashboard, Recommendations, AdsGPT↗, Callified↗) → **Clinical** (Patients, Services, Calendar, Booking, E-Signatures) → **Leads & Revenue** → **Finance** → **Marketing** → **Reports** → **Admin**
- Hides modules that don't apply to clinics: Pipeline, Deal Insights, Tickets, CPQ, Doc Templates, Live Chat, Chatbots, Web Visitors (B2B), etc.
- Brand label uses `tenant.name` so it reads "Enhanced Wellness" instead of "Globussoft"
- Generic tenants see the existing full sidebar unchanged

### External product links

Both env-overridable, both opening in new tabs with an external-link icon:

| Link | URL | What it is |
|---|---|---|
| AdsGPT | https://adsgpt.io (`VITE_ADSGPT_URL`) | Sister Globussoft product for ad creation. Visible to all roles in both generic + wellness sidebars. |
| Callified | https://callified.ai (`VITE_CALLIFIED_URL`) | Sister Globussoft product for voice + WhatsApp. Replaces all CRM voice/WhatsApp/chatbot work. |

### External Partner API (v1) — `/api/v1/external/*`

Built so **Callified.ai** and **Globus Phone** can drive the lead-to-call-to-recording flow:

```
Website → POST /leads → CRM stores
Callified → GET /leads?since=… → AI auto-dials
Callified → POST /calls (with recordingUrl) → CRM user plays back inline
```

- **Auth:** `X-API-Key: glbs_…` per request, scoped to a tenant
- **Endpoints:** `/health`, `/me`, `/leads`, `/contacts/lookup`, `/contacts/:id`, `/patients/lookup`, `/patients/:id`, `/calls`, `/messages`, `/services`, `/staff`, `/locations`, `/appointments`
- **Demo keys (seeded automatically):** "Callified.ai (demo key)" and "Globus Phone (demo key)" — printed at end of `node prisma/seed-wellness.js` output
- **Partner reference:** [EXTERNAL_API.md](EXTERNAL_API.md) with cURL quickstart
- Smoke-tested end-to-end: lead push → poll → contact lookup → call recording back, all working on production

### Auth response shape

`/api/auth/login`, `/api/auth/me`, `/api/auth/2fa/verify`, `/api/auth/register`, `/api/auth/signup` all now include `tenant.vertical` in the response so the frontend can route to the right landing page and render the right sidebar.

### Demo data (seeded by `node prisma/seed-wellness.js`, idempotent)

| Entity | Count | Notes |
|---|---|---|
| Tenant | 1 | "Enhanced Wellness", vertical `wellness`, plan `professional` |
| Locations | 1 | Ranchi (The Ikon, Tagore Hill Road, Morabadi 834008, +91 9637866666) |
| Staff | 22 | Demo Admin + Demo User + Rishu + 3 doctors + Manager + Telecaller + 12 professionals + 2 helpers |
| Services | 106 | Across 18 categories — full Dr. Haror's catalog mirror (see breakdown below) |
| Patients | 50 | Indian names, weighted source distribution (~60% Meta, ~20% Google, rest mixed) |
| Visits | 208 | 161 historical (last 90 days) + 16 today (mix of completed/in-treatment/booked) + 19 yesterday (all completed) + 12 tomorrow (booked). Service-specific notes. |
| Treatment plans | 10 | Active multi-session bundles |
| Prescriptions | 10 | Realistic minoxidil/finasteride combos |
| Consent forms | 5 | Hair-transplant, botox-fillers, general |
| Leads | 35 | Active, last 3 days, Meta-weighted sources |
| Agent recommendations | 3 | Hand-crafted: Boost hair transplant campaign, Tomorrow's slim-room utilisation, 12 hot leads aging |

### Service catalog breakdown (from drharorswellness.com)

| Category | Count | Sample |
|---|---|---|
| hair-transplant | 12 | Ultra Receptive, Unshaven FUE, Bio FUE, DHI, Robotic, Beard, Eyebrow, Giga Session, Failed Repair |
| anti-ageing | 12 | Botox, Cheek/Lip/Dermal fillers, Thread Lift, HIFU, Ulthera, RF, PDRN, Vampire Facelift |
| hair-restoration | 11 | QR 678, GFC, PRP, Mesogrow, Exosomes, Keravive, Scalp Micropigmentation, LLLT, Stem Cell |
| body-contouring | 10 | Liposuction, CoolSculpting, Cavitation, Cellulite, Gynecomastia, Blepharoplasty, Ozempic, Mounjaro |
| skin (diagnostic) | 8 | Consultation, Acne, Eczema, Vitiligo, Melasma, Psoriasis, PCOD |
| pigmentation | 7 | Cosmelan, Vampire, HydraFacial Basic/Elite, Skin Boosters, Profhillo |
| medifacial | 7 | Korean Glass, Diamond Polishing, Oxy, Power Glow, 7D Lift, IV Glow Drip |
| laser-hair | 6 | Full body, face, underarms, bikini, arms, legs |
| skin-surgery | 6 | Subcision, Mole/Tag/Cyst removal, Earlobe repair, Wart/DPN |
| acne | 6 | Peels, Carbon, Chemical, Dermaroller, Fractional CO2, RF microneedling |
| under-eye | 4 | Dark Circles, Fillers, Tear Trough, Boosters |
| hair-concern | 4 | Hair-loss consult, Alopecia Areata, Dandruff, Premature Greying |
| laser-skin | 3 | Tattoo, Birthmark, Mole |
| salon | 3 | Haircut, Hair Color |
| ayurveda | 2 | Consultation, Shirodhara |
| (legacy) | 7 | Holdovers from initial seed; not actively used |

Each service carries `category`, `ticketTier` (low/medium/high), realistic Indian-market `basePrice`, `durationMin`, and **`targetRadiusKm`** (3 km salon / 30 km aesthetics / 50–100 km specialty / 200 km hair-transplant + body-contouring) so the future campaign engine can target right-sized audiences.

### Compliance & security (added in v3.2 / v3.2.1)

- **Field-level encryption** on patient PII — AES-256-GCM on `Patient.allergies`, `Visit.notes`, `Prescription.*`, `ConsentForm.signatureSvg`. Transparent decrypt-on-read via Prisma `$extends`; opt-in per environment via `WELLNESS_FIELD_KEY`. One-shot backfill at `scripts/encrypt-existing-pii.js`. Decryption is recursive across nested relations as of v3.2.1 (#224).
- **JWT revocation** (v3.2.1) — `RevokedToken` model + `jti` minted on every login. New endpoints: `POST /auth/logout`, `GET /auth/sessions`, `DELETE /auth/sessions/:jti`. Verify checks the table on every request (fail-open on DB error).
- **wellnessRole RBAC gates** (v3.2.1) — orthogonal `verifyWellnessRole(allowed)` middleware. JWT carries the `wellnessRole` claim. 18 backend endpoints gated (Owner Dashboard, reports, recommendation approve/reject/edit, service catalog POST/PUT, location POST/PUT, prescription POST/PUT, consent POST/PUT, telecaller queue + dispose). Frontend: login redirects by wellnessRole; OwnerDashboard render-time guard; sidebar hides management modules from clinical staff. **20/20 RBAC e2e tests pass live.**
- **Clinical no-delete policy** (v3.2.1, #21) — Patient, Visit, Prescription, ConsentForm, AgentRecommendation, ServiceConsumption are PERMANENT. No DELETE endpoints, no `deletedAt`, no soft-delete. Corrections via PUT/PATCH (amendment trail in audit log). Compliance basis: HIPAA 164.312(c)(1), India MoHFW EMR Standards 2016, DPDP Act 2023.
- **Audit log on patient writes** (v3.2.1, #179) — POST/PUT on Patient, Visit, Prescription, ConsentForm, recommendations, loyalty all write audit rows. PII recorded as `piiFieldsTouched: [...]` name list only — no raw values.
- **Wellness retention enforcement** — DPDP-aligned: anonymise inactive 24mo+ patients, hard-delete consent forms >7yr, purge old call logs.

### Telehealth (v3.2)

- Jitsi-based video consult tab on Patient Detail. Room name auto-stored on `Visit.videoRoom`.

### Loyalty + referrals (v3.2 / v3.2.1)

- `LoyaltyTransaction` + `Referral` Prisma models. Manager UI at `/wellness/loyalty`.
- Auto-link referrals when referred patient signs up via `source = "referral"`.
- **Auto-credit on visit completion** (v3.2.1) — POST/PUT visits with status='completed' auto-credit 10% of `amountCharged`; idempotent via `LoyaltyTransaction` lookup.

### White-label branding (v3.2)

- `Tenant.logoUrl` + `Tenant.brandColor` — uploadable via Settings → Branding.
- Logo + accent applied to Sidebar header, Owner Dashboard, email templates, invoice PDFs.

### AdsGPT impersonation (v3.2.1)

- Real SSO launcher wired into wellness dashboard + sidebar. Owner clicks → silently lands in AdsGPT as the right user. "Back to CRM" link from AdsGPT side still pending with their team (see Deferred).

### Reliability & test infrastructure (v3.2.2)

These don't change anything Rishu sees on screen, but they harden the demo around the edges and let us measure how much of the codebase is actually exercised.

- **Backend line coverage baseline measured for the first time: 33.20%** (10,858 / 32,700 lines) via `c8` against the wellness-only spec set. This is the floor we ratchet up from each release. CI gate set at 50% to start, critical-path floor at 70% (`routes/auth.js`, `routes/external.js`, `routes/billing.js`, `routes/wellness.js`, all `middleware/*`, all `lib/*`). The full 121-spec suite under coverage is queued for the next pass.
- **DISABLE_CRONS=1 sandbox switch** on `server.js` — lets us spin up a side-by-side coverage-instrumented Express instance on a different port without the cron jobs from the primary process firing twice. Used by the c8 measurement workflow (see PRODUCTION_RUNBOOK §5b).
- **Graceful SIGTERM/SIGINT shutdown** — `server.js` now flushes V8 coverage data on shutdown so `c8` can write its `.c8tmp/coverage-*.json` artefacts. Without this, killing the process hard meant losing the coverage data.
- **Form autosave hook** (`useFormAutosave`) — wraps any controlled wellness form (New Prescription, Log Visit, Treatment Plan first; opt-in for the rest). Rehydrates from sessionStorage on mount, debounced persist on every keystroke, `beforeunload` warning if dirty, "Restored from previous session" banner the user can keep or discard. A browser refresh mid-prescription no longer silently nukes 5 minutes of typing.

---

## What's deferred (waiting on partner teams)

The handshakes happen tomorrow with the AdsGPT and Callified.ai teams:

| Item | Owner | Status |
|---|---|---|
| AdsGPT silent SSO | AdsGPT team / CRM | **Partial** — impersonation launcher live in CRM (v3.2.1); "Back to CRM" link from AdsGPT side still pending |
| AdsGPT silent user provisioning at CRM signup | AdsGPT team | Pending API contract |
| Callified silent provisioning at CRM signup | Callified team | Pending API contract |
| Callified "Back to CRM" link | Callified team | Pending |
| Callified → CRM webhook for arriving WhatsApp/call leads | Callified team | Pending contract |

When their endpoints land, the only CRM-side work is calling the provision API on signup (small change in `routes/auth.js`).

---

## What's next (post-demo, when Rishu signs)

From the Implementation Plan, in priority order:

1. **Phase 4 — Orchestration agent (real engine)**
   - Today: 3 hand-crafted recommendation cards. Real engine: `backend/cron/orchestratorEngine.js` runs every morning at 7 AM, reads occupancy/leads/ad data, calls Gemini to draft proposals.
2. **Real AI calling agent integration** — once Callified ships their webhook, lead-arrival auto-creates a Lead row in CRM.
3. **Migration scripts** — Superphone CSV → CRM contacts, Zylu CSV → CRM patients.
4. **Android app help** — Globussoft committed to help Rishu resubmit his existing rejected app to Play Store with Aadhaar/PAN docs.
5. **Field-level encryption** on `Patient.allergies`, `Visit.notes`, `Prescription.*` (PRD §5.6 PII compliance).
6. **Per-location dashboard rollup** — UI to switch between "all clinics" and one specific clinic. Backend already supports `?locationId=`.

---

## Commits (in this session, oldest → newest)

| SHA | Title |
|---|---|
| `6309d46` | feat(wellness): Enhanced Wellness vertical — first vertical tenant build |
| `835a493` | feat(wellness): add demo admin/user accounts for live walkthroughs |
| `9f14a72` | feat(wellness): seed today/yesterday/tomorrow appointments + service-specific notes |
| `899532d` | feat(login): one-click quick-login buttons grouped by tenant |
| `f13450d` | feat(wellness): Dr. Haror's full service catalog (80+ services) + multi-location support |
| `ab82241` | fix(seed): backfill locationId on existing patients + visits |
| `bdcc793` | docs(wellness): add STATUS.md |
| `4ccfc9d` | feat(api): external partner API v1 for Callified + Globus Phone |
| `ce6139a` | fix(external-api): mount /health before auth middleware |

---

## Files added/modified

```
backend/prisma/schema.prisma                                  9 new models + 2 new fields
backend/prisma/seed-wellness.js                                NEW — 597 lines
backend/routes/wellness.js                                     NEW — 631 lines (CRUD + dashboard)
backend/routes/auth.js                                         tenant.vertical in responses
backend/routes/auth_2fa.js                                     tenant.vertical in 2FA response
backend/server.js                                              mount /api/wellness
frontend/src/App.jsx                                           6 wellness routes + lazy imports
frontend/src/components/Sidebar.jsx                            tenant-aware split + ext links
frontend/src/pages/Login.jsx                                   quick-login buttons + wellness redirect
frontend/src/pages/wellness/OwnerDashboard.jsx                NEW
frontend/src/pages/wellness/Recommendations.jsx               NEW
frontend/src/pages/wellness/Patients.jsx                      NEW
frontend/src/pages/wellness/PatientDetail.jsx                 NEW (5 tabs incl. signature canvas)
frontend/src/pages/wellness/Services.jsx                      NEW
frontend/src/pages/wellness/Locations.jsx                     NEW
docs/wellness-client/PRD.md                                    NEW
docs/wellness-client/IMPLEMENTATION_PLAN.md                    NEW
docs/wellness-client/STATUS.md                                 NEW (this file)
```
