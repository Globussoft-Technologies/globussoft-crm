# Credentials & Assets Needed from Yasin

> **Authored 2026-06-14** from a fresh sweep of the travel-CRM tracker after the 2026-06-13 PRD-drain session.
> Code surface is **substantially built and stub-mode wired**; ~85 gap items collectively unblock on three credential clusters that only Yasin can resolve.
> **Cross-reference:** [docs/TRAVEL_GAP_CLOSURE_TRACKER.md](TRAVEL_GAP_CLOSURE_TRACKER.md) §4 (cred-blocked items, full per-item swap effort).

---

## TL;DR for Yasin

Three credential drops would unblock approximately **~75 of the 154 remaining gap items** across the 15 travel PRDs. Listed in order of blast radius:

| # | Cred | Unblocks | Engineering work to flip |
|---|---|---|---|
| 1 | **Q22 — Brand pack** (logos / palettes / fonts / PDF covers, all 4 sub-brands) | ~33 Branding FRs + 4 Visa Sure brand-variant FRs + 6 Flyer brand-kit FRs + per-sub-brand PDF templates in Billing = **~45 FRs across 4 PRDs** | ~2-3 days swap once assets land — all consumer surfaces (PDF, email, portal, embed, microsite, sidebar) are pre-wired by the in-flight Wave-4 Branding agents |
| 2 | **Q9 — Wati WhatsApp Business** (3 WABA IDs + Meta System User token) | ~15 stubbed consumers: 7 cron engines (journey reminders, payment reminders, religious guidance, post-trip feedback, advisor alerts, milestone reminders, web check-in scheduler) + 3 endpoints (diagnostic PDF send, OTP delivery, boarding pass) + Quote-builder customer send + Visa Sure advisor priority alert + Flyer WA share | ~1-2 days swap once creds land — `services/watiClient.js` is fully written in stub mode; flips on env-var present |
| 3 | **Q11 — LLM API keys** (Perplexity + Gemini; optionally Claude + GPT) | All AI surfaces flip to real mode: talking-points generation, form-vs-call comparison, visa-summary brief, flyer copy, itinerary-suggest, marketing-image gen (DALL-E or Stability via Q-MF-2), AI-suggested flyer layouts | ~1 day swap once keys land |

Plus 11 smaller cred chases listed in §6 below — most are 0.5-1 day swap each.

---

## 1. Q22 — Brand pack (HIGHEST blast radius)

### What we need

For each of the 4 sub-brands (**TMC** — school trips · **RFU** — Umrah · **Travel Stall** — family holidays · **Visa Sure** — visa consultation), provide:

#### 1.1 Logos (5 variants each, 20 files total)

- Primary logo (vector SVG preferred, OR PNG @ 1200×400 transparent)
- Dark-mode variant (white/light version for dark backgrounds)
- Favicon (32×32 PNG OR ICO)
- Wordmark (text-only, vector SVG OR PNG)
- Hero / cover-art (3:2 aspect, used on PDF cover pages + microsite headers, ≥ 1800×1200)

#### 1.2 Color palette (6 colors per sub-brand)

Provide hex codes for:
- **Primary** — main brand colour (used in CTAs, header bands)
- **Secondary** — supporting palette colour
- **Accent** — highlight / chips
- **Background** — neutral surface
- **Text** — primary text colour on background
- **Success badge** (e.g. green for "Confirmed") + **Warning badge** (e.g. amber for "Pending") — semantic colours

CMYK equivalents also needed (for print) — comma-string format like `0,100,100,0` for cyan/magenta/yellow/key.

#### 1.3 Typography (3 font families per sub-brand)

- **Heading font** — used in PDF section titles, H1/H2 in microsite + portal
- **Body font** — used in long-form text on PDFs, emails, microsite
- **Code/monospace** (optional) — used in invoice line items + receipts

For each: font name + a public web-font URL (Google Fonts / Adobe Fonts / direct WOFF2 OK). If proprietary fonts, attach the WOFF2 file directly.

#### 1.4 Additional assets per sub-brand

- **Email signature template** — HTML snippet (signature for outbound emails)
- **Header image** — banner used at top of email templates (≥ 1200×300)
- **Footer text** — regulatory/copyright/contact block (HTML allowed)
- **Invoice stamp** — image overlay used on invoices (e.g. "PAID", "TRAVEL STALL — Confirmed Booking"), transparent PNG
- **Mission statement** — one-paragraph tagline used in portal/microsite/marketing flyer
- **Support email + support phone** — per-sub-brand customer-facing contacts
- **Social links** — Twitter/X, Instagram, Facebook, LinkedIn, YouTube URLs

### How to deliver

Either:
- (a) Zip drop to a shared Drive folder; share link with us, OR
- (b) Direct upload via the BrandKit admin page once Wave-4 ships — `/settings/brand-kits` will have Multer upload fields ready

### What flips when these land

- **Per-Sub-Brand Branding PRD**: 8% → ~80% shipped (rest is admin polish)
- **Visa Sure Phase 3**: brand variants on PDF reports + quotations + Visa Sure theme variant
- **Marketing Flyer**: brand-kit consumer in Studio, lock-to-brand mode, auto-apply-latest-kit
- **Billing**: per-sub-brand invoice PDF branding

### Reference contracts (per-sub-brand asset locations)

Once delivered, assets will land at these schema paths:
- `BrandKit.{logoUrl, logoDarkUrl, faviconUrl, wordmarkUrl, heroUrl}`
- `BrandKit.{primary, secondary, accent, bg, text, successBadge, warningBadge}`
- `BrandKit.{cmykPrimary, cmykSecondary, cmykAccent}`
- `BrandKit.{headingFont*, bodyFont*, codeFont*}`
- `BrandKit.{signatureTemplate, headerImageUrl, footerText, invoiceStampUrl}`
- `BrandKit.{tagline, missionStatement, supportEmail, supportPhone, socialLinksJson}`

---

## 2. Q9 — Wati WhatsApp Business (SECOND blast radius)

### What we need

We use [Wati](https://www.wati.io/) as the WhatsApp Business API provider (Meta-approved BSP). Per the multi-sub-brand-tenant decision (Q25), each sub-brand needs its own WABA number for sender trust + brand recognition:

#### 2.1 Three WABA setups (one per messaging sub-brand)

- **TMC** — School trip parents/teachers/students get messages from a `+91-…-TMC` (or similar) verified WABA number
- **RFU** — Umrah pilgrims get messages from a `+91-…-RFU` number
- **Travel Stall** — Family holiday customers get messages from `+91-…-TVS`

Visa Sure customers can share the Travel Stall WABA (low volume per consultation), OR get a 4th number if Travel Stall flags concern.

#### 2.2 For each WABA, provide:

- **WABA ID** (the 16-digit Meta-assigned business account identifier)
- **Phone Number ID** (per-number identifier within the WABA)
- **Access token** — Meta System User long-lived token with `whatsapp_business_messaging` + `whatsapp_business_management` scopes
- **Verified display name** (the customer-facing sender name shown above messages)

### How to deliver

Via the SupplierCredential vault that's already built (`/travel/suppliers/credentials` admin page):
- Category: `wa-config`
- Per-row: `subBrand` + `wabaId` + `phoneNumberId` + `accessToken` + `displayName`
- Or send via 1Password / Bitwarden share if you prefer not to paste into the admin UI

### What flips when these land (15 consumers)

**Cron engines (7):**
- `travelJourneyReminders.js` — pre-Umrah educational/spiritual reminders
- `travelMilestoneRemindersEngine.js` — visa milestones, payment milestones
- `tripPaymentReminders.js` — TMC instalment schedule
- `religiousGuidanceEngine.js` — daily Quranic verses during Umrah
- `tripPostTripFeedback.js` — NPS surveys 72h post-trip
- `travelDiagnosticAdvisorAlerts.js` — 30-min stall escalation to advisor
- `webCheckinScheduler.js` — T-24h boarding reminders

**Endpoints (3):**
- `routes/travel_diagnostics.js` — diagnostic PDF report → WhatsApp customer
- `routes/travel_microsites.js` — TripMicrositeOtp WhatsApp delivery
- `routes/travel_trips.js` — boarding pass WhatsApp delivery on trip confirm

**Other (5):**
- Quote Builder `POST /send-to-customer` (FR-3.7.1)
- Visa Sure advisor priority alerts (PRD §FR-3.3)
- Marketing Flyer WhatsApp-share button (PRD §FR-3.5.1)
- Multichannel intake webhook signature verification (FR-3.4.3)
- TMC parent/teacher OTP delivery for sensitive microsite tabs

---

## 3. Q11 — LLM API keys (THIRD blast radius)

### What we need

Real-mode keys for the LLM router. The codebase has a per-task routing layer (`backend/lib/llmRouter.js`) that maps task classes to specific models — we need the keys for ALL keyed tasks to flip from stub to real mode.

| Task | Model preferred | Required key |
|---|---|---|
| Talking-points (Job B sales brief) | Claude 3 Opus OR Sonnet 4 | `ANTHROPIC_API_KEY` |
| Form-vs-call comparison | Gemini 2.5 Pro (cheap) OR Claude 3 Sonnet | `GEMINI_API_KEY` OR `ANTHROPIC_API_KEY` |
| Visa-summary brief | Gemini 2.5 Pro | `GEMINI_API_KEY` |
| Itinerary-suggest (Job A blank-state) | Gemini 2.5 Pro | `GEMINI_API_KEY` |
| Flyer copy (Marketing Studio) | Gemini 2.5 Flash (cheapest) | `GEMINI_API_KEY` |
| Web research (RFU + TMC enrichment) | Perplexity Sonar Pro | `PERPLEXITY_API_KEY` |
| TMC diagnostic Job A readiness narrative | Claude 3 Opus | `ANTHROPIC_API_KEY` |
| TMC diagnostic Job B sales brief | Claude 3 Opus | `ANTHROPIC_API_KEY` |

### Minimum viable: 2 keys

If budget is a concern, the absolute minimum is:
- **Gemini API key** — flips form-vs-call + visa-summary + itinerary-suggest + flyer copy (4 tasks). Cheapest at Gemini 2.5 Flash pricing.
- **Anthropic API key** — flips both TMC LLM jobs + talking-points (3 tasks). Highest-quality outputs for advisor-facing briefs.

**Perplexity is optional** for now — only used by TMC web-research enrichment which works fine in stub mode.

### Budget caps (already enforced)

The codebase has per-tenant monthly spend caps in `lib/llmCostTracker.js`:
- Default: $50/month per tenant per provider
- Per-task max: $0.50/call ceiling
- When cap is hit, the router falls back to stub mode + alerts admin

You can adjust the caps via the `LlmSpend` admin page after first month's usage data.

### How to deliver

Same SupplierCredential vault:
- Category: `llm-key`
- Per-row: `provider` (`anthropic` / `gemini` / `perplexity`) + `apiKey`
- Or set as backend env vars: `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `PERPLEXITY_API_KEY`

### What flips when these land

Master TRAVEL_CRM_PRD §4.2 (Diagnostic engine — talking points + form-vs-call), §4.3 (Itinerary suggest), §4.8 (LLM-driven advisor handover) + Visa Sure §FR-3.3 LLM narrative + Marketing Flyer §FR-3.6 AI copy + Itinerary §FR-3.4 real-mode suggest. **All AI surfaces ship as live by end of the cred-drop deploy.**

---

## 4. Q3 — DigiLocker (pairs with Q2 Aadhaar consent counsel)

For TMC parent/teacher KYC. We need:

- **Client ID + Client Secret** from the [DigiLocker partner portal](https://partners.digilocker.gov.in/)
- **Redirect URI** registered: `https://crm.globusdemos.com/api/travel/passport/digilocker-callback`
- **Approved scopes**: `read_aadhaar`, `read_pan`, `read_passport`

Paired blocker: **Q2 Aadhaar consent legal copy** — Travel Stall counsel needs to sign off on the consent text. GS has drafted [docs/TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md). Once signed off, the 15-minute swap brings DigiLocker live.

---

## 5. Q19 — RateHawk (production keys)

For RFU lowest-rate auto-pick on hotel quotations. We need:

- **API Key + Account ID** from [RateHawk B2B](https://www.ratehawk.com/b2b)
- Production tier (test sandbox already wired in `services/ratehawkClient.js`)
- Volume tier — we expect ~500 quotation lookups/month initially

---

## 6. Smaller cred chases (0.5-2 day swap each)

| Q-marker | What | Owner action | Effort |
|---|---|---|---|
| **Q1 Callified.ai** | API key for AI-qualification call service ($100/month budget cap built-in) | Sign up at callified.ai → request API key → drop in SupplierCredential vault `category=ai-call` | 0.5d swap |
| **Q1 AdsGPT** | API key for marketing-report enrichment | Same vault `category=ads-research` | 0.5d swap |
| **Q1 Google Workspace** | Domain-wide delegation cred OR service-account JSON for `googleDriveClient.js` (auto-creates trip Drive folder on confirm) | Google Workspace admin console → create service account → grant Drive scope | 1d swap |
| **Q-MF-1 Storage** | S3 bucket + access key OR Cloudinary key for Flyer asset uploads | Create bucket OR Cloudinary acct → `category=storage` cred | 2d build (Multer pipeline) after cred |
| **Q-MF-2 Image gen** | OpenAI key (DALL-E) OR Stability AI key | Either provider → `category=image-gen` cred | 1d swap |
| **Q-GST-2** | GSTIN reverse-check vendor (e.g. Cleartax / Karza) | Vendor onboarding → API key in vault `category=gst-validate` | 1d swap |
| **Q-GST-3** | Per-sub-brand GSTINs (the GST numbers of TMC / RFU / TVS / Visa Sure legal entities) | Send the 15-character GSTINs; we populate `Tenant.subBrandConfigJson.<sub>.gstin` | 0.5d swap |
| **Q-GST-4** | LUT references per sub-brand (for export invoices without GST) | Send LUT ARN + validity-end dates per entity | 0.5d swap |
| **Q-BILL-1** | TCS non-filer flag source (e.g. compliance-vendor API for 20% rate detection) | Share vendor docs OR confirm we should default-to-1% | 1d build |
| **Q8 Excel Software** | API/CSV docs for the accounting platform Travel Stall currently uses | Send technical docs from vendor; we build the bridge | 3-5d build post-docs |
| **Q21 DNS + wildcard SSL** | DNS record for `*.tmc.travelstall.in` + wildcard cert | Travel Stall DNS / hosting team | ops |

---

## 7. RFU vendor onboardings (separate cluster, ~5-day window)

For the RFU Ground Services PRD (24 FRs, currently 0% shipped — all cred-blocked):

| Vendor | Service | Why we need it |
|---|---|---|
| **Q-RFU-1 Zikr Cabs** | Madinah/Makkah ground transfers | RFU §3.1 — 8 FRs flip on cred drop |
| **Q-RFU-2 Almosafer** | Saudi hotel inventory | RFU §3.2 hotel-scraper portal #1 |
| **Q-RFU-3 Tajawal** | Saudi hotel inventory | Portal #2 |
| **Q-RFU-4 MyHoliday2** | Saudi hotel inventory | Portal #3 |
| **Q-RFU-5 PilgrimsChoice** | Umrah package operator | Portal #4 |
| **Q-RFU-6 ReservationHouse** | Saudi hotel inventory | Portal #5 |
| **Q-RFU-7 HHR Haramain Rail** | Madinah↔Makkah high-speed rail | RFU §3.3 — 8 FRs flip on cred drop |

**Note:** Zikr Cabs + HHR have inert stub clients already (`services/zikrCabsClient.js`, `services/haramainRailClient.js`). The 5-portal Saudi hotel-scraper is NOT yet built — it's an 8-10 day build that starts when the first 2 vendor creds drop (parallel adapter pattern).

---

## 8. What we DON'T need from Yasin right now

For transparency, these items are pending other resolutions:

- **DD-5.* design calls for B2B Agent Portal** — entire 34-FR PRD waits on a 7-decision product call between GS and Travel Stall leadership. Yasin is not the unblocker here unless he's invited to that call.
- **Chrome flight-quote plugin + airline check-in automation** — both are Phase-1 contract commits sitting at 0% code; need a "decision to start" from GS/TS leadership (DC-1..DC-5), not creds.
- **PC-1..PC-5 visa-risk product calls** — embassy-data calibration; needs Travel Stall visa team input, not creds.

---

## 9. Recommended order

For maximum unblocking-per-day-of-Yasin-time:

1. **Q22 brand pack drop** — biggest blast radius, frees up 4 PRDs' worth of consumer wiring once shipped
2. **Q9 Wati creds** (3 WABAs) — completes the entire customer messaging story
3. **Q11 LLM keys** (Gemini + Anthropic at minimum) — flips all AI surfaces to real mode
4. **Q3 DigiLocker + Q2 consent sign-off** — completes TMC parent registration end-to-end
5. **Q-GST-3 + Q-GST-4** (per-sub-brand GSTINs + LUTs) — short emails, 30-second drops, completes GST compliance surface
6. **Q19 RateHawk** — RFU quote engine completion
7. **RFU vendor onboardings** (Q-RFU-1..7) — bigger commitment; can sequence over 2-3 weeks

Total: if Yasin can dedicate ~6-8 hours across 1-2 weeks to chasing items 1-5, the codebase moves from ~62% shipped → ~85% shipped across the 15 travel PRDs.

---

## 10. Status reference

This doc is a snapshot. Live status of each gap item is tracked at:
- [docs/TRAVEL_GAP_CLOSURE_TRACKER.md](TRAVEL_GAP_CLOSURE_TRACKER.md) — single source of truth
- Each travel PRD's top-block "Implementation Status" header

When a cred drops, find the relevant G-rows in the tracker §4, flip their markers, and ship.
