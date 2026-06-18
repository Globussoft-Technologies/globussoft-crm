# Travel CRM — What's Still Pending (Plain English)

**Date:** 17 June 2026
**Who this is for:** Anyone (not just developers) who wants to understand what's left to do in the Travel system, why each thing is waiting, and what would unblock it.

This is the **easy-to-read companion** to the detailed engineering gap docs
(`TRAVEL_FINAL_GAP_ANALYSIS_2026-06-17.md`, `DECISIONS_TRACKER.md`,
`CREDS_TRACKER.md`, `MANUAL_CODING_BACKLOG.md`). Those have the code-level
detail; this one is the "explain it to me normally" version.

---

## First, the 3 reasons something is "pending"

Every unfinished item falls into one of three buckets. Throughout this doc each
item is tagged with one of these:

| Tag | Meaning | What it needs from you |
|-----|---------|------------------------|
| 🔨 **Build** | We can build it right now. Nothing is blocking us — it just needs developer time. | Nothing. Just say "go". |
| 🔑 **Waiting on a key** | The code is **already written and sitting ready**. It's "asleep" because we don't have a password / API key / login / logo yet. The day we get it, we flip a switch and it works. | A login, key, or file (usually from Yasin or a vendor). |
| 🧩 **Big project / decision** | Either a large multi-week build, or something where **someone has to decide how it should work** before we can start. | A decision, or a green-light for a long build. |

**The single most important takeaway:** most of the "missing" features are NOT
missing code. They are **finished features waiting for a key or a login.** A
handful of deliveries from you would light up dozens of features at once.

---

## The 3 deliveries that unlock the MOST (do these first)

If you only act on three things, make it these. Each one is a single handover
that switches on many already-built features:

### 1. 🔑 Brand pack (the "Q22" item) — unlocks ~45 things
**What it is:** For each of the 4 brands (TMC, RFU, Travel Stall, Visa Sure):
the logo files, the brand colours (the exact colour codes), and the fonts.
Plus simple PDF cover designs for trip plans and invoices.

**What it switches on:** Every brand-coloured screen, every branded PDF (trip
plans, invoices, reports), every branded email, the marketing flyers, and the
look-and-feel of each brand's customer portal. Right now everything shows in a
plain placeholder navy/gold because we have no real brand art.

**Who provides it:** Yasin.

### 2. 🔑 WhatsApp numbers (the "Q9" item) — unlocks ~15 things
**What it is:** The official WhatsApp Business accounts/numbers for TMC, RFU,
and Travel Stall (set up through the "Wati" provider).

**What it switches on:** Automatic WhatsApp messages to customers — booking
confirmations, payment reminders, journey/trip-day reminders, OTP codes,
boarding passes, post-trip feedback requests, and alerts to advisors. All of
these are already built and currently run in "pretend" mode (they log instead
of sending). The real numbers turn them live.

**Who provides it:** Yasin (via the Wati/WhatsApp partner).

### 3. 🔑 AI keys (the "Q11" item) — unlocks all the "smart" features
**What it is:** The API keys for the AI services (Google Gemini at minimum;
optionally Anthropic Claude and Perplexity).

**What it switches on:** AI-written sales talking points, visa summaries,
auto-generated trip suggestions, marketing flyer text, and the diagnostic
report write-ups. Today these run on canned/placeholder text. The keys make
them genuinely smart.

**Who provides it:** Yasin (sign up per provider, or let us do it for you).

---

## What's pending, area by area

### 🌍 The whole Travel system (shared by all brands)

- ✅ **Reminders now also show in the app, not just email** *(done 2026-06-17)*.
  The four reminder crons — packing countdown, pay-your-deposit, web check-in, and
  post-trip review — now also drop a notification into the customer's portal bell
  (each one deep-links straight to the relevant trip), in addition to the email.
  **SMS was intentionally dropped:** we don't collect a phone number at
  registration, so there's nothing to text. If SMS is wanted later, the only
  prerequisite is capturing a phone at sign-up.
- ✅ **Email-verification lock on sign-up is complete** *(done 2026-06-17)*. All
  three public sign-up screens — Signup, Get Started, and Customer Register — now
  require an emailed 6-digit code before an account is created (Get Started was
  the last one missing the step). Team invitations stay exempt (an admin manages
  their own team). **Chosen posture:** the UI enforces verification on every human
  sign-up path, so the backend `REQUIRE_EMAIL_OTP` hard-switch is left OFF on the
  server as optional defense-in-depth. Turn it on later only if you also want to
  block direct, scripted API account creation — which would first need ~4 e2e
  specs (auth-security, gdpr, portal-kyc, staff) updated to send a verified token.
- 🔑 **AI sales talking points & summaries** — built, asleep until the AI keys
  arrive (see "AI keys" above).

### 🎒 TMC — School trips

- 🔨 **School term calendar screen.** The system can store school term dates,
  but there's no page yet for staff to enter/see them. *(Small build.)*
- 🔑 **Aadhaar-based identity check for parents/teachers (DigiLocker).** A safe,
  legal way to verify identity without risky photo uploads. Built and waiting
  on the DigiLocker partner login (Q3) plus a lawyer's sign-off on the consent
  wording (Q2). *(Code ready; ~1 day to switch on.)*
- 🔑 **Google Meet booking slots** on the school booking page — waiting on a
  Google Workspace login (Q7). *(Small.)*
- 🔑 **Trip recommendation copy.** The wording that ties a school trip to what
  kids are studying needs the academic content from Yasin's team. *(Waiting on
  content.)*
- 🧩 **A few business questions** still need answers (e.g. how multi-board
  scoring works, report link expiry). *(Small, but needs a decision.)*

### 🕋 RFU — Umrah / religious trips

- 🔑 **Live hotel prices in Umrah quotes (RateHawk).** Show real, current hotel
  rates and auto-pick the cheapest. Needs the RateHawk account keys (Q19).
  *(Note: this one still needs to be coded after the keys arrive — ~3–5 days.)*
- 🔑 **Filter hotels by "facing the Haram", floor, room type.** Mostly built;
  small admin screen left, and it depends on the live hotel feed above.
- 🧩 **Cab transfers in Makkah/Madinah (Zikr Cabs).** Lets quotes include real
  cab prices and bookings. Partly stubbed; needs the Zikr vendor account and
  more building. *(Large + vendor onboarding.)*
- 🧩 **High-speed train (Haramain) pricing & booking.** Same shape as cabs —
  partly stubbed, needs the rail partner program. *(Large + vendor onboarding;
  the vendor can take weeks.)*
- 🧩 **Saudi hotel portals (Almosafer, Tajawal, and 3 others).** Pull live
  inventory from 5 Saudi sites. **This one is not built yet at all** and is a
  multi-week project, plus it needs vendor access or a legal review to scrape.
  *(Big project.)*

### 👨‍👩‍👧 Travel Stall — Family holidays

- 🧩 **Booking.com hotel search** — planned for a later phase; needs a
  Booking.com affiliate account (their side takes 2–4 weeks). Also flagged with
  a licensing question to resolve first. *(Big project, later phase.)*
- 🧩 **Expedia hotel search** — same idea, even later phase. *(Big project.)*

### 🛂 Visa Sure — Visa processing

- ✅ **Visa documents are now access-controlled** *(done 2026-06-17)*. Opening a
  passport/bank scan now goes through a **short-lived signed link (~5 min)** that
  is **access-checked first**: the owning customer can open their own docs in the
  portal, and staff can open them only if they're an **admin** or have **Visa Sure
  in their sub-brand access** (so e.g. a TMC-only staffer is blocked). Plain file
  URLs no longer work on their own. Files were already encrypted at rest by the
  storage — we did access-control instead of app-encryption so your admins keep
  full visibility. **One ops note to confirm:** the S3 bucket should be *private*
  (not public-read) so signed links are the only way in — the code already mints
  them; this is just a bucket setting to verify on the server.
- 🔨 **Use the customer's past visa rejections in risk scoring.** The data
  exists; we need to feed it in when the diagnostic is submitted. *(Small.)*
- 🔨 **Visa quote templates** → auto-fill a quote → turn into an itinerary.
  *(Medium.)*
- 🔨 **Add the "Reports" link** to the Visa Sure side menu (the report page
  exists, the menu link doesn't). *(Trivial.)*
- 🔨 **Email the visa diagnostic report** to the customer. *(Small.)*
- 🔨 **Data-retention rules** (auto-delete documents after the compliance
  period). *(Small.)*
- 🔑 **AI visa summary** — built, asleep until AI keys arrive.
- 🔑 **Visa-branded PDFs & theme** — waiting on the brand pack (Q22).
- 🧩 **Embassy rules / rejection-rate logic** — needs some product decisions on
  exactly how the rules should drive the checklist and risk score. *(Medium +
  decisions.)*

### 🧾 Billing, tax (GST) & suppliers

- 🔨 **Three more tax reports** (customer ledger, TDS, commission) — several GST
  reports already exist; these three are still to add. *(Medium.)*
- 🔨 **TCS Form 27EQ export** for the accountant. *(Small.)*
- 🔨 **Auto-create a purchase order when a booking is confirmed**, and hard-stop
  bookings that exceed a supplier's credit limit. *(Small.)*
- 🔨 **Supplier KYC screens** (the data model exists; the screens/handlers
  don't). *(Small.)*
- 🔨 **Invoice numbers reset on 1 April** (financial year), not 1 January.
  *(Small.)*
- 🔑 **Each brand's GST number + LUT details** need to be supplied before tax
  invoices are fully correct. *(Waiting on Yasin.)*
- 🔑 **Auto-check a customer's GST number** against the government database —
  needs a validation vendor key. *(Small build after key.)*
- 🔑 **Export to the existing "Excel Software" accounting system** — needs that
  vendor's file/API spec. *(Not built yet; waiting on docs.)*
- 🧩 **Who edits tax rates?** Decide whether rates stay fixed in code or get an
  admin screen. *(Needs a decision.)*

### 📥 Leads & marketing

- 🔨 **Settings screen for lead capture** (the back-end works; the screen to
  configure it is missing). *(Medium.)*
- 🔨 **Route leads by channel and brand** (e.g. WhatsApp-TMC leads to the TMC
  team). The generic routing works; the channel/brand-specific part doesn't.
  *(Medium.)*
- 🔨 **Group the shared inbox by channel.** *(Small.)*
- 🧩 **Marketing flyer designer** (drag-and-drop poster maker) — a large build,
  and it needs a decision on whether to build it ourselves or use a ready-made
  editor. *(Big project.)*
- 🔑 **AI flyer text & images, and "share to WhatsApp"** — waiting on AI keys
  (Q11), an image-AI key, a storage account for uploads, and WhatsApp (Q9).
- 🔑 **Real ad-spend dashboard** (Instagram/Facebook/Google) — waiting on the
  "AdsGPT" account from Yasin.
- 🔑 **AI phone-call lead qualification** (auto-calls and scores leads) —
  waiting on the "Callified.ai" account from Yasin.

### 👤 Customer portal (what customers log into)

- ✅ *Already shipped today:* in-app notifications with a bell, deep-linking to
  the exact trip, and a status filter + location search on "My Bookings".
- 🔑 **Brand theming per sub-brand** — waiting on the brand pack (Q22).
- 🔨 **Portal usage analytics.** *(Small.)*
- 🧩 **Multiple travellers per booking** — needs a small clarification on how
  you want it to work. *(Medium.)*

### 🔒 Security (behind the scenes — affects all brands)

These are important but mostly invisible to customers. Several need a design
decision before we start because they touch the whole system:

- 🧩 **Use safer login storage (cookies instead of browser storage).** *(Needs a
  decision on the approach; medium-large.)*
- 🧩 **Hide internal ID numbers** so they can't be guessed or counted from the
  outside. *(Large, system-wide change.)*
- 🔨 **Tighten the content-security rules** in the browser. *(Medium, careful
  rollout.)*
- 🔨 **Trim personal info out of list/search results** so less data is exposed.
  *(Medium.)*

### 🏗️ Big future projects (multi-week, plan separately)

- 🧩 **B2B Agent Portal** — a whole portal for sub-agents/resellers (commissions,
  corporate accounts, approval chains). It's at 0% and needs 7 design decisions
  before it can start. *(~5–9 weeks once decided.)*
- 🧩 **Chrome flight-quote plugin** — a browser add-on that scrapes airline fares
  and pushes quotes back into the CRM. Separate project/repo. *(~3 weeks; needs a
  decision on scope.)*
- 🧩 **Automatic airline web check-in** — a robot that checks travellers in on
  IndiGo/Air India/Vistara/Emirates. *(~3 weeks; high upkeep; needs decisions.)*

---

## The honest summary

- **Decisions are basically done.** Almost every product/business question has
  been answered. The few "decision" items left are really about *big future
  projects* (B2B portal, security re-architecture) — not day-to-day work.
- **The biggest lever is deliveries, not coding.** A large share of "pending"
  features are finished and waiting for a **key, login, or logo** — mostly from
  Yasin. The brand pack, WhatsApp numbers, and AI keys alone unlock dozens.
- **There's a healthy pile of pure build work too** — small/medium screens and
  reports we can knock out without waiting on anyone (the 🔨 items above).
- **A few things are genuinely big** and should be scheduled as their own
  projects: the Saudi hotel integrations, the marketing flyer designer, the B2B
  agent portal, and the airline automation.

**Suggested order:** (1) chase the 3 big-unblock deliveries from Yasin, (2) let
the team clear the 🔨 build-now list in parallel, (3) schedule the big projects
once their decisions land.
