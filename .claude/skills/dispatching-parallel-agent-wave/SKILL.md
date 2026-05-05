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
7. **Progress-reporting block (mandatory)** — every agent prompt MUST include the bash invocations from `reporting-agent-progress` (start / milestone / commit / done events via `.claude/skills/reporting-agent-progress/log.sh`). Without this, the user can't see anything until each agent finishes — the wave is opaque. The block is canned in `AGENT_PROMPT_TEMPLATE.md`'s "Progress reporting (mandatory)" section; copy it verbatim into each agent's prompt.

## Tell the user to open /developer BEFORE launching the wave

Before invoking the Agent tool with `run_in_background: true`, the dispatching parent should output:

> **Open https://crm.globusdemos.com/developer (or your local frontend's /developer page) to watch the agents in real time.** Newest entries first; color-coded by status. The page polls every 3s.

Do this once per wave dispatch, in the same response that fires the agents. The Live Agent Activity widget at the top of /developer surfaces every `start` / `milestone` / `commit` / `done` log line within 3 seconds. **Without this prompt the user has no idea the page exists; without the agent-side log calls the page stays empty.** Both halves of the contract are needed.
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

## Concurrent-agent git hygiene (added 2026-05-06)

Multiple agents in the same repo share **two** mutexes that are easy to forget:

1. **Working tree** — every agent reads + writes the same files. Avoided by the disjoint-files invariant (above).
2. **Git index** — every agent's `git add file` mutates the same staging area. A parent's later `git commit` (no pathspec) sweeps up *whatever* is currently staged, which may include sibling agents' WIP from in-flight work.

The 2026-05-05 5-agent QA wave hit this twice:
- A parent's `git commit` of the #413 schema fix bundled 6 unrelated files (Agent B's e2e specs + the deduplication helper). Caught pre-push, soft-reset, re-staged with explicit pathspec.
- Agent F's first commit (`cfb9973`) accidentally captured 7 of Agent J's files via the same race. They soft-reset and recovered.

**Mandatory mitigation pattern — use `git commit --only <pathspec> -F msg.txt`:**

```bash
# UNSAFE during parallel waves — race window between add and commit:
git add backend/routes/foo.js e2e/tests/foo.spec.js
git commit -m "fix(foo): close #N"

# SAFE — atomically pins the commit to ONLY the named files,
# even if the index races mid-operation:
git commit --only backend/routes/foo.js e2e/tests/foo.spec.js -F /tmp/msg.txt
```

The `--only` flag bypasses the staging area entirely for the commit step. Even if a sibling agent ran `git add unrelated_file.js` between your add and commit, the commit still includes only your two files.

**Rule of thumb:** if there's any chance another agent might be touching the repo concurrently, use `--only`. The dispatching parent should also use it for any consolidation commits.

**`-o` is the short form of `--only`** — same semantics, fewer keystrokes, more pleasant to retain in agent prompts. Use either:

```bash
git commit -o backend/routes/foo.js -o e2e/tests/foo.spec.js -F msg.txt
git commit --only backend/routes/foo.js e2e/tests/foo.spec.js -F msg.txt
```

**Empirical confirmation — v3.4.12 closure wave (2026-05-05):** the W1/W2/W3 waves dispatched 7 agents across 27 issues with `-o` baked into the per-agent prompt template from the start (see [AGENT_PROMPT_TEMPLATE.md "Commit hygiene"](AGENT_PROMPT_TEMPLATE.md)). **Zero index-race collisions across the entire wave.** The pattern that bit the 2026-05-05 morning waves twice (Agent F sweeping 7 of Agent J's files; #413 bundling 6 unrelated) didn't recur once the template required `-o`. **Bake the `-o` rule into the per-agent prompt** — relying on the agent to remember the existing skill section is unreliable; making it canned in the template is what converted the pattern from "occasionally bit us" to "zero incidents."

## Verify each issue's auto-close after multi-issue commits (added 2026-05-06)

GitHub's auto-close-on-trailer behavior has TWO silent failure modes that bit the 2026-05-05 5-agent wave:

1. **Shortform `Closes #N + #M` only auto-closes the FIRST issue.** Per GitHub's grammar, the keyword must immediately precede each `#N`. `Closes #462 + #463` closes #462 but NOT #463.
2. **Per-commit auto-close cap.** Even with one `Closes #N` per line (the correct grammar), commits with 5+ trailers appear to silently cap. Agent J's `ecb4ae0` had 7 separate `Closes #N` lines; only 6 fired (`#476` stayed OPEN). Agent I's `fc9898e` (multi-fix) had `#465` and `#473` stay OPEN despite explicit trailers.

**Mandatory verification step after any commit that's supposed to auto-close 2+ issues:**

```bash
# After push, verify each issue actually closed:
for n in 462 463 466 467 468 473 474 475 476; do
  echo -n "#$n: "; gh issue view $n --json state --jq '.state'
done
```

Any issue still showing `OPEN` → close manually with citation:

```bash
gh issue close 463 --reason completed --comment "Fixed in commit \`a2895d8\` — auto-close trailer didn't fire (GitHub cap). [<root-cause-summary>]. See <SHA> commit body."
```

The `bumping-version-docs` companion skill should encode this verify-then-manual-close step too.

## Stop-before-push when a local CI-equivalent gate fails (added 2026-05-06)

Agents have access to local equivalents of every CI gate (`npm test`, `eslint`, `node backend/scripts/check-migration-safety.js`, `cd e2e && npx playwright test`). When one of those flags an issue an agent can't trivially resolve, **STOP and report — don't push and hope the gate is wrong.**

The 2026-05-05 5-agent wave's Agent C demonstrated this perfectly: completed the #413 schema work but `check-migration-safety.js` flagged 6 false-positive risks (`FK_WITHOUT_ON_DELETE` matching DROP-FOREIGN-KEY statements that can't carry ON DELETE). Agent C reported the flag, asked for direction, and waited rather than push. The parent confirmed the false-positive analysis and shipped a one-line detector bug-fix bundled with the schema change in the same commit (`1ef4ba5`). Had the agent pushed anyway, `migration-check.yml` would have gone red on `main` and blocked all subsequent schema work until manually cleared.

**Rule for every dispatched agent prompt:** "If a local CI-equivalent gate (eslint, vitest, migration-safety, prisma validate, etc.) flags an issue you can't trivially resolve in 5 minutes, STOP, report the failure with the full error output, and wait for parent direction. Do NOT push and hope the gate is wrong; do NOT skip-the-check (`--no-verify`, `--ignore-scripts`) to bypass it."

This complements the existing "5-iteration heal cap" rule (which applies to test failures); the same shape applies to all non-test gates.

## NEW spec authored by an agent? Run it locally before commit (added 2026-05-06)

Build / lint / `node --check` do not catch a class of spec bug that only fires when the spec is actually executed: **wrong-field reads in fixture-loading helpers** (e.g. `j.user?.tenantId` when the response shape is `j.tenant?.id`), missing assertions on async resource creation, etc.

The 2026-05-05 wave's Agent A landed `landing-page-upload-api.spec.js` that compiled clean (build green, eslint clean, `node --check` green) but failed every per-push api_tests run because `genericTenantId` was captured from the wrong response field — assertions read `tenant-${null}/`. Result: 4 consecutive failed deploys (9abbafe → 51e8891 → 1ef4ba5 → cc1a0ca), demo stuck for ~50 min.

**Rule for every dispatched agent prompt that authors a NEW spec (not editing existing ones):** before commit, run the new spec locally against the local stack:

```bash
cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test --project=chromium tests/<new-spec>.spec.js
```

(Boot the local stack first with `.\scripts\local-stack-up.ps1` if needed.) The spec must be all-green against local before the agent commits. If a sibling agent is currently using the local stack for their own spec run, queue or use a freshly-named project to avoid races.

For spec EDITS (not new files), running locally is recommended but not mandatory — the diff is small and easier to reason about statically.

## Templates

See `AGENT_PROMPT_TEMPLATE.md` for the full per-agent prompt skeleton with placeholder slots.
