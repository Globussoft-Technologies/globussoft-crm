> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-04 — wave 18, v3.4.6 release candidate) — superseded above

**HEAD on origin/main:** `4ec8873`. Per-push gate ✅ GREEN. Live on demo. **6 commits since v3.4.5** (`0e5d574`); ~3,437 tests on every push; 5 mandatory deploy gates.

### Why this session

User asked: "spin up multiple agents to finish what's left. Use the skills." Wave 18 dispatched 4 disjoint-file agents (I/J/K/L) closing the parallelizable single-day items remaining after v3.4.5. Multi-day items (T2.2 audit-log middleware, G-21 frontend RTL setup) were deliberately deferred — they need real planning, not parallel-agent dispatch.

### What shipped this session (6 commits, all CI-green)

**Wave 18 (4 agents, all clean — no healing required):**

| Commit | What | Closes |
|---|---|---|
| `227b445` | **#413 batch 2** — 10 more `@relation` (auth: RevokedToken/ScimToken/SsoConfig; integration: Pipeline/Playbook/BookingPage; RBAC/compliance/sandbox: FieldPermission/RetentionPolicy/ApprovalRequest/SandboxSnapshot). Drift 39 → 29. All `onDelete: Cascade`. | (#413 stays open — 29 left) |
| `1a51fe6` | **#425 G-23 allowlist** — `[allow-unique]` / `[allow-drop]` / `[allow-not-null]` / `[allow-narrow]` commit-message markers. 16 vitest + 4 playwright tests covering cross-class isolation. | #425 |
| `561ab6b` + `5a18291` | **G-18 wellness-reports-api** — 76 tests / 20.3s. 12 endpoints (4 JSON + 8 export); CSV/PDF contract pinning. Zero drift. | G-18 |
| `54b1ff1` + `4ec8873` | **G-17 wellness-dashboard-api** — 40 tests / 14.4s. 5 endpoints; full-shape pin + state-machine for recommendations approve/reject. Zero drift. | G-17 |

### Issues closed this session
✅ #425 G-23 migration-safety allowlist (commit `1a51fe6`)

### Per-push gate state (post this session)

**~69 specs / ~2,442 tests + 37 vitest files / 995 unit tests = ~3,437 tests on every push** (+4% vs v3.4.5). All 5 mandatory deploy gates green at HEAD `4ec8873`.

### Three things to do first next session

1. **Tag v3.4.6** — `git tag -a v3.4.6 -m "..."` + push tag. Fires e2e-full release-validation against demo.

2. **#413 batch 3** (~1h) — calendar + scheduled-email cluster: CalendarIntegration, CalendarEvent, ScheduledEmail, Booking. Plus 6 more from the remaining 25. Drift would drop 29 → 19.

3. **PlaybookProgress audit** (~2h, planning + 1 commit) — has `@@unique([dealId, playbookId])` with "tenantId is implicit via dealId" docstring. Decide: defensive @relation+tenantId on key, or test+document the dealId-implies-tenantId invariant. Was deliberately skipped in #413 batch 2.

### Long tail still open

| Item | Effort | Status |
|---|---|---|
| **G-21** Frontend vitest + RTL setup + first 5 component tests | 3-5 days | ⬜ open — multi-day project; needs library/runner-config decisions; **NOT parallel-agent dispatchable** |
| **#413** remaining 29 models without `tenant Tenant @relation` | 3 batches × 1h | partial — batches 1+2 done (20 of 49); batch 3 next |
| **T2.2** Audit-log middleware build-out (Patient/Visit/Rx/Consent) | 4-5 days | ⬜ open — wellness compliance work; needs schema decisions; **NOT parallel-agent dispatchable** |
| **T2.3** Ship P1 of regression backlog | varies | ⬜ open |

**E2E_GAPS.md status**: only G-21 remains open. Every other G-XX row from G-1 through G-25 is now ✅ shipped.

**Estimate to fully empty TODOS**: G-21 alone is 3-5 days; T2.2 is 4-5 days; #413 batches finish in another ~3h. Total ~2 calendar weeks of focused work. Single-wave parallelization will not get to zero.

**Recommendation for next session:** spend a half-day knocking off #413 batch 3 + the PlaybookProgress audit (~3h total), then start the G-21 frontend RTL setup as a dedicated multi-day project (NOT a parallel-agent wave).

---

