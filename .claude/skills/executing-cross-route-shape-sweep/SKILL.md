---
name: executing-cross-route-shape-sweep
description: Process for class-fix sweeps that touch many routes' response shape (e.g. flip every DELETE handler from "200 + {message}" to "204 No Content", or migrate every error response from {message:} to {error, code}). Pin shape with user FIRST, identify all touch sites with a fixed grep, sweep routes + their specs in lockstep in one PR, verify zero hits on the OLD shape post-sweep. Anti-pattern: shipping per-route — partial-state where some routes return 200 and others 204 is worse than either consistent shape. The canonical example is commit 8853546 (#550 sweep) that closed yesterday.
---

# Executing a cross-route shape sweep

## When to use

You're about to change a response shape that's repeated across many routes. The change is mechanical (find-replace-shape), not semantic. Examples:

- DELETE handlers returning `200 + { message: "X deleted" }` → `204 No Content` (REST-canonical)
- Error responses with `{ message: "..." }` → `{ error: "...", code: "..." }`
- Success responses with `{ ok: true }` → `{ status: "success" }`
- Renaming a top-level field (`body.email` → `body.message`) across all routes that emit it

The defining trait: there are 10-30 routes affected, and the SHAPE — not the BEHAVIOUR — is what's changing. The route logic, the auth checks, the DB writes all stay identical.

NOT this skill: a single route's fix (just edit it), a behaviour change (what the route DOES, not what it RETURNS), or a backwards-compatibility shim.

## Why this matters — the partial-state problem

The default failure mode is to ship the sweep route-by-route over multiple commits. That produces an intermediate state where:

- 7 of 22 routes return `204` and 15 still return `200 + {message}`
- The frontend has to handle BOTH shapes (`if (res.status === 204) ... else if (body.message)`)
- The specs are in mixed states (some pinning 200, some pinning 204)
- A future "what's the canonical shape?" reader can't tell which is the convention

Partial state is **strictly worse** than either consistent shape. Either ship all routes at once or don't ship any.

The canonical example: `8853546` (the #550 sweep) on 2026-05-06 evening. 22 routes + 11 specs swept in a single commit. SPA frontend audit done as part of the same commit (zero `body.message` consumers found, so no SPA changes needed). Three bare-name specs were missed; close-out shipped same day in `a27843e`. The sweep itself is a clean reference for this skill.

## The five-step process

### 1. Pin the shape with the user FIRST

Before touching code, get explicit alignment on the new shape. Write up a 3-line proposal:

```
Old: res.json({ message: "X deleted" }) → 200
New: res.status(204).end()                → 204 No Content
```

Confirm with user. Don't proceed until the shape is agreed. If you find unusual cases mid-sweep (e.g. a route that needs to return the deleted row's id), flag them separately rather than guessing.

### 2. Identify all touch sites with a fixed grep

Two greps — one for backend routes, one for specs:

```bash
# Backend route handlers (this is the "what to change"):
grep -rn 'res\.json(\s*{\s*message:' backend/routes/

# Specs (this is the "what to update in lockstep"):
grep -rn -B 2 "expect(.*\.status()).toBe(200)" e2e/tests/ \
  | grep -B 2 -E "request\.delete|del\.status|del = await"

# Frontend audit — find any consumer of the old field:
grep -rn "\.message\b" frontend/src/  # then filter by hand for response-body reads
```

List every hit. Group by file. Estimate effort (the diff per file is small; total diff is the count).

### 3. Sweep routes + specs in lockstep, single commit

Open ONE commit that:

- Updates every backend route's response (e.g. `res.json({ message: "..." })` → `res.status(204).end()`)
- Updates every spec's assertion (e.g. `toBe(200)` → `toBe(204)`)
- Updates the frontend if any consumer reads the old shape (per-route audit; if zero consumers, note that in the commit message)

The commit body should:
- Name the issue / decision (`#550`)
- List every route touched (or just file count + the grep that produced it)
- List every spec touched
- Explicitly note "frontend audit clean" or "frontend changes included" — never leave this implicit

Reference: see commit `8853546` for the exact format. Body listed all 22 routes + 11 specs explicitly so the diff was self-documenting.

### 4. Verify zero hits post-sweep

Re-run the SAME greps from step 2. They should all return zero hits.

```bash
# Should return nothing:
grep -rn 'res\.json(\s*{\s*message:' backend/routes/

# Should return nothing in the swept routes (other status-200 assertions
# unrelated to the swept routes will still hit; review by hand):
grep -rn -B 2 "expect(.*\.status()).toBe(200)" e2e/tests/ \
  | grep -B 2 -E "request\.delete|del\.status|del = await"
```

If any hit remains, either you missed it or it's intentionally out of scope. Comment it explicitly in the commit message.

### 5. Run the cross-cutting spec audit before push

Cross-shape sweeps trigger the full audit from `auditing-cross-cutting-spec-impact` skill. The bare-name specs (`currencies.spec.js`, `custom_reports.spec.js`, etc.) are NOT in the per-push gate's spec list and need explicit grep coverage. The v3.4.14 cycle force-moved its tag THREE times before going green; two of those rebuild rounds were preventable by running this audit pre-push.

## Verifying before push

```bash
# Backend vitest — full suite (catches helper-test regressions):
cd backend && npx vitest run

# Frontend vitest if you touched anything in frontend/src/:
cd frontend && npx vitest run

# Vite build if Frontend touched:
cd frontend && npx vite build

# Eslint — run on the changed files:
npx eslint <files...>
```

When all four are green AND the post-sweep grep returns zero hits, push.

## What goes WRONG when this skill is skipped

The PR review failure mode: PR #566 came in mid-2026-05-06 with an `email_scheduling.js` diff that silently reverted yesterday's #524 work. The PR was branched from before the #524 commit. The author's intent was unrelated (calendar + payment work), but their branch's ancestry caused a side-effect revert.

Defence: when reviewing PRs that touch a route which had recent class-fix work, **always `git diff main..pr_head -- <file>`** — diff against current main, not against the PR's base. The reverse-diff exposes silent reverts that pre-PR review tools can miss.

## Helper-port → callsite-sweep two-wave pattern (added 2026-05-07)

A common shape: a backlog card asks for "unit test on `<helper>`" but the helper either doesn't exist backend-side OR exists but has many bypassing callsites. This expands to a two-wave shape:

**Wave 1 — Helper-port + contract test**
- Create the helper at the right layer (typically `backend/lib/<helper>.js` or `backend/utils/<helper>.js`)
- Port logic from frontend if it already exists frontend-side; OR build from scratch using already-imported deps (e.g. `date-fns-tz`, `Intl.NumberFormat`)
- Pin the helper's contract with vitest cases — every input shape, edge case, boundary value
- Ship as a single commit closing the backlog card. Note in commit body: "callsite migration filed as separate follow-up — this commit pins the helper's contract, NOT every callsite."
- File the callsite sweep as a TODOS user-attention row.

**Wave 2 — Callsite sweep**
- Grep all bypass callsites (see "Why callsite-sweeps need ALL render layers" below for which layers to grep)
- Migrate each callsite to use the helper
- Per-callsite test if cheap (e.g. existing route spec extension); skip if expensive (e.g. would require new fixture stand-up)
- Single coordinated commit per the executing-cross-route-shape-sweep main flow

Confirmed instances of this two-wave pattern:
- `formatMoney` — Wave 5 helper-port (`backend/utils/formatMoney.js` + 31 tests, commit `8fd3283`) → Wave 6 callsite-sweep (16 callsites across 11 files, commit `437614f`)
- `datetime` — Wave 6 helper-port (`backend/lib/datetime.js` + 36 tests, commit `663bd7c`) → Wave 7 callsite-sweep (3 classes migrated, commit `bfb098d`)

When you see a backlog card that asks for "unit test on X" but X doesn't exist backend-side, **don't force-fit tests into a sibling helper that doesn't have X's responsibility** (Wave 7 Agent P's lesson with `leadJunkFilter` vs the new `junkSourceFilter`). Create the right helper at the right layer.

## Why callsite-sweeps need ALL render layers (added 2026-05-07)

When sweeping callsites, the grep needs to span more than user-facing UI. Agent M's #286/#330 sweep (16 callsites) hit:

- **Backend PDF rendering** (`routes/billing.js`, `routes/deals_documents.js`, `routes/reports.js`, `cron/reportEngine.js`) — invoice PDFs, quote PDFs, scheduled-report PDFs
- **Backend email/SMS templates** — including HTML email body emitters in `cron/reportEngine.js`
- **Backend AI-prompt context strings** — `routes/ai.js`, `routes/deal_insights.js` interpolate deal/customer context into Gemini prompts. When the prompt contains `Won Revenue: $${rev}`, the model sees a literal `$` regardless of tenant currency, biasing its responses for non-USD tenants
- **Backend route-side activity strings** — `routes/deals.js` won-deal activity log
- **Frontend UI components** — CommandPalette, CPQBuilder, Omnibar, AgentReports

The non-obvious one is AI-prompt context. Don't miss it. Grep template:

```bash
# Currency-shape ${X} interpolation (replace pattern as needed):
grep -rEn '\$\$\{[^}]+\}' backend/services backend/routes backend/lib backend/cron
grep -rEn '\$\$\{[a-zA-Z_][^}]*\.(amount|total|value|price|cost|fee|sum|revenue|balance|currency)' frontend/src

# AI-prompt builders (often `prompt = `...`` or `messages: [...]`):
grep -rEn 'role:\s*"user"|prompt:|systemPrompt' backend/routes backend/lib backend/cron backend/services
```

## "Intentionally NOT migrated" listings preserve product-anchored constants (added 2026-05-07)

Mid-sweep, you'll find callsites that LOOK like candidates but are product-anchored. Two categories:

**Category 1 — Product-anchored constants**

Some constants are intentional and not user-locale-dynamic. Example: wellness clinics are India-only; the daily 07:00 IST orchestrator cron is a product fixture. Migrating `IST_OFFSET_MS` to `parseDateTimeLocalInTZ(input, tenant.timezone)` would WRONGLY make the cron user-locale-dependent. Keep it pinned to `'Asia/Kolkata'` literally.

**Category 2 — Wrong-tool-for-the-job callsites**

Some callsites use a different shape than what the new helper accepts. Example (Wave 7 Agent O, commit `bfb098d`): `email_scheduling.js`, `booking_pages.js`, `marketing.js`, `billing.js`, `estimates.js` accept full ISO timestamp inputs (`'2026-05-15T10:30:00.000Z'`) per their route validation. Native `new Date()` handles these correctly; running them through `parseDateTimeLocalInTZ` (whose job is to disambiguate datetime-local FORM input) would be wrong.

**Pattern:** every callsite-sweep commit body should ship an explicit "Intentionally NOT migrated" section listing skip-cases + reasons. Implicit "we got everything" is wrong; explicit "we got X, intentionally skipped Y for reason Z" is right. The next maintainer benefits from seeing the holdout list — they don't re-investigate "did this get missed?"

Confirmed instances:
- Wave 1 Agent C (#523 selectors) — 6/14 selectors migrated, 8 retained as documented safety nets
- Wave 7 Agent O (datetime sweep) — 3 classes migrated, 5+ classes intentionally NOT migrated with per-callsite reason

## Related

- `auditing-cross-cutting-spec-impact` — the spec-side audit that runs alongside this skill (step 5)
- `triaging-stuck-deploy-gate` — what to do when this sweep was done piecemeal and the gate is now stuck on inconsistent state
- `verifying-gap-card-claims` — runs BEFORE this skill when the sweep is being driven from a gap card
- Reference commits: `8853546` (#550 sweep — canonical), `8fd3283` + `437614f` (formatMoney two-wave), `663bd7c` + `bfb098d` (datetime two-wave). Read commit bodies for shape.