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

## Related

- `auditing-cross-cutting-spec-impact` — the spec-side audit that runs alongside this skill (step 5)
- `triaging-stuck-deploy-gate` — what to do when this sweep was done piecemeal and the gate is now stuck on inconsistent state
- Reference commit: `8853546` (`fix(#550): per-route response shape sweep`) is the canonical example. Read its commit body for shape.