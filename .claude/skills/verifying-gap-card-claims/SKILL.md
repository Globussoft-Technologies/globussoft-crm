---
name: verifying-gap-card-claims
description: Pre-spec-authoring grep audit when implementing a regression-coverage card from docs/regression-coverage-backlog.md, docs/E2E_GAPS.md, or a similar gap card. Gap cards drift from actual code — action verbs, numerical bounds, error codes, field names, endpoint shapes, and format tokens often differ from what the card claims. Without this audit, the spec pins the gap card's hypothesis instead of the route's actual contract; the test passes today (good) and goes red the moment someone changes either side (bad signal). With it, every spec pins reality + documents drift in the commit body. Today's session logged 19 instances of drift across 14 waves; every single regression-coverage agent surfaced at least one drift item. Pattern is overwhelming.
---

# Verifying gap-card claims before spec authoring

## When to use

You're about to write a regression-coverage spec from one of these sources:
- `docs/regression-coverage-backlog.md` — the R-1..R-24 cards
- `docs/E2E_GAPS.md` — the G-1..G-25 cards
- A `gh issue view <num>` body that includes "Acceptance:" bullets
- Any "what the test should assert" framing that pre-dates the actual code

**Always run this audit before authoring the spec.** Skipping it costs ~25-90 min of agent time (today's average bisect cost across 19 drift instances).

NOT this skill: writing a brand-new spec for a route you wrote (you know the contract). Writing a spec from a fresh PR review (the PR diff IS the contract). Single-acceptance-point cards where there's nothing to drift on.

## Why this matters — 19 instances logged in one day

The 2026-05-07 cron-loop session shipped 24 regression-coverage backlog items via 14 dispatched agents. **Every agent surfaced at least one drift between the gap-card claim and the actual code.** Sample drift:

| Wave / Agent | Card claimed | Code reality |
|---|---|---|
| 4 / I (audit-coverage) | DELETE emits `*_DELETED` | Soft-delete emits `SOFT_DELETE`; INVOICE PATCH emits `INVOICE_UPDATE` |
| 6 / N (datetime) | TZ-label `IST` | CI Node ICU renders `GMT+5:30` |
| 8 / Q (services-api) | Price cap `1e7`, duration cap `1440` | Actual caps `5_000_000`, `720` |
| 10 / U (tasks-api) | Year range `1990..2100` | Route enforces `2000..2100` |
| 10 / V (report-schedules-api) | Code `PII_EXFIL_BLOCKED` | Route emits `EXTERNAL_RECIPIENT_FORBIDDEN` |
| 11 / X (orchestrator-api) | Status enum mixed-case | Lowercase: `pending/approved/rejected/snoozed` |
| 11 / W (sequences-authoring) | `status: 'DRAFT'` field | Schema is `isActive: Boolean`; no status enum |
| 11 / W | `{error, code, hint}` envelope | Route emits `{error, code}` only |
| 11 / W | Field `delay` | Field is `delayMinutes` |
| 12 / Z (reports-api) | Code `INVERTED_RANGE`, year `1900..9999` | Code `INVERTED_DATE_RANGE`, year `2000..2099` |

The common thread: **gap cards are written from the bug report's framing, not from grepping the code.** When a bug was filed, the reporter described what they observed; when the gap card was authored, that framing was preserved verbatim. Months later when the regression spec is implemented, the underlying code may have moved — different action verb, different cap, different envelope shape. The card stays stale unless explicitly refreshed.

## The audit (5 minutes, before opening the spec file)

### Step 1 — Read the card

Pull the acceptance points. For each one, identify what kind of claim it is:

- **Action verb** — e.g. "writeAudit emits `*_DELETED`"
- **Numerical bound** — e.g. "rejects price > 1e7"
- **Error code identifier** — e.g. "returns 400 with `PII_EXFIL_BLOCKED`"
- **Field name** — e.g. "step.delay accepts only numeric"
- **Endpoint shape** — e.g. "PUT /:id returns 4xx"
- **Format token** — e.g. "TZ label is `IST`"

### Step 2 — Grep the actual code per claim type

#### Action verb claims

```bash
# Find every writeAudit call to confirm the actual action string
grep -rn "writeAudit\(" backend/routes backend/lib backend/cron | head -30

# For a specific entity, narrow:
grep -rn "writeAudit('Patient'" backend/routes backend/lib backend/cron
grep -rn "writeAudit('Pipeline'" backend/routes backend/lib backend/cron
```

If the grep returns zero hits, that's a gap — file as a sub-issue and ship the test as gap-tracking ("asserts NO audit row exists today") that flips positive once emission lands. See Wave 4 Agent I's pattern in `e2e/tests/audit-coverage-api.spec.js`.

#### Numerical bound claims

```bash
# Read the route's validators / ensureNumberInRange / ensureDateInRange calls
grep -rn "ensureNumberInRange\|ensureDateInRange\|maxYear\|max:\s*[0-9]\|min:\s*[0-9]" backend/routes/<file>
```

If the route's bound is tighter than the card's bound, send BOTH values in the test (just-over-tighter + card's value). If the route's bound is looser, the card was being aspirational — pin the route's actual value with a comment "card said X, route is currently Y."

#### Error-code identifier claims

```bash
# Find every code: "..." emission in the route
grep -rn 'code:\s*"' backend/routes/<file>
```

Pin the actual emitted code, not the card's framing. Document drift in the spec header.

#### Field-name claims

```bash
# Read the Prisma schema for the model
grep -A 30 "^model <ModelName>" backend/prisma/schema.prisma
```

If the card says `step.delay` but the schema has `delayMinutes`, the card is stale.

#### Endpoint-shape claims

```bash
# Find the actual route registrations
grep -n "router\.\(get\|post\|put\|patch\|delete\)" backend/routes/<file>
```

If the card says "PUT /:id" but the route has only PATCH, the card is stale. Pin the actual verb.

#### Format-token claims (especially dates / TZ / locale)

This is the most environment-sensitive. Local-dev Node ICU may render `'IST'` while CI Node renders `'GMT+5:30'`. **Don't pin verbatim format tokens** — use regex-shape assertions:

```js
// BAD (will fail on CI ICU):
expect(rendered).toBe('2026-05-15 10:30 IST');

// GOOD:
expect(rendered).toMatch(/^2026-05-15 10:30 (IST|GMT\+5:30)$/);
// OR even better, assert the wall-clock prefix verbatim + label-presence via regex:
expect(rendered).toMatch(/^2026-05-15 10:30 \S+$/);
```

Probe CI's ICU output in advance via `node -e "console.log(new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Kolkata', timeZoneName: 'short'}).format(new Date()))"` on the runner.

### Step 3 — Document drift in the spec header

For every drift you found, add a one-line entry to the spec's header docstring:

```js
/**
 * Regression spec for backlog item #X.
 *
 * Gap-card-vs-reality drift documented:
 *   - Card said action `*_DELETED`; route emits `SOFT_DELETE` (this spec pins SOFT_DELETE).
 *   - Card said price cap > 1e7; route enforces 5_000_000. Spec sends both.
 *   - Card said field `delay`; schema has `delayMinutes`. Spec uses delayMinutes.
 */
```

This makes the drift visible to the next reader and prevents the next agent from making the same mistake.

### Step 4 — Reflect drift in the commit body

When you ship the spec:

```
test(area): regression-coverage-backlog #X — pin <N> acceptance points

Gap-card-vs-reality drift surfaced + documented in spec header:
  - Action verb: card SOFT_DELETE → reality *_DELETED
  - Numerical bound: card 1e7 → reality 5_000_000
  - Field name: card `delay` → reality `delayMinutes`

Spec pinned to actual code reality. When the route's contract changes
(e.g. a tighter cap lands), the spec breaks first — that's the
intent of regression coverage.
```

## Anti-patterns

- **"The card says X, my test asserts X"** — without verifying X is what the route emits. The most common failure mode. Cost: agent time × 19 instances logged.
- **"Update the card to match the code"** — wrong direction. Cards are historical; code is authoritative. Pin code reality, document drift in the SPEC, leave the card alone (the next regression spec author benefits from seeing both).
- **"Skip the test if there's drift"** — wrong. Pin reality + flag as gap-tracking if the card's claim is genuinely a missing-feature ("audit-row should exist but doesn't"). Don't silently drop the test.

## When verification reveals a real gap

If the card's claim describes behaviour that SHOULD exist but doesn't (e.g. "DELETE emits audit row" but no `writeAudit('X', 'DELETE'` exists in the route), you have two paths:

1. **Path A — Pin current absence as gap-tracking.** Spec asserts NO audit row appears. When the missing emission ships, flip the assertion. Used in audit-coverage-api spec for Pipeline (no writeAudit) and `/auth/logout` (no LOGOUT audit) — both later closed in dedicated commits.

2. **Path B — Implement the missing code alongside the spec.** If the gap is trivial (≤30 LOC), ship the implementation in the same commit. Six waves today shipped Path B inline; this is the now-default pattern. See `sizing-regression-coverage-dispatch` skill for sizing guidance.

Pick (a) when the missing code needs design discussion or is non-trivial; (b) when it's a one-line addition that mirrors an existing pattern.

## Related

- `executing-cross-route-shape-sweep` — for the upstream side: when the gap is "shape across N routes is inconsistent"
- `auditing-cross-cutting-spec-impact` — for the downstream side: spec audit BEFORE pushing
- `sizing-regression-coverage-dispatch` — for sizing the dispatch given expected backend gaps
- Reference commits: any of yesterday's regression-coverage commits (commits `83d2a88`, `db543af`, `fef51a6`, `c1c6075`, `8fd3283`, `663bd7c`, `bc838d9`, `0d152c3`, `3d5bbc6`, `ae913a9`, `b8f6f30`, `00438ef`) document drift in their bodies — read any one for the canonical pattern.