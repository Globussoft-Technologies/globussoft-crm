---
name: writing-cap-consumer-stub-client
description: Authors a new `backend/services/<vendor>Client.js` stub for a cred-blocked third-party integration. Use when a vendor API (RFU Zikr Cabs, Haramain Rail, Booking.com, AdsGPT, RateHawk, Callified, etc.) is on the roadmap but the credentials haven't landed yet — ship the API surface inert so downstream consumers (routes, frontend admin pages, cron engines) can be built end-to-end. Encodes the 8-instance recipe established across adsGptClient / ratehawkClient / callifiedClient / bookingExpediaClient / bookingCom / haramainRailClient / zikrCabsClient: INTEGRATION constant + BUDGET_CAP_KEY + DEFAULT_CAP_CENTS + checkBudgetCap with CJS self-mocking seam + provider-specific search/details/book methods + bookX() throws `XXX_NOT_YET_ENABLED` + 12+ vitest cases including one regression-pin for the seam. Future stubs clone this in ~30 min vs ~90 min from scratch.
---

# Writing a cap-consumer stub client

## When to use

A new third-party integration is on the roadmap but blocked on credentials, vendor partner approval, or a product-call decision. The downstream surface (a route handler, a frontend admin page, a cron consumer) needs the API to exist BEFORE the cred lands. Stub the client so:

- callers' contracts are pinned (test-mode envelope = real-mode envelope, modulo `stub: true` flag)
- the per-tenant cap pattern works from day 1 (budget enforcement, console.warns, spend logging)
- swap to real-mode is a one-file change at cred-land time

NOT this skill:
- a vendor-API client that's READY to be wired live (`stripeService.js`, `mailgun`, real Twilio) — those skip the stub layer
- a one-off integration with no caps + no budget tracking — overkill
- an internal service module — only stub external paid integrations

## Reference implementations — pick the closest

| Vendor shape | Reference | Why |
|---|---|---|
| Hotel search + book + room details | `backend/services/bookingCom.js` (`1ab0c096`) | Simplest 4-method shape: search / details / book / cap. Currency USD. |
| Transport (ground transfer, capacity tiers) | `backend/services/haramainRailClient.js` (`f261222d`) | Adds per-class capacity + currency SAR + deterministic hashOfArgs price seed |
| Transport with vehicle-class supplements | `backend/services/zikrCabsClient.js` (`7e3ca54a`) | Per-pax-supplement-pricing on capacity overshoot; sedan/van/minibus/bus tier ladder |
| AI / inference (per-call cost log) | `backend/services/adsGptClient.js`, `callifiedClient.js`, `ratehawkClient.js` | Cap consumer + LlmCallLog-style spend tracking |

Read the chosen reference end-to-end. Don't copy line-by-line; copy the SHAPE.

## The 7-block recipe (every cap-consumer stub client has these)

### 1. JSDoc header

```js
/**
 * <vendorName>Client — STUB MODE.
 *
 * Per Q<N> cred chase (CREDS_TRACKER.md): <one-line context — what cred is missing, who owns it>.
 * Until creds land, this module returns deterministic placeholder data so downstream
 * consumers (<list the routes/pages/crons that call this>) can be built + tested
 * end-to-end without external dependencies.
 *
 * Real-mode swap: replace the `// STUB:` block in each method with
 * `return realVendorCall(...)`. The envelope shape is IDENTICAL for stub + real
 * ({ stub: true|false, ... }) so consumers don't break on cutover.
 *
 * Pattern reference: bookingCom.js (1ab0c096) / haramainRailClient.js (f261222d).
 * Tick: <YYYY-MM-DD HH:MM UTC>. Cred block: Q<N>.
 */
```

### 2. Constants block (always at top of file)

```js
const INTEGRATION = 'vendor_slug';                        // snake_case slug, used in spend tracking + caps
const BUDGET_CAP_KEY = 'vendor_slug.monthly_cap_cents';   // tenantSettings key
const DEFAULT_CAP_CENTS = 30000;                           // tunable; pick based on expected per-tenant monthly spend
```

Defaults by category (empirical from shipped clients):
- LLM / AI inference: $100/mo (10000 cents)
- Hotel search (high call volume): $100/mo (10000 cents)
- Transport / ground (low call volume): $300/mo (30000 cents)
- HSR / rail (higher fare scale): $500/mo (50000 cents)
- Operator-facing premium APIs (Callified outbound): $200/mo (20000 cents)

### 3. Inline `getSetting` workaround

DO NOT extend `backend/services/tenantSettings.js`'s KEYS set during the stub phase. Inline a small `async function getSetting(tenantId, key)` that does `prisma.tenantSetting.findFirst({ where: { tenantId, key }})` directly. KEYS-set extension is a separate concern that lands when the real swap happens (and may need bless markers).

bookingCom.js + haramainRailClient.js + zikrCabsClient.js all follow this pattern.

### 4. The CJS self-mocking seam — non-negotiable

Inter-function calls within the module MUST go through `module.exports.fn(...)` not the local closure binding. Without this, `vi.spyOn(client, 'fn')` cannot intercept them — see CLAUDE.md 2026-05-24 cron-learning ("CJS self-mocking seam"), now at 8 confirmed instances.

```js
async function checkBudgetCap(tenantId, attemptedCostCents) {
  // CRITICAL: this MUST be module.exports.computeMonthlySpendCents
  // NOT a local-binding call to computeMonthlySpendCents directly.
  // vi.spyOn(client, 'computeMonthlySpendCents') only intercepts via the exports surface.
  const spent = await module.exports.computeMonthlySpendCents(tenantId);
  const cap = await module.exports.getBudgetCap(tenantId);
  const projected = spent + attemptedCostCents;
  if (projected >= cap) {
    const err = new Error(`${INTEGRATION} monthly cap exceeded`);
    err.code = `${INTEGRATION.toUpperCase()}_BUDGET_EXCEEDED`;
    err.spentCents = spent;
    err.capCents = cap;
    throw err;
  }
  if (projected >= cap * 0.8) {
    console.warn(`[${INTEGRATION}] tenant=${tenantId} spend at ${Math.round(100 * projected / cap)}% of cap`);
  }
}
```

### 5. Required exports (5 methods minimum)

Every cap-consumer stub exports at minimum:

- `isEnabledForTenant(tenantId)` — defaults true; honours `<slug>.disabled` setting
- `checkBudgetCap(tenantId, attemptedCostCents)` — throws on cap-breach; warns at 80%
- `computeMonthlySpendCents(tenantId)` — stub returns 0; real-mode reads from a spend log table
- One or more provider-specific search/details methods (e.g. `searchHotels`, `searchRoutes`, `searchTransfers`) — return deterministic placeholder data
- `bookX(...)` — throws `Error` with `.code = '<SLUG>_NOT_YET_ENABLED'` and message naming the cred block

Determinism in search results: use a tiny `hashOfArgs({ ...args })` function to seed price/availability so the same query returns the same shape (pinnable in tests).

### 6. Provider-specific shape — pick currency + units

Real-world matchings:
- Saudi domestic (HHR, Zikr): `currency: 'SAR'`
- Hotel global (Booking.com, RateHawk): `currency: 'USD'`
- India-domestic: `currency: 'INR'`

Pricing fields ALL in cents (Int), not floats — consistent with WalletTransaction + Invoice patterns across the codebase.

### 7. Test file (12+ vitest cases minimum)

`backend/test/services/<vendor>Client.test.js` mirrors the shape of `backend/test/services/bookingCom.test.js`:

- 2× `isEnabledForTenant` (default true; honours disabled flag)
- 3× `checkBudgetCap` (under-80 ok, 80-100 warns via console.warn spy, ≥100 throws with correct .code)
- 1× `computeMonthlySpendCents` returns 0 (stub)
- 3× search method (returns array, length matches expectations, deterministic for same args, correct currency)
- 1× details method returns expected shape
- 1× `bookX` throws with code `<SLUG>_NOT_YET_ENABLED`
- 1× **CJS self-mocking seam regression-pin** — `vi.spyOn(client, 'computeMonthlySpendCents').mockResolvedValue(999_999_999)` → `checkBudgetCap` with tiny attemptedCost throws because spend already at cap. **THIS TEST IS CRITICAL** — it pins the module.exports indirection.

Use `const client = require('../../services/<vendor>Client')` once at top of file. NOT a fresh `require()` per test — breaks the seam.

## File-disjoint dispatch pattern

Stub clients are file-isolated by design:
- ALLOWED files (NEW): `backend/services/<vendor>Client.js`, `backend/test/services/<vendor>Client.test.js`
- DO NOT TOUCH: schema.prisma, backend/services/tenantSettings.js, server.js, any route file

A new stub client = one commit, file-disjoint from any other parallel-agent work this tick. Perfect "Agent B backend chore" while Agent A does frontend work.

## Commit message template

```
feat(services/<vendor>Client): <Vendor> <category> stub for #<issue> (Phase 2 SHELL)

Q<N> cred-blocked (CREDS_TRACKER.md). Mirrors bookingCom.js (1ab0c096) /
haramainRailClient.js (f261222d) pattern: INTEGRATION + BUDGET_CAP_KEY +
DEFAULT_CAP_CENTS + CJS self-mocking seam + <N> vitest cases including
the seam regression-pin.

Exports:
- isEnabledForTenant(tenantId)
- checkBudgetCap(tenantId, attemptedCostCents) — throws <SLUG>_BUDGET_EXCEEDED at 100%, warns at 80%
- computeMonthlySpendCents(tenantId) — stub returns 0
- searchX / getXDetails — deterministic placeholder data
- bookX — throws <SLUG>_NOT_YET_ENABLED until cred swap

Real-mode swap is zero-change at this route's call site — envelope shape
matches across stub + real.

Tick #<N>. <N>/<N> vitest green.
```

NO `Co-Authored-By: Claude` trailer (global rule).

## Verification before push

```bash
cd backend
npx vitest run test/services/<vendor>Client.test.js   # all green
node --check services/<vendor>Client.js                # parses cleanly
npx eslint services/<vendor>Client.js test/services/<vendor>Client.test.js   # clean
```

The CJS seam test is the most important — if it fails, the module.exports indirection is wrong and future consumers can't mock the cap-check.

## Related

- `dispatching-parallel-agent-wave` — when this is one of N parallel agents
- `writing-vitest-unit-test` — vitest patterns for the test file
- CLAUDE.md cron-learning 2026-05-24 ("CJS self-mocking seam") — the underlying pattern; 8 confirmed instances
- `verifying-issue-before-pickup` — confirm the cred is genuinely blocked + the stub is needed BEFORE writing
