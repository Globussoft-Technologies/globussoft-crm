---
name: sizing-regression-coverage-dispatch
description: Pre-dispatch effort estimate for regression-coverage agents. The card's stated estimate ("0.25 day", "1 day") rarely matches actual delivery time because nearly half the dispatches end up shipping inline backend gaps alongside the spec. Reading the target route's commit history (`git log --oneline -- backend/routes/<file>`) is a 30-second sniff test that predicts whether the dispatch will stay Path A (pin existing contract — card's estimate is accurate) or drift into Path B (ship missing code inline — budget +50-100% on top). 11 waves today produced a clean Path-A-vs-Path-B split correlated with engine maturity; this skill encodes the heuristic.
---

# Sizing a regression-coverage dispatch

## When to use

You're about to dispatch a closer agent (or pick up the work yourself) on a regression-coverage card from `docs/regression-coverage-backlog.md`, `docs/E2E_GAPS.md`, or similar. The card has a "Estimated effort" line — but you want to know whether to trust it before scoping the dispatch's time budget.

NOT this skill: dispatches that aren't regression-coverage (genuine new-feature work, bug fixes from the issue tracker, refactors). Those have their own sizing models.

## Why this matters — the inline-backend-gap pattern

Across 14 regression-coverage waves on 2026-05-07:

- **6 waves shipped Path A only** (pin existing contract; card's estimate was accurate or slightly under).
- **8 waves shipped Path B inline** (ship missing backend code alongside the spec; effort 1.5×–2× the card's estimate).

The 8 Path B instances and what they shipped inline:

| Wave / Agent | Card | Inline backend gap |
|---|---|---|
| 4 / J | public-booking | `publicBookLimiter` rate-limit, slug shape-check, /embed GET-time API-key gate |
| 5 / L | formatMoney | New `backend/utils/formatMoney.js` — port from frontend |
| 7 / O | datetime callsite-sweep | New `backend/lib/datetime.js` helper + 3 callsite migrations |
| 7 / P | leadJunkFilter ext | New `backend/lib/junkSourceFilter.js` helper + wire-in to `routes/attribution.js` |
| 8 / R | notifications-api ext | Backend `router.patch('/:id', markReadHandler)` was missing |
| 10 / U | tasks-api ext | Migrated `tasks.js` POST/PUT to `parseTenantDateInput` sniffer |
| 10 / V | report-schedules ext | `validateRecipientsAgainstTenant` was returning shape errors without `status: 400` |
| 12 / Y | wellness-clinical ext | PUT /visits was skipping `ensureVisitDate` range check |

The 6 Path A instances:

| Wave / Agent | Card | Why pure Path A |
|---|---|---|
| 11 / W | sequences-authoring | `routes/sequences.js` was comprehensive (refactored ground-up at v3.4.x) |
| 11 / X | orchestrator-api | `cron/orchestratorEngine.js` was comprehensive (built v3.1, ground-up) |
| 12 / Z | reports-api ext | All report aggregations + date-range validation already correct |
| ... | (others)   | (engine had been built or refactored ground-up recently) |

## The heuristic — git log sniff test

```bash
# 30-second probe before dispatching:
git log --oneline -- backend/routes/<file> | head -25
```

Three signals to read:

### Signal 1 — Number of commits

| Commit count | Predicted path | Effort buffer |
|---|---|---|
| 1-3 | Path A (ground-up build, no patches yet) | Card's estimate is accurate |
| 4-10 | Mixed (some Path A, some Path B) | +25-50% buffer |
| 11+ | Path B (heavily patch-fixed) | +50-100% buffer |

### Signal 2 — Commit message patterns

Look at the FIRST few commits (oldest):

- **`feat(...)` or `Initial implementation of X` for a single big commit** → ground-up build → expect Path A
- **`fix(#NNN)` repeating across many commits** → patch-fixed → expect Path B (1-3 inline gaps)
- **`refactor(area): rebuild ...` followed by `feat(...)`** → recent refactor → expect Path A despite long log

### Signal 3 — Recent activity vs. age

```bash
git log --oneline --since="30 days ago" -- backend/routes/<file> | wc -l
```

If a route has 5+ commits in the last 30 days, it's been actively patched — almost certainly Path B. If a route has 0-1 commits in 30+ days, it's stable — likely Path A.

## What to write in the dispatch prompt

Once you've sized the dispatch, encode the prediction in the agent's prompt:

### For Path A predictions

```
Expected outcome: Path A (pin existing contract, no backend changes).
The route has <N> commits + last commit <X days> ago suggests the
contract is settled. If you find drift from the gap card, document
it in the spec header per `verifying-gap-card-claims` skill.

If you DO find a Path-B-shaped gap, note it in the commit body
+ ship inline if ≤30 LOC + file as a follow-up TODOS row if larger.
```

### For Path B predictions

```
Expected outcome: Path B (1-3 inline backend gaps likely).
The route has <N> commits suggesting patch-fixed history. Plan
~50-100% buffer over the card's stated effort. When you find a
gap, ship inline (≤30 LOC), document in the commit body, run
revert-and-prove to confirm the spec catches it.
```

## Anti-patterns

- **"The card says 0.25 day, so I'll cap dispatch at 30 minutes"** — costs the agent's headroom mid-flight when they hit a Path B gap. They either ship a half-done spec OR over-run silently. Both are bad.
- **"Always assume Path B"** — over-budgets ground-up engines. Wave 11 Agents X + W finished their cards in well under their cards' stated effort because there was nothing to fix.
- **"Skip the git log probe — just dispatch"** — the probe takes 30 seconds. Skipping it costs ~25-90 min of agent time on average per Path B miss (today's bisect cost).

## When the prediction is wrong

If you predicted Path A but the agent reports inline backend fixes:
- Update the dispatching skill's pattern catalogue with the surface (so future dispatchers learn).
- Don't second-guess the agent's inline fix — by the time you'd revert, the agent has already shipped + tested. Roll forward.

If you predicted Path B but the agent finds nothing to fix:
- Great. Card's estimate was accurate. Engine maturity is higher than the git log suggested (often happens after a big refactor that consolidates the long patch history).

## Related

- `verifying-gap-card-claims` — runs BEFORE this skill (verify the card's claims are accurate). This skill reads the route history; that skill reads the card's specifics.
- `executing-cross-route-shape-sweep` — for sweeps that touch many routes (independent of single-card sizing).
- `dispatching-parallel-agent-wave` — the orchestrator that USES the predictions from this skill to set per-agent time budgets.

## Reference commits to read for the pattern

- Path A canonical: `3d5bbc6` (orchestrator-api, Agent X) + `ae913a9` (sequences-authoring, Agent W)
- Path B canonical: `bc838d9` (report-schedules-api ext, Agent V) + `b8f6f30` (wellness-clinical ext, Agent Y)
- Read the commit bodies for the explicit Path-A vs Path-B disposition per acceptance point.