---
name: dispatching-parallel-agent-wave
description: Orchestrates a wave of parallel closer agents to ship multiple independent gate specs / unit tests / fixes in one round. Use when the user asks to "fire up parallel agents" or when there's a batch of disjoint pickups (R-1/R-4 small-route specs, R-5 cron-engine vitests, G-x engine specs) and waiting for them sequentially would be slow. Encodes the patterns that worked in v3.4.x — disjoint-files invariant (no two agents touching the same route or workflow YAML), max 4-5 concurrent agents (5 worked; 8 had merge collisions), when to spawn a discovery agent first vs jump straight to closers, the standing-rule preamble that points agents at the existing skills, and the rebase-on-collision recovery pattern.
---

# Dispatching a parallel agent wave

## When to use

The user asks for parallel work, or you've identified a batch of disjoint pickups. Typical triggers:
- "Fire up parallel agents on G-X / R-Y / etc."
- "Find more gaps and close them"
- After a wave lands, you want to spin the next round
- You see ≥3 unblocked items in `docs/E2E_GAPS.md` or TODOS.md Tier 2

NOT this skill:
- A SINGLE focused task — just dispatch one agent (or do it yourself)
- A multi-day pickup that needs sequencing (e.g. G-20 tenant-isolation, G-9/G-10/G-11 trigger-endpoint trio) — those get ONE agent doing all of them sequentially. This skill is for genuinely-parallel work.

## The disjoint-files invariant

**Every agent in a wave must touch FILES no other agent touches.** If two agents both edit `routes/marketing.js` or `.github/workflows/deploy.yml` concurrently, you'll get merge collisions or — worse — silently-bundled commits where one agent's `git add -A` sweeps in another agent's WIP.

**Files that ALL gate-spec agents need to touch (collision-prone):**
- `.github/workflows/deploy.yml` (gate-spec list)
- `.github/workflows/coverage.yml` (mirror)
- `e2e/global-teardown.js` (when a new entity needs sweeping)
- `docs/E2E_GAPS.md` (status markers)

**Strategies for the workflow files:**
1. **Tell each agent to `git pull --rebase` if push rejects.** Idempotent — the wire-in.sh script in `.claude/skills/wiring-spec-into-gate/` is safe to re-run.
2. **Or have the parent agent batch the wire-ins** as ONE follow-up commit after all closers report green. Pros: one clean commit. Cons: more orchestration overhead.
3. **Or split the wave** — half the agents in batch 1 (with wire-ins), the rest in batch 2 after batch 1 lands.

Pattern from v3.4.3: 8 agents in a wave hit collisions on `.github/workflows/*` and `e2e/global-teardown.js`. Resulted in `515c316` — a "multi-agent collision commit" titled `accounting-api gate (R-1)` that secretly contained G-13 + G-15 work. Functional but messy. **5-agent waves stay clean; 8-agent waves bundle.**

## Cap: 4-5 concurrent agents

Empirical from v3.4.x:

| Wave size | Result |
|---|---|
| 3 agents (G-2/G-3/G-5) | Clean. All 3 had separate clean commits. |
| 4 agents (G-7/G-14/G-16 + something) | Clean if files are disjoint. |
| 5 agents (engine-fixes + cleanups + G-24 + R-2/R-3 + R-1 + R-5 = ran 8) | Worked but `515c316` bundle commit. |
| 8+ agents | Don't. Even with disjoint per-spec work, the workflow-file collisions get unmanageable. |

**Default to 4 per wave.** If you have more than 4 candidates, run sequential waves of 4.

## Verify each issue before dispatch (added v3.4.8)

**Run the `verifying-issue-before-pickup` skill on EACH issue in the planned batch BEFORE writing the agent prompts.** 5 minutes of code-grep by the parent agent saves ~10 minutes × N agents of in-flight re-derivation.

The v3.4.8 4-agent wave shipped clean but **3 of 4 agents (#180, #398, #443) found doc-vs-reality drift** — the implementation was already shipped; the actual gap was test-coverage. Each agent recovered, but the parent agent could have narrowed each prompt accordingly ("the route is already sanitized; write a contract spec, no impl needed") if it had grepped first. See `.claude/skills/verifying-issue-before-pickup/SKILL.md` for the grep checklist + the four common drift patterns (impl-shipped-spec-missing, impl-shipped-audit-missing, partial-fix-second-bug, framing-wrong).

When the verification surfaces drift on a row, **rewrite the agent prompt to match the actual gap** — don't pass the original issue framing through. The agent will re-derive faster from a tight prompt than from "the issue says X but actually Y."

## Discovery-first vs jump-to-closers

Two patterns:

**Pattern A: jump to closers** — when the work is well-defined in `docs/E2E_GAPS.md` and you can pick disjoint items off the table without exploration. Used for G-2/G-3/G-5, G-7/G-14/G-16, G-9/G-10/G-11, R-1 trio. **Default for most rounds — but always after running the verifying-issue-before-pickup skill on each item.**

**Pattern B: discovery agent first** — when the user says "find more gaps and close them" or you've shipped the obvious E2E_GAPS items. Spawn ONE Explore agent (read-only) to survey:
1. `docs/regression-coverage-backlog.md` — closed-bug audit
2. `TODOS.md` Tier 2 / Tier 3
3. `backend/cron/` cross-referenced with `backend/test/cron/` (engines without unit tests)
4. `backend/lib/` and `backend/middleware/` cross-referenced with `backend/test/`
5. `backend/routes/` cross-referenced with `e2e/tests/*-api.spec.js` (routes without specs)

Discovery agent returns a prioritized list (R-1 / R-4 / R-5 / etc.). You then pick 3-5 from its top recommendations as the closer batch.

This is what produced today's R-1 + R-2/R-3 + R-5 batch. ~5 minutes of discovery saved hours of agents re-discovering the same gaps independently.

## The standing prompt preamble (now: skill references)

Pre-skills, every agent prompt had ~150 lines of "Standing rules: JWT key is userId not id, body strips id/createdAt/etc, header JSDoc, RUN_TAG, afterAll patterns, no Co-Authored-By, ..." This duplication cost tokens and drifted (different agents got slightly-different rules).

**Post-skills:** point agents at `.claude/skills/<skill-name>/SKILL.md` and let them read it on demand. The agent prompt becomes ~30 lines:

```
Use the writing-api-gate-spec skill (.claude/skills/writing-api-gate-spec/SKILL.md).

Target: backend/routes/<area>.js
Pattern: clone <reference-spec> per the skill's selection table.
Acceptance: standard 7-criterion set per the skill.

After spec is green, use the wiring-spec-into-gate skill (run
.claude/skills/wiring-spec-into-gate/wire-in.sh tests/<area>-api.spec.js).

If you find a contract drift while writing this, file as [regression]
issue per the filing-contract-drift-issue skill (when that exists);
for now just document in your final report.

Authority: full — run scripts, edit, commit, push to origin/main. If
push rejects (sibling agent collision), git pull --rebase and retry.

Final report: test count, runtime green-state, commit hash, any
contract drift findings.
```

The skills carry the rules. The prompt carries the task.

## Per-agent prompt template

See `AGENT_PROMPT_TEMPLATE.md` for the full skeleton with placeholder slots.

Key elements every agent prompt should have:
1. **Skill reference** — points at the relevant skill(s)
2. **Target** — exact file paths to read first (the route file, the engine file, etc.)
3. **Pattern** — which existing spec/test to clone (if not obvious from the skill)
4. **Acceptance criteria** — the standard set + any task-specific extras
5. **Wire-in handoff** — explicit pointer to the wire-in skill / script
6. **Coordinate-with-siblings note** — names the other concurrent agents and which files they touch (so this agent can avoid)
7. **Authority statement** — "full" / "no commits" / "no pushes"
8. **Final-report shape** — test count, runtime, commit hash, contract-drift findings

## Coordinating wire-ins across the wave

Tell each agent: "Sibling agents (X, Y, Z) are also working on disjoint files. You'll all need to wire into deploy.yml + coverage.yml. If your `git push` rejects with non-fast-forward, `git pull --rebase` and retry. The `wire-in.sh` script is idempotent so a re-run after rebase is safe."

This solves 90% of collisions. The remaining 10% are the bundled-commit case (`515c316`) which is annoying but functional.

## Cap iterations on heal loops

If a closer agent reports failures and asks to retry: cap at **5 iterations per failing spec**. If still red after 5, the agent reports the blocker and stops — don't let it commit dubious workarounds. (This rule lives in `local-heal-loop` skill when that's authored; for now, repeat in the prompt.)

## When to use background mode vs synchronous

- **Background mode (`run_in_background: true`)**: parallel waves, where you'll do other work while agents run. Get notified on completion.
- **Synchronous**: single agent whose output you need immediately to inform the next decision (e.g. a discovery agent before dispatching closers).

Mix both: discovery agent synchronous, then dispatch closers in background.

## Final-report consolidation

When all agents in a wave return:
1. Pull origin to sync (one or more pushed)
2. Verify the gate is still green (`cd backend && npm test` for vitest; spot-check a few new specs locally)
3. **Run `capturing-wave-findings` skill** over the combined per-agent finding lists — every drift / bug / missing route / shipped spec / standing-rule pattern lands in the right doc (TODOS.md, docs/E2E_GAPS.md, CHANGELOG.md) or a fresh GitHub issue. Do this BEFORE the doc bump so the captured items are reflected.
4. Run `bumping-version-docs` skill to capture the wave in CHANGELOG / README / CLAUDE.md / TODOS / E2E_GAPS at release time (only on version-bump waves)
5. Recommend next wave's batch in your message back to user

## Pitfalls

- **Don't dispatch >5 agents at once.** Workflow-file collisions get bundled-commit messy.
- **Don't have two agents both touch the same route file.** Even if they're "different specs", they'll fight over the route.js edits. Pick disjoint files.
- **Don't skip the discovery step** when the user says "find more gaps". Without discovery, you're guessing at gaps and may pick already-shipped items.
- **Don't bundle the wire-in commits with the spec commits if you're worried about collisions.** Sometimes a separate wire-in commit AFTER all spec commits land is cleaner.
- **Don't forget to update TODOS.md** after a wave. The next session's pickup depends on it.

## When to bundle multiple fixes into ONE commit (added 2026-05-05)

A single closer agent often lands N fixes in M files. Two valid commit shapes:

**1 commit covering all N fixes** — right when:
- The fixes touch DIFFERENT files with no shared touchpoint
- They're being dispatched together as a coherent "fix this cluster" ask from the user
- You want one closing-comment SHA to point all N closed issues at
- The commit body can structure each fix into a per-issue section with "Closes #N" trailers

The 2026-05-05 #439/#440/#441/#448/#452/#456-partial cluster (`4e116ad`) hit this shape — 6 issues in 6 files, no overlap, single commit, GitHub auto-closed each via the trailers.

**N separate commits (one per fix)** — right when:
- The fixes touch the SAME file and you want clean `git bisect`
- One fix is significantly more invasive than the others and the others can ship without it
- You want each issue's closing-comment SHA to point at its own targeted commit

**Rule of thumb:** N fixes in M files with no shared touchpoint → 1 commit. N fixes you want to bisect-isolate → N commits.

The autonomous bug-fix-cluster pattern (when the user says "fix these issues" with a list of 5+) is **shape 1 by default**: pre-grep each candidate first (catches Pattern A drift in 30s/issue, often more than half qualify per the v3.4.8 → v3.4.11 arc), cluster the genuine fixes by file-locality, ship as a structured single commit. This is faster and easier for closing-comment hygiene than N sequential commits.

## Templates

See `AGENT_PROMPT_TEMPLATE.md` for the full per-agent prompt skeleton with placeholder slots.
