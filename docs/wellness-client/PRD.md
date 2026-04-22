# Enhanced Wellness CRM — Product Requirements Document

**Client:** Rishu, Enhanced Wellness (formerly Dr. Harush franchise), Ranchi
**Vendor:** Globussoft Technologies
**Source call:** Apr 15, 2026 — Discussion with Rishu (Sourav, Sumit, Kritica from Globussoft)
**Status:** v1 draft, demo overdue
**Owner:** Sumit (sumit@chingari.io)

---

## 1. Background

Enhanced Wellness is a hair / skin / aesthetics clinic in Ranchi. 17 staff: 3 doctors + 12 professionals (salon, slimming, Ayurveda) + 2 helpers. They are rebranding from a Dr. Harush franchise to their own brand.

Today they bleed money: clinic occupancy is **5–10%**, ad spend is ₹40–45k/month yielding ~100 leads/day with **90–95% junk rate**, and operations are stitched together across three disconnected tools:

| Tool | Used for |
|---|---|
| **Superphone** | Calling, call status tracking, AI calling agent |
| **Zylu** | WhatsApp Business API, chatbot, mini service-listing website |
| **Manual / paper** | Patient case history, prescriptions, consent forms, product consumption |

Rishu (the owner) runs other businesses and can spare **10 minutes to 1 hour per day** on this clinic. The current setup demands far more than that.

## 2. Problem statement

Rishu cannot grow the clinic because:

1. **Marketing is opaque.** The agency burns ₹45k/mo on Meta+Google with no visibility into which creatives work; recent Meta Andromeda algorithm changes broke their old targeting playbook.
2. **Lead quality is terrible.** ~100 leads/day, 90–95% junk. Even the few good ones leak between Superphone, Zylu, and paper.
3. **Operations are fragmented.** Three tools + paper means no single source of truth for a patient's journey from ad click → WhatsApp inquiry → call → consultation → treatment → follow-up.
4. **No goal-driven automation.** Rishu wants to wake up, see "today: 12 appointments confirmed, ₹1.4L expected revenue, here's the campaign tweak the agent recommends — approve?" Not log into 3 tools and stitch the picture together.
5. **Not franchise-ready.** Rishu wants to franchise this model. Today's stack can't be handed to a new operator.

## 3. Vision (Rishu's words)

> "Hum एक complete automation kind of thing चाह रहे हैं ... मेरा बाकी business जो vertical है, तो हम उसके चलते बहुत focus नहीं कर पाते इसमें ... no agent is capable of handling 100% of anything; that's why orchestration came — agents on top of agents, like employee → manager → boss."

**One login. AI agents that orchestrate ad creation, lead handling, patient ops, and reporting. Owner approves big decisions; everything else runs itself.**

## 4. Goals & non-goals

### Goals (this quarter)

| # | Goal | Success metric |
|---|---|---|
| G1 | Replace Superphone, Zylu, and paper with a single platform | All 17 staff log in to one URL; Superphone/Zylu cancelled within 60 days |
| G2 | Cut junk lead rate from 90–95% to under 50% | Measured weekly via lead source dashboard |
| G3 | Lift clinic occupancy from 5–10% to ≥30% in 90 days | Daily occupancy widget on owner dashboard |
| G4 | Owner spends ≤30 minutes/day in the system | Tracked via session duration |
| G5 | Make the stack franchise-ready | Second tenant can be provisioned in <1 hour |

### Non-goals (v1)

- Building a new ads platform from scratch — we wrap AdsGPT instead.
- Replacing Meta/Google as ad delivery channels — we manage them, not replace them.
- Insurance/billing integration with hospitals — out of scope.
- Native iOS app — Android only for now (Rishu's existing app is being resubmitted).
- Multilingual UI — English + Hindi mixed labels acceptable for v1; full i18n later.

## 5. Personas

| Persona | Role | Primary needs |
|---|---|---|
| **Rishu (Owner)** | Sees only outcomes: revenue, occupancy, campaign approvals. Spends <30 min/day. | Owner dashboard, agent recommendations, one-click approvals |
| **Clinic Manager** | Day-to-day ops, schedules, lead assignment, staff oversight | Live appointment board, lead inbox, staff workload view |
| **Doctor (3)** | Sees patient case history, writes prescriptions, marks treatment outcomes | Patient EMR, prescription pad, consent form capture |
| **Professional (12)** | Salon stylist, aesthetician, slimming therapist, Ayurveda practitioner — does the actual treatments | Daily appointment list, treatment log, product consumption entry |
| **Telecaller** | Calls inbound leads (currently via Superphone), confirms appointments | Lead queue with click-to-call, WhatsApp send, disposition codes |
| **Marketer (Globussoft-managed)** | External, runs Meta/Google campaigns via AdsGPT | Campaign console, creative generator, ROAS dashboard |

## 6. Functional requirements

### 6.1 Patient & clinical (replaces paper)

- **Patient record** — demographics, contact, source (which ad/campaign), assigned doctor, lifetime value
- **Case history** — chronological visits, vitals, photos (before/after), notes
- **Prescriptions** — doctor-authored, tied to a visit, printable, sent via WhatsApp
- **Consent forms** — service-specific templates (hair transplant, Botox, fillers); patient signs on tablet; PDF stored
- **Product consumption** — which inventory items used per treatment; auto-decrement stock
- **Treatment plans** — multi-session packages (e.g., 4-session hair PRP); track session N of M

### 6.2 Service catalog & geo-targeting

Each service has a **target radius** so marketing doesn't waste spend:
- Salon: 3 km from clinic
- Aesthetics (Botox/fillers/skin): all of Ranchi
- Hair transplant: all of Jharkhand state

Services also tagged by **ticket size** (high / medium / low) so the campaign engine can prioritize high-ROAS services.

### 6.3 Booking & appointments

- **Public booking page** per service, branded "Enhanced Wellness" (CRM)
- **WhatsApp chatbot booking flow** — lives in **Callified.ai**, not in the CRM. Confirmed appointments push back to the CRM via webhook (contract TBD with Callified team)
- **Calendar view** — by professional, by treatment room, by doctor (CRM)
- **Appointment statuses** — booked / confirmed / arrived / in-treatment / completed / no-show / cancelled (CRM)
- **Reminders** — SMS via existing CRM route; WhatsApp reminders sent by Callified
- **Walk-ins** — staff can add appointments without going through booking flow (CRM)

### 6.4 Lead management (replaces Superphone routing)

- **Lead capture** from: Meta lead form, Google form, WhatsApp inbound, public booking, walk-in, IndiaMART/JustDial
- **Auto-routing** by service interest → assigned to right professional or telecaller queue
- **Junk filter** — rules + AI: missing phone, foreign number, duplicate within 7 days, gibberish name, inappropriate radius for service
- **Disposition codes** — interested / not interested / call back / appointment booked / wrong number / junk
- **SLA timer** — first response in <5 min for high-ticket services

### 6.5 Communication — Callified.ai (separate product, cross-link only)

**Important scope clarification:** All voice + WhatsApp lives in **Callified.ai** (https://callified.ai), another Globussoft product. The CRM does **not** build calling, AI calling agent, WhatsApp Business API, chatbot flows, or WhatsApp inbox. Callified covers all of that.

What we build inside the CRM:

- **Sidebar link "Callified"** → opens https://callified.ai (shipped today)
- Tomorrow, with the Callified team: silent user provisioning at CRM signup + a "Back to CRM" link inside Callified
- Lead intake from Callified (when a WhatsApp/call lead arrives) lands in the CRM via webhook — contract to be defined with their team

What stays in the CRM:
- **SMS** for appointment reminders, OTPs (existing route)
- **Email** for campaigns, newsletters (existing route)

### 6.6 AdsGPT — separate product, cross-link only

**Important scope clarification (from owner):** AdsGPT is a **separate Globussoft product** (live at https://adsgpt.io, maintained by a different team). It is **for ad creation only**. There is **no data integration** between AdsGPT and the CRM. Leads still arrive in the CRM via the normal Meta/Google webhook paths.

What we build inside the CRM:

- **Sidebar link "AdsGPT"** → opens https://adsgpt.io in a new tab (shipped today)
- **Tomorrow, with the AdsGPT team:** silent user provisioning so a new CRM signup also has an AdsGPT account (user enters password once on AdsGPT first time), and a "Back to CRM" link inside AdsGPT
- The CRM does **not** show competitor ads, generate creatives, launch campaigns, or render ad performance dashboards. All of that lives in AdsGPT.

### 6.7 AI orchestration agent (the "boss" Rishu wants)

A goal-driven agent layered above all the above modules. Example flows:

- **Goal: 100% occupancy this week** → agent reads current bookings, computes gap, recommends ad budget per service, generates creatives via AdsGPT, drafts a campaign — surfaces a single proposal in the owner dashboard with **Approve / Reject** buttons.
- **Goal: maximize ROAS** → agent pauses underperforming creatives after the 7-day Facebook learning phase, reallocates budget to top-3 ads, alerts the marketer on anomalies.
- **Goal: zero missed leads** → agent watches lead inbox; if SLA timer elapses, escalates to manager and offers to send a holding WhatsApp from a template.

Implementation note: this is **not a chatbot**. It's a daily-firing cron + event-driven engine that posts proposals to a "Recommendations" inbox. Rishu acts on cards, not chats. (Chat interface can come later.)

### 6.8 Owner dashboard

Single page Rishu opens on his phone every morning:

- **Today's snapshot** — appointments, expected revenue, occupancy %, no-shows risk
- **Yesterday actuals** — sales, leads, conversion, ad spend, ROAS
- **Pending approvals** — campaign proposals, large refunds, staff issues
- **Trend strip** — 30-day occupancy, 30-day revenue, 30-day cost/lead

### 6.9 Reporting & franchise readiness

- **P&L per service** — revenue, ad spend, professional time cost, product cost, contribution margin
- **Per-professional dashboard** — appointments, revenue generated, satisfaction
- **Multi-tenant ready** — when Rishu franchises, each franchisee gets a tenant; he sees aggregated rollup

### 6.10 Mobile (Android)

- The existing Android app (currently rejected by Play Store) needs Globussoft assistance to resubmit with Aadhaar/PAN photos
- v1: app is a thin wrapper around the responsive web UI (already mobile-friendly)
- v2: native screens for owner dashboard + appointment list + click-to-call

## 7. Integrations

| System | Direction | Purpose | Status |
|---|---|---|---|
| **AdsGPT** (adsgpt.io) | Cross-link only (no data) | Sidebar link from CRM. Silent user provisioning + back-link tomorrow with AdsGPT team. | Link shipped; provisioning pending |
| **Callified.ai** (callified.ai) | Cross-link + future webhook | All voice + WhatsApp lives there. Sidebar link from CRM. Lead-arrival webhook + provisioning + back-link tomorrow with Callified team. | Link shipped; provisioning pending |
| **Meta Business API** | Outbound | Lead-form ingestion (campaign mgmt lives in AdsGPT) | Existing webhook |
| **Google Ads API** | Outbound | Lead-form ingestion (campaign mgmt lives in AdsGPT) | Existing webhook |
| ~~WhatsApp Business Cloud API~~ | ~~Bi-directional~~ | **Removed — handled by Callified.ai** | n/a |
| **MSG91 / Twilio** | Outbound | SMS reminders, OTP | Existing |
| ~~MyOperator / Knowlarity~~ | ~~Bi-directional~~ | **Removed — voice handled by Callified.ai** | n/a |
| **Superphone** | One-time export | Migrate historical lead/call data | New, manual one-shot |
| **Zylu** | One-time export | Migrate WhatsApp threads + booking history | New, manual one-shot |
| **Razorpay** | Outbound | Payment links for advance booking, packages | Existing |

## 8. Branding & UX

- Tenant name: **Enhanced Wellness**
- Logo: client to provide (placeholder = wordmark)
- Colors: clean, clinical — primary deep teal, accent gold (proposal; client to confirm)
- UI is glassmorphism (existing CRM design system) — keep
- All wellness modules use medical iconography (stethoscope, pill, calendar) instead of generic CRM icons

## 9. Data model additions

New Prisma models on top of the existing 99:

- `Patient` (extends Contact with medical fields — DOB, allergies, blood group, photo)
- `Visit` (clinical encounter — datetime, doctor, service, vitals, notes, photos[])
- `Prescription` (visit-linked, drug list, dosage, instructions)
- `ConsentForm` (template + signed PDF + signature image + timestamp)
- `TreatmentPlan` (multi-session: package, total sessions, completed, next due)
- `Service` (catalog: name, ticket-tier, target radius km, duration min, base price)
- `ServiceConsumption` (visit + product + qty — auto-decrements `Product.stock`)
- `AdsGptCampaign` (mirrored campaign state from AdsGPT)
- `AdsGptCreative` (generated creative metadata + asset URL)
- `AgentRecommendation` (proposals from the orchestration engine — type, payload, status)

Existing models reused: `Tenant`, `User`, `Contact`, `Lead`, `Deal`, `Pipeline`, `Appointment` (extend), `Task`, `Notification`, `Webhook`, `AuditLog`, `Invoice`, `Payment`, `Product`, `WhatsAppMessage`, `SmsMessage`, `CallLog`, `Campaign`, `Notification`.

## 10. Permissions

Role mapping for the wellness tenant:

- **ADMIN** = Rishu — sees everything, owner dashboard, approvals
- **MANAGER** = Clinic manager — ops, schedules, lead routing, no financial approvals
- **USER** = Doctors, professionals, telecallers — only their own queue/patients
- Plus a new soft-role flag on `User`: `wellnessRole = 'doctor' | 'professional' | 'telecaller' | 'helper'` (controls module visibility)

## 11. Security & compliance

- Patient data is **PII + medical** → field-level encryption on `Patient.allergies`, `Visit.notes`, `Prescription.*`, `ConsentForm.signedPdf`
- Audit log on every read of a patient record (already in `AuditLog`)
- Consent form retention — 7 years (configurable per tenant)
- DPDP Act 2023 (India) — explicit consent capture at first visit; data export/deletion on request (existing GDPR routes cover this)

## 12. Open questions for client

1. Who owns the brand assets (logo, color palette, photos for ads)?
2. Confirm AdsGPT API access — do they have an existing API or do we need to build a scraper/proxy?
3. Confirm hosting: continue on `crm.globusdemos.com` subpath, or vanity domain `app.enhancedwellness.in`?
4. Inventory — does the clinic already have a spreadsheet of products (creams, serums, kits)? We'll seed from it.
5. Existing Superphone + Zylu data — can they get us a CSV export, or do we start fresh?
6. Payment gateway preference — Razorpay vs Stripe vs Cashfree?
7. Android app — is the existing developer continuing, or do we take it over?

## 13. Pricing & commercials (from call)

- AdsGPT subscription: **$572/yr** (~₹50k) — Rishu approved
- Marketer managed services: **10% of ad spend** (~₹4–5k/mo at current spend) — Rishu approved
- CRM platform: TBD (separate commercial — flag for Sumit to scope)

## 14. Success criteria for the Apr-end demo

The 2–3 day demo Rishu was promised should show:
1. Logging into a single "Enhanced Wellness" tenant
2. A populated owner dashboard with realistic numbers
3. AdsGPT competitor view → "generate creative" → push to Meta (mocked OK if API not live)
4. WhatsApp chatbot booking flow ending in a real appointment
5. Doctor entering a prescription + capturing consent on a tablet
6. The orchestration agent surfacing one recommendation card

If those six work end-to-end, Rishu signs.
