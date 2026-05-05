---
name: triaging-stuck-deploy-gate
description: Stop-the-line response when the deploy.yml api_tests gate is red for more than 2 consecutive pushes. A red gate silently blocks demo deploys — every subsequent push also fails because the underlying spec/route mismatch persists, and the demo accumulates a deploy backlog while testers report bugs against stale code. Triggers immediate triage: pull CI failure log, classify as spec-too-strict vs route-bug, ship one bundled fix commit. Without this discipline the gap compounds (this session: 90 minutes red → 3 distinct bugs across 3 commits, demo stuck 5 weeks behind main, tester filed ghost regressions against code that no longer existed on main).
---

# Triaging a stuck deploy gate

## When to use

The instant `gh run list --workflow=deploy.yml --limit 5` shows **two consecutive failures with no green run between them**. Triggers:

- Pushing a commit and getting a red ❌ on api_tests
- Noticing a 2-hour-old TODO mentions "deploy succeeded" but `/api/health` reports a stale version
- A tester's bug report references behavior that doesn't match HEAD (high probability they're testing the demo, which is stuck)

Do NOT defer this. The failure mode is non-linear: every additional red push adds 8-12 minutes of CI time + masks the next bug + grows the demo-vs-main divergence + risks ghost-regression reports from testers. The first 2 reds are noise. The 3rd is signal.

## Why this matters — 2026-05-04 incident

The api_tests gate went red on commit `b44291b` (T2.2 wellness-audit landing). It stayed red for **10 consecutive pushes over 90 minutes** spanning v3.4.8, v3.4.9, the v3.4.8 carry-over #4 fix, and the #182 fix. During that window:

- Demo `/api/health` reported `version: 3.2.0` while main was at v3.4.9 — **5 release tags of drift**
- Tester `nilimeshnayak-max` filed #182 regressions against the SMS reminder body. The "appointment appointment" double-word + `[reminder:24h]` debug markers were real bugs, but they had been fixed mid-stream. Tester was inspecting v3.2.0 demo output and could not have seen any HEAD code, leading to confused triage time
- Three completely separate bugs were masked under the same red gate:
  1. `auth-revocation-api.spec.js:150` asserting `r.status() === 401` but `verifyToken` returns 403 for missing Authorization header (codebase convention is `[401, 403]`; spec was written too strict)
  2. `sequences-input-sanitization-api.spec.js:218` sending payload `<script>x</script>` and expecting empty-after-sanitization → 400. The global `sanitizeBody` middleware (`server.js:93`, `security.js:75`) strips dangerous TAGS but PRESERVES inner text, so `'x'` survived and the route happily 201'd
  3. `sequences POST /:id/steps` returning 500 because `sanitizeJson()` returned an object when given an object input, but `SequenceStep.conditionJson` is `String? @db.Text` — Prisma rejected the write
- Each red push wasted ~10 minutes of CI runtime + fired Sentry/Slack alerts that engineers tuned out

All three bugs ended up in **one bundled commit** (`fd8ad67`) once triaged together. Total fix time once triage started: ~25 minutes. Total time the gate was red: 90+ minutes. **The cost was almost entirely in detection, not repair.**

The lesson: a red gate is its own incident. Treat it like a paged production alert.

## The triage flow (15-30 minutes end-to-end)

### 1. Confirm the pattern (60 seconds)

```bash
gh run list --workflow=deploy.yml --limit 10 --json databaseId,conclusion,createdAt,headSha \
  | python -c "import json,sys; runs=json.load(sys.stdin); [print(r['createdAt'], r['conclusion'] or 'in_progress', r['headSha'][:8]) for r in runs]"
```

Look for the **first red after the last green**. That's where the regression entered. Note the commit SHA — that's your blame anchor (though the actual broken code may be older if the trigger was a newly-added spec asserting against unchanged route behavior).

```bash
# Verify demo divergence — quick sanity check
curl -sk https://crm.globusdemos.com/api/health | jq -r '.version, .uptime'
# Compare with: cat backend/package.json | grep '"version"'
```

> **⚠️ Caveat (added 2026-05-04 from the 940b4f0 wave)**: `/api/health` returns
> a **hardcoded** version string (currently `"3.2.0"` per `backend/server.js:435+443`),
> NOT a value read from `package.json`. The version field is therefore NOT a
> reliable demo-divergence signal — a successful deploy will leave the field
> reading the same hardcoded value. The reliable signal is **`uptime`** —
> a fresh deploy restarts pm2 so uptime drops to <300s. Cross-check by
> grepping the deployed code via SSH (`git rev-parse HEAD` in
> `~/globussoft-crm` on the demo box) or by hitting an endpoint whose
> behaviour changed in the new commits. Filed as a follow-up: change the
> `/api/health` handler to `require('../package.json').version` and bump
> `backend/package.json` on every release-tag.

If demo uptime is high (hours) AND the deploy.yml run completed minutes
ago, the deploy step is silently failing — that's a real divergence even
if the version field looks unchanged.

### 2. Pull failure detail (90 seconds)

```bash
# Use the FIRST red run (not the latest) — the latest may have additional cascading failures.
gh run view <first-red-id> --json jobs --jq '.jobs[] | {name, conclusion}'
```

Identify which gate failed. For api_tests:

```bash
gh run view <first-red-id> --log-failed 2>&1 | grep -E "✘.*spec|Expected:|Received:|Error:.*toBe|Error:.*toContain" | head -40
```

The pattern to spot:
- `Expected: 401 / Received: 403` — assertion-too-strict
- `Expected: 201 / Received: 400` (or vice versa) — spec wrong about route shape, OR route changed and spec is stale
- `Expected: ... / Received: 500` — real route bug, helper threw something unexpected

### 3. Classify each failure (5 minutes per failure)

For each unique failing test, decide which bucket it falls into. **Read the spec line and the route line side-by-side** before deciding.

| Bucket | Symptom | Fix | Blast radius |
|---|---|---|---|
| **Spec-too-strict** | `Expected: 401 / Received: 403` (or other narrow code where the codebase elsewhere accepts both) | Relax to `[401, 403]` to match convention | 1 line in 1 spec |
| **Spec-wrong-payload** | Test sends a payload that doesn't actually trigger the asserted branch (e.g. `<script>x</script>` survives upstream middleware as `'x'`) | Switch payload to one that triggers correctly | 1 spec |
| **Route bug** | Helper returns wrong type, schema mismatch, missing field | Fix route/helper. Often a 5-line diff. | 1 route file ± 1 helper |
| **Stale spec** | Route was refactored; spec asserts old contract | Update spec to match new contract | 1 spec |
| **Schema/data mismatch** | Prisma column type differs from value passed | Fix the producer (sanitizer, helper, route handler) — never widen the column "to make the test pass" | 1 helper |
| **CI env-block gap** *(added 2026-05-04 from 940b4f0)* | Spec exercises a code path that's gated on an env-var (e.g. `WELLNESS_DEMO_OTP`); the env-var is set on demo + locally but missing from `deploy.yml`'s `env:` block. Symptom: spec passes locally, fails on CI with the route's "missing config" error path (often a 401/403/400 with a clear `error` string). | Add the env-var to the api_tests `env:` block. Cross-reference whatever sets it on demo (the deploy script, a `.env.example`, the operator runbook). | 1 line in deploy.yml |
| **Spec-bad-fixture** *(added 2026-05-04 from 940b4f0)* | Spec seeds a fixture that fails route-side validation (e.g. `status:'completed'` Visit without `doctorId`). Spec wants the row for downstream assertions but doesn't care about the row's clinical correctness. | Switch to a status/shape that bypasses the strict validation (e.g. `status:'booked'`) — keep the spec focused on the contract under test, not incidental seed correctness. | 1 spec |

If you can't classify within 5 minutes, **read the route handler end-to-end and run the failing assertion locally against an inline mock**. The simulation pattern from `sanitizeJson` triage (test the helper output type/shape against the column declaration) catches schema mismatches in seconds.

### 4. Bundle the fix into ONE commit (10-15 minutes)

Critical: when multiple distinct bugs are masked behind the same red gate, fix them in **one commit**. Reasons:

- Each push to main triggers ~10 minutes of CI. Two separate commits = 20 min lost on parallel CI
- A "fix #1" commit that pushes while #2 is still red leaves the gate red — the next engineer sees red and assumes nothing has been fixed yet
- The blame log reads more honestly: "fix(deploy-gate): close 3 blocking failures preventing demo deploys" beats three single-issue commits

Commit message structure:

```
fix(deploy-gate): close N blocking failures preventing demo deploys

The api_tests gate has been red on every push since <SHA> (N pushes
over <minutes> minutes), blocking demo deploys — demo's stuck at
v<X.Y.Z> while main is at v<A.B.C> + ... . N real bugs surfaced by
recently-added contract specs:

1. <one-line bug summary> — <root cause> — <minimal fix>
2. <one-line bug summary> — <root cause> — <minimal fix>
3. ...

All N fixes verified inline against <library/schema/middleware> ...
```

The "<root cause>" for each bug is non-negotiable. A reviewer needs to know in 30 seconds why the test was wrong vs why the route was wrong.

### 5. Watch the deploy go green + confirm demo updates

```bash
# After push, wait for the next deploy.yml run
gh run list --workflow=deploy.yml --limit 1
# When it goes green:
curl -sk https://crm.globusdemos.com/api/health | jq -r '.version, .timestamp'
# Demo version should now match main's package.json version
```

If demo still shows the stale version 5+ minutes after a green deploy.yml run, the SSH deploy step or the rsync to `/var/www` is broken — that's a different incident; check the deploy job's "Deploy to demo" step output.

## Anti-patterns to avoid

- **"Just relax the assertion"** for every failure. Some failures are real route bugs that deserve a route-side fix. Spec relaxation is the right call when the route's behavior matches the codebase-wide convention; it's the wrong call when the route returns 500 and the spec is correctly asserting 201
- **Pushing a fix-this-one-spec commit** without reading the other failures first. You'll be back here in 10 minutes
- **Reverting the breaking commit** instead of fixing forward. Almost always wrong on this codebase — the "breaking commit" is usually a newly-added spec that codified a contract that was never actually true. Reverting destroys the contract assertion; fixing forward keeps it
- **Disabling the spec** with `test.skip(...)` or removing it from the gate-spec list in `deploy.yml`. The whole point of the per-push gate is that contract drift is caught. Disabling is admitting defeat. Either fix the spec, fix the route, or delete the spec entirely with a commit message explaining why the contract was wrong
- **Ignoring the demo divergence**. If demo is more than 1 release tag behind main, file an issue or note in the next handoff. Tester ghost-regression reports cost everyone time

## Detection rules (when to invoke this skill)

The skill should fire automatically when ALL of the following are true:

1. The current task involves pushing code or watching a deploy
2. `gh run list --workflow=deploy.yml --limit 3` shows the most recent 2 runs both with `conclusion: failure`
3. Either:
   - Both failures share the same failing spec (regression has stuck), OR
   - The two failures are on consecutive commits (the gate is broken regardless of what was pushed)

When all three are true, **interrupt the current task** and run this skill. The current task can resume after the gate is green.

## Cross-references

- Companion to [verifying-issue-before-pickup](../verifying-issue-before-pickup/SKILL.md) — that skill prevents broken specs entering the gate; this one cleans up when they slip through
- Companion to [writing-api-gate-spec](../writing-api-gate-spec/SKILL.md) — that skill teaches "how to write a spec that won't be too strict"; this one is the recovery path
- See [CLAUDE.md](../../../CLAUDE.md) "Standing rules for new code" for the inline rules that prevent this class of failure

## Same shape applies to release-validation gates (added 2026-05-06)

This skill was authored for the per-push `deploy.yml` gate, but the **identical workflow shape** unblocks chronically-red `e2e-full.yml` (release-validation against demo). The 2026-05-05 → 2026-05-06 arc cleared a 5+-tag-old chronic-red e2e-full in ~3 hours of fix-and-iterate using exactly this triage flow.

The 2026-05-05 sequence:
1. Triggered run → categorized failures (real-bug / spec-fixture / demo-state / deploy-block) → fixed the first category → pushed → waited for deploy → re-triggered → repeated.
2. 4 e2e-full re-triggers across the session, each revealing a different failure class as the prior was cleared:
   - (a) `backup-engine-api` + `migration-safety` needed `IS_LOCAL_STACK` guards (e72cd5c, e8cce09)
   - (b) Agent A's new upload spec had a `j.user.tenantId` capture bug blocking the per-push deploy gate (6f140bc) — fixed FIRST since release-validation runs against the deployed state
   - (c) workflows-api count-based assertion was demo-noise-flaky (47e7a1d)
   - (d) Contact upsert had a latent composite-unique bug exposed by the #445 Nginx fix (36e554d) + 5MB upload returns Nginx 413 not multer 400
   - (e) email_scheduling 502 path returned HTML not JSON; workflows-flow polling too short + leak detection too broad (d84b0d9)
3. Final result: all 4 shards green for the first time since v3.4.9.

**The classifications from "Step 3" above generalize directly:**
- `auth-revocation 401↔403` → demo-state-divergence assertion needs to accept `[401, 403]`
- `WELLNESS_DEMO_OTP env-var missing in CI` → release-validation runs against demo where the var IS set, so this exact failure class can't recur in e2e-full; but the inverse (env-var set on demo, missing in CI) bites the per-push gate
- `wellness-read-audit seed-visit 400` → spec-bad-fixture; same shape on either gate
- `sanitize-json 16 unit tests` → schema/data mismatch; same shape on either gate

**Per-push vs release-validation discrepancies usually come from:**
- Background cron activity on demo that isn't present on local stack (`DISABLE_CRONS=1`) — assertions that compare aggregate counters (`afterTotal === beforeTotal`) are noise-flaky
- Local-stack-only specs that need `IS_LOCAL_STACK` guards (see CLAUDE.md standing rule)
- Latent bugs in code paths that only the demo's external network reaches (e.g. Cloudflare, Mailgun, Nginx in front of the route)
- Demo-state assumptions in fixtures (the test expects a specific seed row that doesn't exist on demo)

**Don't assume a chronically-red e2e-full is "we'll fix it next session" work.** ~1.5-3 hours of fix-and-iterate beats weeks of tag pushes that all show red. Same triage flow as per-push deploy gates.
