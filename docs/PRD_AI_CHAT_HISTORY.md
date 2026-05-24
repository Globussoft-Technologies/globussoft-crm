# PRD — Unified In-App AI / WhatsApp AI Chat History (Audit + Compliance + Operator-Recall Surface)

**Status:** NOT STARTED — PRD draft only; design call required (the LlmCallLog "no prompt/response body" gap below changes the implementation shape materially)
**Source:** GH #855 — [Gap][AI-001] In-app AI/WhatsApp AI chat history missing (AdsGPT/Callified are external)
**Tier:** P3 — Operator audit-trail / compliance + recall surface (no traffic-blocked workflow today; LlmCallLog rows accumulate silently behind the scenes; no human-facing view exists. Material when wellness compliance audits demand "what AI told whom"; material when an operator wants to recall "what AI talking-point did I get for this lead last Tuesday")
**Authored:** 2026-05-25 (tick #192 / Agent B, autonomous overnight cron arc — Bonus PRD #6 in this batch wave)
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8) · `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment governance, D9) · `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, D10) · `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery surface, D11) · `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, D12)
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D13**; see §10.
**Cred dependency:** none external. Pure internal aggregation + new admin page + (CRITICAL) LlmCallLog schema extension to persist prompt + response bodies.

---

## §1 Background + source attribution

The CRM today has **multiple in-app AI consumption surfaces** but **zero unified human-facing history view**. AI traffic flows through three independent storage shapes:

1. **`LlmCallLog`** at [backend/prisma/schema.prisma:1250](../backend/prisma/schema.prisma#L1250) — captures **metadata only**: `task`, `model`, `promptTokens`, `completionTokens`, `costEstimate`, `stub`, `surface` (free-form caller tag), `userId`, `errorMessage`, `createdAt`. Used by the LLM router (`backend/lib/llmRouter.js`) for cost-attribution. **DOES NOT STORE prompt or response BODIES.** Only the `errorMessage` column carries any free-text payload. The 5 known LLM-router consumers writing here:
   - talking-points generation (sales call assistance)
   - form-vs-call comparison (lead intake quality scoring)
   - itinerary-draft generation (travel-vertical Phase 1)
   - religious-guidance generation (travel-vertical Umrah sub-brand)
   - personalised-destinations (travel-vertical recommendation engine)

2. **`ChatbotConversation`** at [backend/prisma/schema.prisma:2076](../backend/prisma/schema.prisma#L2076) — captures **full transcripts** via `messages String @db.LongText // JSON` (a JSON array of message objects). Per-chatbot visitor sessions on the public landing-page widget. Storage is messy (LongText, no normalised per-message rows), but the data is present.

3. **`WhatsAppMessage`** at [backend/prisma/schema.prisma:1468](../backend/prisma/schema.prisma#L1468) — captures **per-message bodies** in `body String? @db.Text`. WhatsApp inbound + outbound traffic. Per `Wave 2 Agent KK` (2026-05-21), 2-way messaging now threads via `WhatsAppThread`. **AI-auto-reply attribution is not currently a column** — there's no `triggeredByAi` / `aiCallLogId` / `aiResponse` linkage; the auto-reply just lands as an outbound message indistinguishable from a human-typed reply.

Per GH issue #855 verbatim:

> In-app AI/WhatsApp AI chat history missing (AdsGPT/Callified are external)
>
> **Gap:**
> - The CRM uses AI for talking-points / form-vs-call / itinerary-draft / religious-guidance / personalised-destinations / chatbot flows / WhatsApp auto-replies. These are IN-APP AI surfaces.
> - There is no unified page where an operator (USER / MANAGER / ADMIN) can see "show me all AI interactions that touched lead X" / "show me my AI history for the last 7 days" / "show me all AI calls this tenant burned this month".
> - The `LlmCallLog` table accumulates rows behind every router call, but no human-facing surface exists.
> - The `ChatbotConversation` table stores full visitor transcripts, but no operator can browse them outside the chatbot page itself.
> - When a WhatsApp inbound triggers an AI auto-reply, the exchange disappears into the regular WhatsApp inbox — no AI-tag, no audit indicator, no recall surface.
> - Sister Globussoft products (**AdsGPT** for marketing AI, **Callified.ai** for voice AI) have their own external chat histories — those are NOT in scope here.
>
> **Why it matters:**
> - **Compliance:** wellness clinics asked for DSAR exports must include "what AI told the patient" — today that data is fragmented across LlmCallLog (no bodies), WhatsAppMessage (mixed AI + human), and ChatbotConversation (LongText JSON). No one-shot extraction.
> - **Operator recall:** a sales rep asks "I got an AI talking-point for this lead last Tuesday — what was it?" — no answer today.
> - **Hallucination spot-checks:** ADMIN wants to scan recent AI outputs for PII leaks or factual errors — no surface.
> - **Per-surface debugging:** when a customer complains "your bot told me X", today the operator has zero ability to verify what the AI actually said.

### Today's denormalised state, in detail

| Surface                          | Storage                                          | Prompt stored? | Response stored? | User attribution | Lead/Contact link |
|----------------------------------|--------------------------------------------------|----------------|------------------|------------------|-------------------|
| talking-points                   | LlmCallLog (metadata only)                       | NO             | NO               | userId           | NONE              |
| form-vs-call                     | LlmCallLog (metadata only)                       | NO             | NO               | userId           | NONE              |
| itinerary-draft                  | LlmCallLog (metadata only)                       | NO             | NO               | userId           | NONE              |
| religious-guidance               | LlmCallLog (metadata only)                       | NO             | NO               | userId           | NONE              |
| personalised-destinations        | LlmCallLog (metadata only)                       | NO             | NO               | userId           | NONE              |
| chatbot conversation             | ChatbotConversation.messages (LongText JSON)     | YES            | YES              | NULL (anonymous) | contactId         |
| WhatsApp AI auto-reply           | WhatsAppMessage.body (no AI tag)                 | YES (inbound)  | YES (outbound)   | userId           | contactId         |
| AdsGPT (marketing AI)            | EXTERNAL — sister product owns history          | n/a            | n/a              | n/a              | n/a               |
| Callified (voice AI)             | EXTERNAL — sister product owns history          | n/a            | n/a              | n/a              | n/a               |

The structural cost: **5 of the 7 in-app surfaces capture metadata but no prompt/response bodies**, which means a unified history page **cannot show what AI actually said** for those surfaces without a schema extension. This is the dominant design-decision in §5 (DD-5.2).

### Why this is a P3, not a P1

Operators don't complain about this today because they never knew the data existed in fragmented form. The pain surfaces when:

- A compliance auditor asks "list every AI-mediated patient interaction for tenant X" (today: cannot produce; would need to manually join LlmCallLog + ChatbotConversation + WhatsAppMessage with AI-flag heuristics)
- A sales rep asks "what talking-point did AI give me on Tuesday for lead X" (today: cannot recall; the metadata row exists in LlmCallLog but the response body is gone)
- A customer complains "your bot told me appointment is at 3pm but my visit shows 4pm" (today: cannot verify; ChatbotConversation is browsable but the operator doesn't know which conversation matches; WhatsApp auto-reply has no AI tag at all)
- A finance lead asks "what's our LLM spend by user this month" (today: `/api/admin/llm-spend` does aggregation, but no drill-down to specific call rows)

**The risk class is "audit gap + recall debt under operator + compliance scrutiny", not capability.** Once a wellness clinic faces its first formal DSAR demand naming AI interactions, this becomes traffic-blocked.

### Prior art

- **HubSpot Sales Copilot history** ([https://knowledge.hubspot.com/copilot/copilot-history](https://knowledge.hubspot.com/copilot/copilot-history)) — per-user history of AI suggestions + accepted/rejected outcomes. Includes prompt + response. Closest match.
- **Salesforce Einstein Trust Layer audit log** ([https://help.salesforce.com/s/articleView?id=ai.einstein_trust_layer.htm](https://help.salesforce.com/s/articleView?id=ai.einstein_trust_layer.htm)) — per-tenant audit + admin-facing AI-usage browser. Mature compliance shape.
- **Intercom Fin AI Inbox** ([https://www.intercom.com/help/en/articles/8205718-fin-ai-conversation-history](https://www.intercom.com/help/en/articles/8205718-fin-ai-conversation-history)) — per-conversation history of AI replies with thumbs-up/down feedback loop. Sets the bar for "AI-flagged messages in a regular inbox" UX pattern.
- **Globussoft sister product** `Callified.ai` has a per-call transcript + AI-utterance log (external — out of THIS PRD's scope but the UX pattern is reusable on the in-app side).

### Source attribution

- GH issue #855 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/855](https://github.com/Globussoft-Technologies/globussoft-crm/issues/855)
- LlmCallLog schema at [backend/prisma/schema.prisma:1250-1277](../backend/prisma/schema.prisma#L1250-L1277) (header comments document the task taxonomy + caller-context fields)
- LLM router at `backend/lib/llmRouter.js` (per CLAUDE.md grouping; centralised LLM dispatch + cost attribution)
- ChatbotConversation at [backend/prisma/schema.prisma:2076-2087](../backend/prisma/schema.prisma#L2076-L2087)
- WhatsAppMessage at [backend/prisma/schema.prisma:1468-1497](../backend/prisma/schema.prisma#L1468-L1497) (Wave 2 Agent KK added 2-way threading)
- `/api/admin/llm-spend` endpoint at `backend/routes/admin.js` — current consumer of LlmCallLog cost aggregation
- `shouldMaskForViewer` at [backend/routes/wellness.js:43](../backend/routes/wellness.js#L43) — canonical PHI-masking pattern this PRD's read surface must mirror
- Related: `PRD_INTEGRATIONS_HUB.md` (D11) — AI surfaces should also appear as integration cards in the hub for at-a-glance status

---

## §2 Use cases

1. **USER reviews their own AI talking-points history for a specific Lead.** Sales rep "Priya" worked Lead "Acme Corp" three times last week — each time invoked the talking-points AI. Today she has no recall of what AI suggested vs what she actually said in the call. She navigates `/ai-history` → filters by `me + Lead = Acme + last 7 days` → sees 3 LlmCallLog rows with timestamps + surface tag `talking-points-regen` + (post-DD-5.2-resolution) the actual prompt + response bodies. Realises one of the suggestions was a hallucination ("Acme is in Pune" — Acme is actually in Mumbai); files a feedback note.

2. **ADMIN audits AI cost + usage for the tenant — total spend, per-user breakdown, per-surface breakdown.** Finance lead asks "what's our LLM bill looking like this month?". ADMIN navigates `/ai-history` → switches to "Cost Breakdown" tab → date range = current month → sees totals by surface (talking-points = 12,400 calls / $34.20; chatbot = 8,200 calls / $19.80; WhatsApp auto-reply = 410 calls / $0.92; itinerary-draft = 230 calls / $4.10) + per-user top spenders (Priya = 1,840 calls / $5.10; Rohit = 1,620 calls / $4.42 ...) + per-model breakdown (claude-opus = $42.80; gemini-flash = $11.10; perplexity-sonar = $4.20). Exports CSV for the QBR.

3. **ADMIN spot-checks for hallucinations or PII leaks in AI outputs.** Wellness clinic ADMIN has a monthly QA ritual — sample 50 recent AI outputs + scan for medical-advice safety + PII leaks. Today: cannot sample because no surface exists. With `/ai-history`: ADMIN navigates → filters by `surface = talking-points` + `vertical = wellness` + last 30 days → clicks "Sample 50 random" → list view shows truncated prompt + response + reviewer can drill into each via the detail drawer → flags 3 for follow-up via an internal feedback column. Audit log captures the `AI_HISTORY_SPOT_CHECK_SAMPLED` event.

4. **USER searches AI history for "I asked for a recommendation for August Bali trip last week — what was it?".** Travel-vertical agent Rakesh remembers asking the personalised-destinations AI for a "honeymoon Bali August" suggestion for a TravelStall customer but forgot to save the response. Navigates `/ai-history` → search box "Bali August" → 4 entries surface. He clicks the matching row → detail drawer shows full prompt + response + the Lead it was linked to → he copies the suggestion + sends to the customer.

5. **COMPLIANCE produces an audit-trail report of all AI-mediated patient interactions for a DSAR.** Patient "Anjali Sharma" files a DSAR per GDPR. ADMIN navigates `/ai-history` → filters by `patientId = Anjali's-id` → sees 7 entries spanning 4 surfaces (1 chatbot conversation, 3 WhatsApp AI auto-replies, 2 talking-points used by her treating doctor, 1 form-vs-call comparison) → clicks "Export DSAR Bundle" → server generates a structured ZIP containing JSON + CSV of all 7 with full prompt + response bodies (PHI-masked appropriately per the wellness PHI-policy at `project_wellness_phi_policy.md`) + an audit-chain receipt. The export is also written as `AI_HISTORY_DSAR_EXPORTED` to the tamper-evident audit chain.

6. **MANAGER reviews team-wide AI adoption.** "Are my reps actually using the talking-points AI?". Sales manager navigates `/ai-history` → filters by `team` (managed users) + `surface = talking-points` + last 14 days → sees a leaderboard view with calls-per-user + average-cost-per-user + a "last used" timestamp. Identifies that Anika hasn't used talking-points in 12 days → schedules a 1:1 to understand whether the tool isn't helpful or she's forgetting to invoke it.

---

## §3 Functional requirements

### FR-3.1 New unified page: `frontend/src/pages/AiHistory.jsx` mounted at `/ai-history`

- **Route registration** in `frontend/src/App.jsx`. Default mount visible to all roles; RBAC scope per FR-3.8.
- **Sidebar entry** under "Analytics" (generic vertical) / "Reports" group (wellness vertical) / "Reports" (travel vertical). Icon: `lucide-react` `MessageSquare` or `Sparkles`.
- **Three tabs:**
  - **History (default)** — chronological list of AI interactions, filterable + searchable.
  - **Cost Breakdown** — aggregations by surface / user / model / day. Mirrors the existing `/api/admin/llm-spend` endpoint but with richer drill-down.
  - **Audit Log** — read-only stream of `AI_HISTORY_*` audit chain events scoped to the tenant (when + who + what filter / export action).
- **URL state persists filters** — operators can bookmark "my talking-points last 7 days for Acme Corp".
- **Lazy-loaded** via `React.lazy()` per existing App.jsx pattern. ~15-25 KB gzipped.

### FR-3.2 Aggregates from 3 (and conditionally 4) data sources

A new aggregation endpoint at `backend/routes/ai_history.js` (new file) implements a **runtime UNION** strategy per DD-5.1 — no new normalised table in v1. Sources:

1. **`LlmCallLog`** — rows where `tenantId = req.user.tenantId`. Includes the 5 LLM-router surfaces (talking-points / form-vs-call / itinerary-draft / religious-guidance / personalised-destinations) + any future caller that uses `lib/llmRouter.js`.
2. **`ChatbotConversation`** — rows where `tenantId = req.user.tenantId`. Each conversation surfaces as ONE history row (not per-message) with `surface = 'chatbot'`. Drilling into the row opens the message stream from the `messages` JSON.
3. **`WhatsAppMessage`** — rows where `tenantId = req.user.tenantId` **AND a new column `aiCallLogId Int?` is non-null** (FK to LlmCallLog). This requires a schema extension (FR-3.3 — the WhatsApp AI auto-reply path needs to write the LlmCallLog row first, then attach the `aiCallLogId` to the outbound WhatsAppMessage). Without this link, no way to disambiguate AI from human replies.
4. **(Conditional, post-DD-5.5)** Sister-product histories via External API pull — OUT OF V1 per the recommendation; mentioned here for completeness.

### FR-3.3 Schema extension — LlmCallLog gains prompt + response body columns (CRITICAL)

```prisma
model LlmCallLog {
  // ... existing columns unchanged ...

  // NEW: persist prompt + response bodies for history / DSAR / spot-check use.
  // Both nullable — older rows have no bodies; new rows backfill.
  // Storage uses @db.MediumText (~16 MB) — generous for any prompt/response we ship today;
  // largest current consumer (itinerary-draft) is ~6 KB per call.
  prompt   String? @db.MediumText
  response String? @db.MediumText

  // NEW: entity attribution — which Lead / Contact / Patient / Deal did this call relate to?
  // Polymorphic via discriminator + id. Nullable for surfaces that aren't entity-scoped (e.g. bulk-text).
  entityType String? // 'Lead' | 'Contact' | 'Patient' | 'Deal' | NULL
  entityId   Int?

  @@index([tenantId, entityType, entityId])
}
```

`WhatsAppMessage` gains:

```prisma
model WhatsAppMessage {
  // ... existing columns unchanged ...
  aiCallLogId Int?
  aiCallLog   LlmCallLog? @relation(fields: [aiCallLogId], references: [id], onDelete: SetNull)
  @@index([aiCallLogId])
}
```

The LLM router (`lib/llmRouter.js`) is updated to accept optional `{ prompt, response, entityType, entityId }` fields from callers + persist them to LlmCallLog. **All 5 existing consumer surfaces are updated to pass these fields** (FR-3.4).

`ChatbotConversation` requires no schema change — bodies already in `messages` JSON. Entity attribution via existing `contactId` column.

### FR-3.4 Five consumer updates to pass prompt + response + entity context

Each of the 5 LLM-router callers passes the new optional fields:

| Caller file                                            | Surface tag                  | Entity attribution                            |
|--------------------------------------------------------|------------------------------|-----------------------------------------------|
| (deal-detail flows that invoke talking-points)         | `talking-points`             | `{ entityType: 'Deal', entityId: deal.id }`   |
| (lead-intake form-vs-call comparison)                  | `form-vs-call`               | `{ entityType: 'Lead', entityId: lead.id }`   |
| `backend/routes/travel_itineraries.js`                 | `itinerary-draft`            | `{ entityType: 'Lead', entityId: lead.id }`   |
| `backend/routes/travel_diagnostics.js` (or kin)        | `religious-guidance`         | `{ entityType: 'Contact', entityId: c.id }`   |
| `backend/routes/travel_personalised_destinations.js`   | `personalised-destinations`  | `{ entityType: 'Lead', entityId: lead.id }`   |

Plus chatbot flow (`backend/routes/chatbots.js` or service) writes `aiCallLogId` to ChatbotConversation per-message; WhatsApp inbound auto-reply (`backend/routes/whatsapp.js`) writes `aiCallLogId` to the outbound WhatsAppMessage.

### FR-3.5 List view contract

Per-row fields shown in the history list:

- `createdAt` (ISO timestamp, formatted per tenant locale)
- `user` (name from `User.name` via FK join — "Priya Sharma" or "(system)" for unattributed)
- `surface` (e.g. `talking-points`, `chatbot`, `whatsapp-auto-reply`)
- `entityLink` (deep-link to the entity's detail page — Lead/Contact/Patient/Deal — when entityType + entityId are present)
- `promptPreview` (truncated to 100 chars, ellipsised; PHI-masked per FR-3.9)
- `responsePreview` (truncated to 100 chars, ellipsised; PHI-masked per FR-3.9)
- `costUsdCents` (formatted as `$0.0123` or `—` for free / stubbed)
- `model` (e.g. `claude-opus-4-7`, `gemini-flash`, `stub`)
- `stub` (boolean indicator — was this a stub-mode response?)
- `errorBadge` (if `errorMessage IS NOT NULL`, show red dot + hover tooltip)

Default sort: `createdAt DESC`. Server-side paginated at 50 rows per page (the page count can balloon — talking-points alone is multiple-calls-per-rep-per-day).

### FR-3.6 Detail drawer

Clicking a row opens a right-side drawer (preserves the filter context per DD-5.4):

- Full prompt body (rendered as syntax-highlighted code block for system prompts; plain text for user-typed inputs)
- Full response body (rendered the same way; LongText for chatbot conversations rendered as a chat-bubble stream)
- Raw envelope (collapsible JSON view: task / model / tokens in/out / cost / errorMessage / stubbed flag)
- Per-call cost breakdown (input-tokens cost + output-tokens cost + total)
- Linked entity (deep-link button — "Open Lead Acme Corp →")
- "Mark for review" button (writes a per-call internal flag; lightweight feedback for spot-check workflow)

### FR-3.7 Search

- **List-view search:** substring match across `prompt + response + errorMessage` (LIKE-based via MySQL — v1; FTS index Phase 2 per DD-5.3).
- **PHI-redaction toggle for wellness vertical:** when ADMIN searches with PHI-redaction ON (default for wellness), the LIKE query runs against the **redacted** projection (server-side regex strips potential PHI fields before substring match) to avoid leaking PHI through search results.
- **Search box on List tab only** — Cost Breakdown + Audit Log tabs have their own filter shapes.

### FR-3.8 RBAC

- **USER:** Sees only OWN history rows (`LlmCallLog.userId = req.user.userId`). Cannot see other users'. Can see Cost Breakdown limited to own costs. Audit Log tab hidden.
- **MANAGER:** Sees tenant-wide history (`LlmCallLog.tenantId = req.user.tenantId`). All Cost Breakdown. Audit Log tab read-only.
- **ADMIN:** Same as MANAGER + Sister-Product External API key management (Phase 2) + ability to export DSAR bundles (FR-3.10) + manually trigger backfill of older LlmCallLog rows (one-shot script per FR-3.11).

### FR-3.9 PHI-redaction in detail view for wellness vertical

Mirrors the canonical `shouldMaskForViewer` pattern at [backend/routes/wellness.js:43](../backend/routes/wellness.js#L43) — when the requesting viewer (role + tenant.vertical combination) qualifies as "PHI-sensitive viewer", prompt + response bodies are redacted at the server before transit. Regex set masks:

- IN phone numbers (`\d{10}` / `+91\d{10}`)
- Email addresses
- Aadhaar numbers (`\d{4} ?\d{4} ?\d{4}`)
- PAN numbers (`[A-Z]{5}\d{4}[A-Z]`)
- Common Indian first-name + last-name dictionaries (best-effort soft match)

ADMIN can toggle "Show un-redacted" (per-call) if the patient detail requires it for audit — toggling writes an `AI_HISTORY_PHI_UNMASK_VIEWED` audit chain event with reason text.

### FR-3.10 Export

- **CSV per-row download** — operator-triggered from the list view ("Download CSV"). Format: one row per history entry, columns matching FR-3.5 + full prompt + response bodies. CSV size capped at 10,000 rows per export (operator paginates if needed).
- **DSAR bundle export** — ADMIN-only "Export DSAR Bundle" button visible when filter scoped to a single Patient/Contact/Lead. Produces a ZIP with `manifest.json` (entity-keyed) + per-entry full prompt + response + a hash-chain receipt linking to `routes/audit.js` `/verify` chain.

### FR-3.11 Backfill script for older LlmCallLog rows

`backend/scripts/backfill-llm-history-bodies.js` — **one-shot operator-triggered script** that scans existing LlmCallLog rows (older than the schema extension's deploy date) and attempts to backfill prompt + response **from caller-side persistence where available**:

- talking-points: NO source today (was discarded); marks rows as `bodyBackfillStatus = 'unavailable'`
- form-vs-call: NO source today; same
- itinerary-draft: travel-vertical persists drafts on `Itinerary` model → script joins by timestamp + user → fills bodies when matchable
- religious-guidance: similar — opportunistic join via timestamp + entityType
- personalised-destinations: persists in tenant settings cache → join via timestamp

Realistic outcome: ~30-50% of historic rows get bodies backfilled; the rest stay metadata-only (operators see "Body not available — backfill from before persistence shipped"). This is acceptable because the value is forward-going.

### FR-3.12 Audit log integration

New audit chain entity `AI_HISTORY` with actions:

- `AI_HISTORY_VIEWED` — on page load (throttled per existing audit-throttling pattern — once per session-id per 10 min)
- `AI_HISTORY_DRAWER_OPENED` — on detail drawer open (throttled similarly)
- `AI_HISTORY_SEARCHED` — on search box use (throttled)
- `AI_HISTORY_FILTERED` — on filter change (throttled)
- `AI_HISTORY_CSV_EXPORTED` — on CSV download
- `AI_HISTORY_DSAR_EXPORTED` — on DSAR bundle export (NOT throttled — always logged)
- `AI_HISTORY_PHI_UNMASK_VIEWED` — on per-call un-redaction (NOT throttled — always logged + reason text required)
- `AI_HISTORY_MARKED_FOR_REVIEW` — on per-call flag-for-review
- `AI_HISTORY_SPOT_CHECK_SAMPLED` — on "Sample N random" use
- `AI_HISTORY_BACKFILL_TRIGGERED` — on backfill script run

All events go through `backend/lib/audit.js` `writeAudit()` for tamper-evident hashing. Audit Log tab (FR-3.1) reads these back.

---

## §4 Non-functional

- **Per-tenant scoping enforced.** Every read scopes by `req.user.tenantId`. Cross-tenant access impossible (`tenantWhere` helper pattern). ESLint rule blocks `req.body.tenantId` reads.
- **No new aggregation table required for v1.** Aggregates existing models at read-time (DD-5.1 recommendation). A future `AiHistoryEntry` materialised table can ship in Phase 2 if read latency becomes an issue.
- **Performance — LlmCallLog can be 100k+ rows on a busy tenant.** Existing `@@index([tenantId, createdAt])` covers the default chronological-list path. The new `@@index([tenantId, entityType, entityId])` (FR-3.3) covers entity-scoped lookups. Server-side pagination at 50 rows per page keeps payload bounded.
- **List endpoint P95 target: <800ms for tenants with up to 200k LlmCallLog rows + 50k ChatbotConversation rows + 100k WhatsAppMessage rows.** Union runs three queries in parallel (Promise.all); the bottleneck is typically the LongText fetch on ChatbotConversation. Cap chatbot drill-in to "show first 50 messages, load more on scroll" to keep response payload bounded.
- **Cost-attribution aggregation cost (Cost Breakdown tab):** sum of `LlmCallLog.costEstimate` by `surface` / `userId` / `model` for the date range. Existing `/api/admin/llm-spend` already does the surface aggregation; THIS PRD's tab extends with userId + model dimensions. Aggregation is cheap (~50ms on a 100k-row scan; can be cached at 5-minute resolution if needed).
- **PII discipline.** Prompt + response bodies stored in clear by default in the new `MediumText` columns (matches existing schema convention for `WhatsAppMessage.body`, `EmailMessage.body`, `KbArticle.content`, etc. — none of these are encrypted at rest in production; encryption-at-rest is a Phase 3 cross-cutting concern). Read-surface respects existing PHI-masking conventions for wellness vertical. **Plain-text storage is an explicit decision recorded as DD-5.6** — alternative is opt-in `fieldEncryption.js` (AES-256-GCM helper from v3.1 wellness layer) for the new columns; we recommend AGAINST because (a) it complicates the search path significantly (encrypted columns are unsearchable without homomorphic search infra), (b) the existing PHI-masking is sufficient for current compliance scope, (c) the per-tenant `WELLNESS_FIELD_KEY` env var setup overhead is non-trivial.
- **Browser bundle.** New page lazy-loaded; ~15-25 KB gzipped.
- **Mobile responsive.** Table view degrades to card list at <768px. Detail drawer becomes full-screen modal.
- **i18n-ready.** Tab labels + filter chips + table headers route through `LanguageSwitcher.jsx`. Prompt + response bodies are NOT translated (they're user-generated or model-generated content; translating would corrupt the audit trail).

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / engineering sign-off before any code lands)

- **DD-5.1 Aggregation strategy — RUNTIME UNION (read-time) vs MATERIALISED `AiHistoryEntry` table (write-time fan-in).** Two paths:
  - **(a) RUNTIME UNION (current proposal).** Backend route queries LlmCallLog + ChatbotConversation + WhatsAppMessage (where `aiCallLogId IS NOT NULL`) in parallel + merges in memory. Pro: zero new schema; backward-compatible; aggregations live; simpler ops. Con: 3 queries per page load (mitigated by parallel + indexed); union sort + paginate at app layer.
  - **(b) MATERIALISED `AiHistoryEntry` table.** New `AiHistoryEntry { id, tenantId, sourceTable, sourceId, surface, userId, entityType, entityId, promptPreview, responsePreview, createdAt }` table populated on write (via the LLM router) + a one-time backfill. Pro: single indexed query for the list; trivial pagination; can support FTS via MySQL FULLTEXT. Con: write-path coupling; backfill complexity; index churn on busy tenants; the source-of-truth bodies still live in their origin tables (this is a PROJECTION table, not a copy table).
  - **(c) HYBRID — runtime UNION for v1, then materialise in Phase 2 IF read latency becomes a problem.**
  - **Recommendation: (c) START WITH (a), promote to (b) only IF read latency exceeds 1s P95.** The schema-extension cost of (b) is real + cron-feedback-loop risk is non-zero. (a) is cheap to ship + cheap to evolve.

- **DD-5.2 Persist prompt + response bodies in LlmCallLog — YES (current proposal) or NO?** Two paths:
  - **(a) PERSIST (current proposal).** Add `prompt String? @db.MediumText` + `response String? @db.MediumText` columns to LlmCallLog. The LLM router passes both through from callers; older rows have NULL bodies (backfill per FR-3.11). Pro: enables the history surface's primary value prop; enables DSAR exports; enables hallucination spot-checks; enables operator recall. Con: storage cost (~1-10 KB per row, accumulates fast on busy tenants — 100k calls × 5 KB = 500 MB per tenant per year); PHI / PII risk if storage encryption isn't on; explicit operator-side acceptance of "we now persist what AI said".
  - **(b) DO NOT PERSIST.** History surface shows metadata only — operators see "the talking-points AI was invoked at 14:33 on Tuesday" but no recall of what was said. Pro: zero storage cost; zero PHI exposure on a new column. Con: defeats most of the operator-recall + DSAR + spot-check use cases (60-70% of §2 use cases become "metadata-only views with no actual content").
  - **(c) PERSIST WITH OPT-IN PER TENANT.** Add `Tenant.aiHistoryPersistsBodies Boolean @default(false)` — tenant opts in via the new `/admin/ai-history-settings` page. Pro: tenant-side control of PHI exposure; rolls out gradually; defaults to safe. Con: extra config surface; operators in default-off tenants don't get the recall benefit until ADMIN turns it on.
  - **Recommendation: (c) PERSIST WITH OPT-IN PER TENANT, default-on for `vertical=generic`, default-off for `vertical=wellness`, default-on for `vertical=travel`.** Splits the difference — wellness tenants ADMIN-opt-in after reviewing compliance posture; non-wellness gets the benefit by default. **MUST RESOLVE before implementation.** Storage cost is the main tradeoff; PHI exposure is the secondary tradeoff.

- **DD-5.3 Search depth — substring LIKE (cheap, v1) vs MySQL FULLTEXT index (Phase 2)?** Two paths:
  - **(a) SUBSTRING LIKE (current proposal).** `WHERE prompt LIKE '%term%' OR response LIKE '%term%'`. Pro: zero new index; works on partial words; works on any character set; cheap to ship. Con: full table scan on cold cache; doesn't rank by relevance; degrades on tables >500k rows.
  - **(b) MySQL FULLTEXT INDEX.** Add `FULLTEXT INDEX prompt_response_ft (prompt, response)` + use `MATCH (prompt, response) AGAINST ('term')`. Pro: indexed; fast even on large tables; relevance ranking. Con: requires schema migration that may need bless markers (existing `migration_check` gate); minimum word length quirks (default 4 chars); stop-word list; partial-word matching requires `IN BOOLEAN MODE` syntax which has different semantics. Different default behaviour on MySQL 5.7 vs 8.0.
  - **Recommendation: (a) for v1.** Substring LIKE is acceptable up to ~500k rows; FTS migration is Phase 2 work after measuring actual query patterns.

- **DD-5.4 Detail view shape — DRAWER (preserves filter context, current proposal) or FULL-PAGE ROUTE (`/ai-history/:id`)?** Two paths:
  - **(a) DRAWER.** Pro: preserves the list filter state; faster perceived interaction; deep-linkable via URL parameter `?detail=<id>`. Con: limited height on long prompts/responses (mitigated by inner scroll); doesn't support browser-back to dismiss in the obvious way.
  - **(b) FULL-PAGE ROUTE.** Pro: full real estate for long content; browser-back works naturally; deep-link as a regular URL. Con: list filter state lost on drill-out (URL state persistence mitigates); slower perceived flow.
  - **Recommendation: (a) DRAWER, with `?detail=<id>` URL param for deep-link.** Most operator flow is "scan list → drill → drill → drill". Drawer preserves context. Deep-link still supported via URL param.

- **DD-5.5 Include sister-product (AdsGPT / Callified) history via External API pull — YES (current proposal: NO) or YES?** Two paths:
  - **(a) NO for v1 (current proposal).** Sister products own their data + have their own history UIs. Pro: scope-bounded; clear product boundaries; no cred chase to set up two new External API integrations. Con: operators looking for "all AI activity touching this lead" still need to jump to AdsGPT + Callified UIs.
  - **(b) YES — pull-on-demand External API integration.** When a history row's entityType=Lead/Contact resolves, fire an External API call to AdsGPT + Callified to fetch any matching call/ad/utterance history + render alongside. Pro: true unification. Con: cross-product latency (External API can be slow under load); cred-chase per integration; UX confusion (which side of the divide a row came from?); failure-mode complexity (one side down = list shows partial data with error indicator).
  - **(c) DEFER to Phase 2 + meanwhile add side-panel deep-link buttons to AdsGPT + Callified scoped by the current entity.**
  - **Recommendation: (c).** v1 ships in-app surfaces only + side-panel deep-link CTAs to sister products. Phase 2 evaluates pull-integration based on operator feedback.

- **DD-5.6 Storage encryption — plain text (current proposal, matches schema convention) or AES-256-GCM via `lib/fieldEncryption.js`?** Two paths:
  - **(a) PLAIN TEXT.** Matches every other free-text body column (EmailMessage.body, WhatsAppMessage.body, KbArticle.content). Pro: searchable; consistent; simple. Con: PHI / PII on disk in clear (mitigated by PHI-masking in read surface + access control + audit trail).
  - **(b) ENCRYPTED.** Use the `lib/fieldEncryption.js` helper (introduced in v3.1 for Patient PII). Pro: defense in depth; explicit compliance posture. Con: per-tenant `WELLNESS_FIELD_KEY` env var setup; encrypted columns un-searchable without decrypting in-memory; key rotation operationally non-trivial; breaks the LIKE search path entirely (would need either client-side search or per-row decrypt+match server-side — expensive at scale).
  - **Recommendation: (a) PLAIN TEXT for v1.** Matches existing schema convention + the PHI-masking pattern at read time is the established defense layer. Encryption-at-rest is a Phase 3 cross-cutting concern that should land for all body columns simultaneously, not piecemeal on LlmCallLog alone.

- **DD-5.7 Retention — match LlmCallLog "indefinite" (current proposal) or shorter (e.g. 1-year)?** Two paths:
  - **(a) INDEFINITE.** Same as LlmCallLog today. Pro: full history available; no operator surprise; no separate retention engine; matches `routes/audit.js` audit-chain retention model. Con: storage grows unboundedly; PHI exposure window is forever.
  - **(b) 1-YEAR ROLLING.** Add a daily cleanup cron that deletes LlmCallLog rows older than 1 year. Pro: bounded storage; bounded PHI exposure. Con: operator surprise ("where's my talking-point from 2 years ago?"); inconsistent with audit-chain; needs careful coordination with `retentionEngine.js` (GDPR retention engine — already runs daily at 03:00 IST).
  - **(c) PER-TENANT CONFIGURABLE.** `Tenant.aiHistoryRetentionDays Int @default(0)` — 0 = indefinite; >0 = days. ADMIN configures in `/admin/ai-history-settings`. Pro: operator-side control. Con: per-tenant retention complexity; coordination with `retentionEngine.js`.
  - **Recommendation: (a) INDEFINITE for v1, coordinate with `retentionEngine.js` for a tenant-configurable extension in Phase 2.** Operator surprise from a default-on retention purge is worse than the storage cost.

### Cred chase

- **None external for v1.** Pure internal aggregation + schema extension + new page.
- **Phase 2 (DD-5.5):** AdsGPT + Callified External API credentials would be needed if pull-integration is approved. Both sister-product creds already managed via the API key surface introduced in v3.1.

### Vendor docs

- N/A for v1. Internal pattern reuse only.
- **Internal doc dependency:** the LLM router (`backend/lib/llmRouter.js`) header comments should be updated to document the new optional `{ prompt, response, entityType, entityId }` fields it accepts. Brief — 4-line addition to the existing taxonomy comment.

---

## §6 Acceptance criteria

- **AC-6.1** USER navigates to `/ai-history` → list loads within 1s (P95) → sees own AI interactions chronologically with surface tag + entity link + truncated prompt + truncated response + cost + model + stub-mode-flag. Filter by `surface` / `date range` / `entity` works. Audit chain logs `AI_HISTORY_VIEWED` (throttled). Cross-tenant access blocked: tenant A USER returns 0 rows from any tenant B entity filter.

- **AC-6.2** ADMIN of wellness-tenant opens detail drawer on a `talking-points` row → prompt + response render with PHI-masked Indian phone numbers + Aadhaar + PAN + email addresses. ADMIN clicks "Show un-redacted" + types reason "DSAR investigation #1234" → un-redacted bodies shown + `AI_HISTORY_PHI_UNMASK_VIEWED` audit chain event captured with reason text.

- **AC-6.3** Per-row schema change visible: `LlmCallLog` now has `prompt` + `response` + `entityType` + `entityId` columns populated for new calls (5 LLM-router consumer surfaces) + `WhatsAppMessage.aiCallLogId` populated on AI auto-replies. Backward compat: old rows have NULL bodies + render with "Body not available — pre-extension call" label.

- **AC-6.4** Cost Breakdown tab loads aggregations: total spend by surface for current month + per-user top 10 spenders + per-model breakdown + 30-day trend chart. P95 <2s for tenants with 100k+ LlmCallLog rows. CSV export download works. Audit chain logs `AI_HISTORY_CSV_EXPORTED`.

- **AC-6.5** ADMIN filters by `entityType=Patient` + `entityId=<Anjali's-id>` + clicks "Export DSAR Bundle" → ZIP downloads containing `manifest.json` + per-entry JSON with full PHI-handled bodies + audit-chain receipt linking to `routes/audit.js` `/verify`. `AI_HISTORY_DSAR_EXPORTED` is the only non-throttled audit event in the chain.

- **AC-6.6** Search box "Bali August" → list shows 4 matching rows + count badge + result-ranking by createdAt DESC. Search runs against PHI-masked projection for wellness viewer (no PHI leak through search results). P95 <1s on 500k-row LlmCallLog scan.

- **AC-6.7** Backfill script `node backend/scripts/backfill-llm-history-bodies.js` runs in dry-run mode → reports per-surface backfillable row counts + estimated success rate. Live run populates `prompt` / `response` for matchable rows + sets `bodyBackfillStatus = 'unavailable'` for un-matchable rows. Idempotent — running twice produces no duplicate updates. `AI_HISTORY_BACKFILL_TRIGGERED` audit event captures.

---

## §7 Out of scope

- **AdsGPT / Callified history aggregation.** Sister products own their data. v1 ships in-app surfaces only. Side-panel deep-links to sister products are in scope (DD-5.5(c)); pull-integration is Phase 2.
- **AI feedback loop (thumbs-up / thumbs-down on responses for fine-tuning).** Per `Intercom Fin AI` pattern. Adds a `feedback` column + UX. Phase 2 — needs product call on whether feedback drives a real fine-tuning signal or just an internal flag.
- **Cross-tenant AI usage reports** (Globussoft-internal analytics across all tenants). Separate platform-level surface; not for in-tenant operators. Phase 3.
- **Real-time stream / WebSocket push** of new AI history rows to the page. Page reloads via filter / refresh in v1. Real-time push is a Phase 2 nice-to-have.
- **AI prompt template editing surface** from the history page. Templates live in `backend/lib/llmRouter.js` taxonomies + per-route. Editing templates is a separate "AI Prompt Library" surface (not on the roadmap).
- **Conversational rewind / re-run** ("re-fire this exact prompt with a different model"). Phase 2 — useful for hallucination investigation but requires careful UX around cost confirmation.
- **Embedding-based semantic search.** Phase 3 — needs vector DB infra.
- **Per-row sharing / collaboration** ("share this AI suggestion with my manager"). Phase 2 — overlaps with team activity feeds.
- **Voice / audio transcription history** for the in-app voice features (Twilio voice + voice transcription). Tracked separately via `VoiceSession` model; integration into THIS history surface is Phase 2 conditional on operator demand.
- **Encryption-at-rest** for prompt + response columns (DD-5.6) — explicit Phase 3 cross-cutting concern that should land for all body columns simultaneously.

---

## §8 Dependencies

- **Existing `LlmCallLog` model** at [backend/prisma/schema.prisma:1250-1277](../backend/prisma/schema.prisma#L1250-L1277) — gains `prompt` + `response` + `entityType` + `entityId` columns (FR-3.3).
- **Existing `ChatbotConversation` model** at [backend/prisma/schema.prisma:2076-2087](../backend/prisma/schema.prisma#L2076-L2087) — no schema change; bodies already in `messages` JSON.
- **Existing `WhatsAppMessage` model** at [backend/prisma/schema.prisma:1468-1497](../backend/prisma/schema.prisma#L1468-L1497) — gains `aiCallLogId Int?` FK (FR-3.3).
- **Existing `/api/admin/llm-spend` endpoint** at `backend/routes/admin.js` — mirror its tenant-scoping + cost-aggregation pattern for the Cost Breakdown tab.
- **Existing `shouldMaskForViewer` pattern** at [backend/routes/wellness.js:43](../backend/routes/wellness.js#L43) — reused for FR-3.9 PHI redaction.
- **Existing `lib/audit.js` `writeAudit()`** — new `AI_HISTORY` entity entries flow through the tamper-evident hash chain. No schema change.
- **Existing `lib/llmRouter.js`** — central LLM dispatch; gains optional `{ prompt, response, entityType, entityId }` field passthrough to LlmCallLog (FR-3.4).
- **Existing 5 LLM-router caller routes** — gain the new field passthrough at their existing dispatch call sites. Pure additive — no breaking change to caller signatures (new fields are optional).
- **New file `backend/routes/ai_history.js`** — list / detail / cost-breakdown / search / CSV export / DSAR bundle endpoints (~7 endpoints).
- **New file `backend/scripts/backfill-llm-history-bodies.js`** — one-shot idempotent backfill.
- **New file `frontend/src/pages/AiHistory.jsx`** — the unified page (3 tabs).
- **Sidebar entry** in `frontend/src/components/Sidebar.jsx` under Analytics / Reports group.
- **Lucide icons** (already in dependencies) — `MessageSquare`, `Sparkles`, `Search`, `Download`, `Filter`, `Eye`, `EyeOff`.
- **`React.lazy()` code-splitting** per existing App.jsx pattern.
- **`/api/audit/verify`** at `backend/routes/audit.js` — DSAR bundle export embeds an audit-chain receipt linking to this endpoint.
- **Existing `retentionEngine.js`** — Phase 2 retention extension coordinates here (DD-5.7).
- **WhatsApp inbound auto-reply path** at `backend/routes/whatsapp.js` (or equivalent) — gains AI-attribution writeback (`aiCallLogId`) so the history surface can disambiguate.

---

## §9 Open questions

- **Q1 Surface filter — whitelist (operator-known surfaces) or auto-derived from `LlmCallLog.surface` distinct values?** Per FR-3.5 the proposal is whitelist of known surfaces (`talking-points / form-vs-call / itinerary-draft / religious-guidance / personalised-destinations / chatbot / whatsapp-auto-reply`). Auto-derived would show new caller tags as they ship without code change. Recommend WHITELIST in v1 (predictable UX); add an "Other" bucket for unrecognised tags + a hidden flag for ADMIN to opt-into seeing all distinct values for debugging.

- **Q2 Time-window default — last 7 days (current proposal) or last 30?** 7 covers the common operator-recall window ("what did AI say to me this week"); 30 covers cost/compliance flows. Recommend default 7 with quick-set chips for 24h / 7d / 30d / 90d / All. ADMIN role's default jumps to 30.

- **Q3 Truncation length in list view — 100 chars (current proposal) or full prompts?** 100 keeps the list scannable; full would degrade table density. Recommend 100 chars + click-to-expand on hover for short previews + the drawer for full body. Tablet/mobile uses 60 chars.

- **Q4 PHI redaction in detail view for wellness — always on or operator-toggleable per row?** Per FR-3.9 the proposal is "always on for wellness, ADMIN can per-call unmask with reason text". Open: should MANAGER role also be able to unmask, or only ADMIN? Recommend ADMIN-only — MANAGER sees masked even for spot-check workflows + escalates to ADMIN for un-redact.

- **Q5 Export bundle — include full prompt+response (current proposal: YES) or metadata only?** Full bodies enable DSAR + audit use cases; metadata-only is safer. Recommend FULL BODIES for ADMIN export + METADATA-ONLY for USER/MANAGER export. CSV export from ADMIN gets the bodies; CSV export from USER role gets the metadata + truncated previews only.

- **Q6 Retention — match LlmCallLog indefinite or set a default cap (DD-5.7)?** Recommend INDEFINITE for v1 + tenant-configurable retention in Phase 2 via `Tenant.aiHistoryRetentionDays`. Confirm.

- **Q7 WhatsApp inbound — include in history if the inbound triggered an AUTO-REPLY (clearly AI), or all inbound regardless?** Per FR-3.2 the proposal is "only inbound+outbound pairs where `aiCallLogId IS NOT NULL` on the outbound message" — so ONLY the AI-attributable exchanges. Pure inbound that didn't trigger AI (human reply later, or no reply at all) does NOT appear in AI History. This is the right scope; confirm. Alternative: include "AI was asked to consider but declined to reply" — Phase 2.

- **Q8 Backfill ETA + matching strategy.** FR-3.11 says realistic backfill = 30-50% body coverage. Operator expectation should be set on the UI ("rows older than <deploy-date> may not have bodies"). Recommend a one-time banner that fades after first dismissal. Confirm.

- **Q9 Storage cost projections — at what tenant scale does DD-5.2(a) "persist bodies" start to bite?** For a busy tenant (100k LlmCallLog rows / year × 5 KB avg body = 500 MB / year), the cost is real but not alarming. Should we set a soft alert at 5 GB per-tenant total AI history footprint? Recommend YES — surfaces in `/admin/ai-history-settings` + Phase 2 retention auto-trigger when threshold crossed.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 / DD-5.2 / DD-5.6 / DD-5.7 + Q4 / Q7 before any code lands. **DD-5.2 (persist bodies — yes/no) is the highest-leverage decision** — it determines whether 60-70% of §2 use cases ship at all in v1, or only the metadata + chatbot transcripts subset.

**Owner:** TBD per product call. Likely allocation:
- Prisma schema extension `LlmCallLog.prompt / response / entityType / entityId` + `WhatsAppMessage.aiCallLogId` (additive nullable, no migration risk per the `migration_check` gate) — backend engineer ~0.25 day
- LLM router (`lib/llmRouter.js`) extension to accept + persist new fields — backend engineer ~0.25 day
- 5 LLM-router caller updates (FR-3.4 — talking-points / form-vs-call / itinerary-draft / religious-guidance / personalised-destinations) — backend engineer ~0.5 day
- WhatsApp AI auto-reply path attribution (FR-3.4) — backend engineer ~0.25 day
- New backend routes `backend/routes/ai_history.js` (7 endpoints — list / detail / cost-breakdown / search / CSV export / DSAR bundle / settings) — backend engineer ~1.5 days
- One-time backfill script `backend/scripts/backfill-llm-history-bodies.js` — backend engineer ~0.5 day
- Frontend page `frontend/src/pages/AiHistory.jsx` (3 tabs + filters + list + detail drawer + cost-breakdown charts + audit log view) — frontend engineer ~2 days
- PHI-masking wiring + the `Show un-redacted` toggle UX (FR-3.9) — backend + frontend coordination ~0.5 day
- Audit log integration (FR-3.12) — backend engineer ~0.25 day
- RBAC enforcement (FR-3.8) — backend engineer ~0.25 day
- Tests (api-spec for 7 endpoints + vitest for router-extension + backfill script + PHI-mask correctness) — backend engineer ~0.75 day
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists — backend engineer ~0.25 day

**Total estimated effort post-design: 3-5 engineering days** (single page + new backend routes + LLM-router extension + PHI-masking integration + one-time backfill script + 5 caller updates; no new vendor; no new cron engine).

**Sibling PRDs in this cluster:**
- `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance, cluster D9)
- `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, cluster D10)
- `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery / status / governance surface, cluster D11)
- `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, cluster D12)

**Blocks before frontend impl can start:**
- DD-5.1 (runtime UNION vs materialised table) — MUST resolve
- DD-5.2 (persist bodies — yes/no/opt-in) — MUST resolve (highest leverage)
- DD-5.6 (plain-text vs encrypted storage) — MUST resolve (security posture)
- DD-5.7 (retention duration) — MUST resolve (compliance posture)
- Q4 (PHI un-redact permission — ADMIN-only or also MANAGER) — MUST resolve
- Q7 (WhatsApp inbound scope — AI-triggered only or all) — MUST resolve

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**
- **Slice 1** (~1.25 days): Prisma schema extension (LlmCallLog body columns + entity attribution + WhatsAppMessage.aiCallLogId) + LLM-router field passthrough + 5 caller updates. Ships the persistence path — older rows have NULL bodies, new rows backfill from day 1.
- **Slice 2** (~1.5 days): `backend/routes/ai_history.js` list + detail endpoints + RBAC + audit log integration + the History tab on `frontend/src/pages/AiHistory.jsx`. Ships the operator-facing read surface.
- **Slice 3** (~1 day): Cost Breakdown tab (extends `/api/admin/llm-spend` shape) + Audit Log tab + search box + filter UI. Ships compliance + spend-management views.
- **Slice 4** (~0.75 day): CSV export + DSAR bundle export + PHI un-redact toggle + backfill script + tests + CI gate-spec wiring.

Slices 1 + 2 must ship in order. Slice 3 + 4 can ship in parallel after slice 2 if dispatched file-disjoint.

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session — though the AI history surface is vertical-agnostic and helps every tenant; wellness gets the DSAR + PHI-masking value most). Proposal: add a new entry **D13. Unified In-App AI Chat History (#855)** under cluster D — sibling to D8 (Purchase Orders), D9 (Payment Gateway Config), D10 (Import/Export Jobs), D11 (Integrations Hub), D12 (Tags Master). Cross-references to D11 (AI surfaces appear as integration cards in the hub Phase 2) + D10 (CSV exports from this surface use the same export-job infra) recommended.

**Cross-PRD coordination check:** Before implementation starts, confirm:
- `PRD_INTEGRATIONS_HUB.md` Phase 2 surfaces AI cost as a hub-level card (deep-links into `/ai-history` Cost Breakdown tab).
- `PRD_IMPORT_EXPORT_JOBS.md` CSV export jobs include the `ai_history` job type — long-running exports (>10k rows) flow through the async job infra rather than blocking the page.
- `routes/audit.js` `/verify` endpoint accepts the DSAR bundle receipt format without code change (entity = `AI_HISTORY`, action = `DSAR_EXPORTED`).
- The LLM router (`backend/lib/llmRouter.js`) header comment is updated to document the new optional pass-through fields + the persistence contract; new caller-side LLM consumers added in future automatically inherit the history surface by passing the fields at their `llmRouter.dispatch()` call site.
