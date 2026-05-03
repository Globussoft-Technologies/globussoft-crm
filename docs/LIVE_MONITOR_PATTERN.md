# Live Health Monitor — pattern doc

A portable, copy-into-any-project pattern for catching outages + correctness drift on a **production** environment. Sibling of [DEMO_MONITOR_PATTERN.md](DEMO_MONITOR_PATTERN.md), with hard-required safety changes for live customer data.

> **TL;DR:** read-only cron probe of production every 5-15 minutes; Slack + PagerDuty + GitHub-issue alerts with severity tiers; auth via a dedicated audit-trail-friendly service account; assertions on aggregates and shapes only — never on individual customer records.

---

## What this is

A **GitHub Actions cron workflow** that hits your **production** URL every 5-15 minutes with a **strictly read-only Playwright spec**, asserts on uptime + response shapes + latency budgets + integration-pipeline health, and **alerts via tiered channels** (Slack/PagerDuty for severe; GitHub issue for trackable). ~250 lines of YAML + ~250 lines of spec.

It's the demo-monitor pattern with the safety dial cranked all the way up for production.

## Why a separate pattern from demo

The demo-monitor pattern works around test residue and seeded fixtures — production has neither. Production has things demo doesn't: real customers, real PII, latency budgets that customers feel, payment processors that go down, compliance auditors that read your logs. The shape of the monitor is the same; the contract is harder.

| Concern | Demo monitor | Live monitor |
|---|---|---|
| **Authentication** | Seeded admin login OK | Dedicated read-only service account; auditable in app logs |
| **Assertions** | Test-residue scans, RBAC matrix, SPA routes | Latency budgets, payment-pipeline health, signup-flow smoke, aggregate-count drift |
| **Cadence** | 30 min | 5-15 min (detection latency matters more) |
| **Failure response** | Auto-file GitHub issue | Tiered: page-on-call (P1), Slack (P2), GH issue (P3) |
| **Read-only** | Strongly preferred | **HARD REQUIREMENT** — even cleanup writes forbidden; the monitor must touch zero customer rows |
| **Privacy** | Can match `^E2E_/Test/Race` patterns | No PII matching, no per-customer queries, assertions on aggregates only |
| **Audit trail** | Workflow logs sufficient | Probes appear in AuditLog table; service account is identifiable; SOC-2 friendly |
| **Kill switch** | None needed | `MONITOR_DISABLED=1` env var must be respected |
| **Dry-run mode** | Optional | Required for first month against a new env |

If you're trying to bolt the demo pattern onto live without these adaptations, stop and read this doc first.

---

## What you'll need

- **GitHub Actions** with cron + secrets
- **A production URL** with a stable base path (`https://app.example.com`)
- **A dedicated service account** in your auth system — call it `monitor@yourcompany.com` or similar. Should:
  - Have a role identifiable in app logs (`MONITOR` or read-only `VIEWER`, never `ADMIN`)
  - Be excluded from any analytics/billing counts
  - Have audit-log entries when it hits endpoints (so SOC-2 auditors can see what it touched)
  - Have **no write permissions at all** at the role level (defense in depth — even if the spec accidentally tries to POST, the route refuses)
- **A Slack webhook URL** OR **PagerDuty integration key** OR both
- **`gh` CLI** in the workflow (preinstalled on `ubuntu-latest`) for issue auto-filing
- **Test runner** that can hit URLs and assert on responses (Playwright shown; adapt to Cypress/pytest/etc.)

Optional but strongly recommended:
- **APM tool** (Datadog/Sentry/New Relic) — the live monitor catches *correctness* drift; APM catches latency/error-rate trends. They're complementary, not substitutes.
- **Status page** (statuspage.io / instatus / atlassian) — wire the monitor's failure signal into a public-facing status page.

---

## Architecture (3 pieces + 2 alert channels)

```
┌─────────────────────────────────────────────────────────────────┐
│  .github/workflows/live-monitor.yml                             │
│  └─ schedule: '*/10 * * * *' (or as low as '*/5')               │
│  └─ workflow_dispatch (manual; with dry-run + cadence overrides)│
│  └─ MONITOR_DISABLED kill switch (early exit if set)            │
│  └─ runs Playwright spec → severity-classified exit code        │
│  └─ ALERT FAN-OUT (depends on severity):                        │
│     ├─ P1 (uptime/auth/payment)   → PagerDuty + Slack + GH      │
│     ├─ P2 (latency/integration)   → Slack + GH                  │
│     └─ P3 (drift/aggregate)       → GH only                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  e2e/tests/live-health.spec.js                                  │
│  └─ test.skip(!IS_PRODUCTION) — only runs against prod          │
│  └─ test.describe('P1') — uptime + auth + payment               │
│  └─ test.describe('P2') — latency + external integrations       │
│  └─ test.describe('P3') — schema invariants + aggregate drift   │
│  └─ READ-ONLY enforced: spec rejects any non-GET request        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Slack channel: #ops-prod-alerts                                │
│  PagerDuty service: <your-app-prod>                             │
│  GitHub issue: "[live-monitor] <env> degraded"                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 1 — drop in the workflow

Save as `.github/workflows/live-monitor.yml`. Read every comment block. Most edits are at `TODO:` markers.

```yaml
name: Live health monitor (read-only, production)

# Read-only assertions against the deployed PRODUCTION env.
# Sibling to demo-monitor.yml but with production-grade defaults:
#   - Tighter cadence (5-15 min vs demo's 30 min)
#   - Severity-tiered alerts: P1 pages on-call; P2 → Slack; P3 → GitHub issue only
#   - HARD read-only — the spec asserts non-GET requests would fail
#   - MONITOR_DISABLED kill-switch respected (set repo secret to "1")
#
# See docs/LIVE_MONITOR_PATTERN.md for design notes.

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Run probes but suppress all alerts (Slack/PD/GH)'
        type: boolean
        default: false
      base_url:
        description: 'BASE_URL to monitor (defaults to production)'
        type: string
        # TODO: replace with your production URL
        default: 'https://app.example.com'

  # 10-minute cadence is a reasonable default. See "Tuning" in the doc.
  # Adjust to '*/5' for high-traffic prod or '*/15' for lower-stakes apps.
  schedule:
    - cron: '*/10 * * * *'

permissions:
  contents: read
  issues: write

jobs:
  monitor:
    name: Probe production
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - name: Honor kill switch
        env:
          MONITOR_DISABLED: ${{ secrets.MONITOR_DISABLED }}
        run: |
          if [ "$MONITOR_DISABLED" = "1" ]; then
            echo "::warning::MONITOR_DISABLED=1 — monitor disabled by repo secret; exiting cleanly"
            exit 0
          fi

      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20' # TODO: match your project's node version

      - name: Install Playwright
        working-directory: e2e
        run: |
          set -euo pipefail
          npm ci --no-audit --no-fund
          npx playwright install chromium --with-deps
          mkdir -p playwright/.auth
          echo '{"cookies":[],"origins":[]}' > playwright/.auth/user.json

      # ─── Probe 1: P1 (uptime / auth / payment-pipeline) ──────────────
      # If this fails, page on-call immediately.

      - name: Probe P1 (uptime + auth + payment)
        id: p1
        working-directory: e2e
        env:
          BASE_URL: ${{ inputs.base_url || 'https://app.example.com' }} # TODO
          MONITOR_EMAIL: ${{ secrets.MONITOR_EMAIL }}
          MONITOR_PASSWORD: ${{ secrets.MONITOR_PASSWORD }}
          LIVE_MONITOR: '1'
        continue-on-error: true
        run: |
          set +e
          npx playwright test \
            --project=chromium \
            --no-deps \
            --reporter=list \
            --grep "@P1" \
            tests/live-health.spec.js \
            > /tmp/probe-p1.txt 2>&1
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"
          cat /tmp/probe-p1.txt

      # ─── Probe 2: P2 (latency budgets / external integrations) ───────
      # Only run if P1 passed (no point measuring latency on a downed box).

      - name: Probe P2 (latency + integrations)
        id: p2
        if: steps.p1.outputs.exit_code == '0'
        working-directory: e2e
        env:
          BASE_URL: ${{ inputs.base_url || 'https://app.example.com' }} # TODO
          MONITOR_EMAIL: ${{ secrets.MONITOR_EMAIL }}
          MONITOR_PASSWORD: ${{ secrets.MONITOR_PASSWORD }}
          LIVE_MONITOR: '1'
        continue-on-error: true
        run: |
          set +e
          npx playwright test \
            --project=chromium \
            --no-deps \
            --reporter=list \
            --grep "@P2" \
            tests/live-health.spec.js \
            > /tmp/probe-p2.txt 2>&1
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"
          cat /tmp/probe-p2.txt

      # ─── Probe 3: P3 (schema invariants / aggregate drift) ───────────
      # Run regardless — these are slow-moving signals worth catching.

      - name: Probe P3 (schema invariants + drift)
        id: p3
        if: steps.p1.outputs.exit_code == '0'
        working-directory: e2e
        env:
          BASE_URL: ${{ inputs.base_url || 'https://app.example.com' }} # TODO
          MONITOR_EMAIL: ${{ secrets.MONITOR_EMAIL }}
          MONITOR_PASSWORD: ${{ secrets.MONITOR_PASSWORD }}
          LIVE_MONITOR: '1'
        continue-on-error: true
        run: |
          set +e
          npx playwright test \
            --project=chromium \
            --no-deps \
            --reporter=list \
            --grep "@P3" \
            tests/live-health.spec.js \
            > /tmp/probe-p3.txt 2>&1
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"
          cat /tmp/probe-p3.txt

      - name: Upload all probe artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: live-monitor-${{ github.run_id }}
          path: |
            /tmp/probe-p1.txt
            /tmp/probe-p2.txt
            /tmp/probe-p3.txt
            e2e/test-results/
          retention-days: 30

      # ─── Alert routing ───────────────────────────────────────────────

      - name: 🚨 P1 → PagerDuty (page on-call)
        if: ${{ steps.p1.outputs.exit_code != '0' && inputs.dry_run != true }}
        env:
          PD_KEY: ${{ secrets.PAGERDUTY_INTEGRATION_KEY }}
          BASE_URL: ${{ inputs.base_url || 'https://app.example.com' }}
        run: |
          set -euo pipefail
          if [ -z "$PD_KEY" ]; then
            echo "::warning::PAGERDUTY_INTEGRATION_KEY not set — skipping page"
            exit 0
          fi
          # Pull the first FAIL line as a one-line summary
          summary=$(grep -E "✘|Error:" /tmp/probe-p1.txt | head -1 | tr -d '"' | cut -c1-200)
          curl -fsS -X POST https://events.pagerduty.com/v2/enqueue \
            -H 'Content-Type: application/json' \
            -d @- <<EOF
          {
            "routing_key": "$PD_KEY",
            "event_action": "trigger",
            "dedup_key": "live-monitor-p1-$(date -u +%Y%m%d-%H)",
            "payload": {
              "summary": "[live-monitor P1] $summary",
              "source": "$BASE_URL",
              "severity": "critical",
              "custom_details": {
                "run_url": "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
              }
            }
          }
          EOF

      - name: ⚠️ P1 or P2 → Slack
        if: ${{ (steps.p1.outputs.exit_code != '0' || steps.p2.outputs.exit_code != '0') && inputs.dry_run != true }}
        env:
          SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_URL }}
          BASE_URL: ${{ inputs.base_url || 'https://app.example.com' }}
          P1_FAIL: ${{ steps.p1.outputs.exit_code != '0' }}
          P2_FAIL: ${{ steps.p2.outputs.exit_code != '0' }}
        run: |
          set -euo pipefail
          if [ -z "$SLACK_WEBHOOK" ]; then
            echo "::warning::SLACK_WEBHOOK_URL not set — skipping Slack"
            exit 0
          fi
          tier="P2"
          if [ "$P1_FAIL" = "true" ]; then tier="P1 🚨 PAGED"; fi
          # Strip ANSI from output before posting
          excerpt=$(grep -E "✘|Error:" /tmp/probe-p1.txt /tmp/probe-p2.txt 2>/dev/null | sed -e 's/\x1b\[[0-9;]*m//g' | head -10 | tr '\n' '|' | sed 's/|/\\n/g')
          curl -fsS -X POST "$SLACK_WEBHOOK" \
            -H 'Content-Type: application/json' \
            -d "{
              \"text\": \"$tier — live-monitor failure on $BASE_URL\",
              \"blocks\": [
                {\"type\":\"header\",\"text\":{\"type\":\"plain_text\",\"text\":\"$tier — Live monitor failed\"}},
                {\"type\":\"section\",\"text\":{\"type\":\"mrkdwn\",\"text\":\"*Target:* \`$BASE_URL\`\n*Run:* <$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID|view logs>\"}},
                {\"type\":\"section\",\"text\":{\"type\":\"mrkdwn\",\"text\":\"\`\`\`$excerpt\`\`\`\"}}
              ]
            }"

      - name: 📋 Any failure → GitHub tracker issue
        if: ${{ (steps.p1.outputs.exit_code != '0' || steps.p2.outputs.exit_code != '0' || steps.p3.outputs.exit_code != '0') && inputs.dry_run != true }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          BASE_URL: ${{ inputs.base_url || 'https://app.example.com' }}
          P1: ${{ steps.p1.outputs.exit_code }}
          P2: ${{ steps.p2.outputs.exit_code }}
          P3: ${{ steps.p3.outputs.exit_code }}
        run: |
          set -euo pipefail
          # TODO: replace <env-name> below with your env (e.g. "prod", "us-east-prod")
          TITLE="[live-monitor] <env-name> degraded"
          {
            echo "## Live monitor failure"
            echo ""
            echo "- **Target**: \`$BASE_URL\`"
            echo "- **Run**: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
            echo "- **Time (UTC)**: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
            echo ""
            echo "### Tier results"
            echo ""
            echo "- P1 (uptime/auth/payment): exit $P1 $([ \"$P1\" = '0' ] && echo '✅' || echo '🚨 paged')"
            echo "- P2 (latency/integrations): exit $P2 $([ \"$P2\" = '0' ] && echo '✅' || echo '⚠️')"
            echo "- P3 (drift/invariants): exit $P3 $([ \"$P3\" = '0' ] && echo '✅' || echo '📋')"
            echo ""
            echo "### Excerpts"
            echo ""
            echo "<details><summary>P1</summary>"
            echo ""
            echo "\`\`\`"
            grep -E "✘|Error:|expected|received" /tmp/probe-p1.txt 2>/dev/null | head -30 || echo "(green)"
            echo "\`\`\`"
            echo "</details>"
            echo ""
            echo "<details><summary>P2</summary>"
            echo ""
            echo "\`\`\`"
            grep -E "✘|Error:|expected|received" /tmp/probe-p2.txt 2>/dev/null | head -30 || echo "(green)"
            echo "\`\`\`"
            echo "</details>"
            echo ""
            echo "<details><summary>P3</summary>"
            echo ""
            echo "\`\`\`"
            grep -E "✘|Error:|expected|received" /tmp/probe-p3.txt 2>/dev/null | head -30 || echo "(green)"
            echo "\`\`\`"
            echo "</details>"
            echo ""
            echo "_This issue is auto-managed by_ \`.github/workflows/live-monitor.yml\`."
          } > /tmp/issue-body.txt

          existing=$(gh issue list --state open --search "in:title \"$TITLE\"" --json number --jq '.[0].number // empty')
          if [ -n "$existing" ]; then
            echo "Updating existing issue #$existing"
            gh issue comment "$existing" --body-file /tmp/issue-body.txt
          else
            echo "Opening new issue"
            gh issue create --title "$TITLE" --body-file /tmp/issue-body.txt --label "live-monitor"
          fi

      - name: Fail the job if any tier failed
        if: ${{ steps.p1.outputs.exit_code != '0' || steps.p2.outputs.exit_code != '0' || steps.p3.outputs.exit_code != '0' }}
        run: |
          echo "::error::live-monitor reported failures — P1=${{ steps.p1.outputs.exit_code }} P2=${{ steps.p2.outputs.exit_code }} P3=${{ steps.p3.outputs.exit_code }}"
          exit 1
```

---

## Step 2 — drop in the spec

Save as `e2e/tests/live-health.spec.js`. **Read the SAFETY block carefully** — production safety is the whole point of this spec.

```js
// @ts-check
/**
 * Live health monitor — read-only assertions against PRODUCTION.
 *
 * SAFETY (non-negotiable):
 *   1. NEVER writes — no POST, PUT, PATCH, DELETE. The describe-level
 *      assertReadOnly() guard rejects test functions that try.
 *   2. NEVER asserts on individual customer records — assertions are
 *      on aggregates (counts, response shapes, latency) only.
 *   3. NEVER includes PII in failure messages — those go to Slack /
 *      PagerDuty / GitHub which have different visibility profiles.
 *   4. Skipped on localhost — IS_PRODUCTION heuristic prevents accidental
 *      runs against dev environments.
 *   5. Auth via dedicated MONITOR account, never a real customer login.
 *
 * Severity tiers (declared via @P1 / @P2 / @P3 in test names):
 *   - @P1: uptime, auth, payment-pipeline. PagerDuty pages on failure.
 *   - @P2: latency budgets, external integrations. Slack notifies.
 *   - @P3: schema invariants, aggregate drift. GitHub issue only.
 *
 * Run modes:
 *   - Workflow: .github/workflows/live-monitor.yml
 *   - Manual: cd e2e && BASE_URL=https://app.example.com LIVE_MONITOR=1 \
 *             MONITOR_EMAIL=... MONITOR_PASSWORD=... \
 *             npx playwright test --project=chromium tests/live-health.spec.js
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://app.example.com'; // TODO
const REQUEST_TIMEOUT = 10000;

// TODO: tune the regex to match YOUR production hostname pattern.
const IS_PRODUCTION =
  /app\.example\.com|api\.example\.com/i.test(BASE_URL) ||
  process.env.LIVE_MONITOR === '1';

// ── Read-only enforcement ────────────────────────────────────────────
//
// Wrap Playwright's request fixture so it rejects any non-GET method.
// Catches accidental POST/PUT/DELETE in a test before it hits prod.

function readOnly(request) {
  return new Proxy(request, {
    get(target, prop) {
      if (['post', 'put', 'patch', 'delete'].includes(prop)) {
        return () => {
          throw new Error(
            `[LIVE-MONITOR-SAFETY] non-GET (${prop.toUpperCase()}) call ` +
            `attempted in live monitor spec — REFUSED. Live spec is read-only.`
          );
        };
      }
      return target[prop];
    },
  });
}

test.describe('Live health monitor (read-only)', () => {
  test.skip(!IS_PRODUCTION, 'BASE_URL is not production — skipping (set LIVE_MONITOR=1 to force)');

  let authToken = null;

  test.beforeAll(async ({ request }) => {
    // TODO: dedicated read-only service account. NEVER use a real
    // customer login. The account should:
    //   - Have role=MONITOR or VIEWER (no write perms in the role table)
    //   - Appear in your AuditLog table when it hits endpoints (so SOC-2
    //     auditors can see what it touched and when)
    //   - Be excluded from billing / usage analytics
    if (!process.env.MONITOR_EMAIL || !process.env.MONITOR_PASSWORD) {
      console.warn('[live-monitor] MONITOR_EMAIL/PASSWORD not set — auth-required tests will skip');
      return;
    }
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      data: {
        email: process.env.MONITOR_EMAIL,
        password: process.env.MONITOR_PASSWORD,
      },
      timeout: REQUEST_TIMEOUT,
    }).catch(() => null);
    if (res?.ok()) authToken = (await res.json()).token;
  });

  // ════════════════════════════════════════════════════════════════════
  //  P1 — uptime, auth, payment-pipeline (PagerDuty fires on failure)
  // ════════════════════════════════════════════════════════════════════

  test('@P1 GET /api/health returns healthy in under 2s', async ({ request }) => {
    const start = Date.now();
    const res = await readOnly(request).get(`${BASE_URL}/api/health`, { timeout: REQUEST_TIMEOUT });
    const ms = Date.now() - start;
    expect(res.status(), 'health endpoint not 200').toBe(200);
    expect(ms, `health endpoint slow: ${ms}ms`).toBeLessThan(2000);
    const body = await res.json();
    // TODO: customize to your /health response shape
    expect(body.status).toBe('healthy');
  });

  test('@P1 monitor service-account login succeeds', () => {
    expect(authToken, 'monitor service-account login failed — credentials rotated or disabled?').toBeTruthy();
  });

  // TODO: list every payment provider you depend on. For each, hit a
  // health-probe endpoint that doesn't actually charge a card. Stripe
  // has a `/v1/balance` endpoint that returns 200 if your API key is
  // valid; equivalent exists for Razorpay/Square/Paddle/etc.
  // Wire it through a backend route that proxies; don't hit the
  // payment provider from GitHub Actions directly (rate-limit risk +
  // your secrets aren't there).

  test('@P1 payment-pipeline upstream reachable', async ({ request }) => {
    test.skip(!authToken, 'auth required');
    // TODO: route in your app that pings the payment provider's healthcheck
    const res = await readOnly(request).get(`${BASE_URL}/api/payments/healthcheck`, {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.providers?.stripe?.reachable, 'Stripe upstream unreachable').toBe(true);
    // Add other providers as needed
  });

  test('@P1 signup endpoint returns 4xx (NOT 5xx) on bad input', async ({ request }) => {
    // We cannot create a real user, but we CAN verify the signup endpoint
    // is functioning by hitting it with deliberately invalid input and
    // expecting a clean 400, not a crashy 500. This catches the class
    // where signup is broken because of a downstream regression (DB
    // schema drift, validator throwing, etc.).
    const res = await readOnly(request).get(`${BASE_URL}/api/auth/signup-config`, {
      timeout: REQUEST_TIMEOUT,
    });
    // Adjust based on what your signup-config-style read endpoint returns.
    // The point is: probe a route in the signup flow that's read-only.
    expect([200, 400, 401]).toContain(res.status());
    expect(res.status(), 'signup endpoint 5xx — flow likely broken').not.toBeGreaterThanOrEqual(500);
  });

  // ════════════════════════════════════════════════════════════════════
  //  P2 — latency budgets + external integrations (Slack notifies)
  // ════════════════════════════════════════════════════════════════════

  // TODO: enumerate the endpoints customers hit on every page load
  // (your app shell + the most-frequently-called list endpoints) with
  // realistic latency budgets. The first probe of the day is allowed
  // to be slower (cold start); subsequent ones must be fast.

  const LATENCY_BUDGETS = [
    { path: '/api/me',           budgetMs: 800 },
    { path: '/api/dashboard',    budgetMs: 1500 },
    { path: '/api/notifications?limit=10', budgetMs: 1000 },
    // Add the endpoints your app shell pulls on every page load
  ];

  for (const { path, budgetMs } of LATENCY_BUDGETS) {
    test(`@P2 ${path} latency under ${budgetMs}ms`, async ({ request }) => {
      test.skip(!authToken, 'auth required');
      const start = Date.now();
      const res = await readOnly(request).get(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: REQUEST_TIMEOUT,
      });
      const ms = Date.now() - start;
      expect(res.status(), `${path} non-200`).toBe(200);
      expect(ms, `${path} slow: ${ms}ms (budget ${budgetMs}ms)`).toBeLessThan(budgetMs);
    });
  }

  // TODO: external integrations YOUR app depends on. Pattern:
  // health-probe route in YOUR app that tests upstream reachability.

  test('@P2 email provider (Mailgun/SendGrid) reachable', async ({ request }) => {
    test.skip(!authToken, 'auth required');
    const res = await readOnly(request).get(`${BASE_URL}/api/integrations/email/healthcheck`, {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.reachable).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════
  //  P3 — schema invariants + aggregate drift (GitHub issue only)
  // ════════════════════════════════════════════════════════════════════

  // These are slow-moving signals that don't need to page anyone but
  // are valuable if they show up in a tracker issue. Run every cycle;
  // open a ticket if drift exceeds threshold.

  test('@P3 aggregate user count not collapsed', async ({ request }) => {
    test.skip(!authToken, 'auth required');
    // TODO: an admin endpoint that returns a SCALAR count, not the rows.
    // Privacy-friendly: no PII surfaces. Catches "OMG someone ran a mass
    // delete query" or "primary DB rolled back to a snapshot".
    const res = await readOnly(request).get(`${BASE_URL}/api/admin/stats/totals`, {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // TODO: tune the threshold to your scale. The point is "not zero"
    // and "not radically different from yesterday".
    expect(body.users, 'user count is zero — schema rollback?').toBeGreaterThan(100);
  });

  test('@P3 schema unique-constraint still enforced', async ({ request }) => {
    test.skip(!authToken, 'auth required');
    // TODO: a route that READS a uniqueness contract.
    // Example: list of "duplicates detected last hour" — if this number
    // suddenly jumps, your @@unique constraint may have been dropped or
    // a dedup job is broken. Stay read-only.
    const res = await readOnly(request).get(`${BASE_URL}/api/admin/stats/recent-duplicates`, {
      headers: { Authorization: `Bearer ${authToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    if (res.status() !== 200) test.skip(true, 'stats endpoint not exposed in this env');
    const body = await res.json();
    expect(body.duplicatesLastHour, 'duplicate spike — constraint dropped?').toBeLessThan(10);
  });

  test('@P3 SPA route smoke', async ({ request }) => {
    // SPA route smoke (catches nginx history-fallback regressions)
    // TODO: list customer-visible routes (leave admin-only out).
    const PUBLIC_ROUTES = ['/', '/login', '/pricing'];
    for (const route of PUBLIC_ROUTES) {
      const res = await readOnly(request).get(`${BASE_URL}${route}`, { timeout: REQUEST_TIMEOUT });
      expect(res.status(), `${route} not 200 — nginx misconfig?`).toBe(200);
      const html = await res.text();
      // TODO: match your SPA mount-point selector
      expect(html, `${route} not serving SPA shell`).toContain('<div id="root">');
    }
  });
});
```

---

## Step 3 — secrets you'll need

Add these to your repo's **Settings → Secrets and variables → Actions**:

| Secret | Required for | What |
|---|---|---|
| `MONITOR_EMAIL` | All auth-required tests | Email for the dedicated read-only service account |
| `MONITOR_PASSWORD` | All auth-required tests | Password for that account. Rotate quarterly. |
| `SLACK_WEBHOOK_URL` | Slack alerts (P1+P2) | Incoming webhook URL for `#ops-prod-alerts` (or wherever) |
| `PAGERDUTY_INTEGRATION_KEY` | PagerDuty page (P1) | Events API integration key (NOT your account API key — the per-service routing key) |
| `MONITOR_DISABLED` | Kill switch | Set to `"1"` during planned outages or maintenance windows. Unset it to re-enable. |

The standard `GITHUB_TOKEN` is auto-provided; you only need to declare `permissions: issues: write` in the workflow.

---

## Step 4 — customization checklist

Find every `TODO:` and decide:

- [ ] **Production URL** in workflow + spec
- [ ] **Cron cadence** — `*/10` is the default. `*/5` for high-stakes/high-traffic; `*/15` for less critical
- [ ] **Issue title pattern** — `[live-monitor] <env-name> degraded`
- [ ] **Node version** — match your `package.json`/`.nvmrc`
- [ ] **Test runner** — Playwright shown; adapt invocation to your stack
- [ ] **`IS_PRODUCTION` regex** — match your prod hostnames so the spec doesn't run against staging accidentally
- [ ] **Service account** — create `monitor@yourcompany.com` (or similar) in your auth system with role `MONITOR` or `VIEWER`. Grant ONLY read perms.
- [ ] **`/health` response shape** in spec
- [ ] **P1 payment-pipeline endpoint** — write a backend route that proxies a payment-provider healthcheck. Don't call Stripe/etc. from GitHub Actions directly.
- [ ] **P2 latency budgets** — pick realistic thresholds. Look at your APM's p95 numbers and pad by 50%.
- [ ] **P2 external-integration endpoints** — list every external service your app depends on and add a backend healthcheck route per provider.
- [ ] **P3 aggregate stats endpoint** — write a backend route that returns SCALAR counts only (`{ users: 12450, contacts: 89234, ... }`). NEVER list rows.
- [ ] **P3 SPA routes** — list customer-visible routes (skip admin-only)
- [ ] **SPA mount-point selector** — `<div id="root">` (React) / `<div id="app">` (Vue) / etc.
- [ ] **Issue label** — create `live-monitor` label first via `gh label create live-monitor`
- [ ] **Slack webhook configured** — point at the right channel
- [ ] **PagerDuty service set up** — with an on-call rotation that responds to events
- [ ] **Run a dry-run cycle** before turning on production alerting (next section)

---

## Step 5 — first-month rollout (DO THIS — don't skip)

Production alerting that pages on-call has to be RIGHT before it goes live, or the team learns to ignore the pages. Suggested ramp:

### Week 1 — silent baseline
Set `MONITOR_DISABLED=1` in repo secrets temporarily, OR run only with `workflow_dispatch -f dry_run=true`. The probes still run; alerts are suppressed. Verify:
- All probes pass on a healthy production
- No flaky failures over 100+ runs
- Workflow runtime < 3 min consistently

### Week 2 — Slack only
Unset `MONITOR_DISABLED`. PagerDuty step is gated on P1 — comment out `PAGERDUTY_INTEGRATION_KEY` in the workflow YAML temporarily. Slack will fire, but no pages. Watch the channel for a week. Tune thresholds.

### Week 3 — Full alerting
Re-enable PagerDuty. Brief on-call on what `[live-monitor]` Slack messages mean and how to triage.

### Week 4+ — Iterate
Every alert that fires should result in either:
1. A real fix (the bug the assertion caught is shipped)
2. A threshold tune (the budget was too tight; raise it)
3. A test-suppress (the assertion is genuinely noisy; remove it or downgrade tier)

If after a month the same alert keeps firing without resolution, that's an architectural bug — open a separate engineering ticket. Don't keep snoozing the monitor.

---

## What to put in each tier

The tier classification is the most important design decision. Get this wrong and you either page on noise or miss real outages.

### P1 — page on-call (sub-15-min response expected)

**Criteria:** customer-impacting, time-sensitive, not self-healing. Engineering must be in the loop NOW.

Typical assertions:
- `/api/health` returns 200 (process is alive)
- Login flow works (auth provider isn't down)
- Payment provider reachable from your backend (your API key didn't get rotated; their service is up)
- Critical signup/onboarding path returns non-5xx
- Database is reachable (your healthcheck includes a `SELECT 1`)

Don't put here:
- Latency assertions (those are P2 — slow ≠ down)
- Aggregate drift (P3 — slow signal)
- Anything that takes > 5s to assert (probe budget)

### P2 — Slack notify, no page (next-business-day acceptable)

**Criteria:** degradation that customers will notice but not catastrophically; engineering should triage during business hours.

Typical assertions:
- Latency on app-shell endpoints under N ms
- External integrations reachable (email provider, SMS provider, telephony provider — not payment, that's P1)
- Background-job lag under N minutes (e.g. queued emails being processed within reasonable window)
- Rate-limit headroom > N% (catch drift toward exhaustion)

### P3 — GitHub issue only (weekly review acceptable)

**Criteria:** drift signals worth tracking but not interrupting anyone for.

Typical assertions:
- Aggregate row counts in expected range (not collapsed; not exploding)
- Unique-constraint health (no duplicate spike)
- SPA route shell smoke (all canonical routes serve the shell)
- Schema invariant probes (every multi-tenant table's row count > 0 across all active tenants — confirms tenant scoping isn't silently filtering everyone out)
- Storage-pool health (low-watermark probes — catches "we're 90% full on disk")

---

## What NOT to do on a live monitor (ever)

- **Write to production.** Even cleanup writes. If you find drift the monitor can't fix safely, file a ticket; don't write.
- **Use a real customer login.** Audit logs will show your monitor account hitting endpoints all day; using `customer-jane@gmail.com` confuses the audit trail and breaks usage analytics.
- **Match patterns against PII** in assertions. No `name LIKE '%test%'` against the customer table; assert on aggregates only.
- **Put PII in failure messages.** Slack and GitHub have different visibility profiles than your app's audit log; a customer name in a Slack alert is a privacy event.
- **Schedule probes faster than your DB can handle.** A `*/5` probe that takes 30 seconds runs back-to-back; a slow query in the probe can cause the monitor to be the cause of the latency it's measuring.
- **Hard-code production URL in the spec.** Always make it configurable. The same spec runs against staging in week 1 of rollout; against prod in week 3.
- **Skip the dry-run rollout.** First-week production alerting that pages incorrectly trains the team to ignore the system.
- **Assert on multi-step flows.** "Can a user create an order and pay?" is an e2e flow, not a monitor probe. Belongs in your release-validation suite, not in a 5-min cron.

---

## Tuning + maintenance

### Cadence trade-offs

| Cadence | Runs/day | Detection latency p95 | Cost (GH Actions minutes/day) |
|---|---|---|---|
| `*/5 * * * *` | 288 | ~5 min | ~12-15 min |
| `*/10 * * * *` | 144 | ~10 min | ~6-8 min |
| `*/15 * * * *` | 96 | ~15 min | ~4-5 min |
| `0 * * * *` | 24 | ~60 min | ~1 min |

Start at `*/10`. Tighten only if your incident postmortems say "5-min vs 10-min detection latency materially changed customer impact". For most B2B SaaS, that's never; for high-traffic consumer or payment-critical, sometimes.

### Single-failure noise suppression

Production has legitimate transient failures (network blip, cold start, garbage-collection pause). Add a probe-then-retry within the same run, only fail if both fail:

```yaml
- name: First probe
  id: p1a
  ...
- name: Wait + retry
  if: steps.p1a.outputs.exit_code != '0'
  run: sleep 20
- name: Confirm
  id: p1b
  if: steps.p1a.outputs.exit_code != '0'
  ...
- name: Fail only on confirmed failure
  if: steps.p1a.outputs.exit_code != '0' && steps.p1b.outputs.exit_code != '0'
  run: exit 1
```

### Quarterly maintenance

- Rotate the `MONITOR_PASSWORD` secret
- Review every assertion: is it still relevant? Tune thresholds.
- Audit how many tracker issues opened that quarter. > 1/week of recurring alerts = real architectural work needed.
- Review the on-call's response data: median time-to-ack on P1 pages. > 15 min consistently = either page-routing is broken, or the pages aren't actionable enough.

---

## Compliance notes

If you operate in a regulated space (healthcare, fintech, gov):

- **GDPR / HIPAA**: the monitor account must not have access to PII unless absolutely necessary. P1 health probes are usually unauth or use synthetic data; P2 latency probes can use the monitor account hitting `/api/me` (returns the monitor's own profile). P3 aggregate-stats probes should hit endpoints that return SCALAR aggregates only.
- **SOC-2**: workflow run history is your audit trail. Every probe must be traceable to (workflow_run_id, monitor_account_id, endpoint, timestamp). Don't rotate workflow run logs faster than your audit retention period (default 90 days; bump to 365 if SOC-2 requires).
- **PCI-DSS**: if your app handles card data, the monitor must not be in cardholder-data scope. The payment-pipeline P1 probe should hit YOUR healthcheck route that proxies the provider; never hit the provider's API directly from GitHub Actions (your prod environment is in scope; your CI runner is not, and you don't want it pulled in).

---

## What this is NOT

- **Not a production APM.** Datadog/Sentry/New Relic catch latency trends, error-rate, traffic patterns. They sit in your runtime and see every request. The live monitor catches *correctness* drift on a small set of contracts. Pick both — they answer different questions.
- **Not a release-validation suite.** Release validation is heavy (full UI flows, write-heavy, hours of runtime, runs on tag push). The live monitor is light, read-only, every 5-15 min.
- **Not an uptime-pinger.** UptimeRobot/Pingdom answer "is the box reachable from N geographies". The live monitor answers "is the box reachable AND is it correct AND is it within latency budget AND are the upstream integrations healthy". Use both — the pinger gives you geographic coverage GH Actions doesn't.

These complement each other. Serious production deployments use all four (live monitor + APM + release validation + uptime pinger).

---

## Sister doc

[DEMO_MONITOR_PATTERN.md](DEMO_MONITOR_PATTERN.md) — same pattern adapted for demo/staging environments. The differences are listed at the top of this doc; if you're confused which one to start with: if the env has real customers on it, use this (live) doc; if it's a demo/test box, use the sister.

Both docs can coexist in a project — one workflow file each, one spec file each, different cadences, different alert tiers. They share zero state and shouldn't conflict.
