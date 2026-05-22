# WhatsApp Integration — Product Requirements

**Status:** SPEC — wiring is cred-blocked on Q9 ("Meta Business Manager access
for 3 WhatsApp Business numbers") per
[TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md). The decision is
made (🟢 2026-05-20: *"All 3 procured + Meta-verified … Share Meta Business
Manager access; GS provisions 3 Wati WABAs immediately"*). This document is
what's needed for that hand-over to actually happen.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §6 (Communications) +
§4.7 (Travel Stall operating model).

**Audience:** Yasin (delivery owner of the Meta Business Manager artifacts),
Travel Stall ops, GS engineering.

---

## 1. Background

WhatsApp is the **default communications channel** for Travel Stall — for
both the parent / pilgrim (customer side) and the advisor (operator side).
SMS is fallback only. Six already-built CRM features depend on WhatsApp
delivery; today every one of them logs *"WhatsApp dispatch pending"* to the
console and writes a placeholder row, because the credentials to actually
send a message are not yet in place.

### 1.1 Source attribution + how the architecture evolved

The WhatsApp requirement originates from a **single paragraph in Yasin's
clarifications email** (`travel-crm/Understanding and clarifications - Yasin.pdf`,
2026-05-13 16:48 IST → chandrikapaul@globussoft.in / souravpatra@globussoft.in /
sumit@globussoft.com). Under "Additional clarifications we need from you,"
Yasin wrote:

> **Vati (WhatsApp):** cost model, template approval timelines, message-volume
> limits, and how the shared Travel Stall number stays cleanly separated
> between TMC and RFU.

(Spelled "Vati" in the original — correct spelling is **Wati**; that's the
BSP that helped Travel Stall onboard the numbers to Meta. Runtime path is
direct to Meta Cloud API; Wati is upstream-only — see §2.3.)

That paragraph asks 4 distinct questions. Yasin also committed in the same
email's Section 13 inputs list to deliver: *"WhatsApp numbers planned for use"*
+ *"existing email and WhatsApp templates"*.

**Architectural evolution 2026-05-13 → 2026-05-20:** Yasin's original framing
implied **one shared Travel Stall number** with multi-tenanting routing
("how the shared Travel Stall number stays cleanly separated between TMC and
RFU"). On 2026-05-20 the decision flipped to **3 separate WABAs** (TMC + RFU
+ ops-shared) per the Q9 update (*"All 3 procured + Meta-verified … Share
Meta Business Manager access; GS provisions 3 Wati WABAs immediately"*).

This is a real product simplification — separation moved from application
layer (routing logic on every send + per-sub-brand template variants on one
WABA) to infrastructure layer (separate WABAs with independent number-quality
ratings). The `subBrandConfig` helper at `backend/lib/subBrandConfig.js`
(commit `621aab7`) is the code embodiment of this evolution — per-tenant
config keyed by sub-brand returns the right `wabaId` + `phoneNumberId` so
each cron / endpoint dispatch routes to the right WABA without per-callsite
logic.

§5.4 below answers Yasin's original 4 questions point-by-point so the PRD
serves as the formal reply to his email.

**Source-of-truth chain:**
```
Yasin's email (2026-05-13)         ← original ask, 1 paragraph, 4 questions
  └─ Q9 decision (2026-05-20)       ← architecture choice (3 WABAs not 1)
       └─ this PRD (live)            ← full spec; serves as reply to his email
            └─ subBrandConfig (621aab7) + 10 stub call sites
                 └─ Q9 cred handover ← outstanding (§5 below)
```

Travel Stall has procured and Meta-verified **3 WhatsApp Business numbers**
(per Q9 decision 2026-05-20):

| Number label | Purpose |
|---|---|
| **TMC** | School-trip parent communications (consent reminders, payment-plan instalments, journey reminders, web check-in nudges). |
| **RFU** | Pilgrim communications (Umrah pre-departure briefing, document checklist, group-WA invite, post-trip feedback). |
| **ops-shared** | Internal advisor / ops alerts (diagnostic-to-advisor escalations, lead-SLA breaches, system warnings). |

This document defines (a) what GS owes the integration code-wise — already
shipped — and (b) what Travel Stall owes for the hand-over, with **exact
artifacts and two delivery paths**.

---

## 2. Use cases — what depends on WhatsApp

All six are wired in code today. Each is currently dispatching to a stub.

### 2.1 Customer-facing (TMC + RFU numbers)

| Feature | Cron / route | Today | After Q9 ships |
|---|---|---|---|
| **Microsite OTP** (parent verifies phone before viewing PII) | [routes/travel_microsites.js](../backend/routes/travel_microsites.js) `request-otp` | Logs OTP to server console; parent can't actually receive it | Real OTP via WhatsApp template message; parent enters 6-digit code to gate PII reveal |
| **Trip-payment reminders** (instalment due in N days) | [cron/tripPaymentReminders.js](../backend/cron/tripPaymentReminders.js) | Writes `WhatsAppMessage` row with `status=pending_dispatch` | Sends WA template; flips row to `sent`; tracks delivery + read receipts |
| **Journey reminders** (RFU pre-departure briefing, packing list) | [cron/travelJourneyReminders.js](../backend/cron/travelJourneyReminders.js) | Same — pending_dispatch | Real send |
| **Post-trip feedback / NPS** (T+3 days after `returnDate`) | [cron/tripPostTripFeedback.js](../backend/cron/tripPostTripFeedback.js) | Same | Real send with feedback-form deep-link |
| **Web check-in scheduler** (T-48h nudge for the parent to web-check-in) | [cron/webCheckinScheduler.js](../backend/cron/webCheckinScheduler.js) | Same | Real send with airline web-check-in deep-link |
| **Birthday / anniversary greetings** (Travel Stall brand touchpoint) | [cron/contactGreetingsEngine.js](../backend/cron/contactGreetingsEngine.js) | Same | Real send |

### 2.2 Operator-facing (ops-shared number)

| Feature | Cron / route | Today | After Q9 ships |
|---|---|---|---|
| **Diagnostic-to-advisor escalations** (lead scored ≥ premium tier, no advisor contact in 6h) | [cron/travelDiagnosticAdvisorAlerts.js](../backend/cron/travelDiagnosticAdvisorAlerts.js) | Pending_dispatch | Notifies the assigned advisor on the ops-shared WhatsApp number |
| **Itinerary / PDF / share-link delivery** to lead (advisor manually triggers from TripDetail) | [routes/travel_itineraries.js](../backend/routes/travel_itineraries.js) `/share` | Returns the share URL but doesn't auto-WA it | Advisor click → WA template fires with the share URL |

### 2.3 Why direct Meta Cloud API, not Wati's wrapper

The TODOS.md KEY BLOCKERS table calls this the *"Wati BSP wrapper"* — that's
terminology drift. **Wati is the BSP** (Business Solution Provider) that
helped Travel Stall onboard the numbers to WhatsApp Business; **the GS
backend talks to Meta Cloud API directly** (Graph API
`POST /v.../{phoneNumberId}/messages`). Code at
[backend/services/whatsappProvider.js](../backend/services/whatsappProvider.js).

Implication: the artifacts come out of Meta Business Manager, not Wati's
dashboard. Wati's role in production runtime is zero — they're upstream only.

---

## 3. Functional requirements (already shipped, awaiting creds)

| FR-ID | Requirement | Status |
|---|---|---|
| FR-1 | Send WhatsApp **template messages** (HSM — approved templates for marketing/utility) via Meta Cloud API. | ✅ [whatsappProvider.js → sendTemplate()](../backend/services/whatsappProvider.js) |
| FR-2 | Send WhatsApp **session text messages** (free-form, within 24h of a customer-initiated message). | ✅ `whatsappProvider.sendText()` |
| FR-3 | Verify **inbound webhook signatures** (Meta's `X-Hub-Signature-256` HMAC) before processing. | ✅ `whatsappProvider.verifyWebhook()` |
| FR-4 | Persist every outbound + inbound message as a `WhatsAppMessage` row with delivery / read receipts. | ✅ `WhatsAppMessage` Prisma model + threading + opt-out tracking. |
| FR-5 | **Per-tenant** credential isolation — each tenant has its own `WhatsAppConfig` row with its own `phoneNumberId` + `wabaId` + encrypted `apiToken`. | ✅ `WhatsAppConfig` model already in schema. |
| FR-6 | Opt-out enforcement (DPDP §11) — `WHATSAPP_OPT_OUT` action blocks further sends. | ✅ Existing wellness CRM flow extended for Travel CRM. |
| FR-7 | Template approval workflow surface in `/channels` admin page (operator submits Meta-approved template name + variables). | ✅ Channels.jsx + WhatsAppTemplate model. |

**Nothing in this section needs more code.** The blocker is purely the
credential delivery from §5.

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Latency** (send → Meta accepted) | < 2 s p95 |
| **Throughput** (per number) | Subject to Meta's tier — TS starts at Tier 1 (1k unique recipients / 24h per number) |
| **Reliability** | 5xx from Meta retries 3× with 1/2/4s backoff; persistent failure marks row `failed`; advisor sees failure in `/channels` log |
| **Compliance** | Templates only outside the 24h session window; opt-out honored within 1 minute; webhook receives delivery receipts and stamps `WhatsAppMessage.deliveredAt` + `readAt` |
| **Cost visibility** | Per-template + per-number cost surfaced in `/reports/communications` (Phase 2 polish) |

---

## 5. Hand-over requirements — exactly what Travel Stall owes

This is the section that unblocks every feature in §2.

### 5.1 The artifacts (the goal — regardless of delivery path)

For each of the 3 numbers (TMC / RFU / ops-shared):

| Artifact | What it is | Where it lands in the codebase |
|---|---|---|
| **Permanent access token** | Generated for a **System User** inside the MBM. Non-expiring (vs a personal-user token which expires in 60 days). | `WHATSAPP_ACCESS_TOKEN` env var; then encrypted into per-tenant `WhatsAppConfig.apiToken` |
| **Phone Number ID** | Numeric ID Meta assigns to each registered WhatsApp number (not the +91 number itself). 3 of them. | `WhatsAppConfig.phoneNumberId` — one row per number |
| **WhatsApp Business Account ID (WABA ID)** | One per WABA. Used for template management + webhook routing. | `WhatsAppConfig.wabaId` |
| **Meta App ID + App Secret** | The Meta App tied to the MBM (the app that holds the WhatsApp permissions). | `META_APP_ID` + `META_APP_SECRET` env vars (used for webhook HMAC verification) |
| **Webhook verify token** | A string Yasin picks. Same string lives in (a) the MBM webhook config and (b) the GS deployment. | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` env var |

That's the **complete delivery**. No usernames. No passwords. No SMS OTPs.

### 5.2 Two delivery paths — Travel Stall picks one

#### Path A — Travel Stall produces the artifacts themselves (preferred, zero GS access to MBM)

Yasin (or his ops person) does this once. No third party touches the MBM.

1. **Business Manager → Business Settings → Users → System Users → "Add"**
   - Name: `Travel CRM Production`
   - Role: **Admin**
2. **Assign the 3 WABAs to that System User**
   - Business Settings → Accounts → WhatsApp Accounts → for each WABA → "Add People" → select the System User → check "Manage WhatsApp Business Account"
3. **Generate the token**
   - Business Settings → Users → System Users → click `Travel CRM Production` → "Generate New Token"
   - In the dialog, select all 3 WABAs
   - **Uncheck "Token expiration in 60 days"** (this is critical — default is expiring; non-expiring is what production needs)
   - Required permissions: `whatsapp_business_messaging` + `whatsapp_business_management`
   - Copy the token (it's shown ONCE — store it in 1Password / a secure vault immediately)
4. **Collect the per-number IDs** — for each of TMC / RFU / ops-shared:
   - Business Settings → WhatsApp Accounts → click the WABA → Phone Numbers tab
   - Copy the **Phone Number ID** (the long numeric, not the +91 number)
   - Copy the **WhatsApp Business Account ID** (shown on the WABA overview)
5. **Collect Meta App ID + App Secret**
   - Business Settings → Apps → click the app linked to the WABAs → Settings → Basic
   - App ID is shown; App Secret has a "Show" button
6. **Pick a webhook verify token** — any random string (e.g. a UUID). Note it; Travel Stall will paste the same string into both Meta and the GS deployment.
7. **Deliver the bundle to GS** via secure channel (1Password, encrypted email, or a one-time-view secret share — never plain email / WhatsApp / Slack):

```yaml
accessToken: EAAB...                       # the single non-expiring System User token
webhookVerifyToken: <chosen-string>        # the random string from step 6
metaAppId: 1234567890
metaAppSecret: abcdef...

numbers:
  - label: TMC
    phoneNumberId: 111111111111111
    wabaId:        222222222222222
  - label: RFU
    phoneNumberId: 333333333333333
    wabaId:        444444444444444
  - label: ops-shared
    phoneNumberId: 555555555555555
    wabaId:        666666666666666
```

GS pastes those into `backend/.env` + seeds 3 `WhatsAppConfig` rows. **~30 min
of GS work after delivery.** All 8 features in §2 go from stub-mode to live.

#### Path B — Travel Stall adds GS as a Business Manager user

If Yasin prefers to delegate the System User setup: add a GS email to the
MBM with **"Develop apps"** + **"Manage WhatsApp accounts"** permissions on
the 3 WABAs. GS performs Path A steps 1-6 inside Yasin's MBM and emails
back the same bundle.

Recommended GS email: `sumit@chingari.io` or a service identity like
`gs-integrations@globussoft.com`.

**Yasin's personal username / password are never shared in either path.**
Meta's user-add flow is invitation-based — it sends an email to the GS
address with an accept-link.

### 5.4 Answering Yasin's original 4 questions (formal reply to 2026-05-13 email)

Yasin's clarification paragraph asked 4 distinct things. Map:

| # | Yasin's question (verbatim, 2026-05-13) | GS answer |
|---|---|---|
| 1 | **Cost model** | Meta charges per conversation (24-hour window, not per message). Pricing varies by country + category: India utility ~₹0.30 / conversation, marketing ~₹0.85, authentication (OTP) ~₹0.12. **2-layer cost cap shipping pre-launch:** per-tenant monthly budget ($50 default, configurable) + per-number daily soft cap (200/day during days 1-3, relax after stability). Real-time spend visible in admin LlmSpend-style dashboard (Phase 2). |
| 2 | **Template approval timelines** | Meta SLA: 24-48 hours per template; rejections common on first submission, expect 1 round trip. **Mitigation:** GS submits 2 alternate copy variants per template in parallel (Meta charges $0 for review). Starter set of 6 templates (§9 OQ-1): `otp_verification`, `payment_reminder_t_minus_n`, `journey_reminder`, `post_trip_feedback`, `web_checkin_nudge`, `birthday_greeting` — submitted on Day 1 in parallel with env wiring. |
| 3 | **Message-volume limits** | Meta tier-rate-limits per number, starting Tier 1: 1k unique recipients / 24h. Tier 2: 10k/24h (auto-promoted after ~24h of clean Tier-1 traffic + good number-quality rating). Tier 3: 100k/24h. **Mitigation:** opt-out enforced within 1 minute (FR-6) + per-number quality monitoring in MBM. |
| 4 | **How shared Travel Stall number stays cleanly separated between TMC and RFU** | **Architecture changed 2026-05-20 (Q9 update):** no longer one shared number with routing — now **3 separate WABAs** (TMC + RFU + ops-shared). Separation moved from application layer (routing logic on every send) to infrastructure layer (independent number-quality ratings + independent rate-limit budgets per WABA). Code embodiment: `subBrandConfig` helper at `backend/lib/subBrandConfig.js` (commit `621aab7`) returns the right `wabaId` + `phoneNumberId` per sub-brand. All 7 cron engines + 3 endpoints already resolve via this helper — the Q9 cred drop is a one-line `if (apiKey) wati.send(...)` per consumer, no per-callsite WABA-routing decision needed. |

This section IS the formal answer Yasin asked for on 2026-05-13. Send this PRD link to Yasin to close the loop on his clarification request + unblock his Section 13 deliverable on WhatsApp.

### 5.3 Webhook setup (Meta → GS callback)

Once the artifacts above land, GS adds the webhook to Meta. Travel Stall's
involvement is just *approving* the GS-initiated webhook addition in the MBM
(one-click in the App Settings → Webhooks page).

Webhook callback URL GS will register:

```
https://crm.globusdemos.com/api/whatsapp/webhook
```

Subscribed fields: `messages`, `message_status` (delivery + read receipts).

---

## 6. Acceptance criteria

The integration is "done" when **all 6 of the following are demonstrable**:

| # | Test | Verifies |
|---|---|---|
| AC-1 | An advisor triggers `POST /api/travel/itineraries/:id/share` → the lead receives a WhatsApp template message with the share URL within 10 s. | FR-1 (template send) + the per-tenant token routing. |
| AC-2 | A parent submits the microsite OTP request → receives a 6-digit code via WhatsApp; entering it on the microsite gates the PII reveal. | FR-1 + the microsite OTP flow end-to-end. |
| AC-3 | A scheduled `TripInstalmentPayment` with `dueDate = today + 3` triggers `cron/tripPaymentReminders.js` → the parent receives a WA reminder. | The cron dispatch stubs are now real. |
| AC-4 | Replying to a WhatsApp message from the customer side → the inbound shows up in `/channels` as a `WhatsAppMessage` row with `direction=in`. | FR-2 (inbound webhook + session-text receive). |
| AC-5 | Marking a contact's WhatsApp as opted-out → subsequent crons skip that contact and log a `WHATSAPP_OPT_OUT` audit row. | FR-6 (DPDP compliance). |
| AC-6 | Each of TMC / RFU / ops-shared is independently routable — sending to a TMC contact uses the TMC `phoneNumberId`, not RFU's. | FR-5 (per-tenant config isolation). |

GS owns the e2e validation; Travel Stall owns acknowledging acceptance.

---

## 7. Out of scope

- **WhatsApp Pay collection flow** — out of scope; payments go via the
  Razorpay/Stripe flow per Q4. WA is comms only.
- **WhatsApp marketing broadcast / bulk campaigns** beyond Meta's
  template-approved utility messages — out of scope for Phase 1.
- **WhatsApp web-chat widget on the public microsite** — Phase 2 polish; not
  blocking the customer onboarding flow.
- **Voice / video calls** — out of scope. WA is messaging only.

---

## 8. Dependencies + downstream

- **Q11 (LLM defaults)** — when LLM creds arrive, the
  diagnostic-to-advisor escalation cron in §2.2 will start generating
  per-lead talking points; the cron-dispatch leg is still WA. So Q11 +
  Q9 must both ship to fully light up that feature, but they're independent
  blocks — Q9 lights up the 5 other features regardless.
- **Q2 (Aadhaar consent counsel review)** — orthogonal; doesn't affect WA.
- **Q3 (DigiLocker creds)** — orthogonal; doesn't affect WA, but DigiLocker
  verification + WA reminders together complete the parent-onboarding loop
  on the microsite.

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | Which approved templates land in v1? Suggested set: `otp_verification`, `payment_reminder_t_minus_n`, `journey_reminder`, `post_trip_feedback`, `web_checkin_nudge`, `birthday_greeting`. Each needs Meta template-approval (typically 24-48 h). | Yasin to approve copy; GS submits to Meta. |
| OQ-2 | TS tier-rate-limits — TS starts at Tier 1 (1k unique recipients / 24h per number). When does TS request Tier 2 promotion? | Travel Stall ops, post-launch. |
| OQ-3 | Group-WA invites for RFU pilgrim groups — does that flow happen in-app (operator manually adds), or via the Hajj Committee export? | RFU product call. |

---

## 10. Status snapshot

- **Backend code** ✅ shipped and tested. See `backend/services/whatsappProvider.js`
  + 30+ vitest cases at `backend/test/services/whatsappProvider.test.js`.
- **Cron dispatch wiring** ✅ shipped (6 crons reference the provider).
- **Schema** ✅ shipped. `WhatsAppConfig` + `WhatsAppMessage` + `WhatsAppTemplate` models live.
- **Hand-over** 🔴 **outstanding** per §5 — this is the entire blocker.

Once Travel Stall delivers the §5 bundle (Path A or B), expected time to
fully-live across all 8 use cases: **half a day of GS engineering work + 1-2
days for Meta template approvals** (parallel to the env wiring).

---

**Ownership chain:**

- **Travel Stall (Yasin)** owes the §5 bundle — outstanding per
  [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) Q9.
- **GS engineering** owes the env wiring + per-tenant `WhatsAppConfig` seed
  + the e2e validation (~½ day after Q9 lands).
- **Meta** owes template approvals (24-48h per template; can be initiated in
  parallel by GS as soon as the App ID / App Secret arrive).
