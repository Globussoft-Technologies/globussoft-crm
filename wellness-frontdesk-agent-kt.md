# Wellness Admin Support Chatbot — Knowledge Transfer Document

**Version:** 2.0  
**Date:** 2026-07-17  
**Project:** GlobusCRM / Wellness Module  
**Document Type:** Development-ready KT / Implementation Blueprint  
**Status:** Draft for review

---

## 1. Executive Summary

Build an **in-dashboard AI support chatbot** for wellness clinics. The chatbot lives inside the **admin dashboard only** and is available to a small set of authenticated staff users (owner, admin, and dashboard users — typically up to ~10 people per clinic). It answers questions about how to use the dashboard, explains features, points users to the right screens, and escalates to human support when needed.

This is **not** a patient-facing bot. It does **not** handle bookings, WhatsApp conversations, or customer portal chats.

### Business Outcomes
- Reduce "how do I…?" support tickets from clinic staff.
- Help new staff learn the dashboard faster.
- Provide instant 24/7 help inside the tool where work happens.
- Capture structured support requests when human help is required.

---

## 2. Problem Statement & Goals

### Pain Points Today
- Staff forget how to perform infrequent workflows (e.g., "How do I add a new service?").
- New employees need training on the dashboard.
- Simple questions currently become support tickets or Slack messages.
- Users don't always know which page or feature to open.
- Human support lacks context about what the user was trying to do.

### Goals
1. Provide instant answers to dashboard usage questions.
2. Guide staff to the correct page/feature with deep links.
3. Surface relevant documentation and FAQs through RAG.
4. Create structured support tickets with full chat context when escalation is needed.
5. Operate within existing GlobusCRM data model and infrastructure.

---

## 3. Actors & Use Cases

### Actors
| Actor | Description |
|-------|-------------|
| **Dashboard User** | Authenticated staff member (owner, admin, or assigned user) using the wellness admin dashboard. |
| **Support Chatbot** | Conversational AI that answers dashboard questions, searches docs, and creates support tickets. |
| **Support Team / Admin** | Internal GlobusCRM support staff or clinic owner who receives escalated tickets. |
| **Backend Services** | Existing CRM APIs for users, tenants, support tickets, and documentation content. |

### Use Cases
| ID | Use Case | Example |
|----|----------|---------|
| UC-01 | Ask how to use a dashboard feature | "How do I add a new patient?" |
| UC-02 | Find the right page for a task | "Where do I export appointment reports?" |
| UC-03 | Get help with a workflow | "How do I reschedule an appointment?" |
| UC-04 | Ask FAQ about pricing, limits, or plans | "How many staff users can I add?" |
| UC-05 | Receive contextual suggestions based on current page | User is on Reports page → "Need help with this report?" |
| UC-06 | Create a support ticket | "I can't find the invoice. Please help." |
| UC-07 | Escalate to human support | "Talk to support" / "This isn't working" |

---

## 4. Functional Scope

### In Scope (MVP)
- Embedded chat widget in the wellness admin dashboard.
- RAG-based answers from documentation, help articles, and FAQs.
- Context-aware help (current page/route awareness).
- Deep links to relevant dashboard pages.
- Support ticket creation with chat transcript attached.
- Escalation to human support.
- Per-tenant AI provider configuration (BYOK) and internal dev proxy key.
- Chat history for the current user/session.
- Basic analytics: questions asked, tickets created, escalations.

### Out of Scope (Phase 2+)
- Patient-facing channels (WhatsApp, customer portal live chat).
- Appointment booking/rescheduling through chat.
- Lead capture.
- Voice/phone support.
- Multi-language support beyond configured language.
- Real-time screen sharing or co-browsing.

---

## 5. Architecture Overview

```
┌─────────────────────────────────────────┐
│        Wellness Admin Dashboard         │
│         (Authenticated Staff)            │
│  ┌─────────────────────────────────┐    │
│  │   Support Chat Widget (React)   │    │
│  │  - Floating button / side panel │    │
│  │  - Sends current page context   │    │
│  │  - Renders answers & deep links │    │
│  └─────────────┬───────────────────┘    │
└────────────────┼────────────────────────┘
                 │ WebSocket / HTTP
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│              Support Chatbot Service (new module)                │
│  - Session manager (per dashboard user)                          │
│  - Intent classifier (LLM + rules)                               │
│  - RAG retriever (docs / FAQs)                                   │
│  - Tool executor (create ticket, get page info, deep link)       │
│  - Response formatter                                            │
│  - Escalation orchestrator                                       │
└─────────────────────────────┬───────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       ┌──────────┐    ┌──────────┐    ┌──────────────┐
       │   LLM    │    │  Docs /  │    │  Support     │
       │ Provider │    │  KB      │    │  Ticket API  │
       └──────────┘    └──────────┘    └──────────────┘
```

### Key Integration Points
- `frontend/src` — admin dashboard and embedded chat widget.
- `backend/routes/` — existing REST APIs to extend or consume.
- `backend/prisma/` — data layer for chat sessions, support tickets, provider config.
- `docs/wellness-client/` — source content for RAG/help articles.
- `gemini-central-docs.md` — internal Gemini proxy usage.

---

## 6. Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Chat Widget | React component in `frontend/src/admin/` | Floating button or right-side panel; aware of current route. |
| Agent Runtime | Node.js service nested under `backend/` | Recommend `backend/services/support-chatbot/`. |
| Session Store | PostgreSQL (via Prisma) | Chat history per user; optional Redis for ephemeral context. |
| LLM (internal/dev) | Gemini via internal proxy (`gemini-central-docs.md`) | Model: `gemini-2.5-flash-lite` only. Safe proxied key managed by platform team. |
| LLM (production BYOK) | Tenant-configured provider: Gemini, OpenAI, OpenAI-compatible (OpenRouter, Groq, Together, Azure, local vLLM, etc.) | Admin/owner pastes key in Settings UI; backend stores encrypted and calls provider server-side. |
| Provider Abstraction | `GeminiAdapter` + `OpenAICompatibleAdapter` | Normalizes tool calling and responses across provider families. |
| Key Security | AES-256-GCM encryption at rest + KMS-managed key | Keys server-side only; masked in UI; audit-logged. |
| RAG / Docs | Existing docs + optional vector store (pgvector / Pinecone) | Index `docs/wellness-client/` and in-app help content. |
| Support Tickets | Existing ticket/issue API or new `SupportTicket` table | Attach full transcript on escalation. |

---

## 7. Conversation State Machine

Support chat sessions are simpler than patient-facing booking flows.

```
IDLE
  │
  ▼
GREETING ──▶ INTENT_DETECTION
  │
  ├──▶ FAQ / DOC_ANSWER ─────────────────▶ REPLY_DONE
  │
  ├──▶ PAGE_GUIDANCE ──▶ DEEP_LINK ──────▶ REPLY_DONE
  │
  ├──▶ SUPPORT_TICKET ──▶ TICKET_CREATED ─▶ REPLY_DONE
  │
  └──▶ ESCALATE ──▶ HUMAN_SUPPORT_QUEUE
```

### State Storage
```typescript
interface SupportChatSession {
  id: string;
  channel: 'dashboard';
  userId: string;              // authenticated dashboard user
  tenantId: string;            // clinic tenant
  currentPage?: string;        // e.g. /admin/wellness/reports
  state: ConversationState;
  messages: SupportChatMessage[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;             // TTL for inactive sessions
}
```

---

## 8. Data Model

### New Tables (Prisma)

```prisma
model SupportChatSession {
  id              String    @id @default(uuid())
  channel         String    @default("dashboard")
  userId          String
  tenantId        String
  currentPage     String?
  state           String
  messages        SupportChatMessage[]
  supportTicketId String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  expiresAt       DateTime

  @@index([userId, tenantId])
  @@index([state])
}

model SupportChatMessage {
  id            String              @id @default(uuid())
  sessionId     String
  session       SupportChatSession  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  role          String              // user | assistant | system
  content       String
  toolCalls     Json?               // LLM function calls
  toolResults   Json?               // API results
  createdAt     DateTime            @default(now())

  @@index([sessionId, createdAt])
}

model SupportTicket {
  id              String   @id @default(uuid())
  tenantId        String
  userId          String
  sessionId       String?
  subject         String
  description     String   @db.Text
  transcript      Json?    // full chat history
  status          String   @default("open")  // open | in_progress | resolved | closed
  assignedTo      String?
  source          String   @default("chatbot")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model AiProviderConfig {
  id                String   @id @default(uuid())
  tenantId          String
  providerType      String   // gemini | openai | openai-compatible
  model             String
  apiKeyEncrypted   String   // AES-256-GCM ciphertext (base64)
  apiKeyNonce       String   // GCM nonce used for encryption
  baseUrl           String?  // required for openai-compatible, optional override for others
  isActive          Boolean  @default(true)
  isDefault         Boolean  @default(false)
  lastUsedAt        DateTime?
  lastErrorAt       DateTime?
  lastErrorMessage  String?
  createdByUserId   String
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([tenantId, isDefault])
  @@index([tenantId, isActive])
}
```

### Reuse Existing Tables
- `User` / `Staff` — identify dashboard users and permissions.
- `Tenant` / `Clinic` — scope configuration and tickets.
- `Notification` — alert support team of new escalations.

---

## 9. LLM Layer & Provider Configuration

### Dual-Mode Key Strategy

The chatbot supports two mutually exclusive modes for LLM credentials:

| Mode | Environment | Key Source | Set Via |
|------|-------------|------------|---------|
| **Internal / Dev / Dev Site** | Local development, internal QA, company-hosted dev server | Platform team (safe proxy key) | `GEMINI_PROXY_API_KEY` environment variable / backend config |
| **Production Client (BYOK)** | Customer production tenants | Clinic admin/owner | Wellness Settings UI, stored encrypted per tenant |

**Team-lead mandate:** For internal, local, and dev-site usage, use **only** the provided **proxied Gemini safe API key** and the **Gemini Flash Lite** model. No other provider or model may be used for internal testing.

---

### 9.1 Internal / Dev Mode: Proxied Gemini Key

Use the existing internal Gemini proxy documented in `gemini-central-docs.md`.

| Setting | Value / Source |
|---------|----------------|
| Base URL | `GEMINI_PROXY_BASE_URL` environment variable |
| API Key | `GEMINI_PROXY_API_KEY` (safe proxy key from team lead) |
| Model | `gemini-2.5-flash-lite` |
| Endpoint | `{GEMINI_PROXY_BASE_URL}/v1beta/models/{model}:generateContent` |
| Auth header | `Authorization: Bearer <GEMINI_PROXY_API_KEY>` (proxy also accepts `x-goog-api-key`) |
| Go client | `internal/gemini` package (if Chatbot Service is Go) |
| Node/Python | Raw `fetch` / `requests` as shown in `gemini-central-docs.md` |

The proxy provides shared RPM limiting, token/call metrics, and automatic retry/backoff. It is the only allowed path for internal development.

---

### 9.2 Production Client Mode: BYOK (Bring Your Own Key)

In production, each clinic tenant supplies its own AI provider credentials. Only users with `owner` or `admin` role plus `wellness_settings_manage` permission can access:

**Wellness Settings → AI Provider → Bring Your Own Key**

#### Settings UI Fields
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| **Provider** | Dropdown | Yes | `gemini`, `openai`, `openai-compatible` |
| **API Key** | Masked password input | Yes | Provider API key |
| **Base URL / Endpoint** | Text | Conditional | Required for `openai-compatible`; optional override for others |
| **Model** | Text / Dropdown | Yes | e.g. `gemini-2.5-flash-lite`, `gpt-4o-mini`, `meta-llama/Meta-Llama-3-8B-Instruct` |
| **Active** | Toggle | Yes | Enable/disable this config |
| **Set as default** | Toggle | Yes | One default per tenant |
| **Save & Test** | Button | — | Validate key with a lightweight test call before saving |

The backend stores credentials **encrypted at rest** and uses them **server-side only**.

---

### 9.3 Supported Provider Families

The runtime must support two adapter families and treat every pasted key generically within its family.

| Family | Providers | API Shape | Notes |
|--------|-----------|-----------|-------|
| **Gemini-native** | Google Gemini, internal Gemini proxy | `GenerateContentRequest` with `contents`, `tools`, `generationConfig` | Wire-compatible with `google-genai` SDK |
| **OpenAI-compatible** | OpenAI, OpenRouter, Together AI, Groq, Anyscale, Azure OpenAI, local vLLM, LM Studio, etc. | `/chat/completions` with `tools` / `function_calling` | Standard OpenAI client initialized with custom `baseURL` and `apiKey` |

For any `openai-compatible` provider, the runtime reads `baseUrl`, `apiKey`, and `model` from tenant config and constructs the client dynamically. Tool schemas and system prompts stay identical across providers; only the wire adapter changes.

---

### 9.4 Provider Adapter Interface

```typescript
interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface AgentResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

interface LLMProviderAdapter {
  generate(messages: Message[], tools: ToolSchema[]): Promise<AgentResponse>;
  buildToolResultMessage(call: ToolCall, result: unknown): Message;
}
```

Implement two adapters:
- `GeminiAdapter` — internal proxy + tenant Gemini keys
- `OpenAICompatibleAdapter` — all `/chat/completions` providers

The adapter is selected per request based on the tenant's active `AiProviderConfig`.

---

### 9.5 System Prompt (template)

```text
You are a helpful support assistant for the GlobusCRM Wellness admin dashboard.
Your job is to help staff users with:
- Answering questions about dashboard features and navigation
- Explaining how to perform common tasks
- Pointing users to the right page or setting
- Searching help documentation
- Creating a support ticket when the user needs human help

Rules:
- Answer only about the dashboard, its features, and clinic workflows supported by the software.
- Do NOT give medical, legal, or financial advice.
- Do NOT share private information about patients, clinics, or other users.
- When appropriate, provide a deep link to the relevant dashboard page.
- If the user asks for a person, says "this isn't working", or asks something you cannot answer, create a support ticket or escalate.
- Keep responses concise, friendly, and professional.
```

---

### 9.6 Tools / Functions Exposed to LLM

```json
[
  {
    "name": "search_help_docs",
    "description": "Search help documentation and FAQs for a user question",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string" },
        "currentPage": { "type": "string" }
      },
      "required": ["query"]
    }
  },
  {
    "name": "get_page_info",
    "description": "Get description and deep link for a specific dashboard page",
    "parameters": {
      "type": "object",
      "properties": {
        "pageName": { "type": "string" }
      },
      "required": ["pageName"]
    }
  },
]
```

---

### 9.7 Intent Routing Strategy

Use a **hybrid approach** for reliability:
1. Fast rule/heuristic check first (e.g., "how do I", "where is").
2. LLM classification for ambiguous cases.
3. LLM formats the final answer after retrieving docs or executing tools.

If the active provider becomes unavailable or returns invalid credentials, show a friendly error in the widget and alert the admin to check the provider settings.

---

### 9.8 Provider Fallback Behavior

| Scenario | Behavior |
|----------|----------|
| No tenant BYOK config set | Internal/dev: use `GEMINI_PROXY_API_KEY`. Production: show "AI provider not configured" in widget and disable chatbot. |
| Invalid/expired key | Show error in widget; alert admin to update key; allow manual ticket creation. |
| Rate limited (429) | Retry with backoff; if persistent, show temporary error and suggest retry. |
| Provider family unsupported | Reject save in UI; show supported providers list. |

---

## 10. Dashboard Chat Widget Integration

### Widget Location
- Embed as a **floating action button** in the bottom-right of the wellness admin dashboard.
- Or as a **collapsible side panel** on the right edge of the screen.
- Always visible to authenticated staff users with permission `wellness_support_chat`.

### Context Awareness
- Widget sends the current route/page with every message (e.g., `/admin/wellness/reports`).
- System prompt includes: `The user is currently on the {pageName} page.`
- Enables contextual greetings: "Need help with Reports?"

### Message Format
```json
{
  "channel": "dashboard",
  "userId": "user_123",
  "tenantId": "tenant_456",
  "currentPage": "/admin/wellness/reports",
  "text": "How do I export this report?",
  "timestamp": "2026-07-17T10:00:00Z"
}
```

### Transport
- WebSocket preferred for real-time feel.
- HTTP polling fallback every 3–5 seconds.

### UI Elements
- Message bubbles (user / assistant).
- Deep-link buttons ("Open Appointments →").
- "Create ticket" button surfaced by the bot or user.
- "Was this helpful?" thumbs up/down.
- Clear history / new conversation.

### Widget Placement & Drag Behavior

**Default position:** bottom-right corner of the main dashboard content area, clear of the left sidebar.

**Draggable:**
- Users can click-hold the icon and drag it anywhere within the main content area.
- It cannot be dragged over the left sidebar or outside the viewport.
- A short drag threshold (e.g., 5 px) distinguishes a drag from a click.

**Click to open:**
- A normal click opens the chat panel.
- A drag-and-release does not open the panel.

**Position persistence:**
- Final position is saved to `localStorage` under a key like `wellness_support_chat_pos_<userId>`.
- On refresh or reopening the dashboard, the icon returns to the saved position.
- If no saved position exists, it falls back to the default bottom-right spot.

**Scope:** web dashboard only. No mobile-specific behavior for now; responsive CSS will handle smaller screens naturally.

---

## 11. RAG / Help Documentation

### Content Sources
- `docs/wellness-client/` markdown files.
- In-app help tooltips and feature descriptions.
- Curated FAQ list maintained by product/support team.

### Indexing Options
| Option | Best For |
|--------|----------|
| **Simple keyword search** | MVP; small doc set; fast to implement |
| **pgvector embeddings** | Larger doc set; semantic search; stays in Postgres |
| **Pinecone / Weaviate** | Scale; multi-tenant isolation; advanced retrieval |

### Retrieval Flow
1. User asks a question.
2. `search_help_docs(query, currentPage)` retrieves top-k relevant chunks.
3. Chunks are injected into LLM context with source citations.
4. LLM answers and may include a deep link to the relevant page.

---

## 12. Backend API Design

### New Chatbot Service Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/support-chat/message` | Receive message from dashboard widget |
| GET | `/api/support-chat/history` | Get current user's chat history |
| DELETE | `/api/support-chat/history` | Clear current user's chat history |
| GET | `/api/support-chat/analytics` | Usage metrics (admin/support view) |

### Provider Configuration Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/admin/ai-provider-config` | Get tenant config (masked) |
| POST | `/api/admin/ai-provider-config` | Create or update config |
| POST | `/api/admin/ai-provider-config/test` | Validate a key without saving |
| DELETE | `/api/admin/ai-provider-config/:id` | Remove a config |

### Internal Tool Handlers
Implement in Chatbot Service:
- `handleSearchHelpDocs(query, currentPage)`
- `handleGetPageInfo(pageName)`
- `handleCreateSupportTicket(session, params)`
- `handleEscalateToSupport(session, reason)`

---

## 13. Frontend Views

### Admin Dashboard
- **Support Chat Widget** — floating button / side panel, visible on all wellness admin pages.
- **Settings → AI Provider** — BYOK configuration page (provider dropdown, masked key input, base URL, model, test button).
- **Support Tickets** — existing or new view to see tickets created via chatbot.

### Recommended Routes
- `/admin/wellness/support-chat` — full-page chat history view *(optional)*
- `/admin/wellness/settings/ai-provider` — provider configuration
- `/admin/wellness/support-tickets` — ticket list

---

## 14. Security & Compliance

### Access Control
- Chatbot widget is visible only to authenticated dashboard users.
- Requires permission `wellness_support_chat`.
- Provider config changes require `wellness_settings_manage` permission.
- Each user sees only their own chat history within their tenant.

### API Key Security (Critical)

| Requirement | Implementation |
|-------------|----------------|
| **Encryption at rest** | AES-256-GCM on `apiKeyEncrypted`. Encryption key stored in KMS / environment secret, separate from DB. |
| **Server-side only** | Keys are never returned to frontend after save. UI displays masked form only (e.g. `sk-...XXXX`). |
| **TLS in transit** | All key submission and provider API calls over HTTPS / TLS 1.3. |
| **Access control** | Only `owner`/`admin` with `wellness_settings_manage` permission can create/edit/delete provider config. |
| **Audit logging** | Log every config change: who, when, provider type, model, action. Never log the plaintext key. |
| **No plaintext in logs** | Redact keys from app logs, error traces, Sentry, and request dumps. |
| **Test-key isolation** | "Save & Test" validates the key with a live call but does not persist or log the key plaintext. |
| **Rotation & expiry** | Allow key updates; track `lastUsedAt` and `lastErrorAt` for stale-key detection and alerting. |
| **Internal key protection** | `GEMINI_PROXY_API_KEY` is never exposed to tenants or frontend; loaded only via backend env. |

### Data Handling
- Chat transcripts tied to authenticated dashboard users only.
- Do not include patient data or PHI in support chat context unless the user explicitly pastes it; if pasted, apply normal PII handling.
- Set session TTL (e.g., 30 days) and allow users to clear history.

---

## 15. Error Handling & Fallbacks

| Scenario | Behavior |
|----------|----------|
| LLM unavailable | Show: *"I'm having trouble right now. You can still create a support ticket."* |
| Invalid / expired provider key | Show widget error; alert admin to update key in Settings. |
| Provider rate limit (429) | Retry with exponential backoff; show temporary retry message if persistent. |
| Unsupported provider family | Reject in UI at save time with clear error message. |
| No relevant docs found | Answer generally if safe, or offer to create a support ticket. |
| Unknown intent | Ask clarifying question; after 2 failures, offer ticket creation. |
| User asks for human | Create support ticket with transcript and notify support team. |
| Session expires | Start fresh greeting on next open. |

---

## 16. Testing Strategy

### Unit Tests
- Intent classification for 30+ support questions.
- RAG retrieval relevance.
- Tool handler logic (mock docs, ticket API).
- Provider adapter normalization.

### Integration Tests
- End-to-end dashboard message → reply flow in staging.
- Ticket creation with transcript attachment.
- BYOK key save/test/encryption flow.

### Manual QA Checklist
- [ ] Chatbot widget opens/closes correctly on dashboard pages.
- [ ] FAQ responses are accurate and cite documentation.
- [ ] Deep links navigate to the correct dashboard page.
- [ ] Support ticket is created with correct subject, description, and transcript.
- [ ] Escalation notifies support team.
- [ ] Internal/dev mode uses only `gemini-2.5-flash-lite` via proxy key.
- [ ] BYOK Settings UI saves and encrypts keys; masked key is shown on reload.
- [ ] Gemini, OpenAI, and at least one OpenAI-compatible provider work end-to-end.
- [ ] Invalid/expired key triggers admin alert.
- [ ] API keys never appear in frontend network tab, logs, or error traces.
- [ ] User can only see their own chat history.

### Regression
- Ensure existing dashboard navigation and settings are not broken.
- Ensure no patient-facing pages are affected.

---

## 17. Deployment & Rollout

### Phase 1: Internal Alpha (1–2 weeks)
- Deploy Chatbot Service behind feature flag.
- Test with internal dashboard users only.
- Validate prompt, RAG retrieval, and ticket creation.

### Phase 2: Limited Pilot (2–4 weeks)
- Enable for one clinic's admin users.
- Monitor ticket quality and escalation rate.
- Expand FAQ/docs based on real questions.

### Phase 3: General Availability
- Roll out to all wellness admin users.
- Add analytics dashboard.
- Optimize LLM cost based on volume.

### Monitoring
- Track: questions asked, docs retrieved, tickets created, escalation rate, LLM latency/cost, error rate.
- Alerts: high escalation rate, LLM failures, invalid key events.

---

## 18. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| LLM answers are inaccurate | Medium | RAG with citations; fallback to ticket creation; human review loop. |
| Users paste PHI into chat | Medium | Clear UI warning; normal PII handling; short retention. |
| API key leaked | High | Encryption at rest, server-side only, audit logs, no plaintext in logs. |
| High escalation rate | Low | Expand docs/FAQs; improve retrieval. |
| Staff ignore the bot | Low | Context-aware prompts; useful deep links; measure engagement. |

---

## 19. Open Questions / Decisions Needed

1. **Widget placement:** Floating button or fixed side panel?
2. **RAG approach:** Keyword search, pgvector, or external vector store for MVP?
3. **Help content source:** Which docs are authoritative? Who maintains the FAQ?
4. **Support ticket routing:** To internal GlobusCRM support team or clinic owner?
5. **Multi-language:** Single language MVP or multi-language from day one?
6. **Encryption Key Management:** Use AWS KMS / Azure Key Vault / HashiCorp Vault, or a single env-derived master key?
7. **Provider Whitelist:** Allow any OpenAI-compatible base URL, or maintain an approved-provider list?
8. **Cost Visibility:** Show tenant admins estimated spend or usage in the Settings UI?

---

## 20. Next Steps / MVP Checklist

- [ ] Confirm internal/dev `GEMINI_PROXY_BASE_URL` and `GEMINI_PROXY_API_KEY` from team lead.
- [ ] Create `SupportChatSession`, `SupportChatMessage`, and `AiProviderConfig` migrations.
- [ ] Build Chatbot Service skeleton.
- [ ] Implement `GeminiAdapter` for internal proxy (model: `gemini-2.5-flash-lite`).
- [ ] Implement `OpenAICompatibleAdapter` for BYOK providers.
- [ ] Implement intent classifier + support tools (`search_help_docs`, `get_page_info`).
- [ ] Index help docs / FAQs and wellness repo docs for RAG.
- [ ] Build dashboard chat widget (floating button or side panel) with current-page context.
- [ ] Build Wellness Settings UI: provider dropdown, masked key input, base URL, model, save & test.
- [ ] Add backend key encryption (AES-256-GCM) and audit logging.
- [ ] Write tests and run end-to-end QA.
- [ ] Deploy to staging for alpha testing.

---

## 21. Appendix: Project File References

| Component | Location in Repo |
|-----------|------------------|
| Backend APIs | `backend/routes/`, `backend/controllers/` |
| Database Schema | `backend/prisma/schema.prisma` |
| Background Jobs | `backend/cron/` |
| Admin Frontend | `frontend/src/` |
| Wellness Documentation | `docs/wellness-client/` |
| Gemini Proxy Client Docs | `gemini-central-docs.md` |

---

**End of Document**

Prepared for: Development Team  
Prepared by: AI Assistant  
Next Action: Review and confirm scope, then begin MVP implementation.
