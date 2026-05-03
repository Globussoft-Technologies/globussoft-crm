# Demo Health Monitor — pattern doc

A portable, copy-into-any-project pattern for catching drift on a deployed environment that your per-push CI gate can't see.

---

## What this is

A **GitHub Actions cron workflow** that hits your deployed box every 30 min with a **read-only Playwright spec**, asserts a small set of invariants, and **auto-files (or comments on) a tracker GitHub issue** when one of them fails. Nothing else. ~150 lines of YAML + ~150 lines of spec.

In one sentence: *"the per-push gate proves a fix works against a clean ephemeral DB; this proves the deployed box hasn't drifted away from that state since the last deploy."*

## Why you want it

Every product team eventually hits this gap:

> *"Our 4-gate CI is green. Why is the demo broken?"*

The per-push gate runs against an ephemeral MySQL/Postgres/SQLite the GitHub runner spins up. It can't catch:

- **Test residue accumulating** on the deployed env (manual QA sessions, sister agents running tests against deployed, ad-hoc `curl` poking)
- **Deploy state drift** (env-var was unset on prod but works locally; a schema migration applied but the seed data fix didn't)
- **Real-deploy infrastructure regressions** (nginx history-fallback misconfigured; SSL cert silently expired; load balancer routing changed)
- **Customer-visible data-quality drift** (real customer entries duplicating because a job is misfiring; counters inflating because a cron is double-running)

The per-push gate cannot see any of that. The deploy job's `/health` smoke check sees only "process is alive". A 30-min cron that probes the deployed env with regression-class assertions sees the rest.

---

## What you'll need

- **GitHub Actions** enabled on the repo (any plan with cron triggers — that's all of them)
- **A deployed environment** with a stable URL (`https://your-app.example.com`)
- **A test runner** that can hit URLs and assert on responses. The template below uses **Playwright**; if you use Cypress, Vitest+supertest, pytest+httpx, or RSpec+Capybara you adapt the spec template to your runner — the workflow template stays the same
- **`gh` CLI** in the workflow (preinstalled on `ubuntu-latest`)
- **`GITHUB_TOKEN`** with `issues: write` permission (provided automatically; you just declare the permission)

---

## Architecture (3 pieces)

```
┌──────────────────────────────────────────────────────────────┐
│  .github/workflows/demo-monitor.yml                          │
│  └─ schedule: '*/30 * * * *' (or hourly — see "Tuning" below)│
│  └─ workflow_dispatch (manual, with input to suppress issue) │
│  └─ runs Playwright spec → exits 0 (green) or 1 (failed)     │
│  └─ on failure: gh issue list/create/comment (stable title)  │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  e2e/tests/demo-health.spec.js                               │
│  └─ test.skip(!IS_DEPLOYED) — only runs against deployed     │
│  └─ /api/health probe — bare minimum                         │
│  └─ N regression-class assertions, one per closed-bug cluster│
│  └─ READ-ONLY: never POST/PUT/DELETE                         │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Stable-titled GitHub issue                                  │
│  Title: "[demo-monitor] <env> health-check failing"          │
│  Body: failure summary + run URL + UTC timestamp             │
│  Subsequent failures comment on the same issue (no spam)     │
└──────────────────────────────────────────────────────────────┘
```

---

## Step 1 — drop in the workflow

Save as `.github/workflows/demo-monitor.yml`. The `TODO:` markers are the only edits needed per project.

```yaml
name: Demo health monitor (read-only)

# Read-only assertions against the deployed env. Catches regression
# classes the per-push CI gate can't see because it runs against
# an ephemeral DB. See docs/DEMO_MONITOR_PATTERN.md for design notes.

on:
  workflow_dispatch:
    inputs:
      open_issue_on_failure:
        description: 'Open/comment on a GitHub issue if the monitor fails'
        type: boolean
        default: true
      base_url:
        description: 'BASE_URL to monitor (defaults to deployed env)'
        type: string
        # TODO: replace with your deployed URL
        default: 'https://your-app.example.com'

  # 30-min cadence — adjust to taste. See "Tuning" below.
  schedule:
    - cron: '*/30 * * * *'

permissions:
  contents: read
  issues: write

jobs:
  monitor:
    name: Probe deployed env
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20' # TODO: match your project's node version

      # TODO: adapt this step to your runner. Playwright shown.
      - name: Install Playwright
        working-directory: e2e
        run: |
          set -euo pipefail
          npm ci --no-audit --no-fund
          npx playwright install chromium --with-deps
          # If your spec uses storageState (saved auth) you may need to
          # pre-create an empty file so chromium loads cleanly.
          mkdir -p playwright/.auth
          echo '{"cookies":[],"origins":[]}' > playwright/.auth/user.json

      - name: Run demo-health spec
        id: probe
        working-directory: e2e
        env:
          # On scheduled runs `inputs.*` are empty; fall back to demo.
          BASE_URL: ${{ inputs.base_url || 'https://your-app.example.com' }} # TODO
          # If your project has E2E teardown that scrubs after each run,
          # set this to "1" so this monitor doesn't trigger it (we only
          # want to OBSERVE state, not modify it).
          E2E_SKIP_SCRUB: '1'
          DEMO_MONITOR: '1'  # spec uses this to force-run vs deployed
        # Don't fail the step yet; we want to upload artifacts +
        # post the issue first, then fail at the end.
        continue-on-error: true
        run: |
          set +e
          npx playwright test \
            --project=chromium \
            --no-deps \
            --reporter=list,json \
            tests/demo-health.spec.js \
            > /tmp/probe.stdout.txt 2>&1
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"
          cat /tmp/probe.stdout.txt

      - name: Upload probe artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: demo-monitor-${{ github.run_id }}
          path: |
            /tmp/probe.stdout.txt
            e2e/test-results/
            e2e/playwright-report/
          retention-days: 14

      - name: Build issue body from failures
        id: report
        # Open issue by default. workflow_dispatch can pass false to
        # suppress (e.g. when manually re-running for verification);
        # scheduled runs always open.
        # Note: `inputs.x` evaluates to '' (empty string) on scheduled
        # runs, and `'' != false` evaluates to FALSE in GHA expressions
        # (empty string coerces to false). So the conditional must
        # branch on event_name explicitly, not on inputs.
        if: ${{ steps.probe.outputs.exit_code != '0' && (github.event_name == 'schedule' || inputs.open_issue_on_failure == true) }}
        env:
          BASE_URL: ${{ inputs.base_url || 'https://your-app.example.com' }} # TODO
        run: |
          set -euo pipefail
          {
            echo "body<<EOF_BODY"
            echo "## Demo monitor failed"
            echo ""
            echo "- **Target**: \`$BASE_URL\`"
            echo "- **Run**: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
            echo "- **Triggered by**: @$GITHUB_ACTOR"
            echo "- **Time (UTC)**: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
            echo ""
            echo "### Failed assertions"
            echo ""
            echo "\`\`\`"
            grep -E "(✘|Error:|expected|received)" /tmp/probe.stdout.txt | head -60 || echo "(see artifact)"
            echo "\`\`\`"
            echo ""
            echo "### What this means"
            echo ""
            echo "Each failed assertion in the demo-health spec maps to a"
            echo "regression class — the test name carries the issue number."
            echo "A failure here means deployed state has drifted from the"
            echo "contract the spec encodes; the per-push CI gate cannot see"
            echo "this because it runs against a fresh ephemeral DB."
            echo ""
            echo "_This issue is auto-managed by_ \`.github/workflows/demo-monitor.yml\`."
            echo "EOF_BODY"
          } >> "$GITHUB_OUTPUT"

      - name: Open or update the demo-monitor tracker issue
        if: ${{ steps.probe.outputs.exit_code != '0' && (github.event_name == 'schedule' || inputs.open_issue_on_failure == true) }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          BODY: ${{ steps.report.outputs.body }}
        run: |
          set -euo pipefail
          # Stable title so re-runs comment on the existing issue rather
          # than spawning a new one each time. Matches by exact title.
          # TODO: replace <env-name> with your env (e.g. "demo", "staging")
          TITLE="[demo-monitor] <env-name> health-check failing"
          existing=$(gh issue list --state open --search "in:title \"$TITLE\"" --json number --jq '.[0].number // empty')
          if [ -n "$existing" ]; then
            echo "Updating existing issue #$existing"
            gh issue comment "$existing" --body "$BODY"
          else
            echo "Opening new issue"
            gh issue create --title "$TITLE" --body "$BODY" --label "demo-monitor"
          fi

      - name: Fail the job if the probe failed
        if: ${{ steps.probe.outputs.exit_code != '0' }}
        run: |
          echo "::error::Demo health monitor reported failures (exit ${{ steps.probe.outputs.exit_code }})"
          exit 1
```

---

## Step 2 — drop in the spec

Save as `e2e/tests/demo-health.spec.js`. Replace `TODO` markers with project-specific checks.

```js
// @ts-check
/**
 * Demo health monitor — read-only assertions against the deployed env.
 *
 * Why this exists: the per-push CI gate validates a fix works on a clean
 * ephemeral DB. Nobody validates that the deployed box stays in a sane
 * state between deploys. This spec hits the deployed box (or any URL)
 * with GETs only and fails on each regression class that's hurt us before.
 *
 * SAFETY:
 *   - This spec NEVER writes. No POST, PUT, DELETE.
 *   - No fixture creation; no afterAll cleanup; nothing to leak.
 *   - Skipped unless BASE_URL points at a deployed env (heuristic) or
 *     DEMO_MONITOR=1 forces it. On localhost it's a no-op.
 *
 * Run modes:
 *   - Workflow_dispatch via .github/workflows/demo-monitor.yml
 *   - Manual: cd e2e && BASE_URL=https://your-app.example.com \
 *             npx playwright test --project=chromium tests/demo-health.spec.js
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://your-app.example.com'; // TODO
const REQUEST_TIMEOUT = 15000;

// Heuristic: only run when BASE_URL clearly points at a deployed env.
// On localhost the spec is a no-op so it doesn't fail unrelated dev runs.
// TODO: tune the regex to match YOUR deployed hostname patterns.
const IS_DEPLOYED =
  /your-app\.example\.com|staging\./i.test(BASE_URL) ||
  process.env.DEMO_MONITOR === '1';

test.describe('Demo health monitor (read-only)', () => {
  test.skip(!IS_DEPLOYED, 'BASE_URL is not a deployed env — skipping (set DEMO_MONITOR=1 to force)');

  let authToken = null;

  test.beforeAll(async ({ request }) => {
    // TODO: replace with your auth flow. Some monitors don't need auth
    // at all (only public endpoints). Some need 1-2 logins (e.g. one
    // per tenant). Whatever the deployed env supports.
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      data: {
        email: process.env.MONITOR_EMAIL || 'monitor@your-app.example.com',
        password: process.env.MONITOR_PASSWORD || 'redacted',
      },
      timeout: REQUEST_TIMEOUT,
    }).catch(() => null);
    if (res?.ok()) authToken = (await res.json()).token;
  });

  // ── Universal: bare-minimum health probes ─────────────────────────

  test('GET /api/health returns healthy', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`, { timeout: REQUEST_TIMEOUT });
    expect(res.status(), `health endpoint returned ${res.status()}`).toBe(200);
    const body = await res.json();
    // TODO: customize to your /health response shape
    expect(body.status).toBe('healthy');
  });

  test('login flow works (bypass-auth not enabled, password not changed)', () => {
    expect(authToken, 'login failed — auth bypass enabled or password rotated?').toBeTruthy();
  });

  // ── Project-specific: one assertion per closed-bug regression class ──
  //
  // Each test name carries the bug number it prevents from regressing.
  // When this test goes red on the deployed box, the issue body shows
  // the test name → on-call clicks the bug number → reads the original
  // repro. Saves debugging time.
  //
  // GUIDELINES for what to put here:
  //   - One assertion per closed-bug *cluster*, not per individual bug
  //   - Pick bugs that recur on deploy state (data quality, drift) —
  //     not bugs that are deterministic per request (those are CI-gate's job)
  //   - Each assertion should run in <2s on average
  //   - All read-only. If a bug needs a write to surface, file a separate
  //     gate spec instead

  test('#XXX — <regression class>', async ({ request }) => {
    test.skip(!authToken, 'auth required');
    // TODO: example structure — replace with real assertion
    const res = await request.get(`${BASE_URL}/api/contacts?limit=500`, {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const contacts = Array.isArray(body) ? body : (body.contacts || body.data || []);
    // Example: no name appears more than 2x — catches duplicate-creation regressions.
    const counts = {};
    for (const c of contacts) {
      const n = (c.name || '').trim();
      if (!n) continue;
      counts[n] = (counts[n] || 0) + 1;
    }
    const dupes = Object.entries(counts).filter(([, n]) => n > 2);
    expect(dupes, `unexpected duplicates: ${JSON.stringify(dupes)}`).toEqual([]);
  });

  // ── Customer-facing route smoke ───────────────────────────────────
  //
  // For an SPA: hit each canonical route, expect 200 + the React/Vue
  // shell HTML. Catches nginx history-fallback regressions that a /
  // smoke check misses.

  // TODO: list your canonical routes
  const PUBLIC_ROUTES = [
    '/',
    '/login',
    '/dashboard',
    '/some-deep-link',
  ];

  for (const route of PUBLIC_ROUTES) {
    test(`SPA route ${route} returns 200 with shell`, async ({ request }) => {
      const res = await request.get(`${BASE_URL}${route}`, { timeout: REQUEST_TIMEOUT });
      expect(res.status(), `${route}: nginx history-fallback misconfig?`).toBe(200);
      const html = await res.text();
      // TODO: match your SPA's mount-point selector
      expect(html, `${route}: served something other than the SPA shell`).toContain('<div id="root">');
    });
  }
});
```

---

## Step 3 — customization checklist

Per project, find every `TODO:` and decide:

- [ ] **Deployed URL** in workflow + spec (`https://your-app.example.com`)
- [ ] **Cron cadence** in workflow (`*/30` is dense; `0 * * * *` hourly is usually plenty — see "Tuning")
- [ ] **Issue title pattern** in workflow (`[demo-monitor] <env-name> health-check failing`)
- [ ] **Node version** in workflow (match your `package.json`/`.nvmrc`)
- [ ] **Test runner** in workflow — Playwright shown; adapt `npm ci` + invocation to Cypress/pytest/etc.
- [ ] **Storage-state file** — only if your runner needs it pre-created
- [ ] **Auth flow** in spec `beforeAll` — match your login/SSO pattern (or remove if all checks are public)
- [ ] **`MONITOR_EMAIL` / `MONITOR_PASSWORD`** — add as repository secrets if your spec authenticates. Use a dedicated read-only account.
- [ ] **`/health` shape** in spec — match your endpoint's response (`{status:'healthy'}`, `{ok:true}`, raw `200 OK`, whatever)
- [ ] **`IS_DEPLOYED` regex** — match your deployed hostnames so the spec doesn't accidentally run against localhost
- [ ] **Regression-class assertions** — replace the example with one per closed-bug cluster from your project's history
- [ ] **`PUBLIC_ROUTES`** — list of canonical SPA paths (skip if you're API-only)
- [ ] **SPA mount-point selector** — `<div id="root">` (React), `<div id="app">` (Vue), `<body class="...">` etc.
- [ ] **Issue label** — `demo-monitor` is fine; create the label first via `gh label create demo-monitor` or it'll be auto-created on first issue

---

## Step 4 — trigger + verify

1. **Fire it manually first** with the issue suppression flag on:
   ```
   gh workflow run demo-monitor.yml -f open_issue_on_failure=false
   ```
2. **Watch the run** — should be green if your env is healthy:
   ```
   gh run list --workflow=demo-monitor.yml --limit=3
   ```
3. **Force a failure** to test the issue auto-filing path. Easiest way: temporarily change one assertion to expect a wrong value, push, wait 30 min for the cron, confirm the issue gets opened. Then revert.
4. **Add the schedule to your team's expectations** — if the monitor opens an issue, oncall should triage within 30 min. Mention this in your team-process doc.

---

## What to put in the regression-class assertions

This is the most important section.

The pattern is **"one test = one closed-bug cluster"**. The test name carries the issue number; when it goes red, oncall opens the original repro and knows what to look for.

### Patterns that work

- **Duplicate-creation guards** — "no contact name appears more than N times"; "no patient phone appears more than once". Catches dedup-job regressions, accidental re-import scripts, broken `@@unique` constraints.
- **Cross-tenant leak guards** — "tenant A's data invisible to tenant B's bearer token". Catches missing `where: { tenantId }` filters.
- **Test-residue guards** — "no contact name matches `^E2E_/^Test /^Race ` pattern". Catches forgotten test cleanup or QA sessions leaving fixture data.
- **State-shape guards** — "GET /api/notifications returns array or `{total}` shape, never 404". Catches removed routes that the frontend still polls (cause silent error toasts).
- **Public-page guards** — "GET /book/:slug returns ≥1 location with non-empty city". Catches data-quality regressions on public surfaces.
- **SPA route smoke** — "GET /some-route returns 200 with `<div id=\"root\">`". Catches nginx history-fallback regressions and lazy-loaded route bundle errors.

### Patterns that DON'T work (skip these)

- **Multi-step write flows** ("can a doctor create a prescription") — that's an e2e UI test, not a monitor. Those belong in your release-validation suite that runs on tag push, not in a 30-min cron that should be cheap and read-only.
- **Performance assertions** ("/api/dashboard responds in < 200ms") — too noisy on cold-start and shared runners. Use a real APM (Datadog, Sentry Performance) for this.
- **Anything writing to the deployed DB** — even cleanup writes; the monitor must be 100% read-only or it'll create exactly the residue it's meant to detect.
- **More than ~20 assertions total** — each one is failure surface area. Prefer 6 high-leverage assertions to 30 noisy ones.

---

## Tuning — keep it from becoming noise

A monitor that opens an issue every other day teaches the team to ignore monitor issues. A few defaults:

### Cadence

| Cadence | Cost (runs/day) | When to pick |
|---|---|---|
| `*/15 * * * *` (15 min) | 96 | Crash-class regressions where 30 min of latency would be customer-visible |
| `*/30 * * * *` (30 min) | 48 | Standard. Most projects start here. |
| `0 * * * *` (hourly) | 24 | Mature project where drift is rare; cuts cost in half |
| `0 */6 * * *` (4×/day) | 4 | API-only service with strong per-push gates and rare drift |

### Auto-self-heal (optional, recommended for projects with cleanup scripts)

If your project has a residue-scrub script, the monitor can call it on `#XXX-residue` failure before opening an issue. Pseudo-code:

```yaml
- name: Auto-scrub residue if matched
  if: ${{ steps.probe.outputs.exit_code != '0' }}
  run: |
    if grep -q "test residue" /tmp/probe.stdout.txt; then
      ./scripts/scrub-test-residue.sh
      # Re-run the spec; if it goes green, exit 0 and skip the issue step
      npx playwright test ... && echo "self-healed=true" >> $GITHUB_OUTPUT
    fi
```

Then gate the issue-filing step on `self-healed != true`. Now single-failure noise from "QA session left 3 rows" gets auto-cleaned without paging anyone, but a real regression (3 rows that come back after scrub) still opens an issue.

### Suppress single-failure noise

For projects that have legitimate transient failures (cold-start retries, partner API blips):

```yaml
# Run twice; only fail if BOTH runs are red
- name: First probe
  ...
- name: Wait + retry
  if: ${{ steps.probe.outputs.exit_code != '0' }}
  run: sleep 30
- name: Second probe
  if: ${{ steps.probe.outputs.exit_code != '0' }}
  ...
```

Only open the issue if the second run also fails.

---

## What you'll learn from running this for a month

Real value emerges over weeks, not days. Patterns we've seen:

1. **Most monitor failures are sibling-system writes.** Other workflows (release-validation suites, scheduled QA browser sessions, ad-hoc agent runs) leaving residue. The fix is teardown discipline at the source, not in the monitor.
2. **A single recurring issue = a real architectural gap.** If `[demo-monitor]` issue keeps reopening for the same assertion, the underlying bug has a structural cause and needs a real fix, not better monitoring.
3. **Adding a new regression-class assertion when a customer-reported bug closes** is the highest-leverage maintenance. It costs ~10 minutes; it permanently catches that class of regression.
4. **The issue body is the most useful artifact**, more than the artifacts upload. On-call sees the failure summary in 30 seconds and knows whether to triage now or batch-defer.

---

## What this is NOT

- **Not a production APM.** Datadog / Sentry / New Relic catch latency, error-rate, traffic-pattern issues. The monitor catches *correctness* drift on data + routing.
- **Not a release-validation suite.** Release validation is heavier (UI flows, write-heavy, hours of runtime, kicks off on tag push). The monitor is light, read-only, every 30 min.
- **Not a uptime-pinger.** UptimeRobot / Pingdom answer "is the box reachable". The monitor answers "is the box reachable AND has its data drifted from the contract".

These complement each other; pick all three for a serious project.

---

## Reference implementation

Globussoft CRM ships this pattern in production. Files to study:

- [.github/workflows/demo-monitor.yml](../.github/workflows/demo-monitor.yml) — the workflow
- [e2e/tests/demo-health.spec.js](../e2e/tests/demo-health.spec.js) — the spec, with 6 regression-class assertions covering closed bugs #401-#406

Real-world track record (May 2026): the monitor caught a 605-row data-pollution event 30 minutes after an unrelated workflow finished, opened a tracker issue, the on-call ran the existing scrub script + dedup script, demo went green again on the next 30-min tick. Total elapsed: 35 minutes from drift → resolution. Without the monitor, this would have been spotted next morning by QA after several hours of polluted demo traffic.
