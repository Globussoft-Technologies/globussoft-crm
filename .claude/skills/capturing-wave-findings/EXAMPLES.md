# Examples — capturing-wave-findings in practice

Concrete examples mapping real findings from prior waves to the
correct `capture.sh` invocation. Reference these when classifying
new findings.

---

## Example 1 — engine bug surfaced by a gate spec (real, v3.4.2 → v3.4.3)

**Finding from G-9 agent's report:**
> "While writing recurring-invoice-engine spec, found that the engine
> excludes status `VOID` but `routes/billing.js POST /invoices/:id/void`
> writes `VOIDED`. Engine will keep retrying voided invoices forever."

**Classification:** Type 1 (bug)

**Capture invocation:**
```bash
cat > /tmp/finding-410.md <<'EOF'
## Bug: recurringInvoiceEngine misses VOIDED invoices

`cron/recurringInvoiceEngine.js` filters out `Invoice.status === 'VOID'`
but `routes/billing.js POST /invoices/:id/void` writes `VOIDED`. Engine
will continue generating recurring children for voided parents.

**Reproduction:** create recurring invoice, hit `/void`, wait for next
engine tick — sees an invoice it thinks is still active.

**Suggested fix:** widen filter to `['VOID', 'VOIDED']`.

Surfaced by: G-9 spec at e2e/tests/recurring-invoice-api.spec.js
EOF

.claude/skills/capturing-wave-findings/capture.sh issue \
  --type bug \
  --title "recurringInvoiceEngine excludes VOID but routes write VOIDED" \
  --area cron \
  --severity P2 \
  --body-file /tmp/finding-410.md \
  --wave 12
```

**Outcome:** Issue #410 filed. TODOS.md "Long tail still open" gets:
`- https://github.com/.../410 — recurringInvoiceEngine excludes VOID but routes write VOIDED (P2)`

That's the entire trail — when a future agent picks up #410 from the
issue tracker, the body has the diagnosis + fix. When someone reading
TODOS.md in a future session asks "what's still open?", #410 is right
there.

---

## Example 2 — missing route surface forced a workaround (real, this session)

**Finding from G-20 wave 2 agent's report:**
> "tenant-isolation-api spec couldn't read workflow by id post-DELETE
> because routes/workflows.js has no GET /:id. Used list+filter
> workaround. Route should add GET /:id."

**Classification:** Type 2 (missing route surface, single route)

**Capture invocation:**
```bash
.claude/skills/capturing-wave-findings/capture.sh issue \
  --type contract-drift \
  --title "routes/workflows.js missing GET /:id" \
  --area routes \
  --severity P3 \
  --body-file /tmp/finding-418.md \
  --wave 14
```

**Outcome:** Issue #418 filed. The next wave (audit-followups) picks
it up and ships the GET /:id handler in commit `2eb7dbc`.

---

## Example 3 — cross-cutting route gap (hypothetical based on this session's #423)

**Finding from spec author:**
> "While writing email-threading-api spec, noticed that hitting
> `/email-threading/abc` (non-numeric :id) returns 500 with prisma
> stack trace instead of 404. Spot-checked 4 other routes — same
> behavior on /deals/abc, /tasks/xyz, /tickets/abc, /landing-pages/abc."

**Classification:** Type 3 (cross-cutting, ≥3 routes affected)

**Capture invocation:**
```bash
cat > /tmp/finding-G26.md <<'EOF'
## Backlog G-26: non-numeric :id sweep

5 routes confirmed; likely affects most numeric :id handlers across
102 routes. Each handler does `parseInt(id)` without validation, then
hands the NaN to Prisma which throws.

**Pattern fix:** middleware that validates `:id` against a regex and
returns 404 if non-numeric, mounted before route handlers.

**Affected (confirmed):**
- /api/email-threading/:id
- /api/deals/:id
- /api/tasks/:id
- /api/tickets/:id
- /api/landing-pages/:id

**Test plan:** spec hits each numeric-id route with `abc` and asserts
404, not 500. ~30 min once the middleware lands.

Surfaced by: email-threading-api spec author (R-4 batch)
EOF

.claude/skills/capturing-wave-findings/capture.sh backlog-row \
  --id G-26 \
  --title "non-numeric :id sweep — handlers crash on /resource/abc" \
  --effort 1d \
  --risk Med \
  --body-file /tmp/finding-G26.md
```

**Outcome:** New row in `docs/E2E_GAPS.md` priority backlog. Umbrella
issue filed. TODOS.md "Long tail" gets the link.

This is much better than 5 separate issues — the fix is one
middleware, not five separate handlers.

---

## Example 4 — spec shipped (the happy path)

**Finding from G-20 orchestrator at wave-3 close:**
> "Wave 3 shipped, 8 resources covered, 35 cross-tenant assertions added.
> Commit f4b4ebe. G-20 row should be marked ✅ shipped."

**Classification:** Type 4 (spec / coverage shipped)

**Capture invocation:**
```bash
.claude/skills/capturing-wave-findings/capture.sh spec-shipped \
  --gap-id G-20 \
  --commit f4b4ebe \
  --tests 93 \
  --note "3 waves; 29 resources; rename-on-cleanup pattern; surfaced #418/#419/#420"
```

**Outcome:** `docs/E2E_GAPS.md` G-20 row flips from `⬜ open` to
`✅ shipped (f4b4ebe — 93 tests; 3 waves; 29 resources; rename-on-cleanup pattern; surfaced #418/#419/#420)`.
A bullet appears under the in-progress CHANGELOG entry.

The next wave's planning sees G-20 ✅ at a glance — won't try to
duplicate it.

---

## Example 5 — standing-rule pattern (real, twice this session)

**Finding from orchestrator after observing 2 spec residue cleanups:**
> "Two waves in a row needed afterAll-cleanup commits AFTER the spec
> shipped (commits 02a4d1e + 967cbdc) because helper resources created
> in beforeAll weren't cleaned by RUN_TAG. Suggest adding a CLAUDE.md
> rule: every new spec MUST have afterAll cleanup, even if RUN_TAG
> covers it."

**Classification:** Type 5 (standing-rule pattern)

**Capture invocation:**
```bash
.claude/skills/capturing-wave-findings/capture.sh rule-proposal \
  --rule "every new e2e spec MUST end with an afterAll cleanup block, even when RUN_TAG-based naming is used" \
  --reason "RUN_TAG only covers test-CREATED rows; helper resources created in beforeAll (Locations, Tenants, etc.) leak across runs and pollute the demo box. Two waves needed cleanup follow-up commits." \
  --evidence "02a4d1e (wellness-clinical-api Location residue) + 967cbdc (wellness-journeys sessionStorage residue)"
```

**Outcome:** Proposal lands in TODOS.md under `🟡 Proposed standing-rule
additions (review before next session)`. The orchestrator/user reviews
in a follow-up session and, if confirmed, adds it to CLAUDE.md
"Standing rules for new code" in a separate commit.

This is intentional — `capture.sh` does NOT auto-edit CLAUDE.md.
Standing-rule changes need human review because they constrain ALL
future work.

---

## End-of-wave routine (orchestrator)

After the parallel wave finishes:

```bash
# Pseudo — collate findings from agents into a wave-N-findings.md
# scratch file. Then for each finding:

# 1. Bug — file issue
.claude/skills/capturing-wave-findings/capture.sh issue \
  --type bug --title "..." --severity P2 --body-file /tmp/f1.md --wave 15

# 2. Drift — file issue
.claude/skills/capturing-wave-findings/capture.sh issue \
  --type contract-drift --title "..." --severity P3 --body-file /tmp/f2.md --wave 15

# 3. Spec shipped — mark and bullet
.claude/skills/capturing-wave-findings/capture.sh spec-shipped \
  --gap-id G-15 --commit abc1234 --tests 14 --note "..."

# Then:
git add TODOS.md docs/E2E_GAPS.md CHANGELOG.md
git commit -m "docs(findings): wave 15 capture — 2 issues filed, 1 backlog row updated"
git push
```

Single commit per wave. Findings durable. Next wave starts with a
complete picture.
