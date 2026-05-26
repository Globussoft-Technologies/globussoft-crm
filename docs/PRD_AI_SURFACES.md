# AI Surfaces Across the CRM — Product Requirements

**Status:** SPEC — scattered AI features are SHIPPED today (talking-points,
lead scoring, deal insights, sentiment, junk-lead classification). What's
missing is a **unified vision** of AI surfaces across Travel + Wellness +
generic verticals, plus 8 NEW task classes flagged by the Travel Stall
roadmap and GH #909. This PRD enumerates feature-level AI surfaces —
the umbrella rebuild vision lives in
[PRD_AI_ERA_CRM_REBUILD.md](PRD_AI_ERA_CRM_REBUILD.md).

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §9.1 (LLM
routing table + per-task model pinning, Q11 locked) +
[PRD_AI_ERA_CRM_REBUILD.md](PRD_AI_ERA_CRM_REBUILD.md) (umbrella vision)
+ GH #909 (Travel Stall CRM Roadmap Tier P3, item 14).

**Audience:** product (DD calls on model selection + cost budget +
customer-visible policy), GS engineering (8 new task classes + UI
surfaces), ops (cost monitoring + feedback-loop adoption), Travel Stall
+ Enhanced Wellness operators (end-user-facing suggestion adoption).

**Sister documents:**
[PRD_AI_CALLING_CALLIFIED.md](PRD_AI_CALLING_CALLIFIED.md) (voice channel
+ call-summary task class — separate scope),
[PRD_PASSPORT_OCR.md](PRD_PASSPORT_OCR.md) (passport-ocr task class —
separate scope, vendor-specific not LLM-router-resident),
[PRD_TRAVEL_DIAGNOSTIC.md](PRD_TRAVEL_DIAGNOSTIC.md) (personalised-PDF
task class — already in router, customer-visible AI surface).

---

## 1. Background

The CRM has grown AI surfaces organically over v3.1 → v3.7: talking-points
generator (Claude Opus via llmRouter), AI lead scoring (rule-based +
optional Gemini fallback), AI deal insights cron (`dealInsightsEngine.js`,
6-hr cadence), sentiment cron (`sentimentEngine.js`, 15-min cadence),
junk-lead classification (`leadJunkFilter.js` — rules + optional Gemini
fallback), AI-drafted personalised-recommendations PDF (Travel Stall
TS18 SHELL). Each landed independently; there is **no unified policy** on
model selection, cost budget, observability, hallucination guardrails, or
customer-visible vs operator-only positioning.

The Travel Stall CRM Roadmap (Tier P3, item 14 — filed as GH #909)
explicitly flags THREE AI surfaces that don't exist today:

1. **Inbox: "Draft reply" button** on incoming email/WhatsApp using
   contact history + last quote/itinerary as context (operator-side).
2. **Reports: natural-language "Ask your data" box** on top of the
   Query Builder (operator-side).
3. **Diagnostics: feed lead-tier output into Sequence selector** —
   Premium-tier → Hot-lead sequence; Entry-tier → Nurture sequence
   (automation routing, operator-invisible).

Beyond #909's three, the Travel vertical reveals 5 more surfaces that
have come up in stakeholder conversations but aren't tracked as separate
issues: AI-suggested **upsells on itineraries**, AI-extracted **insights
from voice calls** (depends on PRD_AI_CALLING_CALLIFIED), AI-suggested
**next-best-action on stuck deals**, AI-personalised **destination
recommendations from diagnostic** (already SHIPPED as TS18 PDF), and
AI auto-categorise + canned-response suggest on **incoming support
tickets**.

This PRD unifies all of them under one task-class catalog, one cost
policy, one observability dashboard, and one set of hallucination
guardrails — so the next 8 surfaces ship with shared infrastructure
instead of repeating the per-feature scaffold pattern.

### 1.1 Source attribution

- **GH #909** (filed by nilimeshnayak-max from Travel Stall CRM gap audit)
  — names the 3 inbox / reports / diagnostics surfaces above.
- **Travel Stall CRM — Implementation & Modification Roadmap** (Google
  Doc) — Tier P3, item 14 — same 3 surfaces, slightly expanded.
- **PRD §9.1** ([TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) lines 700-708,
  Q11 locked) — pinned the per-task model routing table; this PRD
  extends the table with 8 new task classes.
- **GS engineering observations** (commit history `backend/lib/llmRouter.js`
  + `backend/cron/dealInsightsEngine.js` + `backend/cron/sentimentEngine.js`
  + `backend/lib/leadJunkFilter.js`) — scattered shipped AI features
  whose observability / cost-tracking / guardrails aren't unified.
- **Stakeholder conversations** with Yasin (Travel ops) + Rishu (Enhanced
  Wellness) — surfaced the upsell / next-best-action / ticket-categorize
  asks not yet filed as issues.

### 1.2 Existing AI infrastructure (do NOT rebuild)

| Component | File | Status |
|---|---|---|
| LLM router | [backend/lib/llmRouter.js](../backend/lib/llmRouter.js) | SHIPPED — STUB MODE, real-mode swap cred-blocked |
| Task taxonomy | `TASK_ROUTING` const | SHIPPED — 7 tasks; this PRD adds 8 |
| Cost telemetry | `LlmCallLog` model (schema.prisma:1213) | SHIPPED — fire-and-forget per call |
| Admin spend dashboard | `routes/admin/llm-spend.js` + `LlmSpend.jsx` | SHIPPED tick #21 |
| Lead-junk classifier | [backend/lib/leadJunkFilter.js](../backend/lib/leadJunkFilter.js) | SHIPPED — rules + Gemini fallback |
| Deal insights cron | [backend/cron/dealInsightsEngine.js](../backend/cron/dealInsightsEngine.js) | SHIPPED — 6-hr cadence |
| Sentiment cron | [backend/cron/sentimentEngine.js](../backend/cron/sentimentEngine.js) | SHIPPED — 15-min cadence |
| Talking-points endpoint | `routes/travel_diagnostics.js` | SHIPPED — TS18 PDF + form-vs-call |

The router is **STUB MODE** today — synthetic responses on every call so
downstream consumers can build + test without external API keys. Real-mode
swap is a per-provider `if (apiKey) return realProviderCall(...)` branch
inside `routeRequest()`. Cred chase Q-AI-1 through Q-AI-3 below unblock
the swap.

---

## 2. Use cases (12)

1. **Stuck-deal next-best-action.** Sales rep opens a deal that's been
   in `Negotiation` >14 days. AI panel suggests: "Call customer X (last
   touch 9 days ago)" / "Send follow-up template Y (worked on 73% of
   similar deals)" / "Offer 5% discount (deals at this stage close 2.3×
   more often with discount)."
2. **AI-drafted reply (inbox).** Sales rep reviews an incoming customer
   message (email or WhatsApp). AI drafts 3 reply variants in the
   operator's historical tone, using contact history + last quote/
   itinerary as context. (GH #909 surface 1.)
3. **Itinerary upsell suggest.** Operator builds a 5-day Goa itinerary.
   AI panel suggests: "Add 1 extra night at Property X (95% of similar
   bookings extend)" / "Add city tour (avg margin +₹4,800)" / "Upgrade
   to Sea View room (avg margin +₹12,400)."
4. **Personalised destination recs PDF.** Customer completes Travel Stall
   diagnostic quiz. AI generates 3-5 personalised destination recs in
   PDF form using diagnostic tier + budget + dates. (Already SHIPPED
   as TS18 SHELL; included for completeness.)
5. **Live-call objection counter.** Telecaller on call. AI summarises
   live transcript every 30s, surfaces objections raised ("price is too
   high" / "competitor is cheaper" / "need to think") + counter-arguments
   drawn from playbook + similar-deal history.
6. **Lead-cluster intent segmentation.** Marketing lead reviews last
   month's leads. AI clusters by intent (`shopping` / `researching` /
   `comparing` / `ready-to-buy`) + recommends segmentation rules.
7. **Ticket auto-categorise.** Support ticket arrives. AI auto-tags
   (`billing` / `technical` / `refund-request` / `cancellation` /
   `general-query`) + suggests the highest-confidence canned response
   for one-click reply.
8. **Operator weekly digest.** Friday 17:00 IST email. AI summarises
   tenant's pipeline health: leads in / out / stuck / churned, top 3
   risk flags, top 3 opportunities, 1-line narrative each.
9. **Sub-agent quote margin flag.** Sub-agent submits a quote at 4%
   margin. AI flags "this is below your tier average (8.5%) and below
   the supplier's published floor (6%); consider raising to ≥6%."
10. **Mid-trip change refund-or-credit suggest.** Customer requests
    cancellation 5 days before departure. AI surfaces the relevant row
    from the cancellation table + suggests "policy says 50% refund;
    given customer's tier-A status + 3 prior bookings, consider full
    credit-note instead — historical win-back rate is 78% on credit-note
    vs 23% on partial refund."
11. **Passport-OCR auto-fill.** Operator uploads 30 student passport
    scans. AI (via vendor — Google Document AI / Azure Form Recognizer)
    extracts 5 fields per passport. (Separate task class — `passport-ocr`
    — uses external OCR not LLM router; tracked in
    [PRD_PASSPORT_OCR.md](PRD_PASSPORT_OCR.md).)
12. **Natural-language reports.** User types "show me revenue by
    sub-brand last quarter" into Query Builder's "Ask your data" box.
    AI parses → SQL → result set → chart suggestion. (GH #909 surface 2.)
13. **Diagnostic → sequence routing.** Customer completes diagnostic
    quiz → AI extracts tier (Premium / Mid / Entry) → routes to matching
    Sequence (Hot-lead / Nurture / Long-tail). (GH #909 surface 3.)

---

## 3. Functional requirements

### FR-3.1 Task-class catalog (extend LLM router)

- **FR-3.1.a** Existing 7 task classes pinned in `TASK_ROUTING`:
  `search`, `citation`, `reasoning`, `talking-points`, `form-vs-call`,
  `bulk-text`, `call-summary`. Keep as-is — do NOT renumber.
- **FR-3.1.b** Add 8 NEW task classes:
  | Task class | Primary model | Fallback | Token budget | Surface |
  |---|---|---|---|---|
  | `next-best-action` | claude-opus-4-7 | gpt-4 | 2K in / 1K out | Deal page sidebar |
  | `inbox-reply-draft` | claude-opus-4-7 | gpt-4 | 4K in / 1K out | Inbox composer |
  | `upsell-suggest` | claude-opus-4-7 | gpt-4 | 2K in / 800 out | Itinerary builder |
  | `objection-counter` | gemini-flash | claude-haiku | 3K in / 600 out | Live-call panel |
  | `lead-cluster` | claude-opus-4-7 | gpt-4 | 8K in / 2K out | Lead audit page |
  | `ticket-categorize` | gemini-flash | claude-haiku | 1K in / 200 out | Ticket arrival hook |
  | `weekly-digest` | claude-opus-4-7 | gpt-4 | 4K in / 2K out | Email cron Fri 17:00 |
  | `nlq-to-sql` | claude-opus-4-7 | gpt-4 | 1K in / 500 out | Query Builder Ask-your-data |
- **FR-3.1.c** Each task definition lives in `TASK_ROUTING` (existing
  pattern). Adding a new task is a code-only change — no schema
  migration (per LlmCallLog comment).
- **FR-3.1.d** System-prompt template per task lives in
  `backend/lib/llmPrompts/<task>.js` (new directory). Templates are
  vetted by product + ops before first ship; changes go through PR.

### FR-3.2 Model-selection policy

- **FR-3.2.a** Per-task default model (the `primary` field in
  `TASK_ROUTING`) is the ship-default. Admins can override per-tenant
  via a `Tenant.aiModelOverrides` JSON column (new — `tenantId, task,
  primaryModel`).
- **FR-3.2.b** Fallback chain fires on (i) rate-limit (HTTP 429),
  (ii) provider 5xx, (iii) timeout >10s. Falls back ONCE; if fallback
  also fails, surface friendly "AI temporarily unavailable" + log to
  Sentry.
- **FR-3.2.c** Cost-tier policy: `Tenant.aiTier ∈ {free, starter, pro}`.
  Free → Gemini-flash only (lowest cost). Starter → Gemini-flash +
  claude-haiku. Pro → all models including claude-opus-4-7 + gpt-4.
- **FR-3.2.d** Cred check at boot: `llmEnabled(task)` returns false
  for tasks whose primary's API key isn't present. UI surfaces
  "AI feature unavailable — admin needs to configure API key" in the
  affected panel (don't crash, degrade gracefully).

### FR-3.3 Observability + cost tracking

- **FR-3.3.a** LlmCallLog already shipped — every call emits a row
  with `task, model, tokens_in, tokens_out, costEstimate, stub,
  userId?, surface?, errorMessage?`. Keep as-is.
- **FR-3.3.b** Per-tenant monthly cost report at
  `GET /api/admin/llm-spend` (already SHIPPED tick #21). Extend with
  per-task breakdown + per-user breakdown.
- **FR-3.3.c** Per-task latency P50/P95/P99 dashboard (new) at
  `GET /api/admin/llm-latency?task=<X>&from=<D>&to=<D>`. Cron-aggregated
  hourly from raw LlmCallLog (a new `LlmLatencyHourly` rollup table
  to keep query cost bounded).
- **FR-3.3.d** Error-rate alert: when error-rate >10% for any task
  over a rolling 1-hour window, fire `notificationService` alert to
  admin role.
- **FR-3.3.e** Budget warning: when tenant's month-to-date spend
  reaches 80% of `Tenant.aiMonthlyBudgetUsd`, fire toast in admin UI.
  At 100%, throttle (new AI calls return 429 with friendly message).

### FR-3.4 Hallucination guardrails

- **FR-3.4.a** Output validation per task — strictest examples:
  | Task | Validation |
  |---|---|
  | `upsell-suggest` | Suggested SKU must exist in tenant's `Product` table |
  | `next-best-action` | Suggested template-id must exist in `EmailTemplate` |
  | `nlq-to-sql` | Generated SQL must pass parameterised-query check + tenant-scope check before exec |
  | `ticket-categorize` | Category must be in tenant's `TicketCategory` enum |
- **FR-3.4.b** Fact-checking: prompts include ground-truth context
  (deal/contact/itinerary data) at the top, and the LLM is instructed
  to reference only that context. Outputs containing references not
  in the context are flagged as "potentially hallucinated" + suppressed
  if confidence is low.
- **FR-3.4.c** Confidence score: each LLM response is post-processed
  to extract a `confidence ∈ [0,1]` (model is asked to emit it). Low-
  confidence outputs (< 0.6) are suppressed in customer-visible
  surfaces; operator-visible surfaces show them with a "low-confidence"
  badge.
- **FR-3.4.d** Operator feedback loop: every AI suggestion card has
  `👍` / `👎` buttons. Clicks land in `AiFeedbackLog` (new model:
  `id, tenantId, userId, task, suggestionPayload, feedback ∈ {up,
  down}, createdAt`). Aggregated nightly into prompt-tuning recommendations
  (per-task acceptance-rate report).

### FR-3.5 Customer-visible vs operator-only positioning

- **FR-3.5.a** Operator-only by default — every new task class defaults
  to operator-side (suggestions appear to staff, not customers).
- **FR-3.5.b** Customer-visible AI requires explicit per-tenant opt-in
  via `Tenant.customerVisibleAiEnabled = true`. Today, only one task
  is customer-visible: `personalised-pdf` (TS18 PDF).
- **FR-3.5.c** Customer-visible outputs MUST be labeled "AI-generated"
  (transparency requirement — EU AI Act + general operator trust).
  PDF footer / chat bubble label / email signature all carry the badge.
- **FR-3.5.d** Customer-visible task classes are a small, explicit
  allowlist (currently `personalised-pdf` only; future addition needs
  PRD-level review, not a config flip).

### FR-3.6 PII discipline

- **FR-3.6.a** PII redaction BEFORE LLM call where possible. Helper
  `backend/lib/piiRedact.js` masks names / phones / emails / Aadhaar /
  PAN with placeholders (`[NAME_1]`, `[PHONE_1]`, etc.). Caller chooses
  whether to redact (some tasks need the names — e.g. `inbox-reply-draft`
  needs the customer's name to address them personally; others don't
  — e.g. `ticket-categorize`).
- **FR-3.6.b** LlmCallLog never stores raw prompt text — only token
  counts + the task class + the redaction-applied flag. PII discipline
  is a CRM-level invariant, not a per-feature opt-in.
- **FR-3.6.c** Per-tenant data-residency: EU tenants (`Tenant.country ∈
  EU_27`) route to EU LLM endpoints when available (OpenAI EU /
  Anthropic EU region / Gemini EU). Today only the US endpoints are
  in `ENV_FOR_MODEL`; EU-residency cred is cred-chase Q-AI-5.

### FR-3.7 UI surfaces

- **FR-3.7.a** Per-page AI panel — sidebar drawer on Deal / Quote /
  Itinerary / Ticket pages. Surfaces task-relevant suggestions inline.
- **FR-3.7.b** Suggestion cards: "AI recommends X" with one-click
  apply button + `👍` / `👎` feedback + "why?" expand showing the
  ground-truth context the LLM used.
- **FR-3.7.c** Inline drafting: "Draft reply with AI" button on email/
  chat composer (GH #909 surface 1). Produces 3 variants; user picks.
- **FR-3.7.d** Weekly digest email (GH #909 not direct but related):
  Friday 17:00 IST cron sends per-operator pipeline summary.
- **FR-3.7.e** "Ask your data" box on Query Builder (GH #909 surface 2):
  natural-language input → SQL preview → result + chart suggestion.

### FR-3.8 Diagnostic-to-sequence routing (GH #909 surface 3)

- **FR-3.8.a** When diagnostic quiz completes, `TravelDiagnostic.tierBand`
  is computed (already SHIPPED). Add `DiagnosticTierSequenceRule`
  (new model: `id, tenantId, tierBand ∈ {premium, mid, entry, junk},
  sequenceId, createdAt`).
- **FR-3.8.b** Diagnostic-completion hook fires `eventBus.emit('diagnostic.
  completed', { diagnosticId, contactId, tierBand })`. New listener
  `diagnosticSequenceRouter` looks up the rule for `(tenantId, tierBand)`
  + enrolls the contact in the matching sequence.
- **FR-3.8.c** Admin UI under `/settings/travel/diagnostic-routing` shows
  the rule list + edit form.

---

## 4. Non-functional requirements

- **NFR-4.1 Latency.** In-flight suggestions (next-best-action, inbox-
  reply-draft, upsell-suggest, objection-counter) MUST meet <3s P95. Batch
  workloads (weekly-digest, lead-cluster, personalised-pdf) <30s P95.
- **NFR-4.2 Cost cap.** Per-tenant monthly budget MUST be enforced —
  hard throttle at 100% of `Tenant.aiMonthlyBudgetUsd`. Free-tier tenants
  default to $0 (AI features unavailable unless admin sets a budget).
- **NFR-4.3 Fallback availability.** If primary model unavailable,
  fallback within 10s; if all fail, surface "AI temporarily unavailable"
  toast (don't block the operator's primary task).
- **NFR-4.4 Audit log.** Every operator-applied AI suggestion lands in
  `AuditLog` with action=`ai_suggestion_applied`, the task class, and
  the suggestion id — so we can measure adoption + accuracy
  retrospectively.
- **NFR-4.5 PII never logs.** LlmCallLog has zero raw prompt text;
  payload contents NEVER leave the request envelope; structured logs
  only carry token counts + cost + routing reason.
- **NFR-4.6 Stub mode parity.** STUB MODE responses (no real API keys)
  MUST match the real-mode envelope shape (`{ text, finishReason, usage,
  model, stub: true }`) so consumers can build + test without external
  dependencies.

---

## 5. Hand-over requirements / cred chase / design decisions

### Design decisions (PRODUCT, not engineering)

- **DD-5.1 Default model per task class.** The table in FR-3.1.b is
  the ship-default; does product agree with the model choices?
  (Claude vs GPT vs Gemini per task — locked by Q11 of TRAVEL_CRM_PRD.md
  for the existing 7 tasks; the 8 new tasks need DD-5.1 sign-off.)
- **DD-5.2 Cost budget per tenant — flat monthly, per-task, or
  pay-as-you-go?** FR-3.2.c proposes a 3-tier flat (`free / starter /
  pro`). Alt 1: per-task budgets (more granular but harder to communicate).
  Alt 2: pay-as-you-go (no budget cap, monthly invoice). Need product
  decision; pricing-model implication.
- **DD-5.3 Customer-visible AI: operator opt-in or per-tenant opt-in?**
  FR-3.5.b proposes per-tenant. Alt: operator-side default, with a
  customer toggle in the customer portal. Need product call —
  regulatory implication for EU tenants (EU AI Act).
- **DD-5.4 Operator-feedback storage: per-tenant data or shared
  learning?** AiFeedbackLog (FR-3.4.d) — should feedback aggregate
  cross-tenant (faster prompt tuning) or stay per-tenant (data
  isolation)? Default proposal: per-tenant; aggregate ONLY for the
  GS-managed shared prompts not customer data.
- **DD-5.5 PII redaction strategy.** FR-3.6.a proposes rule-based
  redact via `piiRedact.js`. Alt: send sanitized-via-LLM (use a smaller
  LLM to redact, then send redacted to the larger LLM). Default
  rule-based — cheaper, deterministic, auditable.
- **DD-5.6 Data residency for EU tenants.** FR-3.6.c — which EU
  endpoint? OpenAI EU + Anthropic EU + Gemini EU are all available
  but pricing differs. Product + finance decision.

### Cred chase

- **Q-AI-1** OpenAI API key for GPT-4 — held by Travel Stall, dropped
  to `SupplierCredential category='llm-key' supplier='openai'`.
- **Q-AI-2** Anthropic API key for Claude Opus + Claude Haiku.
- **Q-AI-3** Google API key for Gemini Pro + Gemini Flash.
- **Q-AI-4** PII-redaction tooling — Presidio (Microsoft open-source)
  vs custom rule-based regex. Default custom rule-based (no extra dep);
  Presidio is the upgrade path if PII surface broadens.
- **Q-AI-5** EU-region endpoints — OpenAI EU + Anthropic EU + Gemini
  EU API keys. Needed only when first EU tenant lands; not a blocker
  for IN / US launch.

### Vendor docs

- OpenAI API: https://platform.openai.com/docs
- Anthropic API: https://docs.anthropic.com
- Google AI Studio: https://aistudio.google.com/app/apikey

---

## 6. Acceptance criteria

- **AC-6.1** Open a deal in `Negotiation` stage >14 days → AI
  next-best-action card appears within 2s. Card shows 3 suggestions,
  each with `👍` / `👎` + "why?" expand.
- **AC-6.2** Click "Draft reply with AI" on an incoming inbox message
  → 3 reply variants returned within 3s. Each variant references the
  contact's last quote/itinerary as context.
- **AC-6.3** Build an itinerary, click "AI upsell suggest" → 2-3
  upsell SKUs returned, each validated against the tenant's `Product`
  table (no hallucinated SKUs).
- **AC-6.4** Every AI call writes one `LlmCallLog` row with redacted
  prompt context + token counts + cost estimate. Zero raw PII in any
  log row.
- **AC-6.5** `GET /api/admin/llm-spend` shows tenant's month-to-date
  spend with per-task breakdown + per-user breakdown.
- **AC-6.6** When tenant's MTD spend reaches 100% of
  `aiMonthlyBudgetUsd`, new AI calls return HTTP 429 with body
  `{ error: 'BUDGET_EXCEEDED', message: 'AI budget exceeded. ...' }`.
- **AC-6.7** Customer-visible AI output (currently only the TS18 PDF)
  has "AI-generated" label visible. Operator-visible suggestions do
  NOT need the label (they're internal tools).
- **AC-6.8** Click `👎` on a suggestion → `AiFeedbackLog` row created.
  Nightly cron aggregates feedback into per-task acceptance-rate report
  visible at `/admin/llm-feedback`.
- **AC-6.9** Diagnostic quiz completion → `eventBus.emit('diagnostic.
  completed')` fires → `diagnosticSequenceRouter` enrolls contact in
  the matching sequence per `DiagnosticTierSequenceRule`. Verify via
  end-to-end: complete quiz, check `SequenceEnrollment` row appears.
- **AC-6.10** "Ask your data" natural-language input → SQL preview →
  result returned within 5s. SQL preview is parameterised + tenant-
  scoped (no cross-tenant data leak possible).

---

## 7. Out of scope

- **Voice synthesis.** Outbound voice + text-to-speech are separate;
  tracked in [PRD_AI_CALLING_CALLIFIED.md](PRD_AI_CALLING_CALLIFIED.md).
- **Image generation.** No use case yet for generating images (logos,
  banners). Out of scope for v1.
- **Embeddings-based semantic search.** Search uses keyword today;
  embeddings-based search is a future scope (tracked separately).
- **Custom model fine-tuning.** Fine-tuning per-tenant prompts is
  Phase 2 — needs >6 months of feedback-loop data first.
- **Self-hosted models.** OpenWeight models (Llama, Mistral) on
  customer infra — out of scope until a tenant explicitly demands data
  residency that the EU endpoints can't satisfy.
- **Multi-modal (vision) inputs.** Passport-OCR uses external vendor
  (Google Document AI / Azure Form Recognizer), not LLM router;
  tracked in [PRD_PASSPORT_OCR.md](PRD_PASSPORT_OCR.md).

---

## 8. Dependencies

- **`backend/lib/llmRouter.js`** (existing) — extended with 8 new task
  classes per FR-3.1.b.
- **`LlmCallLog`** model (existing, schema.prisma:1213) — extended with
  no new columns; `surface` field captures the new task taxonomy.
- **`Tenant.aiTier` + `Tenant.aiMonthlyBudgetUsd` + `Tenant.customer
  VisibleAiEnabled` + `Tenant.aiModelOverrides`** (new columns on
  existing model).
- **`AiFeedbackLog`** (new model per FR-3.4.d).
- **`LlmLatencyHourly`** (new rollup table per FR-3.3.c).
- **`DiagnosticTierSequenceRule`** (new model per FR-3.8.a).
- **`backend/lib/piiRedact.js`** (new helper per FR-3.6.a).
- **`backend/lib/llmPrompts/<task>.js`** (new directory of system-prompt
  templates per FR-3.1.d).
- **`notificationService`** (existing) — used for budget-warning + error-
  rate alerts.
- **`eventBus`** (existing) — used for diagnostic-completion routing.

---

## 9. Open questions

- **OQ-9.1** Operator feedback loop — how is it surfaced to admin? Raw
  CSV export of `AiFeedbackLog`? UI dashboard with per-task acceptance
  rates? Both? (Default proposal: UI dashboard + CSV export button.)
- **OQ-9.2** Customer-visible AI in regulated regions (EU AI Act) —
  additional disclosures beyond the "AI-generated" badge? (Lawyer
  review needed before first EU tenant lands.)
- **OQ-9.3** AI auto-apply policy. Never? Never-without-confirm?
  For-low-impact-suggestions-only? (Default proposal: never — operator
  always reviews + approves; auto-apply for `ticket-categorize` only
  where the cost of an error is low.)
- **OQ-9.4** Multi-language support — separate model per language
  or single multilingual model? (Default proposal: single multilingual
  — all 3 providers handle 30+ languages reasonably well; per-language
  prompts only where the tone is critical, e.g. `inbox-reply-draft`.)
- **OQ-9.5** Garbled / off-topic LLM responses — retry + log, or surface
  the garble to the operator? (Default proposal: retry once with
  fallback model, log both attempts to LlmCallLog, then surface
  "AI temporarily unavailable" if both fail.)
- **OQ-9.6** Sub-tenancy AI model overrides — can a sub-brand (e.g.
  TMC vs RFU under the same Travel tenant) have different model
  preferences? (Default proposal: yes, via `Tenant.aiModelOverrides`
  JSON keyed by sub-brand-id.)
- **OQ-9.7** What's the latency budget for an LLM call that BLOCKS the
  user (vs background AI like deal-insights cron)? FR-3.7's "3s P95"
  is aggressive — does the operator hard-wait, or is the UI optimistic
  ("AI is thinking..." spinner with cancel)?

---

## 10. Status snapshot

- **Current:** scattered AI features SHIPPED today (7 task classes
  routed; talking-points, lead-scoring, deal-insights cron, sentiment
  cron, junk-lead classifier, TS18 personalised-PDF) — all use
  `llmRouter.js` in STUB MODE.
- **This PRD:** WRITTEN 2026-05-23 (tick #22).
- **Path to implementation:** 15-30 engineering days depending on
  DD-5.1 sign-off + cred chase Q-AI-1/2/3 resolution. Phasing proposal:
  - **Phase 1 (5-7 days):** Wire real-mode swap into router; ship
    `next-best-action` + `inbox-reply-draft` + `upsell-suggest` panels.
  - **Phase 2 (5-7 days):** Ship `ticket-categorize` + `weekly-digest`
    + `lead-cluster` + `objection-counter`.
  - **Phase 3 (3-5 days):** Ship `nlq-to-sql` + diagnostic routing
    (GH #909 surfaces 2 + 3).
  - **Phase 4 (2-3 days):** Latency dashboard + budget-warning UI +
    `AiFeedbackLog` aggregation report.
- **Blocks:** DD-5.1 (model selection sign-off) + DD-5.2 (cost-budget
  model) gate Phase 1 backend impl; remaining DDs gate later phases.
- **Sibling PRDs:**
  [PRD_AI_ERA_CRM_REBUILD.md](PRD_AI_ERA_CRM_REBUILD.md) (umbrella
  vision — long-form; this PRD is feature-level),
  [PRD_AI_CALLING_CALLIFIED.md](PRD_AI_CALLING_CALLIFIED.md) (voice
  channel + `call-summary` task class — separate scope),
  [PRD_PASSPORT_OCR.md](PRD_PASSPORT_OCR.md) (OCR task class — vendor-
  specific, not LLM-router-resident),
  [PRD_TRAVEL_DIAGNOSTIC.md](PRD_TRAVEL_DIAGNOSTIC.md) (diagnostic
  → tier → sequence-routing depends on this PRD's FR-3.8).
- **Refs:** GH #909 (Travel Stall Tier P3 item 14).
