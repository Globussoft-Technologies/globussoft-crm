---
name: writing-bonus-prd
description: Authors a NEW `docs/PRD_<FEATURE>.md` for a multi-day or product-call-blocked feature. Use when an open issue (`[Gap]` / `[Zylu-Gap]` / `[Travel Gap]` / `[Bug]` with multi-piece scope) needs a design call before implementation can start, and writing the PRD makes the open questions explicit so the call can actually happen. Encodes the §1-§10 template + 4-7 DD + 5-7 OQ + MANUAL_CODING_BACKLOG D-cluster cross-ref shape that 12+ bonus PRDs followed across the 2026-05-24 → 2026-05-25 cron arc (Purchase Orders, Payment Gateway Config, IE Jobs, Integrations Hub, Tag Master, AI Chat History, Customer Segments, Staff Detail, Wallet Top-up, POS New Sale, POS Polymorphic Invoice, Mini Website). Saves ~15 min of structural decisions per PRD; ships a usable design-call surface.
---

# Writing a bonus PRD

## When to use

Open GitHub issue lists multi-step work that needs design alignment first. Typical triggers:

- `[Gap]` / `[Zylu-Gap]` / `[Travel Gap]` issues with multi-feature acceptance criteria
- `[Bug]` issues whose root cause is "we don't have model X yet"
- Multi-day items where the cron's "Refuse multi-day rebuilds" rule pushes PRD writing over implementation
- An autonomous cron tick where you need a file-disjoint Agent B to write a PRD while Agent A ships code

NOT this skill:
- Single-endpoint issues — those are P5 small-chore picks, ship code not a PRD
- Issues that ALREADY have a PRD (check `ls docs/PRD_*` first; common phantom-carry-over class)
- Items in the cron's official P3 list — those have a separate target-doc list and ship pattern

**PRDs are NEVER REJECTED for being incomplete** — they exist precisely to make incompleteness visible. If the design needs the user's product-call answer, write the PRD anyway with the question enumerated in §9.

## Template — the §1-§10 structure

Every bonus PRD ships with EXACTLY ten `## §<N>` sections. Verify with `grep -c '^## §' docs/PRD_<NAME>.md` → 10.

### §1 Background + source attribution

- Cite the GH issue body verbatim where it gives use cases / acceptance criteria
- Note today's state — what exists, what's missing, what's denormalized
- Cross-reference sibling PRDs (e.g. PRD_WALLET_TOPUP cites PRD_POS_NEW_SALE because WALLET_TOPUP is a payment method on a Sale)
- 1-3 paragraphs

### §2 Use cases (4-5)

- Concrete operator/user scenarios with specific quantities
- "ADMIN bulk-imports 500 patients from a CSV; sees row-by-row error report after the job runs" not "ADMIN imports patients"
- Each use case is 1-3 sentences; 4-5 total

### §3 Functional requirements (numbered 3.1, 3.2, ...)

- 7-10 numbered sub-bullets
- Each one a specific FEATURE not a vague capability
- Include endpoint paths, model names, page paths where applicable
- Include RBAC matrix as a sub-bullet (e.g. 3.8 "RBAC: USER reads own, MANAGER tenant-wide, ADMIN configures")

### §4 Non-functional

- Per-tenant scoping (call it out — every feature needs this)
- Performance constraints (index requirements, cache TTLs)
- Encryption / PII / audit posture
- Idempotency on writes (mirror payment-idempotency pattern)
- Migration plan if the model is new + needs backfill

### §5 Hand-over reqs / cred chase / design decisions / vendor docs

The DENSE section. List 4-7 design decisions as `DD-5.<N>` bullets:

```
- DD-5.1: <choice topic> — <option A vs option B> (recommend OPTION X — <reason>)
- DD-5.2: <choice topic> — <option A vs option B vs option C> (recommend OPTION Y)
- ...
- No cred chase  (if no external vendor)
   OR
- Cred chase: <vendor>'s <thing> — Yasin owes <docs/cred/keys>. Blocks §3.<N>.
```

Each DD has a recommended answer with a one-line reason. Recommendations are NOT decisions yet — they exist to anchor the product call. Mark DDs with a clear "HIGHEST LEVERAGE" tag if they cascade to many other decisions.

### §6 Acceptance criteria (5 testable bullets)

- "After implementation, X verifies via Y"
- Testable — each AC maps to a test case or operator-observable behaviour
- 5 is the right count — fewer is under-specified, more is design-by-AC

### §7 Out of scope

- Explicit "Phase 2" / "Phase 3" deferrals
- Things adjacent features might claim are part of this (preempts scope-creep in the design call)
- 4-6 bullets

### §8 Dependencies

- Existing Prisma models this feature builds on
- Existing routes / helpers
- Sibling PRDs (with file references)
- External services (with cred chase if any)

### §9 Open questions (5-7 questions for product call)

The most important section for the user. Each question:
- Specific enough to answer in <2 min during a product call
- Phrased "Q<N>: <topic> — <option A> or <option B>?" not "what should we do about X?"
- Where reasonable, append "(Affects Y)" so the user knows what else depends on the answer

### §10 Status snapshot

```markdown
## §10 Status snapshot

- Status: NOT STARTED (PRD draft only)
- Owner: TBD per product call
- Estimated effort post-design: <N>-<M> eng-days
- Cluster: MANUAL_CODING_BACKLOG.md cluster D — propose D<N>
- Blocks before implementation can start:
  - DD-5.<N> (one-line reminder)
  - DD-5.<N>
  - DD-5.<N>
- Sibling PRDs: <list>
```

## Length target — 350-700 lines

- 350 lines minimum: shorter often means §9 is under-cooked; revisit
- 700 lines maximum: longer often means §3 is design-by-spec; trim
- Tone calibration: read the most-recent bonus PRD (e.g. `docs/PRD_POS_POLYMORPHIC_INVOICE.md` at 577 lines) before writing yours

## MANUAL_CODING_BACKLOG.md cluster D-entry

Every bonus PRD adds a cluster entry under section D (or wherever's appropriate). Existing D-clusters from the 2026-05-24 → 2026-05-25 arc:

- D8: Purchase Orders (#847)
- D9: Payment Gateway Config (#848)
- D10: Import/Export Jobs (#850)
- D11: Integrations Hub (#858)
- D12: Tag Master (#857)
- D13: AI Chat History (#855)
- D14: Customer Segments (#856)
- D15: Staff Detail (#852)
- D16: Wallet Top-up (#788)
- D17: POS New Sale (#771)
- D18: POS Polymorphic Invoice (#775)
- D19: Mini Website (#809)

Next bonus = D20. Mirror the prose density of D17/D18 (the most recent siblings).

Each D-entry has:
- Header: `D<N>. <Feature> (#<issue>)`
- Labels: `<vertical>, <area>, <module>, multi-day-feature, <design-call-required-flag>`
- Why-manual prose (2-3 sentences on why this can't ship in a small chore)
- Slicing recommendation (slice 1, slice 2, ...)
- Blocks-before-impl list (cross-ref to the PRD's DDs + OQs)
- Cross-refs to sibling clusters
- Effort estimate

## File-disjoint dispatch pattern

PRD-writer is a perfect file-disjoint Agent B in a parallel-agent wave:
- ALLOWED files (NEW): `docs/PRD_<NAME>.md`
- ALLOWED files (MODIFY): `docs/MANUAL_CODING_BACKLOG.md`
- DO NOT TOUCH: backend/*, frontend/*, schema.prisma, any test file

Conflicts with: ANOTHER PRD-writer in the same tick (they'd both edit MANUAL_CODING_BACKLOG.md). Solution: one writes the cluster entry; the other writes a follow-up. Or stagger to consecutive ticks.

## Verification before commit

```bash
grep -c '^## §' docs/PRD_<NAME>.md     # must return 10
grep -c '^## ' docs/PRD_<NAME>.md      # higher than 10 is fine (sub-sections OK)
wc -l docs/PRD_<NAME>.md               # should land 350-700
```

Read a recent sibling PRD AFTER writing yours but BEFORE committing — tone-calibration check.

## Commit message template

```
docs(prd): <feature name> — <one-line scope> (#<issue>, D<N> — bonus PRD #<N>)

§1-§10 template. <N> design decisions, <N> open questions, <N>-day estimate
post-design. Adjacent to <sibling-PRD-1> / <sibling-PRD-2>.

3 most-blocking DDs:
- DD-5.<N> <topic> — <recommendation>
- DD-5.<N> <topic> — <recommendation>
- DD-5.<N> <topic> — <recommendation>

MANUAL_CODING_BACKLOG.md cluster D<N> added.
```

NO `Co-Authored-By: Claude` trailer (global rule).

## Anti-patterns

- **Don't write a PRD for an issue that already has one.** Check `ls docs/PRD_*` AND grep for the issue number across `docs/` first. Phantom-carry-over has cost ~30 min of agent budget per instance.
- **Don't ship a 200-line PRD.** It's almost certainly under-cooked in §3 + §9. The point of a PRD is to make implementation possible without further discovery; a thin §3 leaves implementation re-deriving requirements.
- **Don't ship a 1000-line PRD.** That's design-by-spec; the product call will get bogged down in irrelevant detail. Cap at ~700.
- **Don't recommend in §5 then leave §9 empty.** §5 recommendations are HYPOTHESES; §9 is where the user accepts/rejects them. Both exist.
- **Don't pre-decide DD-5.1.** Write it as a real choice the user makes. Recommendations help the user; pre-decisions block them.

## Related

- `dispatching-parallel-agent-wave` — pair with an Agent A scaffold/chore for file-disjoint balance
- `verifying-issue-before-pickup` — check existing PRDs before writing yours
- Existing PRDs (read for tone calibration): `docs/PRD_POS_POLYMORPHIC_INVOICE.md`, `docs/PRD_MINI_WEBSITE.md`, `docs/PRD_WALLET_TOPUP.md`
