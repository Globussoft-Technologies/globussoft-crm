# INTEGRATION.md — embed the brochure engine as a NATIVE CRM feature

> **Goal.** Add brochure generation as a first-class feature inside Globussoft CRM —
> a sidebar item next to **TMC Catalogue / Itineraries / TMC Trips** — running
> **inside the CRM**: one app, one deploy, the CRM's auth, the CRM's **MySQL/Prisma**
> database. **Not** a separate service, no localhost-to-localhost calls.
>
> **End state.** A CRM user opens "Brochure Studio", enters a brief (or pulls one
> from a Trip/Itinerary), and downloads the *same* PDF the standalone app produces
> today — now saved against a CRM record.

This guide is the port-in plan. Deep internals are in `CLAUDE.md`; the security
posture in `SECURITY.md`; the full env list in `.env.example`.

---

## 1. Why this is straightforward

The engine's real work lives in **framework-agnostic Node/TS packages** with **zero
Next.js coupling**: `packages/{shared, providers, tools, sectors, core}`. The
standalone Next app (`apps/web`) is just one thin UI+API consumer of them. So the
CRM's **Express backend becomes another consumer** — it imports the same packages
and calls them in-process. The brochure **rendering is reused unchanged**, which is
why the output stays identical to today.

```
CRM React UI ──> CRM Express backend ──(in-process)──> engine packages
  "Brochure Studio"   /api/brochures/*        Orchestrator → specialists → composer
   (a sidebar feature)                        → puppeteer render → PDF
                                              persisted to CRM MySQL (Prisma) + uploads
```

## 2. What is reused AS-IS (do not rewrite — this is what keeps the PDF identical)

- `packages/tools` — the brochure engine + puppeteer PDF render + asset fetching.
- `packages/sectors` — the `travel` pack (agents, prompts, templates, finalize).
- `packages/providers` — provider-agnostic LLM routing (ModelRouter, pricing, catalog).
- `packages/core` — `Orchestrator`, the agent loop, the `RunStore` **port**, EventBus.
- `packages/shared` — `loadConfig()`, types, logging.

Bring these into the CRM monorepo as workspaces (or vendor them under
`backend/src/brochure/engine/`). Keep their ESM / NodeNext setup and the `.js`
import specifiers. Install their runtime deps — the key one is **`puppeteer`**
(bundles Chromium for the PDF render). **Skip `packages/db`** (Postgres/Drizzle) — we
go MySQL/Prisma instead (§5).

## 3. Backend wiring (Express, behind the CRM's JWT + tenant)

1. **Engine factory** — mirror [`apps/web/src/lib/engine.ts`](apps/web/src/lib/engine.ts):
   `loadConfig()` (from env) → build the engine (provider registry + `ModelRouter` +
   tool registry + a `RunStore`) → an `Orchestrator`. Pin it as a singleton on the
   backend process (one instance, reused per request).
2. **Routes** — port the Next handlers in `apps/web/src/app/api/*` to Express under
   `/api/brochures`, each wrapped by the CRM's auth/RBAC middleware and scoped to
   `req.user.tenantId` / `userId`:
   | Route | Mirrors | Does |
   |---|---|---|
   | `POST /api/brochures/runs` | `api/runs/route.ts` | validate + `sanitizeBrandKit` (port [`apps/web/src/lib/brand-kit.ts`](apps/web/src/lib/brand-kit.ts)), then `orchestrator.run({ runId, sectorKey, goal, styleKey?, brand? })`; return `{ runId }` |
   | `GET /api/brochures/runs/:id` | `api/runs/[id]/route.ts` | run status + result (the PDF link) from the store |
   | `GET /api/brochures/runs/:id/stream` | `api/runs/[id]/stream/route.ts` | SSE live trace — subscribe to `store.bus`; **keep** the `X-Accel-Buffering:no` + heartbeat hardening |
   | `GET /api/brochures/sectors` | `api/sectors/route.ts` | `listSectorPacks()` + each sector's styles (for the picker) |
   | `GET·POST /api/brochures/models` | `api/models/route.ts` | model catalog + per-tier selection (optional) |
3. Keep the engine's **cost/abuse guardrails** (per-run USD budget, step/delegation
   caps, concurrency, rate limit) — they're config-driven (`.env`); just surface them
   through the CRM's config.

## 4. Frontend — the feature page

- Add a sidebar entry **"Brochure Studio"** (or "Travel Brochures") + a route
  (React Router v7), matching the CRM's nav/layout/permissions.
- Port the UI from the Next app — it's standard React (fetch + `EventSource`), so it
  moves over with minimal change:
  - `apps/web/src/components/CommandConsole.tsx` — brief + sector/style picker + brand-kit panel.
  - `apps/web/src/components/LogoPlacer.tsx` — the visual logo placer.
  - `apps/web/src/components/DeliverablePanel.tsx` — PDF/HTML preview.
  - `apps/web/src/lib/useOrchestration.ts` + `lib/types.ts` — the run hook + view models.
  - Repoint every API call to `/api/brochures/*`. Map the Tailwind design tokens the
    components use (`bg-panel`, `border-edge`, `text-muted`, `accent`, `accent2`,
    `bg-ink`) to the CRM's design system, or add them to the CRM's Tailwind config.
- Nice touch: pre-fill the brief from a selected **Trip / Itinerary** so a brochure is
  one click from existing CRM data.

## 5. Database — CRM-NATIVE (MySQL + Prisma)

**Do not deploy our Postgres/Drizzle.** The engine's `RunStore` is a **port** (the
interface in `packages/core/src/run/events.ts`) — the CRM supplies its own:

- **Recommended (minimal, fully native).** Use the bundled **`InMemoryRunStore`** for
  the *transient* run/event state (it only needs to live for the ~30–60s of a run),
  and persist the **deliverable** in the CRM's MySQL via a new Prisma model, written
  when the run completes. Example:
  ```prisma
  model Brochure {
    id        String   @id @default(cuid())
    tenantId  String
    userId    String?
    tripId    String?            // attach to a Trip / Itinerary / Lead
    sectorKey String                 // "travel"
    styleKey  String?
    goal      String   @db.Text       // the brief
    status    String                  // "completed" | "failed"
    pdfUrl    String?                 // CRM-served URL / asset id
    costUsd   Decimal? @db.Decimal(10, 6)
    billedUsd Decimal? @db.Decimal(10, 6)
    createdAt DateTime @default(now())
    @@index([tenantId, tripId])
  }
  ```
  The brochure then lives in the CRM's DB like any other record — listable, filterable,
  attachable. This is the "DB native" path and is all the feature needs to work.
- **Optional (full analytics in MySQL).** If you also want the complete event trace +
  per-model billing in MySQL, implement a `PrismaRunStore` satisfying the `RunStore`
  interface (`runs` / `run_events` / `usage_events` as Prisma models). Our
  `packages/db/schema.ts` is the reference shape to translate from Postgres → Prisma.
  Not required for v1.

## 6. Deliverable storage — CRM-native

Set the engine's `GENERATED_DIR` to the CRM's uploads/static directory (or pipe the
rendered PDF into the CRM's existing file/asset storage). Serve it through the CRM's
own static/asset route, store the URL on the `Brochure` row, and attach it to the
related Trip/Itinerary/Lead. No cross-service `/generated` fetch — the file is a CRM
asset like any attachment.

## 7. Config / env (in the CRM backend `.env`)

The engine reads its config from env via `loadConfig()`. Add to the CRM backend env
(see `.env.example` for the full annotated list):

- **LLM provider + models — keep them IDENTICAL to the standalone project.** Do **not**
  re-pick a provider or model. Copy the project's *current working* values verbatim into
  the CRM backend env: the active provider API key + its base URL, and the four tier ids
  `MODEL_REASONING` / `MODEL_BALANCED` / `MODEL_FAST` / `MODEL_WRITING` it runs today.
  **The repo owner will share the API key** — set it in the CRM env, never commit it.
  The engine is provider-agnostic and reads these via `loadConfig()`, so the same env →
  the exact same models and brochure quality as now. (Leave anything blank in
  `.env.example` blank; only the keys the project actually uses need to be set.)
- **Maps:** `GEOAPIFY_API_KEY` (free; degrades gracefully if absent).
- **Guardrails:** `MAX_RUN_BUDGET_USD`, `MAX_AGENT_STEPS`, `MAX_CONCURRENT_RUNS`,
  `RATE_LIMIT_PER_MINUTE`, `MAX_GOAL_CHARS`.
- **Output:** `GENERATED_DIR` → the CRM uploads dir.

(No `DATABASE_URL` for the engine — persistence is the CRM's Prisma/MySQL, §5.)

## 8. Phased plan (each phase independently testable)

1. **Backend engine** — bring in the packages + engine factory + `POST` and `GET`
   routes (in-memory store, write PDF to disk). ✅ when a call produces a PDF from the
   CRM backend.
2. **Persistence** — add the Prisma `Brochure` model; write a row on completion;
   attach to a CRM entity.
3. **Frontend** — the "Brochure Studio" page (port the components); end-to-end in the UI.
4. **Polish** — SSE live trace, the logo placer, model-routing settings, RBAC/tenant
   on every route, deliverable into CRM asset storage, pre-fill from a Trip.

## 9. What you can rely on

The engine, both templates, provider-agnostic routing, cost guardrails, the brand-kit
sanitizer, and the composer completeness guard are all **imported as-is** — so the
brochure output is exactly what the standalone app produces today. The only **new**
code is the Express route wrappers, the Prisma persistence + attachment, and the React
feature page. Everything that makes the PDF look good is reused, unchanged.
