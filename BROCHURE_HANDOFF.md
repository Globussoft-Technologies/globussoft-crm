# BROCHURE ENGINE — CRM Implementation Handoff (A–Z)

> **Who this is for:** the Claude working **inside the Globussoft CRM repo** (`globussoft-crm`),
> on the **Travel Stall** vertical's **Brochure Engine** feature.
>
> **What this is:** the complete, self-contained spec to (1) make brochure generation work,
> and (2) bring the feature to full parity with the standalone engine's UI — switchable
> models, correct cost estimation, a live multi-agent view, and a full brand kit + visual
> logo placer — **without touching anything else in the CRM.**
>
> **Mental model:** `agentic-orchcrm/` is an **upstream engine** (its own repo). The CRM
> **embeds it as a vendored sibling folder** and drives it through a **subprocess bridge**.
> You build the CRM-side glue + UI; you never edit the engine's internals. Engine fixes
> happen upstream and arrive via `git pull`.

---

## 0. ⛔ GOLDEN RULES — read before any edit

This is a **production repo that auto-deploys to prod on push to `main`** through 6 mandatory
gates. The #1 requirement is **do not affect any feature other than the Brochure Engine.**

**You may ONLY create/edit these files:**

| File | Why |
|---|---|
| `frontend/src/pages/travel/BrochureEngine.jsx` | the operator UI (extend it) |
| `backend/routes/travel_brochures.js` | the brochure API routes (extend) |
| `backend/services/brochureEngineBridge.js` | the subprocess bridge (extend, additive only) |
| `backend/lib/brochureBrandKit.js` | **NEW** — server-side brand sanitizer |
| `backend/test/lib/brochureBrandKit.test.js` | **NEW** — its unit test |
| `frontend/src/pages/travel/__tests__/BrochureEngine.test.jsx` | **NEW** — UI test (frontend gate) |
| `e2e/tests/travel-brochures-models-api.spec.js` | **NEW** — gate spec for the new `/models` route |
| `.github/workflows/deploy.yml` + `coverage.yml` | **ONLY** to add the one new spec line (per `wiring-spec-into-gate`) |
| `agentic-orchcrm/` | **vendoring only** — clone + `npm install`; never edit its source |

**You may NOT touch:** any other route, Prisma model (the `TravelBrochure` model already exists —
don't alter it unless a new column is unavoidable, and if so it must be an additive, migration-safe
change), cron, middleware, other pages, other CI workflows, `server.js` mounts, or the engine's
internal code.

**Standing rules (from the CRM `CLAUDE.md` — they still apply):**
- JWT identity is `req.user.userId`, **never** `req.user.id`.
- The global body-strip middleware deletes `id/createdAt/updatedAt/tenantId/userId` from `req.body` —
  don't rely on those as input names (`brand`, `models`, `strategy` are fine).
- New `backend/lib` module → a **vitest** unit test. New route → a **Playwright** gate spec wired into
  CI (use your `writing-api-gate-spec` + `wiring-spec-into-gate` skills). Frontend change → a
  **vitest + jsdom** test (the `frontend_unit_tests` gate).
- Match the CRM design tokens: primary CTAs use `var(--primary-color, var(--accent-color))`, no Tailwind.
- **Run the local gates green before any push** (`scripts/test-local.ps1 -Local`).
- The brochure endpoints reuse the existing **`marketing`** permission module (read/write/delete) —
  keep it; don't invent a new permission.

**Engine boundary:** if you hit a *rendering / PDF / layout* bug, do **not** patch `agentic-orchcrm/`.
Report it — it's fixed in the upstream repo and pulled in. Your scope is CRM glue + UI only.

---

## 1. What already exists (PR #1179)

The feature is wired but only partially functional:
- **Backend:** `routes/travel_brochures.js` (7 endpoints under `/api/travel/brochures`),
  `services/brochureEngineBridge.js` (the subprocess bridge), a `TravelBrochure` Prisma model,
  SSE live-trace plumbing, static PDF mount at `/api/brochure-assets/*`.
- **Frontend:** `pages/travel/BrochureEngine.jsx` — brief form, sector + template picker, a **basic**
  brand kit (name, tagline, logo upload, accent), a **placeholder** live trace, history, preview/download.
- **Permission:** every endpoint is `verifyToken → requireTravelTenant → requirePermission('marketing', …)`.

**What's missing / broken (this handoff fixes all of it):**
1. The engine folder `agentic-orchcrm/` **isn't installed** → "Generate" errors. *(Phase 0)*
2. The route forwards `brand` but **does not sanitize it** (the frontend comment claims it does — it
   doesn't). *(Phase 1)*
3. No **visual logo placer**, no contacts/socials/backing in the brand kit. *(Phase 1)*
4. No **model switching**. *(Phase 2)*
5. No **cost estimation** (pre-run estimate; the actual cost is returned but not surfaced richly). *(Phase 3)*
6. The live trace is a placeholder — no **per-agent cards**. *(Phase 4)*

---

## 2. Architecture (one picture)

```
 ┌─ CRM (this repo, deploys normally) ──────────────────────────────────────────┐
 │  BrochureEngine.jsx ── fetch/SSE ──> travel_brochures.js ── spawn ──┐         │
 │                                       (auth, sanitize, persist)     │         │
 └────────────────────────────────────────────────────────────────────│─────────┘
                                                                        ▼
 ┌─ agentic-orchcrm/  (vendored sibling, gitignored, installed per box) ─────────┐
 │  crm-bridge.ts  ──>  Orchestrator → specialist agents → composer → puppeteer  │
 │   (reads BROCHURE_BRIEF, streams JSONL events on stderr,                      │
 │    prints final JSON on stdout, writes PDF to public/generated/)              │
 └──────────────────────────────────────────────────────────────────────────────┘
```

- **One process boundary per run.** The CRM's CommonJS backend cannot cleanly import the engine's
  ESM/tsx packages, so the bridge **spawns** `tsx crm-bridge.ts` per run. This is **not** a microservice
  and **not** an HTTP service — it's a child process, JSON over env/stdout/stderr.
- The engine is **provider-agnostic** and reads its own `.env`. Same `.env` → identical brochures to
  the standalone app.

---

## 3. The bridge contract (already implemented in the engine — build to it, don't change it)

`backend/services/brochureEngineBridge.js` spawns:
```
node  agentic-orchcrm/node_modules/tsx/dist/cli.mjs  agentic-orchcrm/apps/orchestrator/src/crm-bridge.ts
   cwd = agentic-orchcrm/
```
`crm-bridge.ts` has **two modes**, selected by env:

### RUN mode (default) — generate one brochure
- **IN:** env `BROCHURE_BRIEF` = JSON
  `{ runId, sectorKey, goal, styleKey?, brand?, models?, strategy? }`
- **OUT (stderr):** one engine event per line as JSON (the live trace).
- **OUT (stdout):** exactly one final line — `{ ok:true, runId, result, billedUsd }` on success, or
  `{ ok:false, runId?, error }` on failure. `result` is a string containing `Download: /generated/<file>.pdf`.
- **Side effect:** the PDF is written to `agentic-orchcrm/public/generated/<file>.pdf`.

### CATALOG mode — list the model catalog (for the picker + cost estimate)
- **IN:** env `BROCHURE_MODE=catalog` (no brief).
- **OUT (stdout):** one line —
  `{ ok:true, tiers, strategies, defaults, models:[{ id,label,provider,available,intelligence,costEff,inputPer1M,outputPer1M,blurb }] }`.
  `available` reflects which providers the configured keys can actually reach.

> The bridge reads the **last non-empty stdout line** as the result. `crm-bridge.ts` keeps stdout
> pristine (all logs go to stderr), so you can trust it.

---

## 4. PHASE 0 — Vendor the engine (makes "Generate" work)

The engine is gitignored, so a fresh checkout never has it. Install it once (per machine):

```bash
cd <crm-repo-root>            # the folder that contains backend/ and frontend/
git clone https://github.com/muralidharans-glb/Agentic_orchcrm.git agentic-orchcrm
cd agentic-orchcrm
npm install                  # ~5 min — installs tsx + puppeteer's Chromium (~170MB)
cp .env.example .env         # then paste ONE provider key + the MODEL_* lines (see below)
```

**`.env` — keep the models identical to the standalone project.** The repo owner will give you the
exact provider key + model ids it runs today. Set at minimum:
```
# one provider key (whichever the project uses — e.g. Groq):
GROQ_API_KEY=...
# the four tier model ids (copy verbatim from the project's working .env):
MODEL_REASONING=openai/gpt-oss-120b
MODEL_BALANCED=openai/gpt-oss-120b
MODEL_FAST=openai/gpt-oss-120b
MODEL_WRITING=openai/gpt-oss-120b
# safety:
MAX_RUN_BUDGET_USD=0.50
# optional maps (degrades gracefully if absent):
GEOAPIFY_API_KEY=...
```
`agentic-orchcrm/.env` is gitignored — **never commit it or any key.**

**Verify the install:**
```bash
node agentic-orchcrm/node_modules/tsx/dist/cli.mjs --version          # prints a version
ls   agentic-orchcrm/apps/orchestrator/src/crm-bridge.ts              # exists
# smoke-test catalog mode (no LLM call):
cd agentic-orchcrm && BROCHURE_MODE=catalog node node_modules/tsx/dist/cli.mjs apps/orchestrator/src/crm-bridge.ts
```
Then restart the backend → log in as the travel admin → **Brochure Engine → Generate** → a real PDF.

> **Note:** `docs/AGENTIC_ENGINE_SETUP.md` says `crm-bridge.ts` isn't in the upstream repo — **that is
> now stale.** It's committed upstream, so vendoring is a plain `git clone` (no tarball), and `git pull`
> brings every engine update (incl. catalog mode + model selection).

---

## 5. PHASE 1 — Brand kit + visual logo placer (+ server sanitization)

The engine supports a rich brand kit and exact logo placement. The CRM must **collect** it and
**sanitize** it. Reference UI is in the vendored engine — copy from it.

### 1a. Route — sanitize `brand` (security; currently missing)
`travel_brochures.js` (~line 108) does `brand = req.body.brand` with no validation. Add a sanitizer:
- Create **`backend/lib/brochureBrandKit.js`** (CommonJS). Port the validation from
  `agentic-orchcrm/apps/web/src/lib/brand-kit.ts`:
  - logo: data-URI **only** (no external URL, **no SVG**); magic-byte sniff PNG/JPEG/WebP/GIF;
    re-emit a clean data URI; **≤120 KB**.
  - text fields length-capped; colours `#hex`-validated; socials slugged.
  - `custom` placement: every number **clamped**, every corner coerced to the fixed enum (never raw text).
  - **Drop invalid input (→ `undefined`); never reject the run.**
- Call it on `req.body.brand` before `startRun`.
- Add **`backend/test/lib/brochureBrandKit.test.js`** (vitest): rejects SVG/oversized/external-URL logos,
  clamps `custom`, passes a clean PNG through.

### 1b. Frontend — full brand kit + the placer
In `BrochureEngine.jsx`, extend the brand panel (currently name/tagline/logo/accent) to add:
- **contacts[]**, **socials[]**, and a **backing** toggle (`none` = transparent as-uploaded / `plate` = white frosted).
- The **visual logo placer** — port `agentic-orchcrm/apps/web/src/components/LogoPlacer.tsx` to plain
  JS + CRM tokens: drag/resize the logo on a cover mock, and pick an interior **header** position + size.
- Build the full `brand` object (incl. `custom`) and include it in the POST body.

Reference: `agentic-orchcrm/apps/web/src/components/CommandConsole.tsx` (the whole brand panel),
`LogoPlacer.tsx` (the placer), `lib/types.ts` (`LogoPlacementCustom`).

### The full `brand` shape
```jsonc
brand: {
  logoUrl,                              // data URI ONLY (no external URL, no SVG)
  name, tagline,
  colors: { accent: "#hex" },
  contact: ["+91…","mail@…"], socials: ["instagram","facebook"],
  onDark,                               // bool — logo backing (auto-detected if omitted)
  custom: {                            // from the visual placer
    cover:    { x, y, scale } | null,   // 0..1 fractions (centre + width)
    interior: { corner, scale } | null, // corner ∈ top-left|top-center|top-right|
                                        //              bottom-left|bottom-center|bottom-right
    backing:  "none" | "plate"
  }
}
```

---

## 6. PHASE 2 — Switchable models

### 2a. Bridge — add `listModels()` + pass selection (additive; keep the IO mechanism)
In `brochureEngineBridge.js`:
- Add **`listModels()`**: spawn `crm-bridge.ts` exactly like `startRun`, but with
  `env:{ ...process.env, BROCHURE_MODE:'catalog' }` and **no** `BROCHURE_BRIEF`; parse the last stdout
  line → resolve the catalog object. (No event streaming needed.)
- In `startRun`, add `models` + `strategy` to the brief:
  `JSON.stringify({ runId, sectorKey, goal, styleKey, brand, models, strategy })`.

### 2b. Route — expose the catalog + forward the selection
In `travel_brochures.js`:
- Add `GET /api/travel/brochures/models` → `listModels()` (guard: `requirePermission('marketing','read')`).
- In `POST /runs`, read `req.body.models` / `req.body.strategy` and pass them to `startRun`.

### 2c. Frontend — the model picker
A picker like `agentic-orchcrm/apps/web/src/app/settings/page.tsx`:
- **Strategy presets:** Recommended / Cheapest / Smartest.
- **Advanced (optional):** per-tier dropdowns (reasoning / balanced / fast / writing).
- Each option shows the rating + price; **filter to `available:true`**.
- Put the choice in the POST body as `models` (per-tier id map) or `strategy`.

---

## 7. PHASE 3 — Cost estimation

- **Actual (live + final):** sum `usage.billedUsd` events for a running total; the final `billedUsd`
  is already on the `TravelBrochure` row — show it on the result card + history.
- **Pre-run estimate:** catalog `inputPer1M/outputPer1M` of the selected model(s) × a per-tier token
  estimate. **Copy the estimate math from** `settings/page.tsx` (its `TIER_TOKENS` × price logic). Show
  "~$X estimated", updating as the model/strategy changes.

---

## 8. PHASE 4 — Live multi-agent view ("see the agents working")

The events already stream to your SSE — render them as a CEO→specialists card tree.
- **Copy the fold logic** from `agentic-orchcrm/apps/web/src/lib/useOrchestration.ts` (folds events →
  `AgentView[]`) + `lib/types.ts`; card UI from `apps/web/src/components/` / `app/page.tsx`.
- **Event shapes** (`agentKey` + `parentAgentKey` build the tree):

| `type` | `data` fields | use |
|---|---|---|
| `run.started` | `sector, goal, styleKey` | header |
| `agent.started` | `name, tier, task` | create a card |
| `delegation.started` | `task, from` | nest child under parent |
| `agent.tool_call` | `tool, args` | "calling image_search…" |
| `usage` | `provider, model, inputTokens, outputTokens, billedUsd` | per-agent tokens + running cost |
| `agent.message` | `text, final` | the agent's output |
| `run.completed` / `run.failed` | — / `error` | finish state |
| `engine.log` | `line` | non-JSON noise (harmless) |

Render: each card = name + tier badge + status (working/done) + tokens + cost; show the **total cost
ticking up live**.

---

## 9. The complete data flow

```
BrochureEngine.jsx
  ├─ GET  /api/travel/brochures/models ──> route ──> bridge.listModels() ──BROCHURE_MODE=catalog──> crm-bridge.ts
  │        └─> { tiers, strategies, defaults, models:[…] }  ──> model picker + cost estimate
  │
  └─ POST /api/travel/brochures/runs
        body { goal, sectorKey, styleKey?, brand?, models?, strategy? }
          └─> route: requirePermission + sanitize(brand) + insert TravelBrochure(running)
                └─> bridge.startRun(...)
                      └─> BROCHURE_BRIEF{ runId, sectorKey, goal, styleKey, brand, models, strategy }
                            └─> crm-bridge.ts  (applies models/strategy → runs)
                                  ├─ stderr: JSONL events ──> SSE ──> live agent cards + running cost
                                  └─ stdout: { ok, result, billedUsd } ──> route updates row(completed,pdfUrl,billedUsd)
                                                                              └─> UI previews /api/brochure-assets/<file>.pdf
```

---

## 10. Reference files (copy-from map — all in the vendored `agentic-orchcrm/`)

| Need | Copy from |
|---|---|
| Brand kit panel | `apps/web/src/components/CommandConsole.tsx` |
| Visual logo placer | `apps/web/src/components/LogoPlacer.tsx` |
| Brand sanitizer (→ `backend/lib/brochureBrandKit.js`) | `apps/web/src/lib/brand-kit.ts` |
| Brand/placement types | `apps/web/src/lib/types.ts` |
| Live-trace fold → agent cards | `apps/web/src/lib/useOrchestration.ts` + `app/page.tsx` |
| PDF preview | `apps/web/src/components/DeliverablePanel.tsx` |
| Model picker + cost estimate | `apps/web/src/app/settings/page.tsx` |
| The bridge contract / catalog shape | `apps/orchestrator/src/crm-bridge.ts` |

---

## 11. Verification & CI

- **Local, before any push:** `scripts/test-local.ps1 -Local` (all 6 gates green).
- **CI must NOT spawn the real engine** (it isn't present in CI). Any backend/e2e test that would click
  "Generate" must **mock `brochureEngineBridge`** (stub `startRun`/`listModels`). The `brochureBrandKit`
  test is a pure unit test — fine. The new `/models` gate spec should mock the bridge too (assert the
  route shape/auth, not a real catalog).
- Wire the new `/models` spec into `deploy.yml` + `coverage.yml` with the trailing backslash
  (per `wiring-spec-into-gate`).

---

## 12. Production deployment (read this — the engine does NOT ride the deploy)

**The CRM code (Phases 1–4) deploys normally** — they're tracked files → push to `main` → gates →
auto-deploy. In the browser it's just another feature.

**But `agentic-orchcrm/` is gitignored, so the deploy never carries it.** The engine is a **one-time
manual install per box**, and the same is true on the prod box (`crm.globusdemos.com`):

**One-time prod setup:**
1. Vendor: `git clone …Agentic_orchcrm agentic-orchcrm && cd agentic-orchcrm && npm install`.
2. Chromium system libs (Ubuntu — else PDF render crashes):
   `sudo apt-get install -y libnss3 libatk-bridge2.0-0 libxkbcommon0 libgtk-3-0 libgbm1 libasound2 libxshmfence1`.
3. `agentic-orchcrm/.env` with the provider key + a real `MAX_RUN_BUDGET_USD`.
4. `public/generated/` writable by the PM2 user (`chown` it; else PDFs silently don't write).
5. `pm2 restart` the backend.

**After that it works in prod like any feature.** Caveats to keep in mind (not v1 blockers):
- Each Generate spawns a Node+tsx+**Chromium** process (~30–60s, RAM-heavy) and writes a **~12 MB PDF**.
  At volume, add a concurrency cap + a `public/generated/` retention/cleanup job (disk fills otherwise).

---

## 13. The forever update loop

- **Engine improvements/bug-fixes** happen **upstream** (the `Agentic_orchcrm` repo) → in the CRM box:
  `cd agentic-orchcrm && git pull && npm install && pm2 restart`. The whole engine updates; generation
  keeps working. **No tarballs, no version drift.**
- **Most engine updates need zero CRM change.** Only a *new engine input* (e.g. a new placer control)
  needs a matching control added in `BrochureEngine.jsx`.

---

## 14. Final DO-NOT checklist

- ❌ Don't edit any file outside the brochure scope (§0 table), or the engine's internal source.
- ❌ Don't commit `agentic-orchcrm/`, any `.env`, or a provider key.
- ❌ Don't change the bridge's IO mechanism (env-in / stdout-JSON / stderr-events). *(Adding `listModels`
  and adding `models`/`strategy` to the brief is fine — that's additive.)*
- ❌ Don't add a new permission module — reuse `marketing`.
- ❌ Don't let a test spawn the real engine in CI — mock the bridge.
- ❌ Don't push with red local gates.
- ✅ Do build the UI by copying view logic from `agentic-orchcrm/apps/web/`.
- ✅ Do keep models/providers identical to the standalone project (same `.env`).
