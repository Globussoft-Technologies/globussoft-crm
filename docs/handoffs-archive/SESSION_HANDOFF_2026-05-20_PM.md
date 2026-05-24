# Session handover — 2026-05-20 PM

Read top-down. Picks up where the morning's autonomous Travel-CRM build
([TRAVEL_CRM_SESSION_HANDOFF_2026-05-20.md](TRAVEL_CRM_SESSION_HANDOFF_2026-05-20.md))
left off.

## TL;DR

Two ships landed cleanly. Repo is on `main` at `006af71`, working tree
clean, all CI gates green, demo deployed. Cron queue emptied for the
office session.

## What shipped this session

Five commits, in chronological order:

| Commit | Why |
|---|---|
| `003394f` | **fix(e2e): /Demo Admin/i strict-mode disambiguation.** Travel vertical (v3.9.0) added a "Travel Stall — Demo" quick-login section with its own "Demo Admin" button (admin@travelstall.demo). That broke `getByRole('button', { name: /Demo Admin/i })` in `loginAsWellnessAdmin` — now resolves to 2 elements → Playwright strict-mode violation → 9 wellness UI tests cascaded red on e2e-full run 26135573349. Fix tightens the regex to `/Demo Admin\s+admin@wellness/i` in `wellness-ui-flows.spec.js` + `wellness-deep.spec.js`. |
| `2840d46` | **feat(travel): CSV import/export (v3.9.1).** New endpoints `/api/travel/cost-master/{export,import}.csv` + `/api/travel/diagnostic-banks/{export,import}.csv`. Mirrors the `routes/csv_io.js` pattern but adds the travel-vertical + sub-brand guards. Closes the Phase 1.5 polish-list item 10. New file `backend/routes/travel_csv_io.js`, new gate spec `e2e/tests/travel-csv-io-api.spec.js` (12 cases, wired into both `deploy.yml` + `coverage.yml`). Frontend Export/Import buttons on `CostMaster.jsx` + `DiagnosticBuilder.jsx`. Bumped `backend/package.json` 3.8.3 → 3.9.1. |
| `012f066` | **fix(travel-csv): exempt 2 new endpoints from the global 415 guard.** [server.js:262](../backend/server.js#L262)'s `CONTENT_TYPE_GUARD_EXCLUDE_PREFIXES` only listed `/api/csv/` — POSTs to the new travel CSV imports got 415 before `verifyToken` ran. Added `/api/travel/cost-master/import.csv` + `/api/travel/diagnostic-banks/import.csv` to the allowlist. |
| `4bf6739` | **fix(travel-csv): mount CSV routes before CRUD to avoid /:id collision.** `GET /api/travel/cost-master/export.csv` was being caught by the older `/cost-master/:id` handler in `routes/travel_cost_master.js` — `parseInt("export.csv", 10) → NaN → 400 INVALID_ID` before `travel_csv_io.js`'s export handler could fire. Same shape for `diagnostic-banks/export.csv` vs `:id`. Reordered the `app.use("/api/travel", …)` block so `travelCsvIoRoutes` mounts FIRST. |
| `006af71` | **fix(travel-csv): MANAGER role assertion uses real seeded MANAGER.** `admin@travelstall.demo` is seeded as ADMIN (the "Demo Admin" label was misleading); the real MANAGER on the travel tenant is `tmc-ops@travelstall.demo` ([seed-travel.js:86-87](../backend/prisma/seed-travel.js#L86-L87)). Spec line 308 expected 403 but the ADMIN account got 200. |

Net effect:
- Wellness UI regression (1 commit) fixed → e2e-full release validation went green.
- Travel CSV ship (1 feat + 3 follow-up fixes) lands as v3.9.1 in production.
- The 3 follow-up fixes each addressed a **different** root cause (env-config, route ordering, test-fixture mismatch) — not "the same bug 3 times." Each fix advanced the spec further; the chain is the value, not the count.

## CI / demo state right now

| Gate | Run | Conclusion | Commit |
|---|---|---|---|
| e2e-full release validation | `26160632529` | ✅ success | `003394f` |
| deploy.yml (per-push) | `26165083140` | ✅ success | `006af71` |

Demo is live on `006af71` at https://crm.globusdemos.com.

## Open items — pick up next

### Top of pile (do these first)

1. **R11 infra-handover call** with Travel Stall ops — schedule for W0. On-prem decision from Q6 adds W0-W1 work not in 6-week scope. Need SSH bastion / DNS API / backup strategy / DR targets in writing before any deploy pipeline tunes. Risk goes 🔴→🟡 once scoped.

2. **Yasin's Section 13 deliverables** — 9 items on the [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) "What Yasin owes GS now" checklist. Biggest single unlock is real diagnostic Q-sets (Q13) — the placeholder content in `seed-travel.js` needs to be replaced. Now that CSV import is live (this session's ship), Yasin can hand over Q-sets as CSV files instead of JSON-pasted-into-textarea.

3. **Aadhaar consent legal copy** (Q2) — GS owes Travel Stall. Draft against Aadhaar Act §29 + DPDP Act → counsel review → ship in Phase 1. ~½ day of legal work.

### Medium leverage (blocked on creds)

4. **DigiLocker wiring** once Travel Stall shares partner creds (Q3). Aadhaar OCR path goes live; until then `TripParticipant.aadhaarTokenId` stays null.

5. **Wati BSP provisioning** for the 3 WABAs (Q9). Needs Meta Business Manager access. ~1 day per WABA after access arrives.

6. **Microsite OTP flow** (Day 11.5) — `POST /microsites/public/:uuid/request-otp` + `/verify-otp` + gated `/full` read. ~4 hours once SMS provider creds land.

7. **Reminder cron** for `TripInstalmentPayment` instalments — fires WhatsApp/SMS reminder at `dueDate - reminderDays`. ~3 hours, same SMS dep as item 6.

### Phase 1.5 polish (no blockers — low urgency)

8. **Frontend visual builders** replacing the JSON-paste / API-only flows:
   - Diagnostic Q-set visual builder (drag-add questions, per-question option editor, scoring weights)
   - Rooming visual builder (drag-and-drop participant → room)
   - Payment-plan timeline builder
   - Inline microsite editor with rich-text + image upload
   - Seasons + markup rules admin UI

9. **Brand-asset swap** once Yasin shares the design pack (Q22). Replace placeholder navy `#122647` + warm gold `#C89A4E` in `frontend/src/theme/travel.css`.

10. ~~CSV import for cost-master + diagnostic banks~~ ✅ **Shipped this session (v3.9.1)**.

### Phase 3 (intentionally out of Phase 1 scope)

- **Visa Sure** (`VisaApplication`, `VisaDocumentChecklistItem`) — schema present, no routes/UI. Q18 puts this in Phase 3. Reopening needs a conversation with Yasin.
- **Web check-in Chrome extension** — separate repo at `flight-plugin/` per PRD §7.2. Needs Manifest V3 build + per-airline DOM adapters.

## Watchpoints / non-obvious things from this session

- **Wellness `/Demo Admin/i` regex pattern is now anchored on `admin@wellness`** in 5 spots across 2 spec files. If anyone re-adds a third tenant section with a "Demo Admin" label, the regex doesn't disambiguate further — they need their own anchor. `wellness-a11y.spec.js:74` uses `.first()` and works only because the wellness section renders before travel in DOM order; if that order changes, that test breaks.

- **Travel route precedence is now load-bearing.** `travelCsvIoRoutes` MUST mount BEFORE the CRUD route files in [server.js:621-632](../backend/server.js#L621-L632) because `/cost-master/:id` and `/diagnostic-banks/:id` capture greedy on the literal export.csv paths otherwise. Any new travel route file with `:id` route params needs to land AFTER `travelCsvIoRoutes` to preserve the precedence.

- **Demo accounts have misleading labels.** `admin@travelstall.demo` is labeled "Demo Admin" on the login page but is actually a real ADMIN role in the seed. The MANAGER on the travel tenant is `tmc-ops@travelstall.demo`. Same convention for wellness: `admin@wellness.demo` is ADMIN, `user@wellness.demo` is USER. Don't infer role from the label.

- **Global 415 content-type guard at [server.js:263-277](../backend/server.js#L263-L277)** rejects unsupported MIME types before routes run, with an allowlist (`CONTENT_TYPE_GUARD_EXCLUDE_PREFIXES`). Any new endpoint accepting `text/csv` or similar must add its path prefix to the allowlist OR use multipart-form. Symptom of the miss is "401-expected test sees 415" — same shape that bit `travel-csv-io-api.spec.js:106` in `2840d46`.

- **v3.9.0 (the morning autonomous ship) forgot to bump `backend/package.json`.** It was at 3.8.3 even though CHANGELOG said v3.9.0. `/api/health.version` was reading the stale value. Bumped to 3.9.1 this session along with the CSV ship.

## Cron status

All 11 in-session cron jobs deleted. Queue is empty. No autonomous follow-up
will fire while you're at the office unless you re-create one.

## Useful URLs

- Demo: https://crm.globusdemos.com (currently on `006af71`)
- e2e-full last green: https://github.com/Globussoft-Technologies/globussoft-crm/actions/runs/26160632529
- v3.9.1 deploy last green: https://github.com/Globussoft-Technologies/globussoft-crm/actions/runs/26165083140
- Travel CRM PRD: [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md)
- Open questions for Yasin: [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md)
- Risks ledger: [TRAVEL_CRM_RISKS.md](TRAVEL_CRM_RISKS.md)
