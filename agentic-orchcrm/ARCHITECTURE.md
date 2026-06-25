# Architecture

This document explains *why* the system is shaped the way it is, so a new
contributor can navigate it with confidence.

> **New here?** Jump to the [Visual guide](#visual-guide--the-whole-system-in-maps)
> at the bottom for a diagram-first, file-by-file tour of the whole project.

## Guiding principles

1. **Provider-agnostic.** No package except `providers` knows a specific LLM
   exists. Agents ask for a *capability tier*; the router resolves it to a
   concrete model using whatever keys are configured.
2. **Minimal human-in-the-loop.** The human assigns one goal. Autonomy is the
   default; human approval is an opt-in policy on individual tools.
3. **Sector adaptation is configuration, not code.** Domains differ only in
   their sector pack (agent roster + prompts + tools). The engine is constant.
4. **Clean dependency direction.** `shared` ← `providers`/`tools`/`sectors` ←
   `core` ← `db`/apps. Nothing depends "upward". Ports (interfaces) invert the
   few places that would otherwise.
5. **Model proposes, engine guarantees.** For rich artifacts (the brochure), the
   LLM decides *content and structure* (including arbitrary extra sections); the
   deterministic engine owns *layout physics* — it measures real heights and flows
   content into pages. The output is fully adaptive yet can never clip or look
   broken, regardless of LLM variance.

## The dependency graph

```
shared  (types, config, logging, errors — no deps)
  ▲  ▲  ▲
  │  │  └────────── sectors      (agent rosters per domain)
  │  └───────────── providers    (LLM adapters + ModelRouter)
  │                    ▲
  └── tools ───────────┘         (tool contract + built-ins)
        ▲   ▲   ▲
        └───┴───┴──── core        (agent loop, orchestrator, RunStore port)
                        ▲
                        ├──────── db   (PgRunStore implements core's RunStore)
                        ├──────── apps/orchestrator
                        └──────── apps/web
```

## How a run works

```
human ── goal ──▶ Orchestrator.run({ sector, goal })
                      │
                      ▼
              runAgent(CEO)                      ◀── packages/core/agent
                      │  model wants to "delegate"
                      ▼
              ctx.invokeAgent("researcher", task)
                      │
                      ▼
              runAgent(researcher) ──▶ returns text ──┐
                      │                                │
              ctx.invokeAgent("writer", task)          │ results folded back
                      ▼                                │ into the CEO's context
              runAgent(writer) ──▶ returns text ───────┘
                      │
                      ▼
              CEO integrates ──▶ final deliverable
```

Every step emits an `OrchestrationEvent` to the `RunStore`. The in-memory store
also republishes to an `EventBus` so the dashboard can stream it live (SSE).
The same events, persisted to Postgres, are the analytics + audit trail.

### The two loops

- **Agent loop** (`packages/core/src/agent/agent-loop.ts`): one agent ↔ one
  model, running tools until the model returns a final answer. Generic — the
  CEO and every specialist use it.
- **Delegation** (`packages/core/src/orchestrator/orchestrator.ts`): the CEO's
  `delegate` tool calls `ctx.invokeAgent`, which runs *another* agent loop and
  returns its output. Recursion is depth-capped (`MAX_DELEGATION_DEPTH`), a
  per-pair anti-loop cap (`MAX_DELEGATIONS_PER_PAIR`) blocks repeated or duplicate
  delegations to the same specialist, and a shared step counter (`MAX_AGENT_STEPS`)
  bounds total work. The step cap is a *soft* stop — a capped run finalizes with
  its best available output instead of failing.

## Provider-agnosticism in detail

`AgentDefinition.tier` is one of `reasoning | balanced | fast | writing`.
`ModelRouter.resolve(tier)`:

1. Walks a provider priority list (`moonshot` → `xai` → `groq` →
   `openai-compatible` → `openai` → `anthropic`).
2. Picks the first provider that has a key configured (i.e. is in the registry).
3. Returns that provider + the model id for the tier (Moonshot's are
   `.env`-overridable; others use built-in defaults).

Result: the *same* sector pack runs on Kimi, OpenAI, or a local model with no
code change — only `.env` differs. Adding a native (non-OpenAI) provider means
implementing the `LLMProvider` interface and registering it; nothing downstream
changes.

## The adaptive brochure engine (the travel flagship)

The travel sector's deliverable is a print-ready PDF brochure. It is built on a
strict split that keeps it BOTH adaptive and reliable (principle 5):

- **The model owns CONTENT + structure.** `brochure_composer` emits a single
  `BrochureContent` JSON object — never HTML. Beyond the fixed fields (cover, intro,
  highlights, itinerary, route, inclusions, pricing), it routes ANY extra content the
  user gives — flight plan, packing list, "why us", visa FAQ, dining guide, … — into
  a generic `sections[]` array, each with a `layout` (`prose | grid | cards | gallery`).
  Nothing the user asks for is dropped.
- **The engine owns LAYOUT.** `buildBrochureHtml` (`packages/tools/src/brochure/
  render-core.ts`) renders that JSON into A4 HTML in one of two template *families* —
  `banded` (tmc-press) and `editorial` (editorial-sakura) — owning pagination,
  asset-fetching and styling. The template is a **blueprint + block library**, not a
  fixed pipeline.
- **Measure-and-flow, not guesswork.** Both families paginate by MEASURING real block
  heights in headless Chrome (`measureEditorialBlocks` in `render.ts`) and packing
  blocks into pages. So arbitrary `sections[]` reflow, split across pages (with a
  "cont." header), and NEVER clip; a sparse page distributes whitespace evenly
  (intentional, not stranded); an oversized block escapes to a flow page. The same
  content adapts to any trip length — a 1-day multi-stop trip fills its page, a 22-day
  trip paginates.
- **Schema-constrained output.** When the provider supports it (Groq/OpenAI
  `response_format: json_schema` for gpt-oss-120b), the composer is forced to emit a
  schema-valid object — killing markdown-fence / commentary / malformed-JSON failures.
  Providers that lack it are unaffected, and the engine still parses defensively
  (`parseBrochureContent`) and rejects an empty body (`hasBody`). Model = intent;
  engine = guarantee.

## Minimal human-in-the-loop

`Tool.permission` is `auto` or `ask`. The engine gates `ask` tools through
`requestApproval`, whose behavior follows `ORCHESTRATION_MODE`:

- `autonomous` (default): approve immediately, but still emit an
  `approval.requested` event so the dashboard shows what happened.
- `supervised`: the intended extension point to block on a real human decision
  (e.g. a pending-approvals queue + EventBus round-trip). Marked `TODO` in
  `agent-loop.ts`.

So the product can be fully hands-off, or selectively gate only the few tools
that touch the outside world — without changing agent or sector code.

## Persistence & billing

`RunStore` is a port (interface in `core`). Two implementations:

- `InMemoryRunStore` — dev/demo, also powers the dashboard's live + analytics
  reads.
- `PgRunStore` (`packages/db`) — writes `run_events` and `usage_events` to
  Postgres. `usage_events` records raw `cost_usd` and marked-up `billed_usd` per
  model call — the basis of pooled-key markup billing and per-tenant invoices.

Multi-tenancy: every customer-owned row carries `tenant_id`. Enforce isolation
with Postgres row-level security in production.

## Production checklist

The scaffold is correct but intentionally minimal. Before shipping:

- [ ] **Durable execution** — replace the in-process / DB-poll worker with a
      real queue (BullMQ) or durable engine (Temporal) so long runs survive
      restarts and can pause for approvals.
- [ ] **Auth & tenancy** — add authentication (Clerk/WorkOS) and Postgres RLS;
      thread `tenantId` through the API and engine.
- [ ] **Secret encryption** — encrypt `provider_keys.encrypted_key` with KMS/
      Vault; never log or prompt-inject secrets.
- [ ] **Approval UX** — implement `supervised` mode end-to-end (pending queue +
      UI + resume).
- [ ] **Observability** — wire the logger to a real sink and add LLM tracing
      (Langfuse/Helicone).
- [ ] **Rate limits & retries** — per-provider backoff and fallback across
      providers in the router.
- [ ] **Native providers** — add the Anthropic adapter (and others) implementing
      `LLMProvider`.

---

## Visual guide — the whole system in maps

A diagram-first, file-by-file tour. The sections above explain the *concepts*;
this one is the *concrete map* of the current implementation. Start at Level 0 and
zoom in.

### Level 0 — bird's-eye

```
              YOU
               │ assign ONE goal
               ▼
   ┌───────────────────────────┐
   │   apps/   (what you RUN)   │   web dashboard · CLI demo · worker
   └─────────────┬─────────────┘
                 │ import the engine
                 ▼
   ┌──────────────────────────────────────────┐
   │ packages/ (the ENGINE = your libraries)   │   the brain + its parts
   └─────────────┬──────────────────────────────┘
                 │ call out to
                 ▼
   ┌───────────────────────────┐
   │ External services         │   LLM APIs (Groq/Moonshot/…), image APIs
   │                           │   (Pexels/Wikimedia/…), maps, Postgres
   └───────────────────────────┘

   node_modules/ = downloaded 3rd-party libs (Next, React, …) — not your code, gitignored
```

### Level 1 — the dependency stack (who imports whom)

Arrows point downward = "depends on". Nothing points up; `shared` is the floor.
(This expands "The dependency graph" above with the runnable apps on top.)

```
┌──────────────────────── apps/ (top — you run these) ────────────────────────┐
│   apps/web  (Next.js dashboard)        apps/orchestrator  (demo CLI + worker) │
└───────────────┬───────────────────────────────┬─────────────────────────────┘
                │   import @agentic-os/core       │
                ▼                                 ▼
┌──────────────────────────── packages/ (the engine) ─────────────────────────┐
│                      ┌───────────────────────────┐                           │
│                      │  core  (orchestrator +     │   ← the brain            │
│                      │        agent loop)         │                          │
│                      └───────┬─────────┬──────────┘                          │
│                ┌─────────────┘         └─────────────┐                       │
│                ▼             ▼                        ▼                       │
│          providers        tools                   sectors                    │
│         (LLM router)   (what agents do)        (agent behavior)              │
│                └─────────────┴────────────┬───────────┘                      │
│                                           ▼                                  │
│                                 shared  (types/config/log)  ← FLOOR          │
│                                                                              │
│   db (Postgres)  ──implements──▶ core's RunStore "port"   (production only)  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Level 2 — the full annotated file tree

```
Orchestrator_product/
├── package.json            monorepo root: workspaces + npm scripts (demo/worker/web)
├── tsconfig.base.json      shared TypeScript settings
├── .env / .env.example     real secrets (gitignored) / blank template
├── .gitignore              ignores node_modules, .env, temp/, public/generated/
├── README / ARCHITECTURE / SECURITY .md
├── node_modules/           downloaded libs + symlinks to your packages (auto, gitignored)
│
├── packages/   ───────────── THE ENGINE ─────────────
│   ├── shared/src/          FOUNDATION — imported by everything
│   │   ├── types.ts            domain types (Agent, SectorPack, Event, Usage…)
│   │   ├── config.ts           the only reader of .env → AppConfig
│   │   └── errors.ts · ids.ts · logger.ts · index.ts
│   │
│   ├── providers/src/        LLM ACCESS — the only package that knows models exist
│   │   ├── router.ts           tier → provider+model (provider-agnosticism)
│   │   ├── registry.ts         which providers have a key configured
│   │   ├── openai-compatible.ts one adapter: Moonshot/OpenAI/Groq/xAI/…
│   │   └── pricing.ts · types.ts · index.ts
│   │
│   ├── tools/src/            WHAT AGENTS CAN DO
│   │   ├── registry.ts · types.ts (Tool contract + ToolContext)
│   │   ├── render.ts           HTML → PDF (headless Chrome) + measureBlocks (real block heights)
│   │   ├── assets.ts           fetch real photos / QR / maps (keyless fallbacks)
│   │   ├── builtins/
│   │   │   ├── delegate.ts        hand a sub-task to a specialist (orchestration)
│   │   │   ├── web-fetch.ts       gated + SSRF-hardened
│   │   │   └── image-search.ts · map-route.ts · render-pdf.ts (shim)
│   │   └── brochure/          THE TEMPLATE ENGINE (sakura / tmc-press) — adaptive
│   │       ├── types.ts          BrochureContent JSON shape (+ sections[]) + Template type
│   │       ├── templates.ts      template "cards" (fonts + family)
│   │       ├── render-core.ts    ★ template families + MEASURE-AND-FLOW pagination + sections[]
│   │       ├── geomap.ts         custom SVG country map
│   │       └── data/countries-110m.json   world-atlas data
│   │
│   ├── sectors/src/          AGENT BEHAVIOR (pure config, no logic)
│   │   ├── registry.ts · shared-prompts.ts (autonomy + specialist) · styles.ts
│   │   └── packs/
│   │       ├── travel.ts          research→copy→compose(JSON + sections[] + schema) → template PDF
│   │       ├── report-writing.ts  research→analyst→writer→editor→designer → PDF
│   │       └── finance.ts · healthcare.ts   + compliance gates → PDF
│   │
│   ├── core/src/             THE BRAIN
│   │   ├── engine.ts           createEngine() wires it all together
│   │   ├── agent/agent-loop.ts ★ the loop EVERY agent runs (model→tools→repeat)
│   │   ├── orchestrator/orchestrator.ts ★ run a goal: delegate + finalize
│   │   └── run/events.ts       RunStore port + InMemoryRunStore + EventBus (SSE)
│   │
│   └── db/src/               PERSISTENCE (production only)
│       ├── schema.ts (runs/events/usage/tenants) · pg-run-store.ts
│       └── client.ts · queries.ts · migrate.ts   (+ drizzle.config.ts)
│
└── apps/   ───────────── THE PROGRAMS YOU RUN ─────────────
    ├── orchestrator/src/
    │   ├── demo.ts             `npm run demo`   — one-shot CLI (in-memory)
    │   └── index.ts            `npm run worker` — prod worker (polls Postgres)
    └── web/                    `npm run web`    — the dashboard (see Level 4)
```

`★` = the files where the important logic lives.

### Level 3 — what happens when you submit a goal

```
goal ──▶ orchestrator.run({ sector, goal, styleKey })            [packages/core]
            │  load pack + CEO                                    [packages/sectors]
            ▼
    ┌── runAgent(CEO) ────────────────────────────────┐          [agent-loop.ts]
    │   loop: call model ─▶ wants a tool? ─▶ run it ─┘  (tier→model via providers)
    │   CEO calls delegate(specialist, task)                     [tools/delegate]
    │        │  guards: depth · allowlist · per-pair anti-loop    [orchestrator]
    │        ▼
    │   runAgent(researcher) ─▶ notes + accent + photo queries
    │   runAgent(copywriter) ─▶ prose
    │   runAgent(composer)   ─▶ ONE JSON object  (no HTML)
    │        └── each result folded back into the CEO's context
    └──────────────────────────────────────────────────┘
            │
            ▼  FINALIZE — two modes (set per sector by finalize.render)
    ┌──────────────────────────────┬───────────────────────────────────────┐
    │ 'html_to_pdf'                 │ 'brochure_json'   ◀ travel uses this    │
    │ (the AI wrote the full HTML)  │ (the AI wrote JSON content)            │
    │   renderHtmlToArtifact()      │   parseBrochureContent()               │
    │       → Chrome → PDF          │   buildBrochureHtml(content, template) │
    │                               │     ├ fetch real photos (from queries) │
    │                               │     ├ build SVG map (from cities)       │
    │                               │     ├ QR + palette (from accent)        │
    │                               │     └ flow into template → Chrome → PDF │
    └──────────────────────────────┴───────────────────────────────────────┘
            │
            ▼  run.completed → deliverable = text or PDF download URL

   ⟂ Every step emits an event → RunStore → EventBus → (SSE) → live dashboard.
     The step cap is a SOFT stop: a capped run finalizes its best output, not fails.
```

> The `brochure_json` branch is the **adaptive** path (see *The adaptive brochure
> engine*): the composer's `sections[]` carry any extra content the user asked for,
> and `buildBrochureHtml` measures real block heights to flow everything across pages —
> so the brochure never clips or strands whitespace, whatever the trip length or extras.

### Level 4 — inside `apps/web`

```
apps/web/
├── package.json              deps: @agentic-os/{shared,core,sectors} + next/react
├── next.config.mjs · tailwind.config.ts · postcss.config.mjs
└── src/
    ├── app/                  Next.js App Router (pages + API routes)
    │   ├── layout.tsx          shell: sidebar + fonts (wraps every page)
    │   ├── page.tsx            ★ Command Center (assign goal, watch live)
    │   ├── globals.css
    │   ├── history/page.tsx · history/[id]/page.tsx   past runs + detail
    │   ├── analytics/page.tsx · agents/page.tsx · settings/page.tsx
    │   └── api/
    │       ├── runs/route.ts            POST = start run · GET = list
    │       ├── runs/[id]/route.ts       one run's full detail
    │       ├── runs/[id]/stream/route.ts ★ SSE live event stream
    │       ├── sectors/route.ts         packs + agents + template picker
    │       └── analytics/route.ts · config/route.ts
    ├── components/
    │   ├── CommandConsole.tsx     input form (sector + template + goal)
    │   ├── AgentNetwork.tsx       live agent graph (status + tokens)
    │   ├── TraceConsole.tsx       live event log
    │   ├── DeliverablePanel.tsx   result / PDF preview + download
    │   └── ui.tsx · layout/Sidebar.tsx
    └── lib/
        ├── engine.ts             ★ in-process engine singleton (createEngine)
        ├── useOrchestration.ts   ★ client hook: POST goal + open SSE + fold state
        └── artifact.ts · format.ts · rate-limit.ts · guards.ts · types.ts
```

Request flow inside the dashboard:

```
 Browser: page.tsx (Command Center) ── useOrchestration() hook
    │ ① POST /api/runs { sectorKey, goal, styleKey }
    ▼
 api/runs/route.ts ─▶ rate-limit ▶ validate ▶ concurrency cap ▶ orchestrator.run()
    │                              (engine from lib/engine.ts — runs IN-PROCESS today)
    │ returns { runId }
    │ ② open EventSource  GET /api/runs/:id/stream
    ▼
 api/runs/[id]/stream/route.ts ─▶ subscribes to the EventBus in core's store
    │ pushes each event as SSE
    ▼
 useOrchestration.fold(event) ─▶ updates state ─▶ re-renders:
    ├─ AgentNetwork    (who is working)
    ├─ TraceConsole    (the live log)
    └─ DeliverablePanel(final text / PDF)   when run.completed arrives
```

> **Today vs. production.** Right now `apps/web` runs the engine *in-process* with
> the in-memory store (no database). In production, `POST /api/runs` would instead
> enqueue a run into Postgres, and `apps/orchestrator/index.ts` (the worker) would
> pick it up and execute it — the two communicate through the DB, not by calling
> each other.

### One-sentence summary

**`apps/` are thin hosts that call the `packages/core` engine; the engine routes
agents to LLMs (`providers`), lets them use `tools`, following the personas in
`sectors`, all typed by `shared`; results stream back as events to the `apps/web`
UI — and `db` only enters when you run it for real.**
