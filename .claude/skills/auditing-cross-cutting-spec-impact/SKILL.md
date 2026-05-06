---
name: auditing-cross-cutting-spec-impact
description: Pre-push grep audit for cross-cutting changes (auth-status code flips, response-envelope reshapes, DELETE-success status flips, /api/health body reshapes). The per-push gate's spec list is a strict subset of e2e-full's; cross-cutting changes that pass per-push can red e2e-full because the bare *.spec.js smoke tests aren't in the per-push gate list. Without this audit, every cross-cutting change pays a release-validation round-trip (~15 min) to discover its missed specs. With it, both layers go green on the first try. Today's v3.4.14 cycle hit this twice (#537 401-vs-403 missed 7 specs; #550 DELETE-204 missed 3 specs).
---

# Auditing cross-cutting spec impact before push

## When to use

You're about to push a change that flips a response shape or status code system-wide. Specifically:

- **Auth-status flip** — anything that changes how `verifyToken` (or any auth middleware) responds to missing / invalid credentials. Example: #537 RFC 7235 401-vs-403 sweep on 2026-05-06.
- **Response-envelope reshape** — renaming a top-level field, swapping `{message:}` for `{error, code}`, splitting a single-tier response into two tiers. Example: #543 `/api/health` two-tier; #550 per-route `{message:}` → 204 sweep.
- **DELETE-success status flip** — flipping DELETE handlers from `200 + {body}` to `204 No Content`. Example: #550 DELETE-204 sweep on 22 routes.
- **Status-code flip on a shared error path** — e.g. middleware globally now returns 401 instead of 403 for missing Authorization header.

NOT this skill: route-local changes (a single endpoint's behaviour, validators on a single field, rate limits on a single route). Those only touch their own spec.

## Why this matters — the v3.4.14 release-cycle cascade

v3.4.14 was tagged FOUR times before going green:

| Tag attempt | SHA | Result | What was missed |
|---|---|---|---|
| 1 | `751ab58` | Red | 7 specs encoding old contracts (#537 401-vs-403, #543 health two-tier): `ship-readiness`, `signatures`, `wellness`, `wellness-real-user-journeys`, `portal-api`, `zapier`, `demo-health` |
| 2 | `f0fd190` | Push-trigger green; release-trigger red | #531 forgot-password rate-limiter bucket sharing across two e2e-full runs against same demo (separate class — see release-validation in `triaging-stuck-deploy-gate`) |
| 3 | `befd867` | Red | 3 bare `*.spec.js` files missed by the #550 DELETE→204 sweep: `currencies.spec.js`, `custom_reports.spec.js`, `field-permissions.spec.js` |
| 4 | `a27843e` | **Green** | All three regression classes closed |

Total cost: ~30 min × 4 e2e-full runs = ~2 hours of release-validation latency, plus ~30 min of investigation per failed run. The audit below would have caught attempts 1 and 3 in under 60 seconds combined.

## The audit (5 minutes, run BEFORE `git push`)

### Identify the change class

Pick one of the four classes above. Each has a fixed set of grep patterns to run.

### Run the patterns from repo root

These greps cover BOTH the per-push gate's `*-api.spec.js` variants AND the bare `*.spec.js` smoke tests in the same directory. The bare specs are NOT in the per-push gate list but DO run in `e2e-full.yml` on tag push.

#### Auth-status flip (e.g. 403→401 for missing Authorization)

```bash
# Find every "missing-auth → 403" assertion. Each hit must either:
#   (a) be flipped to 401 to match the new convention, or
#   (b) be tagged as "authenticated-but-not-authorised" (genuine 403).
grep -rn "expect(.*\.status()).toBe(403)" e2e/tests/

# Also the [401, 403] tolerant pattern — flag for tightening:
grep -rn "toContain(403)" e2e/tests/
```

For each hit, read 2 lines of context. If the request had no Authorization header, the assertion is now stale (flip to 401). If it had auth, leave it.

#### Response-envelope reshape (`{message:}` → `{error, code}`, or rename a field)

```bash
# Old shape — every hit needs review.
grep -rn "body\.message" e2e/tests/
grep -rn "data\.message" e2e/tests/

# Field rename — replace OLD with the actual old field name:
grep -rn "body\.OLD_FIELD" e2e/tests/

# Backend route side — find every `res.json({ message: ... })`:
grep -rn 'res\.json(\s*{\s*message:' backend/routes/
```

#### DELETE-success status flip (200 → 204)

```bash
# Find DELETE+200 assertion pairs across BOTH spec naming conventions
# (the per-push gate uses *-api.spec.js; bare *.spec.js smoke tests
# are missed without explicit grep).
grep -rn -B 2 "expect(.*\.status()).toBe(200)" e2e/tests/ \
  | grep -B 2 -E "request\.delete|del\.status|del = await"
```

For each hit, confirm whether the DELETE is on a route in your sweep's scope. If yes, flip `200` → `204`. If no, leave it.

#### /api/health body reshape (e.g. database / uptime now require auth)

```bash
# Every assertion on the body fields that moved tier:
grep -rn "data\.database\|body\.database\|data\.uptime\|body\.uptime\|data\.version\|body\.version" e2e/tests/
```

For each hit, the assertion either needs to (a) authenticate first, or (b) drop the assertion if it's a basic-liveness probe. The `api-health.spec.js` two-tier shape contract covers the full assertion; other specs hitting `/api/health` should only assert `body.status === "healthy"`.

### Per-push spec list ≠ e2e-full spec list

Critical to remember: the per-push gate (`.github/workflows/deploy.yml`) runs **~50 specs** (the `*-api.spec.js` variants enumerated in its "Run API-only specs" step). `e2e-full.yml` runs **~200+ specs** including all bare `*.spec.js` smoke tests.

When grepping, ALWAYS `grep -rn ... e2e/tests/` — never restrict to `*-api.spec.js`. The bare-name specs are exactly where regressions hide.

Spec naming convention quick-reference:
- `e2e/tests/notifications-api.spec.js` — in per-push gate
- `e2e/tests/notifications.spec.js` — NOT in per-push gate, IS in e2e-full
- `e2e/tests/wellness.spec.js` — NOT in per-push gate, IS in e2e-full
- `e2e/tests/ship-readiness.spec.js` — NOT in per-push gate, IS in e2e-full
- `e2e/tests/signatures.spec.js` — NOT in per-push gate, IS in e2e-full

## Fix all hits in lockstep, single commit

Audit findings + their fixes ship in **one** commit, not per-spec. The commit message names the source change (e.g. "#537 401-vs-403") and lists every spec touched. This makes the diff trivially reviewable and the regression class self-documenting in `git log`.

Anti-pattern: shipping the source change first, then "we'll catch the spec misses on the next CI run." That's exactly what produced the v3.4.14 cascade — 4 force-moves of the same tag.

## Verification before push

After applying fixes:

```bash
# Re-run the same greps. They should return zero hits (or only legitimate
# matches you've explicitly left in scope).

# Run vitest locally — the per-push gate's vitest layer is fast (~3.5s):
cd backend && npx vitest run

# For UI surface changes, frontend vitest too:
cd frontend && npx vitest run
```

Per-push gate green is necessary but not sufficient. e2e-full will run on tag push — the audit's purpose is to ensure that gate also goes green on the **first** tag.

## Related

- [feedback_local_test_before_push](memory:feedback_local_test_before_push.md) — vitest-locally rule for middleware/auth/server.js changes
- `triaging-stuck-deploy-gate` skill — what to do when the audit was missed and a gate is now red
- `executing-cross-route-shape-sweep` skill — the upstream side: how to plan the source change before doing this audit