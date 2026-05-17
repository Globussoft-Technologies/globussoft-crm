> Archived from TODOS.md on 2026-05-17 — this was the active session handoff at the time it was written. See [docs/handoffs-archive/README.md](README.md) for the archive convention.

## 🏁 NEXT-SESSION HANDOFF (2026-05-05 night — post-wave: deploy-gate unblock + 3 e2e-full failures pending re-test) — superseded above

**HEAD on origin/main:** `6f140bc` (spec-fixture fix that unblocks the deploy gate). Demo will catch up to `9abbafe`+ once the next deploy completes.

### Stuck-deploy-gate cleared (`6f140bc`)

After the 5-agent wave landed, the deploy gate went RED on every push for 4 consecutive commits (9abbafe → 51e8891 → 1ef4ba5 → cc1a0ca). Demo stuck at b180c4b for ~50 min. Root cause: Agent A's new `landing-page-upload-api.spec.js` had a wrong-field tenant-id capture (read `j.user.tenantId` instead of `j.tenant.id` — the response shape puts tenantId on `tenant.id`, not nested under `user`). Spec assertion `tenant-${genericTenantId}/` evaluated to `tenant-null/` against actual `tenant-1/`. Fixed in `6f140bc`.

**Triaged via `triaging-stuck-deploy-gate` skill — classification: spec-bad-fixture** (same bucket as the 940b4f0 wave's wellness-read-audit fix).

### e2e-full run `25344242416` final result: 3 of 4 shards green

Improved from 2/4 to 3/4 shards (vs pre-Agent-B). Shard 2 still has 3 failing specs:
- `landing-page-upload-api.spec.js:99` — same spec-fixture bug as above; closes with `6f140bc` once demo redeploys
- `landing-page-renderer.spec.js:147` — POST /p/:slug/submit. Was supposed to work post-Nginx-fix. May need investigation; could be CAPTCHA-related (Agent A's #451 work added optional Turnstile)
- `marketplace-leads.spec.js:115` — Agent B's bonus deduplication fix should have addressed this; may be a different code path or demo-state

**Next session: re-trigger e2e-full after `6f140bc` deploys.** If only landing-page-renderer + marketplace-leads remain failing post-deploy, those are real bugs to investigate. Both are in shard 2.

**UPDATE:** `6f140bc` deploy ✅ SUCCESS (demo restarted 21:50 UTC). Re-triggered e2e-full at run `25345786449` on `c2e733a`. Will report shard 2 result when run finishes (~15-20 min).

**UPDATE 2 (e2e-full run 25345786449 finished — 3 of 4 shards green):**
- ✅ Shard 1, 3 — green
- ❌ Shard 4 — `workflows-api.spec.js:279` (tenant-history leak check). **False positive** — assertion was count-based; background cron engines on demo wrote +6 generic-tenant audit rows in the test window. Fixed in `47e7a1d` to assert leak-specific (search for the wellness rule's id in generic's history) instead of count-equality.
- ❌ Shard 2 — 2 failures:
  - `landing-page-renderer.spec.js:147` POST /p/:slug/submit returned 500. **Real backend bug** — Contact upsert used `where: { email }` against a `@@unique([email, tenantId])` model; latent since the original landing-page module shipped, never hit production until #445 Nginx fix unblocked the route. Fixed in `36e554d` (composite-unique selector).
  - `landing-page-upload-api.spec.js:216` (5MB upload). Demo's Nginx returns 413 before the request reaches multer's 400. Both are valid rejection codes. Spec now accepts either. Fixed in `36e554d`.

**Re-trigger e2e-full after `36e554d` deploys — should be GREEN for the first time since v3.4.9** if these 3 fixes hold.

**UPDATE 3:** `36e554d` deploy ✅ SUCCESS (demo restarted 22:26 UTC). Re-triggered e2e-full at run `25347017296` on `3d9edfd`. ~15-20 min to result.

**UPDATE 4 (e2e-full run 25347017296 — 3 of 4 still, but DIFFERENT 3 failures):**
- ✅ Shards 1, 3 — green
- ❌ Shard 4 — `workflows-flow.spec.js:148` (Flow 1 — engine task didn't surface in 750ms on busy demo) + `workflows-flow.spec.js:271` (Flow 4 — broad-tagged-title leak detection false-positived on sibling-test contacts)
- ❌ Shard 2 — `email_scheduling.spec.js:205` (502 was HTML, but spec called res.json() unconditionally)

All 3 are **demo-state-sensitivity bugs in spec assertions**, not real backend bugs (the 36e554d run validated the ACTUAL bugs — Contact upsert composite-key + 5MB upload tolerance — were closed). Fixed in `d84b0d9`:
  - Flow 1 → 4× polling with 1.5s waits (was 2× with 750ms)
  - Flow 4 → leak detection narrowed to `tenantBContact.id` specifically
  - email_scheduling → branch on content-type: JSON path keeps envelope assertion, HTML path just confirms 502 status

**Re-trigger e2e-full after `d84b0d9` deploys.** If it goes green, that's the goal — first all-green release-validation since v3.4.9.

**UPDATE 5:** `d84b0d9` deploy ✅ SUCCESS. Re-triggered e2e-full at run `25348132618` on `c8bab33`. ~15-20 min to result. (3rd e2e-full re-trigger this session — prior runs progressively cleared categories of failure: backup-engine + migration-safety + workflows-api + landing-page upload/submit + email_scheduling/workflows-flow polling. If this one's green, we're done.)

**🎉 UPDATE 6 (e2e-full run 25348132618 — ALL 4 SHARDS GREEN):**
- ✅ Shard 1 — green
- ✅ Shard 2 — green
- ✅ Shard 3 — green
- ✅ Shard 4 — green
- ✅ scrub-demo + merge-reports — green

**First all-green e2e-full release-validation since v3.4.9.** The chronic-red arc that had been blocking the release-validation gate for the entire v3.4.10 → v3.4.11 doc-bump arc is now closed.

Total session arc to clear it (chronological):
1. `e72cd5c` — backup-engine-api `IS_LOCAL_STACK` guard
2. `e8cce09` — migration-safety `IS_LOCAL_STACK` guard
3. `9abbafe` (Agent A) — landing-page builder cluster (closed #446 #449 #450 #451; broke api_tests with new spec's tenant-id bug)
4. `cc1a0ca` (Agent B) — e2e Category 1 cleanup (eventbus, lead-scoring, email-threading, marketplace-leads)
5. `6f140bc` — landing-page-upload spec tenant-id fix (unblocked stuck deploy gate that had been red for 4 commits)
6. `47e7a1d` — workflows-api leak-specific assertion (was count-based, broke on demo background activity)
7. `36e554d` — Contact upsert composite-unique selector (real backend bug latent since landing-page module shipped, exposed by #445 Nginx fix) + 5MB upload status tolerance
8. `d84b0d9` — workflows-flow polling latency tolerance + Flow 4 contactId-specific leak detection + email_scheduling 502 HTML-body tolerance

8 commits across ~3 hours. The autonomous-fixable backlog is now genuinely empty.

---

