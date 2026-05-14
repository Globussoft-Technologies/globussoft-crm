# PRD: Globussoft CRM — AI-Era Rebuild

**Status:** Draft v0.1
**Date:** 2026-05-14
**Author:** drafted from a LinkedIn essay laying out the six pillars of next-generation enterprise software
**Scope:** Roadmap and architecture for evolving Globussoft CRM (v3.7.x today) into an AI-era platform without throwing away the relational truth-store, multi-tenant model, or 90+ page surface area we already have

---

## 0. Executive summary

The post that triggered this PRD argues that the next generation of enterprise software won't be 2015-style SaaS with AI features bolted on. It will be:

1. A **semantic system of record** — built for AI to reason over, not humans to fill in
2. A **knowledge graph** — encoding the business, not just the data
3. A **multi-agent framework** — hundreds of specialized agents under an orchestrator
4. A **conversational interface** — describe what you want in English
5. **Digital teammates** — named colleagues with scope and KPIs
6. **Real-time intelligence** — analytics dissolves into the system

> "Build" is winning today because the mature "Buy" alternative doesn't exist yet. That window is closing faster than most incumbents realize.

This PRD takes that thesis literally and lays out how Globussoft CRM gets there from v3.7.x. It is **not** a green-field rewrite. The relational schema, multi-tenant model, RBAC, audit log, deploy pipeline, and 90+ page surface stay. We add three new layers **on top**:

- **L1 — Semantic graph + embeddings** (read-optimized, derived from L0 relational truth)
- **L2 — Multi-agent runtime** (orchestrator + specialized agents + tool registry)
- **L3 — Conversational surface** (chat-first, with structured forms as fallback)

Each layer compounds on the one beneath. Each layer ships in phases that deliver standalone value before the next layer lands. Customers who never touch the chat surface still benefit from L1 (better search, smarter dedup, semantic deal insights).

**Five-phase plan**, ~12 months end-to-end. Phase 1 + Phase 2 unlock 80% of the user-visible value. Phase 3 + Phase 4 + Phase 5 are the "digital teammate" and real-time analytics layers that make this a category shift, not a feature add.

---

## 1. The six pillars, decoded

### Pillar 1 — A semantic system of record

**Today (v3.7.x):** 114 Prisma models in MySQL. Schema is normalized, foreign keys are referential, every row has `tenantId` for isolation. Field names are CRM-domain (`Deal.amount`, `Contact.lastContactedAt`). Humans fill in forms; backend validates; rows are stored as authoritative truth.

**Problem:** Nothing in the schema tells an AI *what* a row means in business terms. A `Deal` with `stage='negotiation'` is a string — the AI doesn't know that "negotiation" is later in our pipeline than "proposal," or that this deal's stage might genuinely mean stalled-but-not-lost in this customer's vocabulary. Every AI call has to re-discover the semantics from scratch.

**Target:** Every entity that lands in MySQL emits a **semantic event** describing what changed in business-domain language, with embeddings, with explicit references to graph nodes. The relational row is still the source of truth — the semantic record is the AI-readable shadow.

**Shape (illustrative):**
```typescript
type SemanticEvent = {
  id: string;
  tenantId: number;
  occurredAt: Date;
  actor: { kind: 'user' | 'agent' | 'system'; id: string };
  subject: { kind: 'Deal' | 'Contact' | 'Account' | ...; id: string };
  predicate: 'stage_advanced' | 'champion_changed' | 'pricing_objection_raised' | ...;
  details: { from?: any; to?: any; evidence?: string; sourceMessageId?: string };
  embedding: number[]; // 1536-dim, the predicate + details rendered as text
  derivedFrom: string[]; // upstream event IDs that led to this
};
```

This is **not** a generic audit log. The audit log records "User X changed Deal.stage from A to B at T." The semantic event records "Deal X stalled because the champion ghosted us after the demo, evidenced by a thread of unanswered emails." The first is a fact; the second is an interpretation. AI-era CRM needs both.

### Pillar 2 — A knowledge graph that knows your business

**Today (v3.7.x):** We track companies (Accounts → not modeled — we have `Contact.company` as a string), people (Contacts), deals, products, but **none of the relationships between them as first-class objects**. "Who at AcmeCo champions the deal? Who at AcmeCo just left? What other companies share their CTO with AcmeCo?" — none of these are queryable.

**Target:** A graph layer that encodes:
- **Entities:** Account, Person, Deal, Product, Competitor, Vertical, ICPSegment, Region, EmploymentRole, FundingRound, NewsEvent
- **Relationships:** PERSON_WORKS_AT_ACCOUNT, DEAL_BELONGS_TO_ACCOUNT, PERSON_CHAMPIONS_DEAL, COMPETITOR_WON_DEAL, ACCOUNT_FITS_ICP, PERSON_PREVIOUSLY_WORKED_AT
- **Temporal facts:** PERSON_CHANGED_JOB_AT, ACCOUNT_RAISED_FUNDING_AT, DEAL_LOST_TO_AT
- **Business predicates per tenant:** ICPDefinition (e.g. "DTC retailers $5M-$50M revenue with multi-store ops"), WinReason taxonomy, LossReason taxonomy, ChampionRole definitions

**The hard part isn't the graph database** (pick Neo4j, AGE on Postgres, or stay-on-MySQL with carefully-indexed adjacency tables — all viable). The hard part is the **business-meaning layer**:
- ICP isn't a hardcoded enum — it's a per-tenant query against the graph that returns matching accounts
- "Why we win" isn't a single field — it's a learned model + rule set the AI updates based on closed-won deals
- "Champion changed jobs" isn't a notification — it's a recurring graph diff that the multi-agent layer (Pillar 3) acts on

### Pillar 3 — A multi-agent framework as the brain

**Today (v3.7.x):** Single AI surface — `routes/ai.js` calls Gemini for ad-hoc tasks (lead scoring, sentiment, deal insights). One model per call. No state between calls. No specialization. No tool use beyond rendering prompts.

**Target:** A registry of N specialized agents, each with:
- **A scope** (what kinds of facts it produces / what kinds of decisions it makes)
- **A tool allowlist** (which API endpoints, which graph queries, which external services it can call)
- **A budget** (calls/day, tokens/day, latency SLO)
- **A KPI** (what does "this agent is doing its job" mean — e.g. for an EnrichmentAgent: % of contacts with complete employer/title/seniority data; for a FollowUpDraftAgent: % of suggested drafts the AE actually sent)
- **A memory** (persistent context — Pillar 1's semantic events filtered to this agent's scope)

**Concrete sub-agent inventory (initial 12):**

| Agent | Scope | Tool surface | KPI |
|---|---|---|---|
| `ResearchAgent` | Enrich Account/Person from public sources | Web fetch, LinkedIn lookup, Crunchbase | % accounts with employee count, funding, ICP-tag |
| `RevOpsAgent` | Pipeline health, forecast accuracy | Read graph + relational | Forecast variance vs. closed actuals |
| `CSAgent` | Customer health, churn risk | Read tickets + usage + sentiment events | Churn-flag precision/recall |
| `EmailDraftAgent` | Suggest replies + outbound drafts in AE voice | Read thread history, write draft messages | AE accept rate |
| `ICPMatchAgent` | Score new leads against tenant's ICP | Read ICPDefinition + lead enrichment | Match precision |
| `CommitmentExtractor` | Pull commitments from call transcripts / email | Read VoiceSession + EmailMessage | Commitment precision (sample-audited) |
| `JobChangeWatcher` | Track champion / decision-maker job changes | Periodic external lookup + graph diff | Catches/false-positives |
| `CompetitorIntelAgent` | Track competitor mentions, win/loss patterns | Read deal_insights + win_loss_reasons | Win-rate change attribution |
| `NoShowPredictor` (wellness vertical) | Score appointments for no-show risk | Read Visit + Patient + Visit.history | AUC vs. actual no-shows |
| `InventoryReorderAgent` (wellness vertical) | Suggest reorders before low-stock | Read Product + InventoryReceipt | False-positive rate |
| `MeetingSummarizer` | Post-meeting recap + action items + next-touch | Read VoiceSession + CalendarEvent | AE edit rate |
| `OrchestratorAgent` | Routes user queries to specialists | Read query → emit dispatch plan | End-to-end query latency + correctness |

The OrchestratorAgent is the **only one the conversational layer talks to directly**. It plans → dispatches → aggregates → responds. Specialist agents don't know about the user's chat session; they get scoped tasks.

This already exists in skeleton form in our codebase — `backend/cron/orchestratorEngine.js` runs daily and emits `AgentRecommendation` rows for the wellness Owner Dashboard. The skeleton needs:
- Generalizing beyond wellness (today it's hardcoded to wellness scenarios)
- Tool registry instead of hardcoded function calls
- Per-agent budget + KPI tracking
- Synchronous orchestration path (today everything's batch via cron)

### Pillar 4 — A conversational interface

**Today (v3.7.x):** 90+ pages of forms, filters, modals, tables. Every workflow has its own page. Reports are built in code. Custom fields require an admin to define them. The full surface area takes a 20-page onboarding doc to navigate.

**Target:** A single conversational surface (think the Anthropic/OpenAI chat shape, but tenant-scoped and authenticated) that handles 80% of daily tasks:
- "Pull up AcmeCo and show me what's stalled" → opens an account view + highlights deal + summarizes
- "Email everyone who said 'pricing' on a call last month, soft outreach" → dispatches to EmailDraftAgent → returns 12 draft emails, one per recipient, scoped to the AE's voice → AE one-clicks send-all-or-edit
- "What's our win rate against Competitor X in the SMB segment?" → realtime query → table + chart inline in chat
- "Schedule a follow-up with the Acme champion for next Tuesday" → calendar agent + draft → confirm

**The structured form pages don't go away.** They become fallbacks for cases where typing the request would be slower than clicking. They also remain canonical for compliance-sensitive surfaces (consent capture, PHI fields, billing edits) where natural-language ambiguity is dangerous.

**The custom-field / workflow-builder UIs DO go away.** Instead of a UI to "create a workflow rule," the AE says "every time a deal stalls 14 days in negotiation, drop me a daily nudge with the latest activity summary until I act." That natural-language rule becomes (a) a workflow row, (b) a per-agent KPI tracker, (c) a UI-renderable preview.

### Pillar 5 — Digital teammates with real responsibilities

**Today (v3.7.x):** Sub-agents (when they exist) are invisible. They produce `AgentRecommendation` rows that show up in a dashboard panel. Nothing "owns" the output.

**Target:** A handful of **named digital colleagues** per tenant. Each colleague is a stable persona that the user works with by name. Each colleague:
- Has a **scope** ("Rebecca, your research assistant — keeps Account + Person data fresh and surfaces relevant news")
- Has a **persistent identity** (avatar, name, signature — appears in Slack/email digests as a coherent voice)
- Has **KPIs** that get reviewed monthly ("Rebecca enriched 847 accounts this month, 92% accurate per spot-audit, 8 false positives investigated")
- **Is composed of N sub-agents** (Rebecca = ResearchAgent + JobChangeWatcher + CompetitorIntelAgent + a persona prompt)
- **Submits work-output** the user accepts/rejects/edits, NOT raw data the user has to interpret

The shift from Pillar 3 to Pillar 5 is product-design, not technology. Pillar 3 ships dozens of agents the user never sees by name. Pillar 5 wraps them into 4-6 personas the user remembers and trusts.

**Starter teammate roster (per tenant):**
- **Rebecca** — Research assistant (account/person enrichment, news, job changes)
- **Raj** — RevOps analyst (pipeline health, forecasts, win/loss patterns)
- **Priya** — CS lead (health scores, churn signals, expansion opportunities)
- **Sam** — Sales coach (call review, commitment tracking, meeting prep)
- **Tara** — Outbound writer (drafts emails + sequences in the AE's voice)
- **Maya** — Operations (wellness vertical) — inventory + appointments + no-show ops

Naming + persona-design is a real product decision. Generic names ("RevOps Agent") feel like Clippy. Specific names ("Raj") feel like a colleague. **This PRD recommends specific names** but the names should be tenant-customizable (some customers will want their bot named after a founder; some will want strict job-title-only).

### Pillar 6 — Real-time intelligence, not quarterly reports

**Today (v3.7.x):** Reports run on demand against MySQL. Dashboards aggregate live but page-by-page. Custom reports allow saved queries. Scheduled reports email digests on cron. Everything is pre-defined; the data team is the bottleneck for any new question.

**Target:** Any question against the warehouse, any time, returned in conversational shape. The analytics layer dissolves into Pillar 4.

**Architecture shift:**
- Today: routes/reports.js → Prisma queries → recharts render
- Target: a **query service** (DuckDB or ClickHouse + materialized rollups of MySQL via Debezium-style CDC) that the OrchestratorAgent can issue arbitrary SQL against, given a user's natural-language question, with results streamed back into the chat surface as a table-or-chart-or-narrative

**The "ask in the meeting, get the answer in the meeting" promise** requires:
- Sub-second query latency on tenant-scoped warehouse rollups
- The OrchestratorAgent's text-to-SQL fluency on the warehouse schema (NOT the MySQL schema — too noisy)
- A rendering layer that turns SQL result + question intent → the right visualization

**Quarterly reports still exist** — finance/board reporting has compliance shape. But they become outputs of the conversational layer ("Show me Q4 ARR vs. plan and email the board") rather than separate report builders.

---

## 2. Current state — what we keep, what we replace

### What stays exactly as it is

- The 114-model Prisma + MySQL truth store. **L0 doesn't change.** Every other layer derives from it.
- Multi-tenancy (`tenantId` on every row, `verifyToken` middleware, RBAC). Non-negotiable.
- The 90+ page forms-based UI. Stays as the fallback / compliance surface.
- Auth (JWT + SSO + 2FA + step-up), audit log, retention policies.
- Per-push deploy gate (~4,128 tests across 6 mandatory gates). Stays. New layers add gates, don't replace.

### What gets replaced

- **`routes/ai.js`** — today's catchall Gemini wrapper. Becomes the OrchestratorAgent's surface.
- **`routes/dashboards.js` + `routes/custom_reports.js`** — become thin shims over the query service. Saved reports stay (user-facing); the implementation moves.
- **The workflow rule builder UI** (`/workflows`). Stays for legacy rules; new rules are created via natural language and stored in the same `AutomationRule` table.
- **Custom field builder UI** (`/custom-objects`). Stays for legacy; new custom fields are extracted from user requests by an agent and persisted to the same `CustomField` table.

### What gets added

- **`SemanticEvent` model** (Pillar 1) — derived stream from L0 mutations.
- **Graph layer** — Neo4j sidecar OR Postgres+AGE OR carefully-indexed MySQL adjacency tables (decision below).
- **`Agent`, `AgentRun`, `AgentTool`, `AgentKpiSnapshot` models** (Pillar 3).
- **`DigitalTeammate` model + per-teammate Slack/email surfaces** (Pillar 5).
- **`ConversationSession`, `ConversationMessage`, `ConversationAction` models** (Pillar 4).
- **Query service** — DuckDB embedded in backend, or ClickHouse as a sidecar, with CDC from MySQL (Pillar 6).
- **Embedding store** — `pgvector` extension if we go Postgres-side, OR `chromadb` sidecar, OR managed (Voyage/OpenAI text-embedding-3-large). Decision below.

---

## 3. Architecture — a layered view

```
┌─────────────────────────────────────────────────────────────────┐
│  L3 — Conversational Surface (Pillar 4)                         │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │ Chat UI         │  │ Slack/Teams bot  │  │ Email digest   │  │
│  │ (React)         │  │ (per-teammate)   │  │ (per-teammate) │  │
│  └────────┬────────┘  └────────┬─────────┘  └────────┬───────┘  │
│           └────────────────────┼─────────────────────┘          │
│                                ▼                                │
│              ┌──────────────────────────────┐                   │
│              │ OrchestratorAgent (Pillar 3) │                   │
│              │ - intent classification      │                   │
│              │ - dispatch planning          │                   │
│              │ - response composition       │                   │
│              └────────────┬─────────────────┘                   │
└────────────────────────────┼────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  L2 — Multi-Agent Runtime (Pillar 3) + Teammates (Pillar 5)     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│  │Research │ │RevOps   │ │CS       │ │Email    │ │ICPMatch │... │
│  │Agent    │ │Agent    │ │Agent    │ │Draft    │ │Agent    │    │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘    │
│       │           │           │           │           │         │
│  ┌────▼───────────▼───────────▼───────────▼───────────▼─────┐   │
│  │ AgentTool Registry — typed function-calling adapters     │   │
│  │ (graph queries, warehouse SQL, external APIs, L0 CRUD)   │   │
│  └────┬──────────────────────────────────────────────────┬──┘   │
└───────┼──────────────────────────────────────────────────┼──────┘
        ▼                                                  ▼
┌──────────────────────────────────┐    ┌──────────────────────────┐
│ L1a — Semantic + Graph Layer     │    │ L1b — Query Service       │
│ (Pillar 1, Pillar 2)             │    │ (Pillar 6)                │
│                                  │    │                          │
│ ┌─────────────────────────────┐  │    │ ┌──────────────────────┐ │
│ │ SemanticEvent stream        │  │    │ │ DuckDB / ClickHouse  │ │
│ │ (embeddings + predicates)   │  │    │ │ + materialized       │ │
│ └─────────────────────────────┘  │    │ │   rollups            │ │
│                                  │    │ └──────────────────────┘ │
│ ┌─────────────────────────────┐  │    │            ▲             │
│ │ KnowledgeGraph              │  │    │            │             │
│ │ (Entity ↔ Relationship)     │  │    │     CDC stream           │
│ │ Neo4j / AGE / adjacency     │  │    │     (Debezium-style)     │
│ └─────────────────────────────┘  │    │                          │
└──────────────────┬───────────────┘    └──────────────┬───────────┘
                   │                                   │
                   │     Event/CDC stream from L0      │
                   └───────────────┬───────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  L0 — Relational Truth Store (UNCHANGED)                        │
│  MySQL + Prisma + 114 models + multi-tenant + RBAC + audit      │
└─────────────────────────────────────────────────────────────────┘
```

Key invariant: **L0 is the source of truth, always.** L1/L2/L3 are derived. If the graph disagrees with MySQL, MySQL wins. If a semantic event references a row that's been deleted, the event is marked stale, not rewound. This protects every existing integration (Stripe, Razorpay, SendGrid, Twilio, etc.) — they all keep talking to L0 unchanged.

---

## 4. Five-phase roadmap

### Phase 1 — Semantic foundations (8 weeks)

**Goal:** Get Pillar 1 + the read-only piece of Pillar 2 live, even without any user-facing change. Prove the embedding/graph pipeline keeps up with demo's write rate. Ship a single agent (ICPMatchAgent) end-to-end to validate the full stack.

**Deliverables:**
1. **`SemanticEvent` model + migration** + per-route emission hooks (events fire on Deal/Contact/Account/Visit mutations).
2. **Embedding pipeline** — sidecar Node service that pulls SemanticEvent rows, calls embedding API, stores back into `event.embedding` field. Default to OpenAI `text-embedding-3-large` (1536-dim, $0.13/1M tokens) — switchable to Voyage or local Sentence-Transformers via env-var.
3. **`KnowledgeGraph` models** — Account, Person, AccountFitsICP, PersonChampionsDeal, PersonWorksAtAccount, etc. Initial decision: **MySQL adjacency tables** (`graph_edges` with `(tenantId, fromKind, fromId, predicate, toKind, toId, validFrom, validTo)`). Keeps us on the existing infra. Migrate to Neo4j only if query patterns prove it needed in Phase 3.
4. **Sync layer** — derives graph state from L0. Runs on cron + reactively on SemanticEvent emit. Idempotent.
5. **`ICPDefinition` model** — per-tenant ICP rules as structured JSON (initially) + natural-language description.
6. **ICPMatchAgent** — for every new lead, scores against the tenant's ICPDefinition, writes back to `Contact.aiScore` + emits a SemanticEvent. Replaces the current Gemini lead-scoring path on `routes/ai_scoring.js`.

**Success metrics:**
- 100% of Deal/Contact/Account/Visit mutations emit a SemanticEvent within 2s
- Embedding p95 latency < 5s end-to-end
- Graph state matches L0 within 30s (eventual-consistency tolerated, not unbounded)
- ICPMatchAgent precision >= existing aiScore (no regression)
- Per-push deploy gate stays green (target: ~4,400+ tests; +10 vitest cases for the new helpers)

**Risk mitigation:**
- Embedding cost: cap at $50/month/tenant in Phase 1 (back-off + sample on overflow)
- Graph drift: nightly audit job compares L0 vs graph; emits drift report to oncall

### Phase 2 — Knowledge graph fluency (8 weeks)

**Goal:** The graph becomes the AI's "common knowledge." Multi-agent runtime ships. First three named teammates land: Rebecca (research), Raj (revops), Tara (outbound).

**Deliverables:**
1. **Full entity inventory** — Account becomes a first-class model (currently `Contact.company` string). Migration: backfill Account rows from existing Contacts, link via `Contact.accountId`. Adopters keep working unchanged; new flow uses Account.
2. **External enrichment service** — Clearbit/Apollo/Crunchbase adapter behind a unified `enrichAccount()` tool. Tenant-configurable per-source budget. Falls back gracefully on rate limit / no-key.
3. **`Agent`, `AgentRun`, `AgentTool`, `AgentKpiSnapshot` models** + runtime — agents are rows; runs are tasks dispatched + executed + audited; tools are typed function-calling adapters; KPI snapshots are daily rollups.
4. **`DigitalTeammate` model** — name, role, scope, composedOfAgentIds, slackChannel, emailSubjectLine, ownerUserId. Tenant-customizable defaults (Rebecca/Raj/Tara seeded).
5. **Teammate Slack adapter** — `slack-bolt` server that each teammate sends to. Daily digest message per teammate.
6. **`OrchestratorAgent` v1** — generalized from the existing wellness orchestrator. Dispatches to the 3 launched teammates' underlying agents.

**Success metrics:**
- 95% of accounts have employee count + industry within 7 days of creation (Rebecca KPI)
- Raj's daily pipeline-health digest gets >= 30% click-through from its target audience
- Tara's email drafts get >= 40% send-rate (after edit-OK)
- OrchestratorAgent end-to-end latency < 12s p95 for the common queries it supports
- No regression in any L0 surface

### Phase 3 — Conversational surface (8 weeks)

**Goal:** Chat-first UI lands. Three new teammates: Priya (CS), Sam (sales coach), Maya (wellness ops). Custom-field + workflow-rule UIs marked deprecated (still functional, new docs point users at chat).

**Deliverables:**
1. **`ConversationSession` + `ConversationMessage` + `ConversationAction` models.**
2. **Chat UI** — top-right slide-out drawer on every page + dedicated `/chat` page. Streams responses. Inline action chips (Send/Edit/Reject for proposed drafts; Open/Search for navigation suggestions).
3. **Intent classifier** — OrchestratorAgent's first stage. Routes incoming text to the right specialist sub-agent. Falls back to "RAG over conversation history + graph" for open-ended Q&A.
4. **Natural-language workflow creation** — "every time a deal stalls 14 days in negotiation, drop me a daily nudge" → AutomationRule row + per-rule KPI tracker + chat-card preview.
5. **Natural-language custom-field creation** — "I want to track which industry conference each lead came from" → CustomField row + auto-extracts from inbound messages via FieldExtractorAgent.
6. **Voice surface** (stretch) — Whisper-based voice input on mobile.

**Success metrics:**
- 30% of daily-active users issue >= 5 chat queries/day within 4 weeks of launch
- Workflow-rule creation via chat surpasses the legacy UI within 8 weeks
- Chat-to-action conversion >= 25% (chat session leads to an action that would have taken a form)

### Phase 4 — Real-time intelligence (10 weeks)

**Goal:** The analytics layer dissolves into Pillar 4. Any tenant-scoped question against any data, answered in <5s, in the meeting it's asked.

**Deliverables:**
1. **Query service stack decision** — DuckDB embedded vs. ClickHouse sidecar (architecture call below).
2. **CDC pipeline** — MySQL binlog → query service via Debezium or custom tail. <10s replication lag p99.
3. **Materialized rollups** — daily/weekly per-tenant rollups for common dimensions (pipeline by stage, revenue by channel, deals by competitor, etc.). Rollup catalog ships with the platform; tenants can declare custom rollups in YAML.
4. **Text-to-SQL fluency** — OrchestratorAgent gains a text-to-SQL tool scoped to the rollup schema. Includes a "show me the SQL" debug surface (compliance-friendly).
5. **Visualization rendering** — given a SQL result + question intent, pick the right chart type. Reuses recharts.
6. **Saved-query promotion** — any answered question can be saved as a "report" + scheduled.

**Success metrics:**
- p95 query latency < 5s for the common 80% of questions
- Text-to-SQL accuracy >= 85% on a held-out gold-set per tenant
- Saved reports replace 80% of current `routes/custom_reports.js` saved rows within 6 months

### Phase 5 — Polish, scale, certify (8 weeks)

**Goal:** Make it production-grade. SOC2 / HIPAA / DPDP audit-ready. Tenant-isolation hardening. Cost controls. Multi-region.

**Deliverables:**
1. **Per-tenant agent cost cap** + ratelimits + emergency-shutoff toggles.
2. **Agent KPI dashboards** (the user-visible Pillar 5 review surface).
3. **Audit log integration** — every agent action emits an `AuditLog` row + a `SemanticEvent`. Same hash-chain integrity as today's audit-log (`backend/lib/audit.js`).
4. **PHI / PII routing** — agents that touch wellness PHI get a separate model deployment (BAA-covered LLM endpoint) + tighter audit.
5. **Multi-region** — embedding store + query service replicate per region for data-residency tenants (India / EU / US).
6. **External agent SDK** — partners (Callified.ai, AdsGPT, Globus Phone) can register external agents that participate in orchestration.

---

## 5. Decisions needed before Phase 1 starts

### D1 — Embedding provider

| Option | Pros | Cons | Cost |
|---|---|---|---|
| **OpenAI text-embedding-3-large** | Highest quality, simple integration | Vendor lock, US-region | $0.13/1M tokens |
| Voyage AI voyage-3-large | Cheaper, batch-friendly | Less ecosystem | $0.06/1M tokens |
| Local Sentence-Transformers + GPU | Zero per-call cost, on-prem | Operational overhead, lower quality | GPU rental |
| Cohere embed-v3 | Multilingual, BAA-friendly | Higher latency | $0.10/1M tokens |

**Recommendation:** OpenAI for Phase 1; add adapter abstraction so tenants can opt into local/Voyage for cost or sovereignty.

### D2 — Graph store

| Option | Pros | Cons |
|---|---|---|
| **MySQL adjacency tables** | Reuses existing infra, multi-tenant story already solved | Slow on deep traversals (>3 hops); no native graph queries |
| Postgres + AGE extension | Real graph queries on familiar SQL infra | Migrate L0 to Postgres OR run separate Postgres |
| Neo4j sidecar | Best graph query performance, mature ecosystem | New infra, sync complexity, $/license |
| TigerGraph / Memgraph | High-perf | More exotic, smaller community |

**Recommendation:** MySQL adjacency tables for Phase 1+2. Re-evaluate at Phase 3 once we have real query patterns. Premature graph-store optimization is a classic trap.

### D3 — LLM provider for the agents

| Option | Pros | Cons |
|---|---|---|
| **Anthropic Claude Sonnet/Opus** | Highest quality, tool-use native, strong on long context | Pricier than alternatives |
| OpenAI GPT-4o-mini + GPT-4o | Mature ecosystem, cheap small model | Tool-use less reliable than Claude |
| Google Gemini 2.5 (current default) | Cheap, native multimodal | Inconsistent tool-use; we've hit rate-limit issues |
| Mixed (Sonnet for OrchestratorAgent, Haiku for specialist agents) | Cost-optimal | Operational complexity |

**Recommendation:** Anthropic for orchestration + complex tasks; Haiku for high-volume specialist work (enrichment, classification). Keep the existing Gemini integration available as a fallback / cost-tier option.

### D4 — Query warehouse

| Option | Pros | Cons |
|---|---|---|
| **DuckDB embedded** | Zero new infra; tenant-scoped DB per tenant possible | Limited concurrency; not great for streaming |
| ClickHouse sidecar | Real-time analytics champion | New infra; ops cost |
| Postgres (same instance as graph) | Single store | Slow on heavy aggregations |
| Snowflake / BigQuery | Cloud-managed, scales | $$$ + vendor lock |

**Recommendation:** DuckDB for Phase 4; revisit ClickHouse if Phase 4 exposes a real concurrency problem. DuckDB has shipped enough at scale to be a credible default.

### D5 — Teammate naming policy

- **Option A:** Ship with fixed names (Rebecca / Raj / Priya / Sam / Tara / Maya) — strong brand identity but feels presumptuous on first encounter.
- **Option B:** Tenant-customizable from setup — feels more like "your team" but adds onboarding friction.
- **Option C (recommended):** Ship with defaults the user can rename + reskin at any time. Wellness vertical gets vertical-appropriate defaults (e.g. Maya instead of generic ops name).

---

## 6. Backwards-compatibility commitments

This is a stack evolution, not a forklift. The following surfaces stay stable across all 5 phases:

- **All current API endpoints continue to work.** New endpoints get versioned `/api/v2/` paths where the shape genuinely changes.
- **All current Prisma models stay.** New layers add new models; nothing existing gets dropped before a 6-month deprecation window.
- **The 90+ page form-based UI** stays accessible. Users who never engage with chat or teammates get exactly today's experience.
- **The existing AI surfaces** (`routes/ai.js`, lead scoring, sentiment, deal insights) stay live. They get rerouted under the OrchestratorAgent over time but the external contract doesn't break.
- **The deploy pipeline** stays — every new layer adds gates (semantic-event-emit gate, graph-sync gate, agent-budget gate). Nothing existing gets removed.
- **External partner API** (`/api/v1/external/*` — Callified, AdsGPT, Globus Phone) stays exactly as it is. The teammate framework adds an internal-facing layer; partners keep their existing contracts. Phase 5 adds an opt-in "external agent SDK" for partners that want to participate in orchestration.

---

## 7. Success metrics — north stars

| Metric | Baseline (v3.7.x) | Phase 1 target | Phase 3 target | Phase 5 target |
|---|---|---|---|---|
| Chat queries per DAU/day | 0 | 0 (chat not shipped) | 5+ | 20+ |
| Manual form-fill events per DAU/day | ~40 (estimated) | ~40 | ~25 | ~10 |
| Time-to-first-insight on "new question" | 15 min (talk to data team) | 15 min | 2 min | 30s |
| Teammate-suggested action accept rate | n/a | n/a (no teammates) | 35%+ | 55%+ |
| Forecast accuracy (Raj's KPI) | ±25% variance | ±25% | ±15% | ±8% |
| % accounts with full enrichment | ~10% | ~30% | ~70% | ~90% |
| Per-tenant monthly LLM cost | < $5 (current Gemini lead-scoring) | < $25 | < $80 | < $200 (gross — net of value far higher) |
| Per-push test count | ~4,128 | ~4,400 | ~5,200 | ~6,000 |

The cost figures assume mid-market tenants (~5 seats, ~1,000 contacts, ~200 deals/month). Enterprise tenants scale linearly; usage caps + per-tenant SLAs apply.

---

## 8. What we are NOT building

- A new database. L0 stays MySQL/Prisma. We add layers; we don't replace foundations.
- A custom LLM. We integrate frontier models (Claude, GPT, Gemini); we don't train.
- A general-purpose agent platform. Every agent is CRM-task-scoped. We are not building LangChain.
- A new UI framework. React + Vite stay. The chat surface is a React component.
- A coding assistant. "Lovable for CRM" is the user-facing analogy; we're not letting users write code.
- Replacement of compliance-sensitive forms (consent capture, billing edits, PHI fields). These stay structured.

---

## 9. Open questions for stakeholder review

1. **Phase 1 launch tenant** — wellness (Enhanced Wellness, Rishu) or generic (Globussoft demo tenant)? Wellness has clearer "digital teammate" demand (Maya for inventory + appointments); generic has wider eventual market. **Recommendation:** wellness as the alpha, generic at Phase 2.
2. **Embedding cost cap policy** — fixed per tenant ($), per-user ($), or per-event volume? Different models make different sense for SMB vs enterprise.
3. **Slack-first or in-app-first for teammates?** Slack already won at "where work happens" for many tenants but adds OAuth/install friction. In-app is simpler but lower retention.
4. **Whether to publish the External Agent SDK in Phase 5 publicly or stay invite-only.** Public draws ecosystem but increases support load.
5. **Pricing model shift?** v3.7.x today is seat-based. AI-era might warrant a hybrid (seats + agent-action budget + premium teammate tiers). Not in scope for this PRD — a separate commercial doc.
6. **Naming the product** — "Globussoft CRM" still? Or a sub-brand for the AI surface ("Globussoft AI" / "Globussoft Teammates")? Marketing input needed.

---

## 10. Appendix — concrete Phase 1 work breakdown

A first-pass developer punch list for the 8-week Phase 1. Each row is 0.5-2 dev-weeks. Total ~14 dev-weeks across ~2 engineers (with parallel work + buffer).

| # | Item | Effort | Owner | Notes |
|---|---|---|---|---|
| 1 | `SemanticEvent` Prisma model + migration | 0.5w | backend | Single new table; `[allow-unique]` blessing for the eventId unique index |
| 2 | Per-route emit hooks (Deal/Contact/Account/Visit POST + PUT + DELETE) | 1.5w | backend | ~20 routes; wrap with shared `emitSemantic()` helper in `lib/semanticEvents.js` |
| 3 | Embedding pipeline sidecar (Node service) | 1.0w | backend | Pulls SemanticEvent rows where embedding IS NULL; batches; back-pressures on rate limit |
| 4 | OpenAI embedding adapter | 0.3w | backend | Behind `embeddingProvider` factory; env-var swappable |
| 5 | `graph_edges` adjacency table + `KnowledgeGraph` API | 1.0w | backend | Tenant-scoped, indexed on (tenantId, fromKind, fromId) and (tenantId, predicate) |
| 6 | Account model + Contact.accountId migration | 1.5w | backend | Backfill from existing Contact.company; opt-in for now; not used by existing UI |
| 7 | `ICPDefinition` model + tenant-onboarding form | 0.8w | backend + frontend | Settings page gains "Define your ICP" surface |
| 8 | `ICPMatchAgent` — first end-to-end agent | 1.5w | backend | Reuses existing `lib/eventBus.js` action surface for now; writes to Contact.aiScore + SemanticEvent |
| 9 | Embedding-cost budget + back-off | 0.5w | backend | Per-tenant tracker in Redis; hard cap; auto-degrade on overage |
| 10 | Per-push gate additions | 0.8w | tests | +5 vitest for semanticEvents helper, +1 api spec for ICP score parity |
| 11 | Demo seed data update | 0.3w | backend | Seed adds an ICPDefinition for the wellness tenant + 10 sample SemanticEvents |
| 12 | Internal-only `/dev/semantic-events` viewer page | 0.5w | frontend | Read-only table for engineering debug; gated to ADMIN |
| 13 | Drift-detector cron (graph vs L0 nightly audit) | 0.5w | backend | Emits issue if graph state diverges from L0 by >0.1% |
| 14 | Operational runbook + CLAUDE.md updates | 0.5w | docs | New section in `backend/lib/semanticEvents.js` header + CLAUDE.md standing rules for the new patterns |
| 15 | Buffer / unknown unknowns | 2.0w | — | Reserved |

---

## 11. Decision log

A running log of architectural decisions made while building this PRD. Future maintainers should add to this — the "why we chose X over Y" history matters more than the choice itself.

- **2026-05-14 — L0 stays.** No green-field rewrite. Customers + integrations depend on the existing MySQL schema; we add layers on top.
- **2026-05-14 — Adjacency tables, not Neo4j (Phase 1+2).** Premature graph-store optimization; revisit at Phase 3 once query patterns are real.
- **2026-05-14 — Anthropic Claude for orchestration; Haiku for specialists.** Tool-use reliability is the deciding factor. Gemini stays available as a fallback.
- **2026-05-14 — Specific teammate names (Rebecca/Raj/Priya/...).** Generic agent names feel robotic; specific names feel like colleagues. Make them tenant-customizable.

---

## 12. References

- The post that triggered this PRD: an essay arguing that AI-era enterprise software is defined by six pillars — semantic system of record, business knowledge graph, multi-agent framework, conversational interface, digital teammates, real-time intelligence. The shift: "from software you operate to software that operates with you."
- Existing relevant code in this codebase:
  - `backend/cron/orchestratorEngine.js` — embryonic OrchestratorAgent (wellness-only today)
  - `backend/lib/eventBus.js` — workflow engine; the natural foundation for AgentRun dispatch
  - `backend/routes/ai.js`, `routes/ai_scoring.js`, `routes/sentiment.js` — today's AI surfaces; rerouted in Phase 1
  - `prisma/schema.prisma` — 114 models; L0 truth store
  - `backend/lib/audit.js` — hash-chain audit log; pattern reuses for SemanticEvent integrity
