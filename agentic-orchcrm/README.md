# Agentic OS

A **provider-agnostic, sector-adaptable multi-agent orchestration platform**. A
human assigns **one goal** to a CEO/Orchestrator agent; the CEO autonomously
plans, delegates to specialist agents, integrates their work, and returns the
finished result — with **minimal human involvement** by design.

- **Use any provider key** — Moonshot/Kimi, OpenAI, or any OpenAI-compatible
  endpoint. Agents request a *capability tier*; a router maps it to whatever
  keys you've configured.
- **Adapt to any sector** — healthcare, finance, report-writing, … are swappable
  "sector packs" (pure config). The engine never changes.
- **Autonomous by default** — approval gating is opt-in per tool; the human's
  only required action is assigning the goal.
- **Built to monitor** — a live trace + analytics dashboard show every agent,
  delegation, and cost.

> Looking for the "why it's built this way" tour? See **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Quickstart

Requires **Node 20.12+**.

```bash
# 1. Install (npm workspaces links the packages together)
npm install

# 2. Configure a provider key
cp .env.example .env
#   then set MOONSHOT_API_KEY=... (and adjust MODEL_* if your model ids differ)

# 3a. Run the end-to-end CLI demo (no database needed)
npm run demo -- "Write a 1-page brief on the AI orchestration market"

# 3b. Or run the dashboard
npm run web        # http://localhost:3000
```

The demo prints the live orchestration trace (CEO → specialists → final answer)
and the billed cost. The dashboard does the same visually, plus an analytics
panel.

## Layout

```
apps/
  web/            Next.js dashboard — agent network, command console, analytics
  orchestrator/   CLI demo + production worker that runs agent loops
packages/
  core/           Orchestration engine (provider-agnostic). The brain.
  providers/      LLM adapters + ModelRouter (Moonshot/Kimi, OpenAI, …)
  tools/          Tool registry + built-in tools (incl. `delegate`)
  sectors/        Sector packs: report-writing / finance / healthcare
  db/             Drizzle schema + Postgres RunStore (multi-tenant, usage metering)
  shared/         Types, config, logging, errors — depended on by everything
```

## Common tasks

| I want to… | Do this |
|---|---|
| Add a provider | Add a key in `.env`; for OpenAI-compatible ones it just works. Native APIs (e.g. Anthropic) get a new adapter in `packages/providers`. |
| Add/modify a sector | Copy a file in `packages/sectors/src/packs/`, edit the roster, register it in `registry.ts`. |
| Change an agent's behavior | Edit its `systemPrompt` / `tier` / `tools` in its sector pack (or, per-tenant, via the `agent_overrides` table). |
| Add a tool | Implement `Tool` in `packages/tools/src/builtins/`, add it to `builtinTools` or a sector's registry. |
| Persist runs (analytics/billing) | Set `DATABASE_URL`, run `npm run db:generate && npm run db:migrate`, then inject `PgRunStore` (see `apps/orchestrator/src/index.ts`). |

## Billing model

Default is a **pooled platform key with markup**: every model call records the
raw provider cost and the billed amount (`cost × BILLING_MARKUP`) in
`usage_events`. Per-tenant BYOK is supported via the `provider_keys` table
(store keys encrypted — never plaintext).

## Status

This is a working **scaffold**: the engine, routing, delegation, sector packs,
dashboard, and metering all function end-to-end on the in-memory store. See
ARCHITECTURE.md → "Production checklist" for what to harden before shipping
(durable execution, auth, secret encryption, RLS, queue-based worker).
