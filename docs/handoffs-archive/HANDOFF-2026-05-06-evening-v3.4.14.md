> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-06 evening — v3.4.14 SAME-DAY PEN-TEST RELEASE) — superseded above

**HEAD on origin/main:** `f0fd190` (e2e-full spec alignment). Tag `v3.4.14` was force-moved from `751ab58` → `f0fd190` after the original e2e-full caught stale 401-vs-403 + health-shape assertions. Re-run on `f0fd190` went **green** (run 25438206380); GitHub Release published as **Latest** at https://github.com/Globussoft-Technologies/globussoft-crm/releases/tag/v3.4.14.

### What v3.4.14 delivered

Same-day response to a pen-test sweep that filed 23 issues against v3.4.13. **22 shipped today across 22 commits + 3 spec alignments.** See [CHANGELOG.md](CHANGELOG.md#v3414--2026-05-06--pen-test-sweep-22-qa-issues-closed-in-one-day-crithighmediumlow) for the full entry. Headlines:

- **Privilege boundary close-out** across `/api/wellness/*`. **#527 + #533** (CRIT-02 + HI-04) added two named gates (`phiReadGate` 5-role, `phiWriteGate` 4-role) to 21 previously-ungated clinical routes. Cross-professional patient edits stay open by design (multi-doctor clinic semantics) — the existing audit log captures every cross-user UPDATE.
- **Canonical `{error, code}` envelope** — **#544** (MED-03) made the global server-level catch-all handler stamp every JSON failure with stable codes (`INVALID_JSON_BODY` 400, `PAYLOAD_TOO_LARGE` 413, `INTERNAL_ERROR` 500, `HTTP_<status>`). Symmetric per-route `{message:}` → `{error, code}` sweep for ~34 success-shape sites tracked as **#550** (separate coordinated PR).
- **#524 SendGrid /send-now observability** — refactored opaque 500 surface into 6 stable codes (`SCHEDULED_EMAIL_NOT_FOUND` / `ALREADY_SENT` / `EMAIL_PERSIST_FAILED` / `SENDGRID_NOT_CONFIGURED` / `SENDGRID_REJECTED` / `SEND_NOW_INTERNAL`) with sanitised `detail` so the **next** demo failure names the failing phase in the response — no more SSH round-trip to diagnose.
- **#534 cold-call list latency** — added `Patient @@index([tenantId, createdAt])` + `TreatmentPlan @@index([tenantId, startedAt])` to cover orderBy filesort. Converted 11 list/detail audit calls from `await writeAudit` to fire-and-forget `writeAudit().catch(...)`. Write paths still serial-await for audit durability.
- **#529 + #530 sidebar storm** — pen-test reported 390+ requests/2min on idle dashboard. **Pen-test diagnosis was wrong on every detail** (no retry logic in `fetchApi`, all three filter values accepted by backend). Real cause: AuthContext.Provider passed an inline value object + fresh `loginWithToken` every App render → Sidebar's `useCallback`/`useEffect` reran every parent render, firing 4 fetches + a fresh socket each cycle. Two-part fix: `useMemo` on AuthContext value + `refreshCounts` ref pattern in Sidebar with `user?.id` (primitive) as the dep.
- **#541 hourly demoHygieneEngine** — new cron purges `_QA_PROBE_*` / `E2E_FLOW_*` / `_E2E_*` / `E2E_WC_*` test residue from Patient / Pipeline / Currency / Territory / Chatbot tables, 24h safety window, P2003 (Patient FK Restrict) is logged + skipped. 9 vitest unit tests pin the WHERE-clause shape.
- **6 MEDIUM/LOW pen-test fixes** earlier in the session: #526 password-reset token leak + SendGrid plumbing · #527-partial admin-config writes · #528 stale JWT after logout · #537 RFC 7235 401-not-403 · #532+#535 JSON 404 · #539 DELETE /patients ADMIN-gated · #531 forgot-password rate-limit · #538 patient-name strip residual `<>` · #536 patient phone REQUIRED · #540 toast TTL · #548 shared `SEARCH_DEBOUNCE_MS = 300` · #543 health two-tier · #545 415 Content-Type · #546 audit-log on stripDangerous.

### Process learning this session

Two test cascades surfaced and got fixed:

1. **Mid-session per-push gate cascade** (commits #527 → #534, 5 reds) — `forgot-password.spec.js` had a UI test running in the API gate; `auth.test.js` mock res lacked `.set()` after the #537 WWW-Authenticate header addition; ci-smoke + wellness-clinical-api had stale assertions. **Established new rule**: run `npx vitest run` locally BEFORE pushing changes that touch `middleware/`, `auth.js`, or `server.js`. Surfaced and shipped in commits e0c9918 (UI-test guard), e8e0b08 (mock res.set), and 32cc3cb (three spec alignments).
2. **e2e-full release-validation cascade** — initial v3.4.14 tag at `751ab58` red on stale assertions in 7 specs (ship-readiness, signatures, wellness, wellness-real-user-journeys, portal-api, zapier, demo-health). Per-push gate's spec list doesn't include those — they only fire on tag push. **Pattern reinforced**: e2e-full surface needs the same standing-rule audit as per-push when shipping cross-cutting changes (auth shape / response envelope). Fixed in commit f0fd190 + force-moved tag.

### Carry-over for v3.4.15

| Item | Effort | Type |
|---|---|---|
| **#550** Per-route `{message:}` → `{error, code}` envelope sweep — 34 sites across 22 routes (one coordinated PR; partial-state worse than either consistent shape) | ~3-4h | Class fix |
| **#523** `responsive.css` 11 brittle inline-style attribute selectors → class-based (filed alongside v3.4.13) | ~2-3h | Small refactor |
| ~~**#534 follow-ups**~~ | ✅ resolved 2026-05-07 — full cold-call profile against demo found zero remaining >2s endpoints. fb719e6 fixed all 4 reported. [Comment](https://github.com/Globussoft-Technologies/globussoft-crm/issues/534#issuecomment-4391860457) | done | Perf |
| **#527 (the bigger half — wellness PHI per-record ownership)** — current fix gates ungated routes with role-based access. The "telecaller can read all clinical reads" + "professional can edit any patient" decisions are intentionally open per multi-doctor clinic semantics, but the pen-test report flagged this as a *concept* — needs a product call from Rishu to set actual policy | needs product call → ~1d | Bigger investigation |
| Demo SSH probe on **#524** — even with the new observable codes, the underlying SendGrid 500 on demo needs to actually reproduce so we know which `code` it surfaces. ~10 min ssh + curl | ~10m | Confirm |
| Apply #437 chip + 3-state empty pattern to `/payments` (#371-class), `/sequences`, `/calendar-sync` (carried over from v3.4.13) | ~1-2h per page | Class-fix extension |

### Three things to do first next session

1. **Read #524's first failed-on-demo response body** (now that the route emits stable codes) — the `code` + `detail` fields will name the failing phase. Ten-minute SSH probe replaces the previous "wait for QA repro."
2. **Pick #550 if you want a clean class-fix win** — pin the proposed shape with the user first (DELETE → 204 No Content vs `{status, code}` envelope), then sweep all 22 routes + their specs in one PR. The diff is mechanical once shape is settled.
3. **Pen-test re-run advisable** — 22 fixes shipped same-day; QA may want to verify the close-outs against the v3.4.14 demo. Particularly #527 + #533 (run pen-test's USER-JWT script against `/api/wellness/*`), #529/#530 (open DevTools and watch network for 60s), #524 (POST /send-now and check the response code).

### Skills inventory (10, unchanged)

`adding-admin-trigger-endpoint`, `applying-demo-ssh-config`, `bumping-version-docs`, `capturing-wave-findings`, `dispatching-parallel-agent-wave`, `reporting-agent-progress`, `triaging-stuck-deploy-gate`, `verifying-issue-before-pickup`, `wiring-spec-into-gate`, `writing-api-gate-spec`, `writing-vitest-unit-test`.

Earlier arc handoffs preserved below for cross-reference.

---

