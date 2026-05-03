---
name: wiring-spec-into-gate
description: Wires a new e2e/tests/<name>-api.spec.js into both .github/workflows/deploy.yml and coverage.yml gate-spec lists. Use after writing a new gate spec so it actually runs in CI on every push. Inserts the spec line BEFORE tests/teardown-completeness.spec.js with the trailing backslash (avoids the c8a8ad4 missing-backslash incident where one absent backslash silently dropped two later specs from the bash invocation). Handles the rebase-on-push-collision case when sibling parallel agents are touching the same workflow files concurrently.
---

# Wiring a spec into the api_tests gate

## When to use

You just landed a new `e2e/tests/<name>-api.spec.js` (likely via the `writing-api-gate-spec` skill). It needs to be in the `api_tests` job's spec list in `.github/workflows/deploy.yml` AND mirrored in `.github/workflows/coverage.yml` to actually run in CI.

NOT this skill: vitest unit tests under `backend/test/` — those auto-discover via `vitest run`, no wire-in needed.

## The two files

Both files have an explicit list of `tests/<name>.spec.js` lines under the `api_tests` job's "Run API-only specs" step (deploy.yml) or "Run gated API specs against c8-instrumented backend" step (coverage.yml). Each line ends with a trailing `\` (bash continuation).

The spec list MUST end with these two specs in this order:
```
tests/teardown-completeness.spec.js \
tests/demo-hygiene-api.spec.js
```

These are "final-state assertion" specs that verify the suite left zero residue. Your new spec goes BEFORE them.

## The gotcha — trailing backslash

If you forget the trailing `\` on the line BEFORE `teardown-completeness`, bash terminates the `npx playwright test` invocation early and silently drops `teardown-completeness.spec.js` + `demo-hygiene-api.spec.js`. The whole gate appears to pass while two assertion specs never ran.

Commit `c8a8ad4` was the canonical incident: G-8's wire-in lost the backslash on `low-stock-api.spec.js`. Caught only by inspection.

## The fix — use the bundled script

`wire-in.sh` (in this skill's directory) is idempotent: it inserts the spec line if not already present, leaves it alone if it is.

```bash
.claude/skills/wiring-spec-into-gate/wire-in.sh tests/<your-new-spec>.spec.js
```

The script:
1. Checks for the spec line in deploy.yml — adds before `tests/teardown-completeness.spec.js` with trailing backslash if missing
2. Same for coverage.yml
3. Reports `ADD` or `OK` per file

## Manual edit (if you don't trust scripts)

In each file, find the `tests/teardown-completeness.spec.js \` line and insert ONE line ABOVE it:

```yaml
            tests/<your-new-spec>.spec.js \
```

Note the leading 12 spaces (matches surrounding indentation) AND the trailing backslash. Both files; same insertion point.

Then **also update the inventory comment block at the top of the spec list in deploy.yml** (lines ~220-241). It's a `#`-commented enumeration of every spec with brief tag (e.g. `tests/tasks-api.spec.js (53 tests: routes/tasks.js)`). Add your spec's line in the same format. The total-tests count near the bottom (`# Total: ~1,XXX API tests run on every push.`) should also bump, but if you're not sure of the exact number it's fine to leave for the next doc-bump pass.

## Verifying the wire-in

```bash
grep -c "<your-spec-name>" .github/workflows/deploy.yml .github/workflows/coverage.yml
# Should print: 1 (in the comment block) + 1 (in the spec list) = 2 for deploy.yml
# And: 1 (just the spec list — no comment block in coverage.yml) for coverage.yml
```

Then push and watch the CI run.

## Rebase-on-collision pattern

When 3+ parallel agents are wiring specs simultaneously, the second/third pushes will reject with `non-fast-forward`. Don't force-push; rebase:

```bash
git pull --rebase origin main
git push origin main
```

The wire-in.sh script's idempotency means you can re-run it after rebasing — if your line is already there from someone else's push, it no-ops.

If the rebase produces a merge conflict ON THE WORKFLOW FILE specifically (because two agents inserted at the same line), resolve by keeping BOTH spec lines, then re-run wire-in.sh to verify shape, commit, push.

## Commit message

Wire-in usually rides along with the spec commit itself (one combined commit with the new spec + the workflow edits). If you're shipping a wire-in as a standalone fix-up commit (the `c8a8ad4`-style situation), use:

```
ci: wire <area>-api.spec.js into deploy.yml + coverage.yml gate lists

[Brief: which spec, where it sits in the order, why]
```

NOT `feat(...)` — wiring is a CI-config edit, not a feature.
