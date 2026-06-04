# Travel CRM (TMC + RFU) — Full API-Key & Credential Dependency List

**Treat this as a brand-new project.** Below is **every** external API key,
credential, and secret the build needs to run end-to-end — derived from the
TMC/RFU feature scope (build-split sheet, 1 June 2026) — each with the reason
we need it, and whether it is **already used in the existing Wellness product**
(so we know what's proven/reusable vs net-new to procure).

**Columns**

- **Why we need it** — the feature it unblocks + what breaks without it.
- **Used in Wellness today?** — ✅ already wired & proven in the Wellness vertical · ⚠️ similar capability exists but a _different vendor_ is used · ❌ net-new for Travel.
- **Who provides** — Client (Yasin / Travel Stall / Rishu) vs GlobusSoft (GS generates/owns).

> Meta/Facebook excluded as requested. (Note: the existing Wellness product talks
> to Meta's WhatsApp Cloud API directly; for Travel we use **Wati** as the BSP,
> which manages the Meta side — so we request Wati creds, not Meta keys.)

---

## 1. Communications

| Service / Key                                                     | Why we need it                                                                                                                               | Used in Wellness today?                                                              | Who provides         | Env var(s)                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------- | --------------------------------------------------------------------- |
| **Wati — WhatsApp Business API** (3 numbers: TMC, RFU, ops)       | All outbound WhatsApp: itinerary share, payment-plan & journey reminders, lead nudges, sequences. Without it every WhatsApp surface is dead. | ⚠️ WhatsApp is used, but via **Meta Cloud API direct** — Travel switches to Wati BSP | Client (Wati acct)   | `WATI_API_KEY`, `WATI_BASE_URL` (per brand)                           |
| **Exotel — Voice telephony** (SID + API key + token + caller IDs) | In-CRM click-to-call dialer + call logging for agents on both brands.                                                                        | ⚠️ Telephony exists, but via **MyOperator / Knowlarity** — Travel uses Exotel        | Client               | `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_TOKEN`                        |
| **Email sending** — SendGrid (or Mailgun / SMTP)                  | Transactional email: registration, payment receipts, itinerary delivery, reminders, OTP.                                                     | ✅ Yes (SendGrid + Mailgun + SMTP)                                                   | Client (domain) / GS | `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` (or `MAILGUN_*` / `SMTP_*`) |
| **SMS gateway** — MSG91 / Fast2SMS / Twilio                       | OTP, booking confirmations, payment-plan reminders where WhatsApp isn't available.                                                           | ✅ Yes (MSG91 / Fast2SMS / Twilio)                                                   | Client               | `MSG91_AUTH_KEY`+`MSG91_SENDER_ID` (or `FAST2SMS_*` / `TWILIO_*`)     |
| **Web Push (VAPID keypair)**                                      | Browser push notifications to agents (new lead, SLA breach).                                                                                 | ✅ Yes                                                                               | GS generates         | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`                               |

---

## 2. AI / LLM (the "LLM-switchable layer")

| Service / Key                                                                                                                          | Why we need it                                                                                                                | Used in Wellness today?                                                                                         | Who provides | Env var(s)                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------- |
| **Google Gemini** (AI Studio key — Pro + Flash + Vision)                                                                               | Default LLM: itinerary drafting, diagnostic interpretation, lead-junk filter, sentiment/KPI summaries, document-OCR fallback. | ✅ Yes (Gemini 2.5 is the Wellness AI engine)                                                                   | Client / GS  | `GEMINI_API_KEY`                                                      |
| **OpenAI (GPT-4)**                                                                                                                     | Alternative model in the switchable LLM layer (task-class routing).                                                           | ❌ No                                                                                                           | Client       | `OPENAI_API_KEY`                                                      |
| **Anthropic (Claude)**                                                                                                                 | Alternative model in the switchable LLM layer.                                                                                | ❌ No                                                                                                           | Client       | `ANTHROPIC_API_KEY`                                                   |
| **Perplexity**                                                                                                                         | Real-time-search-backed answers for diagnostics.                                                                              | ❌ No                                                                                                           | Client / GS  | `PERPLEXITY_API_KEY`                                                  |
| **Callified.ai — AI calling agent** (base URL + per-tenant key + persona library + webhook signing secret + recording-URL signing key) | Auto-qualifies inbound TMC/RFU leads by phone in Hindi/English, writes transcript + Hot/Warm/Cold score back to CRM.          | ⚠️ Wellness integrates Callified as an inbound partner (pushes data _in_); Travel calls it _out_ to place calls | Client       | `CALLIFIED_BASE_URL`, `CALLIFIED_API_KEY`, `CALLIFIED_WEBHOOK_SECRET` |

---

## 3. Travel-specific integrations

| Service / Key                                                                                                  | Why we need it                                                                                                                       | Used in Wellness today?                                                               | Who provides                           | Env var(s)                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **RateHawk — hotel rates** (API key + API ID + prod base URL)                                                  | Live hotel rates for the RFU Umrah quotation engine + lowest-rate auto-pick + Haram-facing/room/floor filters.                       | ❌ No                                                                                 | Client                                 | `RATEHAWK_API_KEY`, `RATEHAWK_API_ID`, `RATEHAWK_BASE_URL`                                                   |
| **DigiLocker — partner credentials** (client ID + secret + Aadhaar XML pull config)                            | Aadhaar identity verification for parent/teacher (TMC) registration.                                                                 | ❌ No                                                                                 | Client (Travel Stall has partner acct) | `DIGILOCKER_CLIENT_ID`, `DIGILOCKER_CLIENT_SECRET`, `DIGILOCKER_REDIRECT_URI`                                |
| **Passport OCR** — Google Document AI **or** Azure Form Recognizer                                             | Auto-extract passport fields for travellers (TMC students + RFU pilgrims) into secure storage.                                       | ❌ No                                                                                 | Client + GS (vendor pick)              | Google: `GOOGLE_DOCAI_*` + `GOOGLE_APPLICATION_CREDENTIALS` · Azure: `AZURE_FORM_RECOGNIZER_ENDPOINT`+`_KEY` |
| **Google Workspace / Drive / Meet** (OAuth client ID + secret + admin consent; Drive + Calendar + Meet scopes) | Auto-create per-trip Drive folders + book Google Meet links from the CRM.                                                            | ⚠️ Google OAuth (Calendar) exists; Travel adds Drive + Meet + Workspace admin consent | Client (Workspace admin)               | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`                                            |
| **Airline agent portals** — IndiGo, Air India, Vistara, Emirates                                               | Automated web check-in (no public API — these are agency portal logins).                                                             | ❌ No                                                                                 | Client (agency accounts)               | per-airline secure-vault entries                                                                             |
| **Flight-quote source (Chrome plugin)** — paid GDS/aggregator key **if used**                                  | The flight quotation plugin only needs a key if it pulls live fares from a paid source. **❓ Confirm: paid source or manual entry?** | ❌ No                                                                                 | Client (TBD)                           | TBD                                                                                                          |
| **Booking.com partner creds** _(later — Phase 1.5)_                                                            | Expand RFU hotel search beyond RateHawk. **Contract note:** promised in proposal but flagged "not licensed" later — resolve first.   | ❌ No                                                                                 | Client                                 | `BOOKING_COM_*`                                                                                              |
| **Expedia EAN partner creds** _(later — Phase 2)_                                                              | Add Expedia hotel inventory to RFU search. Same licensing caveat.                                                                    | ❌ No                                                                                 | Client                                 | `EXPEDIA_EAN_*`                                                                                              |

---

## 4. Payments

| Service / Key                                               | Why we need it                                                                     | Used in Wellness today?                        | Who provides | Env var(s)                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- | ------------ | ------------------------------------------------------------------- |
| **Razorpay — live key** (Subscriptions module enabled)      | Payment links / installment charges for TMC trip payment plans + light accounting. | ✅ Yes (Razorpay used in Wellness POS/billing) | Client       | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| **Stripe** _(only if non-INR / international cards needed)_ | Card payments for international travellers.                                        | ✅ Yes (wired in Wellness)                     | Client       | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                        |

---

## 5. Hosting, storage & infrastructure

| Service / Key                                                      | Why we need it                                                                                 | Used in Wellness today?                | Who provides      | Env var(s)                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------- | ---------------------------------------------------------- |
| **AWS Mumbai** — IAM access key + secret (if client-owned account) | Hosting the CRM in the client's AWS account ("Hosting on AWS Mumbai, data ownership + exit").  | ❌ No (Wellness runs on GS demo infra) | Client / GS infra | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| **S3 bucket** (or Cloudinary) — document & asset storage           | Secure storage for passports, Aadhaar, itineraries, marketing assets at scale (vs local disk). | ❌ No (local disk today)               | Client / GS       | `AWS_S3_BUCKET` (or `CLOUDINARY_*`)                        |
| **Database (MySQL)** — connection URL                              | The CRM datastore.                                                                             | ✅ Yes (MySQL)                         | GS provisions     | `DATABASE_URL`                                             |
| **Sentry — error monitoring** (DSN)                                | Production error tracking.                                                                     | ✅ Yes                                 | GS                | `SENTRY_DSN`                                               |

---

## 6. Auth, security & internal secrets (GlobusSoft generates — not client keys)

These are required to run a deployment but are **generated by GlobusSoft**, not
requested from the client — listed for completeness since this is a fresh build.

| Secret                                                                 | Why we need it                                   | Used in Wellness today?       | Env var(s)                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------- | ------------------------------------------------ |
| **JWT signing secret**                                                 | Signs user auth tokens.                          | ✅ Yes                        | `JWT_SECRET`                                     |
| **Portal JWT secret**                                                  | Signs customer/portal (OTP) tokens.              | ✅ Yes                        | `PORTAL_JWT_SECRET`                              |
| **Field-encryption key** (AES-256)                                     | Encrypts PII (passport/Aadhaar/contact) at rest. | ✅ Yes (`WELLNESS_FIELD_KEY`) | `WELLNESS_FIELD_KEY`                             |
| **Webhook HMAC secret**                                                | Signs outbound webhooks (website→CRM hand-off).  | ✅ Yes                        | `WEBHOOK_HMAC_SECRET`                            |
| **Cloudflare Turnstile** (captcha) — secret key                        | Bot protection on public lead-capture forms.     | ✅ Yes                        | `TURNSTILE_SECRET_KEY`                           |
| **SSO / Microsoft OAuth** _(if client wants Microsoft login/calendar)_ | Staff SSO + Outlook calendar.                    | ✅ Yes                        | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |

---

## Summary — what to actually request from the client

**Net-new keys to procure for Travel (❌/⚠️ above), in priority order:**

1. **Wati** — WhatsApp Business API, 3 numbers (TMC, RFU, ops)
2. **Exotel** — voice telephony (SID, API key, token, caller IDs)
3. **Callified.ai** — AI calling (base URL, per-tenant key, webhook + recording secrets)
4. **LLM keys** — OpenAI, Anthropic, Perplexity (Gemini already proven in Wellness)
5. **RateHawk** — hotel rates (API key + ID + base URL)
6. **DigiLocker** — Aadhaar partner credentials
7. **Passport OCR** — Google Document AI _or_ Azure Form Recognizer account

8. **AWS Mumbai + S3** — if hosting in the client's own account
9. **Airline agent-portal logins** — IndiGo, Air India, Vistara, Emirates
10. _(later)_ **Booking.com / Expedia** — resolve the licensing question first

**Already proven in Wellness — likely just need the client's own account/keys, not new integration work:**
Gemini · Email (SendGrid/Mailgun/SMTP) · SMS (MSG91/Fast2SMS/Twilio) · Razorpay · Stripe · Web Push · Sentry · Turnstile · Google/Microsoft OAuth · JWT/field-encryption/webhook secrets.

**Two contradictions to settle (from the meeting sheet), before they block billing/quotation:**

- Price **₹2,17,000 vs ₹2,50,000**, and timeline **30 vs 42 days**.
- **Booking.com/Expedia** rates promised in the proposal but flagged "not licensed" in the later response.

_Generated 2026-06-04 from the TMC/RFU build-split sheet; Wellness-usage column verified against `backend/services/*` + `backend/.env.example`._
