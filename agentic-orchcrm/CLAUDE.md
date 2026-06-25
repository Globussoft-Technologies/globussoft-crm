# CLAUDE.md — Agentic OS

> Authoritative onboarding context for this repo. Read this first; it is meant to give a
> fresh session the full picture without re-exploring. Paths are repo-root-relative and
> clickable. When something here conflicts with the code, the code wins — fix this file.

## 1. What this is

**Agentic OS** is a **provider-agnostic, sector-adaptable, low-human-in-the-loop multi-agent
orchestration platform**. A human assigns **one goal** to a CEO/coordinator agent; the CEO
autonomously plans, delegates to specialist agents, integrates their work, and returns a
finished deliverable (text, HTML→PDF, or a designed brochure PDF) with minimal human
involvement (tool approval is opt-in).

- **Any provider** — Moonshot/Kimi, xAI/Grok, Groq, DeepSeek, generic OpenAI-compatible, OpenAI. Agents request a *capability tier*; a router maps it to whatever keys are configured.
- **Any sector** — `travel`, `report-writing`, `finance`, `healthcare` are swappable "sector packs" (pure config: agent roster + tools + finalize strategy). The engine never changes.
- **Flagship deliverable** — a downloadable, agency-grade **PDF travel brochure** rendered by a content-driven engine: the LLM emits structured `BrochureContent` JSON, and a deterministic engine fetches assets and paginates to A4. This is where most recent work has gone (see §7).

Status: a working **scaffold** — engine, routing, delegation, sector packs, dashboard, and
metering all function end-to-end on an in-memory store. Production-hardening items (auth, RLS,
secret encryption, durable queue, multi-instance rate limiting) are listed in [SECURITY.md](SECURITY.md) and §12.

## 2. Repo layout & dependency graph

npm-workspaces monorepo, **ESM** (`"type":"module"`), **strict TypeScript**. Raw `.ts` runs via
**tsx** (CLI) and **Next.js `transpilePackages`** (web). No build step for the libraries.

```
apps/
  web/            Next.js 15 + React 19 dashboard (command console, live trace, analytics, deliverable preview)
  orchestrator/   CLI: demo (one-shot goal) + worker (entry for production loop)
packages/
  shared/         Types, config (loadConfig), logging, errors — base of the DAG, zero deps
  providers/      LLM adapters + ModelRouter (capability tier → provider/model)
  tools/          Tool registry + built-ins (delegate, web_fetch, image_search, map_route) + the BROCHURE ENGINE + PDF render
  sectors/        Sector packs (travel/report-writing/finance/healthcare) + art-direction style catalog
  core/           Orchestration engine: Orchestrator.run(), the agent loop, RunStore port, EventBus
  db/             Drizzle ORM + Postgres: multi-tenant schema + PgRunStore (analytics/billing)
```

Dependency direction: `shared` ← `providers` ← `tools` ← `core`; `sectors` ← `core`; `db` ← `core`;
apps depend on `core` (+ `sectors`/`db`). Package names are `@agentic-os/<dir>`.

**Platform:** Windows 11, PowerShell primary (Bash tool also available — each takes its own syntax).
Node **≥20** (20.12+), npm 11.x. No `packageManager` field.

## 3. Commands

| Command | What it does |
|---|---|
| `npm install` | Install + link all workspaces |
| `npm run web` | Next.js dev server → http://localhost:3000 (alias for `npm run dev --workspace apps/web`) |
| `npm run demo -- "<goal>"` | One-shot CLI orchestration via `tsx apps/orchestrator/src/demo.ts` |
| `npm run worker` | Production worker entry `tsx apps/orchestrator/src/index.ts` |
| `npm run typecheck` | **Only** typechecks `packages/core` + `packages/db`. See note below. |
| `npm run -w apps/web build` | Production Next build (the real typecheck for the web app + tools it imports) |
| `npm run db:generate` / `npm run db:migrate` | Drizzle: generate SQL migrations / apply them (needs `DATABASE_URL`) |

**Typecheck gap:** root `npm run typecheck` covers core+db only. To check the brochure engine and
web app, run `npx tsc --noEmit -p packages/tools/tsconfig.json` and `npx tsc --noEmit -p apps/web/tsconfig.json`
(or `npm run -w apps/web build`). Always run these after touching `packages/tools` or `apps/web`.

## 4. Environment & config

Secrets live in `.env` (gitignored; `.env.example` documents the names). `loadConfig()` in
[packages/shared/src/config.ts](packages/shared/src/config.ts) reads them **once at startup**
(restart to pick up changes). **Never log, echo, commit, or put a secret VALUE in a prompt/tool
arg — only key NAMES.**

- **Provider keys:** `MOONSHOT_API_KEY` (+`MOONSHOT_BASE_URL`), `XAI_API_KEY` (+`XAI_BASE_URL`), `GROQ_API_KEY` (+`GROQ_BASE_URL`), `OPENAI_COMPATIBLE_API_KEY` (+`OPENAI_COMPATIBLE_BASE_URL`), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` *(checked but adapter not yet implemented)*.
- **Model IDs by tier:** `MODEL_REASONING`, `MODEL_BALANCED`, `MODEL_FAST`, `MODEL_WRITING`.
- **Assets (all optional, graceful degrade):** `PEXELS_API_KEY`, `UNSPLASH_API_KEY`, `HUGGINGFACE_API_KEY` (Flux), `GEOAPIFY_API_KEY` (primary maps), `MAPTILER_API_KEY` (fallback, paid).
- **Policy/limits:** `ORCHESTRATION_MODE` (autonomous|supervised), `DEFAULT_SECTOR` (default `report-writing`), `MAX_DELEGATION_DEPTH`, `MAX_AGENT_STEPS`, `MAX_DELEGATIONS_PER_PAIR`, `MAX_GOAL_CHARS`, `MAX_RUN_BUDGET_USD`, `MAX_CONCURRENT_RUNS`, `RATE_LIMIT_PER_MINUTE`, `BILLING_MARKUP`.
- **Other:** `DATABASE_URL` (Postgres; omit → in-memory store), `GENERATED_DIR` (PDF output; defaults to `<cwd>/public/generated` — i.e. `apps/web/public/generated` when running the web app).

## 5. The run lifecycle (end to end)

Entry: `Orchestrator.run({ runId?, sectorKey, goal, styleKey?, brand? })` in
[packages/core/src/orchestrator/orchestrator.ts](packages/core/src/orchestrator/orchestrator.ts).

1. **Assemble engine** — `createEngine(config)` ([packages/core/src/engine.ts](packages/core/src/engine.ts)) wires `buildProviderRegistry` → `ModelRouter` + tool `ToolRegistry` + a `RunStore`.
2. **Load sector** — `getSectorPack(sectorKey)`; get the coordinator (CEO). For `html_to_pdf` sectors with styles, a **per-run clone** of the finalize agent is made with the resolved art-direction appended (the shared pack singleton is never mutated).
3. **Parse brand placement** — `parseLogoPlacement(goal)` regex-parses the goal text into a fixed `LogoPlacement` enum (never raw text → no injection). `map3d` is detected via `/3-?d/i` on the goal.
4. **Run the coordinator** through the generic **agent loop** ([packages/core/src/agent/agent-loop.ts](packages/core/src/agent/agent-loop.ts)): `router.chat(tier, {messages, tools})` → if no tool calls, return final text; else execute each tool via the registry, append results, repeat. Every step records usage/cost and emits events.
5. **Delegation** — the `delegate` tool calls back into the orchestrator's `invokeAgent`. Guards: validates `delegatesTo` DAG, **per-pair delegation cap** (`MAX_DELEGATIONS_PER_PAIR`, default 5) + **normalized task dedup** (anti-loop), and a **depth cap**. Specialist outputs are captured in `lastOutputByAgent`.
6. **Budget** — run-scoped and shared across all agents. Step cap soft-stops an agent (returns best-effort text). Runaway spend (`MAX_RUN_BUDGET_USD`) is a **hard stop** (throws `LimitError`).
7. **Finalize** (post-run, by `sector.finalize.render`):
   - `html_to_pdf`: the finalize agent emits a full HTML document → `renderHtmlToArtifact` → PDF URL.
   - `brochure_json`: the composer emits `BrochureContent` JSON → `parseBrochureContent` → `buildBrochureHtml(content, getTemplate(styleKey), { map3d, measure, brand })` → `renderHtmlToArtifact` → PDF URL.
   - Upstream specialist outputs (URLs, disclaimers) are auto-threaded **verbatim** into the finalize agent's task so nothing is paraphrased away.
   - **Completeness guard (consistency):** a cost-tier composer sometimes emits a THIN brochure (drops the day-by-day itinerary) → a stunted 2–3 page PDF. After parsing, the orchestrator compares `brochureDayCount(content)` to the brief's STATED length (`expectedDayCount(goal)` — "5-day"/"5 Days"/"Day 5"); if a ≥3-day trip came back with <60% of its days, it **re-composes ONCE** with a specific deficiency nudge and keeps whichever pass is fuller. Model-agnostic — makes a cheap model far more consistent (the real lever for full consistency is still a stronger model tier via the routing UI). Fires only on the failure case; normal full runs are untouched.
8. **Persist + stream** — events go to the `RunStore` and out over SSE; `setStatus(runId, 'completed'|'failed', result)`.

## 6. Providers, models, sectors & styles

**ModelRouter** ([packages/providers/src/router.ts](packages/providers/src/router.ts)): agents request a
**capability tier** (`reasoning` | `balanced` | `fast` | `writing`); `resolve(tier)` returns the first
configured provider by priority **moonshot → xai → groq → openai-compatible → openai → anthropic**.
Adapters are OpenAI-compatible ([packages/providers/src/registry.ts](packages/providers/src/registry.ts));
the Anthropic adapter is **not yet implemented** (key is checked, warned, not registered). Pricing/cost
in [packages/providers/src/pricing.ts](packages/providers/src/pricing.ts); `billedUsd = costUsd × BILLING_MARKUP`.

**Sectors** ([packages/sectors/src/registry.ts](packages/sectors/src/registry.ts)): `travel` (→`brochure_json`),
`report-writing` (default, →`html_to_pdf`), `finance`, `healthcare`. A `SectorPack` = `{ key, coordinatorKey, agents[], finalize }`.
Add one: create `packs/<name>.ts`, add to the registry, export from `index.ts`. Shared prompt fragments
(`AUTONOMY_DIRECTIVE`, `SPECIALIST_FOOTER`) live in [packages/sectors/src/shared-prompts.ts](packages/sectors/src/shared-prompts.ts).

**Two different "style" concepts — do not conflate:**
- **Art-direction styles** ([packages/sectors/src/styles.ts](packages/sectors/src/styles.ts) `STYLE_KEYS`): `auto`, `vintage-poster`, `luxury-magazine`, `modern-minimal`, `art-deco`, `bold-contemporary`, `botanical-watercolor`. These are **design briefs injected into a designer agent's prompt** — used only by the `html_to_pdf` path.
- **Brochure template keys** ([packages/tools/src/brochure/templates.ts](packages/tools/src/brochure/templates.ts)): `tmc-press` (DEFAULT) and `editorial-sakura`. For the `brochure_json` path, `styleKey` is a **template key**, not an art-direction brief — the template owns the look at render time; the composer prompt is never rewritten.

## 7. The brochure engine (flagship — `packages/tools/src/brochure`)

The engine turns `BrochureContent` JSON + a template into print-ready A4 HTML. **The engine owns
structure, pagination, and assets; templates own visual style.** Entry: `buildBrochureHtml(content, tpl, opts)`
in [packages/tools/src/brochure/render-core.ts](packages/tools/src/brochure/render-core.ts) (large — grep/section-read it).

**`BrochureContent`** ([types.ts](packages/tools/src/brochure/types.ts)) is the LLM output: all fields optional —
`palette.accent`, cover fields (`agencyName`, `topLeft/topRight`, `title`, `subtitle`, `tagline`, `year`,
`routeLine`, `badge`, `heroQuery`), `intro`, `highlights`, `itinerary.days`, `route` (`cities`/`places`/`headline`),
`sections[]`, `inclusions`, `pricing`, `footer` (`cta`, `qrData`, `social`, `checklist`). Two **transient**
render-time fields set by the engine, never by the LLM: `__brand` (BrandKit) and `__map3d` (boolean).

### Three template families (`BrochureTemplate.family`)
`buildBrochureHtml` dispatches on `tpl.family`. Each family is a separate renderer with its own CSS and pagination:
- **`flow`** (default fallback) — classic margined flow body with `CoverMode` cover archetypes. No template currently sets this; it's the fallback when `family` is unset.
- **`banded`** (`tmc-press`, the DEFAULT template) — bold full-bleed "press" poster: discrete `.page` boxes (210×297mm, `overflow:hidden`, `display:grid`), edge-to-edge colour bands. Fixed archetypes `bandedCover` → `experiencePages` → `mapPages` → (sections) → `logisticsPages` are count-budgeted, BUT arbitrary `sections[]` now go through **measure-and-flow** (`buildSectionFlowPages` → `buildSectionBlocks` → `measure` → `composeSectionPages`): each section is a self-contained `.sblock`, chunked + measured + packed into `.secp-flow` pages (split with a "cont." header, sparse pages `space-evenly`, never clipped). Palette via `bandedScheme(accent)`.
- **`editorial`** (`editorial-sakura`) — premium magazine: composed A4 `.ed-page` flex columns + `.ed-cover` masthead, numbered section grammar, drop-cap lede, pull-quote band. Uses a **headless-Chrome MEASURE pass** (`measureEditorialBlocks` injected as `opts.measure`) so all blocks (incl. `sections[]`) pack by *real* mm heights → no clipping + adaptive whitespace fillers. Palette via `editorialScheme(accent)`.
- **Adaptivity (both families):** the composer emits any extra content as `sections[]` (`prose | grid | cards | gallery`); the engine measures + flows it so nothing is dropped/clipped (see ARCHITECTURE.md → "The adaptive brochure engine"). The measurer selector is `[data-ed-id]` (family-agnostic; banded probes use `.bd-probe`, editorial `.ed-probe`). `measureEditorialBlocks` is passed for **both** families now. Composer output is optionally **schema-constrained** (`AgentDefinition.responseSchema` → `ChatRequest.responseFormat` → OpenAI/Groq `response_format: json_schema`, with a 400-strip fallback); `parseBrochureContent` + `hasBody` remain the net.

### Brand kit & logo placement
`BrandKit` ([render-core.ts](packages/tools/src/brochure/render-core.ts) ~line 501) is **server-trusted**, carried on
`content.__brand`, **never** on `BrochureContent` or a tool arg. The logo is an **inert data: URI** (magic-byte
verified, ≤120KB, no SVG, no external URL — see §9/§10). `LogoPlacement` is a fixed 6-value enum:
`cover | cover-only | top-left | top-right | every-page | footer`. `parseLogoPlacement(goal)` only ever
**returns 4** of them (`cover`, `cover-only`, `top-left`, `top-right`) — "every page"/"footer" keywords map to
top-left/top-right; the other two values exist for completeness. Accent precedence: `__brand.colors.accent || palette.accent`.

**Custom (visual placer) placement** — `BrandKit.custom` (`LogoPlacementCustom`) carries an EXACT, user-dragged
placement from the "Place logo" popup ([apps/web/src/components/LogoPlacer.tsx](apps/web/src/components/LogoPlacer.tsx)):
`cover: {x,y,scale}|null` (cover-centre + width, all 0..1 fractions) and `interior: {corner,scale}|null` (a **6-zone**
enum — `top/bottom × left/center/right` — + a 0.06–0.30 size). When present it **fully overrides** the prompt enum (the
engine reads `custom` first; `placement` is ignored). **Logo always wins, text yields:**
- *Cover:* a free overlay; the cover masthead text never hides behind it — `mastheadKeepout()` wraps the agency
  wordmark into the side-gap beside the logo (or drops it if there's no room). The cover is a fixed photo composition,
  so the overlay itself can't break layout.
- *Interior:* a **zero-flow-height** running mark, so it can't add a page or clip. `runMarkCorner(c)` is the single
  source of truth for the corner (custom OR prompt); `customMarkH(scale,corner,family)` sizes it (HEIGHT-driven, per
  family). The interior mark is really a **HEADER**: the logo sits at the top L/C/R and the page's header text reserves
  space BELOW it (content shifts down), so a bigger logo never overprints.
  **EDITORIAL** reserves a strip in the packer (`composeEditorialPages` reduces the budget + pads the mark's edge), so it
  supports all 6 zones at large sizes and content reflows. **BANDED** is full-bleed (no page margins), so `bandedSafeCorner()`
  keeps the 3 **top header** zones (L/C/R) and clamps a bottom zone up to the matching top one; the header bands
  (`.sblock__head`/`.exp__why`/`.log__band-accent`/`.log__price` `.has-mark`) reserve a `--hr` strip scaled to the logo
  (`bandedHeaderReserve`, applied for ANY top mark — not just left), and the map page **relocates** its route eyebrow to
  the clear side. The placer offers all 6 zones for editorial, the 3 header zones for banded.

The placer also carries a **backing** choice
(`custom.backing: 'none' | 'plate'`, default **`none` = use the logo AS-UPLOADED**, transparent, no white box): it is
consumed at the boundary into `onDark` (`none`→`onDark=false`→`.bare`; `plate`→`onDark=true`), overriding the pixel
auto-detection — so a logo is never given an unwanted white plate when the user placed it themselves. All `custom`
numbers/enums are server-clamped in `sanitizeBrandKit` (never raw text → safe to interpolate into inline styles).
Verified by `temp/_verify_logo_placer.ts` (+ `temp/_shoot_placer.ts`).

**Logo legibility & sizing (current, June 2026):** A logo backing is chosen **automatically** — the white
frosted **plate** is only applied when a logo actually needs it. `sanitizeBrandKit` (web, §9) decodes the
uploaded logo and sets `onDark`: a **dark or opaque** logo → `onDark=false` → **bare** (no white box, just a
soft drop-shadow); a **light cut-out** logo → plate. In the engine CSS `onDark === false ? ' bare' : ''` (plate
is the CSS default). Logos are sized generously and the running mark renders on **every** interior page
**including the map page** (the map's "THE ROUTE" label is suppressed when the logo owns that corner; the
logistics accent header gets extra top padding via `.log__band-accent.has-mark` so the bigger mark never
overprints the heading). Both families honor this identically. *Not user-settable: the exact logo size
(adaptive, engine-controlled) — placement is keyword-controlled, size is not.*

### Map system ([geomap.ts](packages/tools/src/brochure/geomap.ts))
**2D real geographic basemap is the DEFAULT; the 3D country silhouette is opt-in** only when the goal says
"3D" (`__map3d`). 2D uses Geoapify static Web-Mercator tiles + the engine overlays its own markers/leaders/route
polyline using a matching mercator `project()`. 3D projects Natural Earth 110m country polygons
([packages/tools/src/brochure/data/countries-110m.json](packages/tools/src/brochure/data/countries-110m.json), bundled, no API) into a framed zone with an extrude effect. Cities geocode via
Nominatim (1 req/s). Falls back to a raster route map, then an `.is-empty` placeholder, if geocoding fails.
**Reliability:** the route stops are resolved by `routeCities(c)` — `route.cities` → `route.places` → **parsed
`routeLine`** ("A → B — C") — so a requested map still renders (+ geocodes) even when the composer under-fills the
structured `route`. Used by both families for the raster map, the geocoded pins, and filler imagery.

### Deeper specs (auto-loaded memory, this machine)
`memory/banded-engine-spec.md`, `memory/editorial-engine-spec.md`, `memory/brochure-template-engine.md`,
`memory/cover-quality-floor.md`, `memory/pdf-and-styles-direction.md` carry the full design rationale and the
history of fixes. Consult them before reworking either family.

## 8. Rendering & assets (`packages/tools/src/render.ts`, `assets.ts`)

- **`renderHtmlToArtifact(html, id, opts)`** — `sanitizeHtml` (strip scripts/handlers/markdown) → inject deterministic print hardening (`charset`, `-webkit-print-color-adjust:exact`, A4 `@page`) → puppeteer headless Chromium → A4 PDF (`printBackground:true`; full-bleed covers use `preferCSSPageSize` with zero margins; a footer forces a 12mm bottom margin) → writes `{prefix}-{safeId}.pdf` (+HTML fallback) under `GENERATED_DIR` → returns `{url, format}`.
- **`measureEditorialBlocks(measuringHtml, ids)`** — the editorial measure pass: headless Chrome reads each probe block's rendered height → mm, returns `id→mm` or `null` (engine then uses conservative estimates).
- **Photos** — `searchPhotos()` strict fallback chain: Pexels → Unsplash (keyed) → Openverse → Wikimedia (keyless). `aiImageUrl()` only as a last resort (Pollinations/Flux). **Proprietary AI image providers (DALL·E, Midjourney, Stable Diffusion, etc.) are banned.**
- **Maps** — `staticMapUrl()` (Geoapify, needs `GEOAPIFY_API_KEY`), `routeMapUrl()` (Geoapify→MapTiler), `geocode()` (Nominatim, 1100ms throttle), `qrUrl()` (goQR).

## 9. Web app & API (`apps/web`)

Client `page.tsx` → `CommandConsole.tsx` (sector picker, goal, optional **Brand kit** panel: logo upload→dataURI,
name, accent, contacts, socials) → `useOrchestration.start()` → **POST `/api/runs`** → SSE
**`/api/runs/:id/stream`** folds `OrchestrationEvent`s into per-agent status/token tallies → `DeliverablePanel.tsx`
renders the PDF (iframe) or text. The server engine is a `globalThis`-pinned singleton ([apps/web/src/lib/engine.ts](apps/web/src/lib/engine.ts)).

**`/api/runs` is the security boundary** ([apps/web/src/app/api/runs/route.ts](apps/web/src/app/api/runs/route.ts)):
rate-limit (429) → goal length ≤ `MAX_GOAL_CHARS` → `sectorKey` in registry → `styleKey` against the sector's
allowlist → **`sanitizeBrandKit(body.brand)`** → concurrency cap → fire-and-forget `orchestrator.run()` (failures
surface as `run.failed` events, not HTTP errors). Other routes: `/api/runs/[id]`, `/api/sectors`, `/api/config`
(safe view — provider names + base URLs, **no secrets**), `/api/analytics`.

**`sanitizeBrandKit`** ([apps/web/src/lib/brand-kit.ts](apps/web/src/lib/brand-kit.ts)) — the trust boundary for branding:
magic-byte sniff (PNG/JPEG/WebP/GIF only, **no SVG**, no external URL), ≤120KB, re-emit as a clean data: URI;
text length-capped; colours `#hex`-validated; socials slugged. Invalid input is **dropped (undefined), never
rejected** — a bad logo falls back to the text wordmark, never fails the run. It also runs a dependency-free
**PNG decoder** (`node:zlib` inflate + scanline unfilter incl. Paeth) to auto-set `onDark` (see §7); JPEG → bare;
undecodable → safe plate default. Unit-tested by `temp/_verify_logo_detect.ts`. The OPTIONAL `custom` placement
(from the visual placer, §7) is validated here too (`sanitizeCustomPlacement`): every value coerced to a **clamped
number or the fixed corner enum** (attached only when a logo exists), so it carries **no free text** and is safe to
interpolate into engine inline styles.

## 10. Persistence (`packages/db`)

Drizzle ORM + Postgres. `RunStore` is a **port** ([packages/core/src/run/events.ts](packages/core/src/run/events.ts)):
`InMemoryRunStore` for dev/demo, `PgRunStore` for production ([packages/db/src/pg-run-store.ts](packages/db/src/pg-run-store.ts)) —
core has no hardcoded DB dependency. Schema ([packages/db/src/schema.ts](packages/db/src/schema.ts)): `tenants`,
`provider_keys` (BYOK, must be encrypted at rest in prod — scaffold stores plaintext), `agent_overrides`, `runs`,
`run_events` (append-only trace, JSONB `data`), `usage_events` (one row per model call: raw `cost_usd` + marked-up
`billed_usd`). Every row carries `tenant_id` (RLS-ready, **RLS not yet enforced**).

## 11. Security model (in force — keep these true)

- API keys read **only** from env (`.env` gitignored), **never** logged/echoed in responses/prompts/commits. When editing `.env`, reference key NAMES only, never values.
- `web_fetch` ([packages/tools/src/builtins/web-fetch.ts](packages/tools/src/builtins/web-fetch.ts)) has **SSRF protection**: blocks loopback/private/link-local/cloud-metadata (e.g. 169.254.169.254), https(s) only, no redirects, 15s timeout. Permission `ask` (autonomous mode auto-approves but still emits an event).
- `styleKey` is **allowlisted** at `/api/runs` against the sector's `finalize.styles`, then narrowed by `isStyleKey()`.
- Designer/composer agents have `tools:[]` — they only produce content, they don't act.
- **All LLM-supplied text is `esc()`'d** before HTML injection (`esc()` in render-core, `escapeHtml()` in render.ts). Asset URLs are escaped too. Missing an escape in a template literal = XSS.
- Assets only come from trusted server-side functions; **Pollinations/Flux AI images are a last resort and proprietary AI image providers are banned.**
- **Brand logo:** data-URI only (no external user URL, no SVG), magic-byte verified, ≤120KB, server-trusted/run-scoped; **never** on `BrochureContent` or a tool arg. Brand text length-capped + `esc()`'d. Placement is a fixed enum, never raw user text.
- HTML/large content is **never** passed through tool-call arguments.
- HTML deliverables are previewed in a **sandboxed iframe** (no `allow-scripts`); PDFs use the native viewer.
- **Commit/push only when explicitly asked.** The default branch is `main`; if asked to commit while on `main`, branch first. End commit messages with the `Co-Authored-By: Claude` trailer.

## 12. Conventions & gotchas (read before editing)

- **ESM with explicit `.js` import specifiers** that point at `.ts` sources (NodeNext style); Next maps `.js`→`.ts` via `extensionAlias`. Strict TS everywhere (`noUncheckedIndexedAccess`, `noImplicitOverride`).
- **CSS-comment backtick trap:** a backtick inside a CSS comment that lives inside a JS template literal *terminates the template string* → runtime parse error. In `render-core.ts` CSS comments, never write `` `.bare` `` — write "the .bare class".
- **`page.evaluate` must take a STRING body**, not a function literal — tsx/esbuild injects a `__name` helper that is undefined in the browser → `__name is not defined` → the measurer silently returns null. (See `measureEditorialBlocks`.)
- The brochure engine **never throws** on asset failure — photos→gradient, map→omit, QR→omit. It always renders something.
- **Brochure composer outputs flat top-level JSON** (no wrapping container); `parseBrochureContent` defensively strips fences and unwraps, but the prompt forbids wrapping.
- The three brochure **families are not interchangeable** — changing `tpl.family` means a different render function and CSS.
- Puppeteer is in `serverExternalPackages` (never bundled by Next, it carries Chromium).
- **Typecheck the right project** (§3) — root `npm run typecheck` skips tools+web.
- **Dev/test harnesses live in `temp/`** (gitignored): `_verify_banded_logo.ts` (banded logo per placement + map page), `_verify_editorial.ts` (editorial overflow audit across 1/8/22-day trips + placements), `_verify_logo_detect.ts` (plate-vs-bare detector), `_shoot.ts` / `_shoot_chik_dark.ts` (rasterize pages to PNG), `_logo.b64` (worst-case light logo). Run with `npx tsx temp/<file>.ts`.

## 13. Git

Two commits so far: `997c228` (initial) and `e08ccc3` (PDF deliverables, geomap, style system, anti-loop
guards). `README.md` and `ARCHITECTURE.md` exist for the high-level tour. Work on `main`; branch before committing
on request.
