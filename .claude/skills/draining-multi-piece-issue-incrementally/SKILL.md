---
name: draining-multi-piece-issue-incrementally
description: Closes a multi-piece GitHub issue (e.g. `[Bug] Patients page: missing pagination, no bulk/individual tag add, no CSV/XLSX export & template`) by enumerating its sub-items, shipping one slice per cron tick as a file-disjoint pair (backend + frontend; or two backends; or backend + PRD), and only closing the issue after the final slice. Use when an open issue's body lists ≥3 sub-features. Encodes the discipline established across the #820 arc (14 commits across 10 ticks #181 → #197): pagination → bulk-tags → tag-chip → CSV → XLSX backend → XLSX button → template backend → template button → backend filters → frontend filters → import backend → import button → tag-remove backend → tag-remove UI. Each tick shipped 1 small slice; the issue closed naturally once 7/8 items were green.
---

# Draining a multi-piece issue incrementally

## When to use

A GitHub issue's body enumerates ≥3 distinct sub-features that EACH need their own implementation. Typical patterns:

- `[Bug]` issues like #820 with 4 numbered bug-reports (pagination + tags + export + filters)
- `[Gap]` issues with a multi-bullet acceptance-criteria list
- "List view missing X / Y / Z" patterns (common with Zylu-Gap items: #771 POS-002, #775 POS-006)

NOT this skill:
- Single-feature issues — ship as one small chore, close on land
- Multi-day issues where the work needs design (write a PRD instead — see `writing-bonus-prd`)
- Cross-cutting refactors (no per-piece slicing — needs a single bundled commit)

## The discipline — 5-step loop

### Step 1: Enumerate the sub-items

Read the issue body. List every distinct sub-feature as a checklist. The #820 enumeration was:

1. Pagination (server-side + UI)
2. Bulk tag-add (checkbox + modal + endpoint)
3. Individual tag-add (per-row chip)
4. CSV export (backend route + UI button)
5. XLSX export (new backend + new UI button)
6. Import template (backend route + UI button)
7. Source/Gender/Date-range filters (backend filters + frontend dropdowns)
8. Import upload (backend POST + frontend modal)

Estimate 1-2 slices per tick. 8 items = ~10 tick budget.

### Step 2: Per-slice file-disjointness

Each slice should be ONE file-disjoint pair within a tick:
- Backend slice + frontend consumer slice (different agents OR same agent if dependency-ordered)
- Backend slice + PRD-writer (parallel; PRD touches docs/ only)
- Two independent backends (one route + one stub client)

Backend-then-frontend ordering matters when the frontend consumes a new endpoint. Ship backend in tick N, frontend in tick N+1. The interim state (backend exists, no UI yet) is FINE — operators/admins can curl the route to validate.

### Step 3: Skip the "close" intent on every commit except the last

Each slice's commit message references the issue but does NOT include "Closes #<N>". Only the FINAL slice gets a "Closes #<N>" trailer. The mid-arc commits leave the issue open so:
- the issue's open status tracks "is this fully shipped"
- a partial-shipped state isn't lying about being done
- the user can `gh issue list` and see what's still in-flight

Mid-slice commit message pattern (no Closes):
```
feat(<area>): #<N> part <X> — <one-line>

<sub-feature description, 2-3 sentences>

<test counts, gate impact>
```

Final-slice commit message pattern:
```
feat(<area>): #<N> final piece — <one-line> — closes #<N>

<remaining sub-feature description>

Issue #<N> is now end-to-end: <list all <N> sub-items shipped>.
```

### Step 4: GitHub closure trace

The issue may be auto-closed by the "closes #<N>" trailer on the final commit. After push, run:

```bash
gh issue view <N> --json state --jq .state
```

If `CLOSED`: leave a final completion-trace comment summarising the arc (every commit, every test count, what's still potentially open as a follow-up). This is the audit trail for future agents trying to understand "what's the state of #<N>?"

```bash
gh issue comment <N> --body "End-to-end shipped across ticks #<A> → #<B> (<date arc>):

**Backend (<N> endpoints):**
- ...

**Frontend (<N> affordances):**
- ...

**Tests:** <N> vitest cases + <N> supertest cases.

All <count> sub-items from the original bug report now ship end-to-end."
```

If NOT closed (because the trailer was on the wrong commit or the closure was suppressed): use `gh issue close <N> --comment "..."` to close manually with the same summary comment.

### Step 5: After-arc completion-trace

Update CLAUDE.md's cron-learnings or TODOS.md if the arc surfaced a pattern worth codifying. The #820 arc surfaced:
- Sibling-spec rot pattern (different `__tests__` paths)
- Export-trio pattern (CSV/XLSX/template + busy gate)
- Backend list-filter shared helper across 3 endpoints (`applyPatientListFilters`)

These got logged as cron-learning entries; the spec-rot got promoted to a one-line skill extension.

## The #820 case-study — 14 commits across 10 ticks

| Tick | Slice | Backend SHA | Frontend SHA | Notes |
|---|---|---|---|---|
| #181 | bulk tag-add | wellness bulk-tags route | Patients.jsx checkbox + modal | 44d8b950 |
| #185 | pagination + tag-chip | (uses existing limit/offset) | dd67f1a0 | Same commit; backend was already capable |
| #187 | XLSX export | ed00be9b /patients.xlsx | — | Backend first |
| #188 | XLSX button | — | acf61032 | Frontend consumer |
| #189 | Import template | 6b4831bb /import-template.csv | — | Backend first |
| #190 | Template button | — | 32386d08 | Frontend consumer |
| #191 | Filters (backend) | 4fa87b0a list/CSV/XLSX | — | Shared helper across 3 endpoints |
| #192 | Filters (frontend) | — | e74efa9e dropdowns | Frontend consumer |
| #193 | Import upload | 69ee75dc POST /patients/import | — | Backend first |
| #194 | Import button | — | 6ca1c236 | **Closes #820** in final commit trailer |
| #196 | Tag-remove backend | 5b610a56 removeTags param | — | Adjacent slice; #931 |
| #197 | Tag-remove frontend | — | c273f589 | Closes #931 |

Key observations:
- Each tick shipped EITHER one slice OR a (backend, frontend) pair from adjacent slices
- The arc absorbed one fix-forward (`2c8d349` sibling-spec rot fix) without derailing
- Every tick stayed file-disjoint with sibling parallel work (most ticks paired this work with a bonus-PRD agent)
- The arc closed naturally on tick #194; ticks #196-#197 were a SIBLING issue (#931 tag-remove) that shared the Patients.jsx surface

## File-disjointness within a slice

A "backend slice" usually means:
- `backend/routes/<area>.js` (modify)
- `backend/test/routes/<area>-<slice>.test.js` (NEW)

A "frontend slice" usually means:
- `frontend/src/pages/<area>/<Page>.jsx` (modify)
- `frontend/src/__tests__/<area>/<Page>.test.jsx` (modify)

These two scopes are NATURALLY file-disjoint — perfect for a parallel-agent wave (backend agent + frontend agent in same tick). When you ARE pairing them in a single tick, make sure the backend ships BEFORE the frontend agent consumes it (e.g. backend agent commits, frontend agent rebases, then commits).

When dependency-ordered (frontend needs new backend), the wave can't run truly parallel — do backend first, then frontend next tick.

## Anti-patterns

- **Don't ship 2 slices in one commit.** It makes review hard, makes `git revert` lossy, and breaks the "this tick shipped THIS slice" cron audit trail.
- **Don't close the issue mid-arc.** If you close on slice 4 of 8 and forget to re-open, the user thinks the issue is done.
- **Don't write a single mega-PR.** The cron's value is incremental shipping; a 14-file mega-PR loses that.
- **Don't skip the completion-trace comment.** Six months later, someone trying to understand "did we ship XLSX export?" should be able to read the GH issue and see the per-slice SHA list.
- **Don't promote sub-features into new issues.** If item 7 of 8 is "filters" and you decide it's too big, write a PRD (see `writing-bonus-prd`) and leave the rest of the arc continuing — don't fork the issue mid-arc.

## Verification across slices

```bash
# At any point during the arc, check what's open vs shipped:
gh issue view <N> --json state,title --jq '{state, title}'
git log --oneline --grep "#<N>" | head -20

# After final slice, verify auto-closure or manual-close:
gh issue view <N> --json state --jq .state    # should be CLOSED
```

## Related

- `dispatching-parallel-agent-wave` — file-disjoint scope per slice
- `writing-bonus-prd` — when the arc reveals a need for design call before continuing
- `verifying-issue-before-pickup` — check the issue isn't already closed BEFORE starting a slice
- `auditing-cross-cutting-spec-impact` — when a slice changes a response shape used by other surfaces
- CLAUDE.md cron-learning 2026-05-25 (#820 arc) — the canonical case-study
