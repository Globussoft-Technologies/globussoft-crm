# Multi-channel Lead Capture — Product Requirements

**Status:** SPEC — the per-channel handler scaffolding ships in production
(WhatsApp `routes/whatsapp.js`, voice `routes/voice.js`, marketplace
`routes/marketplace_leads.js` + `cron/marketplaceEngine.js`, email
`routes/email_inbound.js`, web `routes/web_visitors.js` + `chatbots.js`,
Voyagr SHIPPED `0299031`); what is missing is the *unifying capture envelope*
+ centralized de-dup + a routing-rules engine that all channels reduce
through. This PRD describes that envelope, not the per-channel integrations
(each has its own PRD).

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §3 (Lead
management) + cross-cutting Marketing-Attribution section.

**Audience:** Travel Stall ops (channel owners on day-to-day), GS engineering
(envelope + routing implementer), Yasin (sub-brand routing rules owner per
Q25), Rishu (wellness vertical reuses the envelope post-launch).

**Issue:** [#904](https://github.com/Globussoft-Technologies/globussoft-crm/issues/904)
— P1 Travel Gap.

---

## Implementation Status (audited 2026-06-13 against HEAD `043b9ab3`)

| Metric | Value |
|---|---|
| Total FRs | 32 |
| ✅ Shipped | 8 (25%) |
| 🟡 Partial | 7 |
| 🔌 Stub | 3 |
| ❌ Missing | 14 |
| **Net gap** | **21 items** |
| Primary blocker | Touchpoint chain + `/settings/lead-capture` UI + `LeadRoutingRule` schema extension |

**Single source of truth for all gap items, prioritisation, and execution waves:** [TRAVEL_GAP_CLOSURE_TRACKER.md §3.1 + §4 (Q9, Q1 AdsGPT)](TRAVEL_GAP_CLOSURE_TRACKER.md).

Path-mismatch drift to flag: code shipped intake as `POST /api/travel/inbound/leads/:channel` (travel-namespaced, channel-as-path); PRD specs cross-vertical `POST /api/leads/intake` (channel-in-body). G015 in the tracker adds the canonical alias.

---

## 1. Background

Travel businesses capture inbound leads from **10+ channels concurrently** —
WhatsApp messages, voice calls, SMS, email replies, web forms, marketplace
APIs (IndiaMART / JustDial / TradeIndia), social ad-platform webhooks
(Meta lead-ads, Google lead-ads), Voyagr-CMS sub-brand websites, embedded
forms on partner sites, and walk-ins. Today's reality on the CRM is:

- **Per-channel handlers exist** as scaffolding (the 7 routes enumerated in
  the Status section above), each speaking its own request shape, de-dup
  semantics, and assignee-routing pseudo-logic
- **No unifying capture envelope** — the moment a lead lands, its journey
  through validation, normalization, de-dup, routing, attribution, and
  operator-notify is forked per channel
- **Routing rules live partly in `LeadRoutingRule` and partly hard-coded**
  inside individual handlers; the operator UI surfaces the table-driven
  rules but the hard-coded paths are invisible
- **De-dup is per-channel**, so a contact arriving on WhatsApp + Voyagr +
  IndiaMART + a walk-in within the same week creates 4 records that need
  manual merging (when noticed at all)
- **Attribution is per-channel**, so the Marketing-Attribution PRD's
  lookback-window math depends on the right channel writing the right
  `Touchpoint` shape; today each handler writes a different shape

The goal of this PRD is to specify the **shared `/api/leads/intake` envelope**
that all channel handlers reduce to, plus the **de-dup + routing engines**
that live behind it. After this surface ships, channel-specific routes
become thin webhook receivers that parse vendor payloads and call the shared
envelope; the operator-facing /leads page sees one consistent shape.

### 1.1 Source attribution + how the requirement arrived

The multi-channel-capture requirement is filed as **GH issue #904** (Travel
CRM gap audit by `nilimeshnayak-max`, 2026-05) referencing the
*Travel Stall CRM — Implementation & Modification Roadmap* Tier P1 item 9.
The roadmap names Facebook + Instagram (via Meta Lead Ads), WhatsApp Business
API, Google Sheets polling, and website JS-snippet forms as the four
launch-critical channels; the other six channels (marketplace, voice,
walk-in, email, partner-embed, referral) are pre-existing CRM surface that
gets pulled into the same envelope.

Sibling PRDs already enumerate per-channel mechanics:

| Channel | Sibling PRD | Status |
|---|---|---|
| WhatsApp (Wati) | [WHATSAPP_INTEGRATION_PRD.md](WHATSAPP_INTEGRATION_PRD.md) | Cred-blocked on Q9 |
| Voice (Callified) | [PRD_AI_CALLING_CALLIFIED.md](PRD_AI_CALLING_CALLIFIED.md) | Cred-blocked on Q13 |
| Meta / Google ads | [PRD_ADSGPT_MARKETING_REPORTS.md](PRD_ADSGPT_MARKETING_REPORTS.md) | Cred-blocked on Q1 |
| Voyagr CMS websites | [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md) cluster F | F1 SHIPPED `0299031`; F2–F6 cred-pending |

This PRD does NOT duplicate any of the above. It describes only the
*unifying envelope* + *routing engine* that sits in front of them.

---

## 2. Use cases

| # | Channel | Flow |
|---|---|---|
| **UC-2.1** | WhatsApp first-message | Customer sends WhatsApp to business number → Wati webhook → `WatiClient.parse()` → `POST /api/leads/intake` with `channel='whatsapp'` + `payload.message` → envelope checks de-dup against Contact by phone → no match → creates Lead, Contact, Touchpoint → LeadRoutingRule matches `channel='whatsapp' + sub_brand='RFU'` → assigns to rep B → rep gets push + db notification |
| **UC-2.2** | Voice missed-call callback | Customer calls business number → no-pick → Callified.ai logs miss → `POST /api/leads/intake` with `channel='voice' + payload.callDirection='inbound' + payload.callOutcome='missed'` → envelope creates Lead with `subStatus='callback_pending'` → SMS-back template fires from the same envelope → routing rule assigns to telecaller queue |
| **UC-2.3** | Voyagr web form submission | Visitor on `tmcedu.com/contact` submits form → Voyagr Next.js API → `POST /api/v1/voyagr/leads` (existing) → server adapts and calls `/api/leads/intake` with `channel='voyagr' + payload.siteSlug='tmc' + utm_*` → envelope de-dups by email + phone → routing matches sub-brand=TMC |
| **UC-2.4** | Meta lead-ad fire | User clicks Meta lead-ad → instant-form submitted → Meta webhook → `POST /api/integrations/meta/leads` (per #904 AC) → adapter calls `/api/leads/intake` with `channel='meta_ad' + utm_source='facebook' + payload.formId='123' + payload.fields={...}` → envelope checks form-ID → sub-brand mapping → routing applies |
| **UC-2.5** | Marketplace cron pull | `marketplaceEngine.js` cron polls IndiaMART API every 5 min → for each new lead → calls `/api/leads/intake` with `channel='indiamart' + payload.queryId + payload.product` → envelope dedupes against MarketplaceLead.externalLeadId + Contact.phone → routes per marketplace-specific rule |
| **UC-2.6** | Walk-in lead | Operator manually fills /leads form in CRM UI → frontend calls `/api/leads/intake` with `channel='walk_in' + payload.notes` → envelope creates Lead with operator as `assignedTo` (no auto-routing) → still appends Touchpoint for attribution |
| **UC-2.7** | Inbound email | Customer emails `sales@travelstall.com` → IMAP poller → `routes/email_inbound.js` parses → calls `/api/leads/intake` with `channel='email' + payload.subject + payload.body + payload.fromEmail` → envelope de-dups by email → if existing Contact → appends Touchpoint, no new Lead; if new → creates both |

---

## 3. Functional requirements

### FR-3.1 Unifying intake envelope (the contract)

- **FR-3.1.1** Single endpoint `POST /api/leads/intake` accepts a typed
  payload of `{ channel, sourceAttribution, payload, idempotencyKey? }`
- **FR-3.1.2** `channel` enum (16 values): `whatsapp`, `voice`, `sms`,
  `email`, `web_form`, `meta_ad`, `google_ad`, `linkedin_ad`, `indiamart`,
  `justdial`, `tradeindia`, `voyagr`, `walk_in`, `referral`, `chat`, `other`
- **FR-3.1.3** `sourceAttribution` block fields: `utm_source`, `utm_medium`,
  `utm_campaign`, `utm_term`, `utm_content`, `siteSlug`, `referrer`,
  `advertiserId`, `formId`, `landingPage`, `firstTouchAt`
- **FR-3.1.4** `payload` is a channel-discriminated union — typed
  per-channel (WhatsApp payload includes `messageId + text + waMessageTs`;
  voice payload includes `callDirection + callOutcome + recordingUrl`;
  marketplace payload includes `externalLeadId + product + queryId`)
- **FR-3.1.5** Per-tenant + per-sub-brand scoping — `req.user.tenantId` for
  internal callers, API-key tenant for external callers
- **FR-3.1.6** Endpoint accepts both **API-key auth** (for sister-product
  callers like Voyagr, Callified, AdsGPT) and **JWT auth** (for the CRM's
  own walk-in form). Cross-tenant calls rejected with `403`.
- **FR-3.1.7** `idempotencyKey` is optional; when present, repeat calls
  with same key within 24h return the original response without side
  effects (covers vendor retries on webhook delivery flakes)
- **FR-3.1.8** Response shape: `{ leadId, contactId, action: 'created' |
  'merged' | 'touchpoint_appended' | 'duplicate_suppressed', assigneeId,
  matchedRoutingRuleId, touchpointId }`

### FR-3.2 De-dup

- **FR-3.2.1** **Primary key:** E.164-normalized phone (use existing
  `lib/deduplication.js` normalizer) — same `(tenantId, phone)` within a
  rolling 90d window = same Contact
- **FR-3.2.2** **Secondary key:** lowercased + trimmed email — same
  `(tenantId, email)` — same Contact (used when phone absent, e.g. email
  channel or web_form without phone field)
- **FR-3.2.3** **Within-channel cooldown:** same `(channel, contactId)`
  within configurable window (default 60min, per FR-3.7.2) → append
  `Touchpoint` to existing Lead, do NOT create new Lead
- **FR-3.2.4** **Cross-channel merge prompt:** if incoming phone matches
  existing Contact created via *different* channel → envelope returns
  `action='merged'` AND queues a `MergePromptNotification` for the
  operator (auto-merges Contact records; Lead records stay separate until
  operator confirms via UI)
- **FR-3.2.5** **Marketplace-specific override:** `MarketplaceLead.externalLeadId`
  uniqueness already gates marketplace-cron retries; the envelope
  short-circuits when channel is marketplace + `payload.externalLeadId`
  matches an existing row (idempotency via vendor's own ID)
- **FR-3.2.6** **Hard-block duplicates:** same `(tenantId, channel,
  idempotencyKey)` returns `action='duplicate_suppressed'` with the
  original response

### FR-3.3 Lead-routing rules engine

- **FR-3.3.1** Backed by existing `LeadRoutingRule` Prisma model + new
  fields `channel` and `subBrand` (additive migration — defaults to NULL
  meaning "matches any channel/sub-brand")
- **FR-3.3.2** **Match priority:** most-specific rule wins (rule with both
  channel + sub-brand set beats one with only channel; one with channel
  beats one with neither)
- **FR-3.3.3** **Tie-break:** `LeadRoutingRule.priority` (existing field,
  integer, lower number = higher priority); within priority, the rule
  created later wins (so operators can override without renumbering)
- **FR-3.3.4** **Round-robin within assignee list:** each rule has
  `assigneeIds: number[]`; envelope picks the next assignee in order
  using a per-tenant per-rule counter stored in Redis (or a
  `LeadRoutingRule.rrCursor` column if Redis isn't on the stack)
- **FR-3.3.5** **Unavailability handling:** if the picked assignee has
  `user.status='away'` or `user.isAvailable=false`, fall through to
  the next assignee in the list; if all unavailable, queue with
  `assigneeId=NULL` and assigneeRuleId set for later reassignment
- **FR-3.3.6** **Form-ID → sub-brand mapping** (per AC item 6 of #904) —
  a settings page lets ops map Meta-form-IDs → sub-brand → default
  assignee, persisted as `FormRoutingMapping` rows

### FR-3.4 Per-channel quirks

- **FR-3.4.1** **Voice channel:** lead may be CALLBACK request (operator
  needs to call back) not initial contact — envelope sets
  `Lead.subStatus='callback_pending'` when `payload.callOutcome='missed'`,
  and routes to telecaller queue regardless of generic routing rules
- **FR-3.4.2** **Marketplace backpressure:** vendor APIs are rate-limited
  (IndiaMART: ~500 req/hr per account). Marketplace cron handles its own
  backoff; envelope itself doesn't need rate-limiting beyond the global
  per-tenant rate-limit middleware
- **FR-3.4.3** **Webhook signature verification:** Meta + Google lead-ad
  webhooks ship signed payloads. The adapter routes (`/api/integrations/meta/leads`
  etc.) verify signatures BEFORE calling the envelope; the envelope itself
  trusts authenticated callers
- **FR-3.4.4** **Walk-in:** envelope skips routing rules entirely (operator
  is already the assignee implicitly); still writes Touchpoint
- **FR-3.4.5** **Referral channel:** payload includes `referrerContactId`;
  envelope links the new Lead's first Touchpoint to the referrer's contact

### FR-3.5 Audit + attribution

- **FR-3.5.1** Every intake writes one `Touchpoint` row tying the contact
  to the channel + UTM set + timestamp
- **FR-3.5.2** First-touch + last-touch fields on the Lead are maintained
  by the envelope; the Marketing-Attribution PRD's lookback-window math
  reads from these
- **FR-3.5.3** Per-channel conversion funnel: dashboard reads
  `Touchpoint.channel` grouped by Lead status — surface in the existing
  marketing-reports endpoint

### FR-3.6 Operator visibility

- **FR-3.6.1** `/leads` page row renders a channel badge (icon + label)
  reading `Lead.channel` (new column; default `'manual'` for legacy rows)
- **FR-3.6.2** Per-channel filter dropdown above the leads table
- **FR-3.6.3** Per-channel inbox view (group by `channel + assignee`) at
  `/leads?view=inbox` — operators can switch between "all leads" and
  "my inbox" scoped to a channel
- **FR-3.6.4** Source-attribution badge on lead-detail page shows
  `utm_source / utm_medium / utm_campaign` when present

### FR-3.7 Settings

- **FR-3.7.1** Settings page `/settings/lead-capture` lists per-channel
  enabled/disabled toggle, webhook URL (read-only), cred status badge
- **FR-3.7.2** Cooldown window setting (default 60min, range 5–1440min)
  per-channel — stored on `TenantSettings.leadCaptureCooldowns Json`
- **FR-3.7.3** Form-ID → sub-brand → assignee mapping UI (per FR-3.3.6)

---

## 4. Non-functional

- **NFR-4.1 Latency:** intake endpoint p99 < 500ms; channel-handler async
  work (notification fanout, SMS-back fire) queued via existing event-bus
- **NFR-4.2 Throughput:** 1000 intakes/min per tenant sustained;
  10000/min burst for 5min (during marketplace-cron sweeps)
- **NFR-4.3 Idempotency:** vendor retries (Meta delivers webhooks with
  exponential backoff up to 24h) MUST NOT produce duplicate leads — covered
  by FR-3.1.7 + FR-3.2.5 + FR-3.2.6
- **NFR-4.4 Audit:** every intake writes an `AuditLog` row with the channel,
  the action taken, and the matched routing rule for ops visibility
- **NFR-4.5 Backpressure:** if all assignees in a rule are unavailable
  AND the rule's `unassignedQueueDepth > 100`, the envelope returns 202
  with `action='queued_for_later'` — ops gets a separate alert

---

## 5. Hand-over requirements / design decisions

### 5.1 Design decisions (need user input before implementation)

- **DD-5.1 Cross-channel merge auto vs prompt:** when WhatsApp arrives and
  same phone exists as a Voyagr-form contact, do we (a) auto-merge contacts
  silently + notify operator, or (b) require operator-confirmation
  ("Merge prompt") before any merge? **Recommendation: (a) auto-merge,
  notify only;** operators get fatigued by merge prompts on multi-channel
  customers. Confirm with Yasin.
- **DD-5.2 Within-channel cooldown duration:** default 60min per FR-3.7.2.
  Confirm or specify per-channel. Marketplace channels probably want
  longer (24h) since vendors re-deliver leads through their UI.
- **DD-5.3 Routing-rule priority resolution:** spec'd as most-specific-wins
  per FR-3.3.2. Alternative is rule-creation-order (last-created beats
  first). Most-specific-wins is the industry pattern (HubSpot / Salesforce).
- **DD-5.4 Per-channel notification cadence:** when a lead arrives, do we
  fire "lead arrived" notification per intake, or only per-rule-match? If
  per-intake, an operator can know-but-not-act on leads outside their
  rule; if per-rule-match, only the assignee sees it. **Recommendation:
  per-rule-match,** with a separate ops-overview channel that sees all.
- **DD-5.5 Idempotency window:** 24h per NFR-4.3; alternative 7d for
  ultra-aggressive de-dup. 24h covers vendor retries; longer might
  legitimately suppress same-customer-different-intent re-leads.

### 5.2 Cred chase

This PRD does not introduce new credential requirements beyond what the
per-channel PRDs already need:

- WhatsApp: Q9 (Wati API key) — see WHATSAPP_INTEGRATION_PRD.md
- Voice: Q13 (Callified API key) — see PRD_AI_CALLING_CALLIFIED.md
- Meta / Google ads: Q1 (AdsGPT handover) — see PRD_ADSGPT_MARKETING_REPORTS.md
- Voyagr: API key per sub-brand — see MANUAL_CODING_BACKLOG.md cluster F
- IndiaMART / JustDial / TradeIndia: per-marketplace API key (existing
  cred storage path under `MarketplaceConfig`)

### 5.3 Vendor docs to compile

- Meta Lead Ads webhook signature spec (`X-Hub-Signature-256` HMAC)
- IndiaMART API rate-limit + response shape
- JustDial / TradeIndia equivalents
- Google lead-ads webhook spec (if launching that channel pre-AdsGPT
  integration)
- Wati WhatsApp webhook shape (channel-specific to Wati, not WhatsApp
  Cloud API directly — they wrap it)

---

## 6. Acceptance criteria

- **AC-6.1** Same phone arrives on WhatsApp (10:00) + Voyagr form
  (10:30) within 60min → operator sees one Contact, two Leads, one
  merge-notification; manual confirm in UI keeps the Leads linked
- **AC-6.2** IndiaMART cron pulls a lead whose phone matches an existing
  Contact → envelope appends Touchpoint, does NOT create duplicate
  Contact; `action='touchpoint_appended'`
- **AC-6.3** Voice missed-call → CALLBACK Lead created with
  `subStatus='callback_pending'`, SMS-back template fires within 30s
- **AC-6.4** LeadRoutingRule with `(channel='whatsapp', subBrand='RFU')`
  routes matching lead to assignee list with round-robin within 30s of
  intake; assignee gets push + db notification
- **AC-6.5** /leads page filter "channel=whatsapp" shows only WhatsApp-
  origin leads (using `Lead.channel` column); badge renders correctly
  on every row
- **AC-6.6** Touchpoint chain preserved across 5 contacts from the same
  Contact on different channels (whatsapp → email → voice → walk_in →
  whatsapp) — Marketing-Attribution PRD's first-touch + last-touch
  reads correctly from the chain
- **AC-6.7** Meta webhook delivers same lead twice within 1h (retry due
  to 5xx response on first attempt) → envelope returns
  `action='duplicate_suppressed'` on second call with same
  `idempotencyKey=meta_leadgenId`; only one Lead/Contact created
- **AC-6.8** Walk-in lead created by operator → no routing rule fires;
  operator is immediate assignee; Touchpoint still written for
  attribution rollup
- **AC-6.9** Form-ID `meta_form_12345` mapped to sub-brand `Visa Sure` +
  default assignee `userX` in settings → Meta webhook with that form-ID
  routes to `userX`; rule fires within 30s

---

## 7. Out of scope

- **Channel-specific NLP / intent classification** — separate AI feature;
  envelope passes `payload.text` through but doesn't analyze it
- **Lead scoring** — handled by existing `leadScoringEngine.js` cron
  (every 10min); envelope just creates the Lead row and the scorer picks
  it up on next tick
- **Lead-to-deal conversion** — existing flow on Lead detail page;
  envelope's job ends at Lead creation + routing
- **Channel-specific reply UIs** — each channel keeps its own
  conversation surface (WhatsApp inbox, voice softphone, email inbox);
  envelope only handles the *capture* side, not the *reply* side
- **Outbound lead synthesis** — when a CRM operator initiates first
  contact (cold call → log in CRM), that's a different flow; envelope
  handles inbound only

---

## 8. Dependencies

- **Models:** `Contact`, `Lead`, `LeadRoutingRule`, `Touchpoint`,
  `MarketplaceLead`, `TenantSettings`, `AuditLog` (all exist; need
  additive columns per FR-3.6.1 + FR-3.3.1 + FR-3.7.2)
- **Routes:** all 7 per-channel routes (`whatsapp`, `voice`,
  `email_inbound`, `marketplace_leads`, `voyagr`, `web_visitors`,
  `chatbots`) — these become thin adapters calling the new envelope
- **Libraries:** `lib/deduplication.js` (existing), `lib/eventBus.js`,
  `lib/notificationService.js`
- **Cron:** `marketplaceEngine.js` (existing) refactored to call the
  envelope instead of directly upserting MarketplaceLead → Contact
- **Frontend:** `pages/Leads.jsx` filter + badge; `pages/LeadDetail.jsx`
  source-attribution surface; new `pages/Settings/LeadCapture.jsx`

---

## 9. Open questions

- **OQ-9.1** Should walk-in leads bypass routing rules entirely, or
  should there be a "manual override" rule type that wins automatically?
  (FR-3.4.4 spec'd as "bypass" — confirm with Yasin.)
- **OQ-9.2** Marketplace dedup across marketplaces: should we treat
  same phone arriving on IndiaMART + JustDial as the same Contact
  (auto-merge), or keep separate because different vendor commission
  attribution? (Probably auto-merge — vendor commission is per-lead-id,
  not per-contact.)
- **OQ-9.3** What happens if a lead's channel changes mid-conversation
  (web form → WhatsApp → voice)? Today: each is a separate Touchpoint.
  Future: should we surface the journey as a single timeline in UI?
- **OQ-9.4** Voyagr lead has sub-brand declared in the form; what if a
  WhatsApp lead doesn't? Default routing fallback to "Unassigned" pool
  pending operator triage, or auto-assign by phone-pattern → sub-brand?
- **OQ-9.5** Should we expose `/api/leads/intake` to partner products
  via API key, or keep it internal-only? (Currently spec'd as both per
  FR-3.1.6 — confirm Yasin / Suresh agree.)
- **OQ-9.6** Should idempotency keys be **opt-in per caller** (vendors
  that retry pass them; vendors that don't, don't) or **mandatory**
  (envelope rejects calls without one)? Mandatory is safer but breaks
  legacy callers that don't yet send keys.
- **OQ-9.7** Per-channel webhook URL secrets: rotate on a schedule or
  only on-demand? (Standard practice: 90d rotation; ops cred-chase
  pain unless we automate.)

---

## 10. Status snapshot

- **Today:** per-channel handlers exist as scaffolding (7 routes); each
  has its own de-dup + ad-hoc routing logic; NO unifying intake envelope
- **This PRD:** WRITTEN 2026-05-23 (autonomous cron tick #21 / Agent 1,
  Refs #904)
- **Path to implementation:** **8–15 engineering days** depending on
  DD-5.1 + DD-5.2 + DD-5.4 outcomes
  - Envelope endpoint + schema migrations: 2d
  - De-dup engine + Touchpoint chain: 2d
  - Routing rules refactor + UI for FormRoutingMapping: 3d
  - Per-channel handler refactor to call envelope: 3d (1 channel ≈ 0.5d)
  - Operator visibility (badge, filter, inbox view): 2d
  - Settings page: 1d
  - Spec coverage (`leads-intake-api.spec.js` + per-channel adapter
    specs): 2d
- **Blockers:** no hard creds blockers for the envelope itself; per-channel
  rollout blocked on the sibling-PRD cred chases (Q9, Q13, Q1, Voyagr keys,
  marketplace API keys — see §5.2)
- **Sibling PRDs:** WHATSAPP_INTEGRATION + PRD_AI_CALLING_CALLIFIED +
  PRD_ADSGPT_MARKETING_REPORTS + MANUAL_CODING_BACKLOG.md cluster F
- **Next action:** Yasin to confirm DD-5.1 + DD-5.2 + DD-5.4 + OQ-9.1 +
  OQ-9.4 + OQ-9.5; GS engineering can ship the envelope + de-dup
  (envelope-only, no channel wiring) in parallel against existing
  scaffolds — would reduce the 8–15d to ~5d by descoping the per-channel
  refactors that depend on cred-chase outcomes
