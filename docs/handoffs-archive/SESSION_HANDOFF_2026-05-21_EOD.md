# Session handoff — EOD 2026-05-21 → next morning

## TL;DR

Today's session shipped the **entire Phase 2 PRD §4.5 (customer dedup) +
§4.7 (Travel Stall family quiz + 50% advance booking) backbone**, end-to-end:

- Lead can take a public 5-Q quiz at `/travel-stall/quiz`, get classified, and
  the advisor sees the lead + diagnostic in the CRM.
- Advisor builds an itinerary, sends a shareToken URL.
- Lead visits `/trip/<shareToken>`, reviews the trip, pays 50% advance (demo
  mode — Razorpay/Stripe stub awaits Q9 / payment creds).
- Trip auto-flips to `advance_paid`; balance pay flips to `fully_paid`.
- Generic contacts intake also got the Phase 2 dedup preflight; the existing
  RFU passport-collision modal pattern now extends to all `POST /api/contacts`.

11 commits landed; 1 follow-up fix at end of day to unblock the api_tests
gate after the dedup preflight quite-reasonably regressed 3 tests that were
deliberately seeding duplicates as fixtures.

## First thing to do tomorrow

1. **Read [TODOS.md](../TODOS.md)** (especially the "🚧 KEY BLOCKERS" section
   at the top — nothing new added today, the cred-blocked list is stable).
2. **Check the latest CI gate run**:
   ```
   gh run list --branch main --limit 3 --json conclusion,workflowName,headSha
   ```
   The last green deploy was on `9e4de70`. Commits `8abf6f3` / `7912b79` /
   `2c0160f` went out with the same `api_tests` red root cause. Commit
   `4bd97f8` (last commit of the day) ships the fix.

   **If `4bd97f8`'s deploy.yml is green** → demo is current, pick from the
   menu below. **If it's still red** → check `field-permissions.spec.js:184` +
   `wellness-read-audit-api.spec.js:190` — both retry-passed yesterday so
   they're known flakes; anything else is a new regression and worth
   triaging via [.claude/skills/triaging-stuck-deploy-gate/SKILL.md](../.claude/skills/triaging-stuck-deploy-gate/SKILL.md).

3. **Smoke-check the demo** once green:
   - Public quiz: https://crm.globusdemos.com/travel-stall/quiz (anonymous, 5 Qs)
   - Public booking: https://crm.globusdemos.com/trip/&lt;shareToken&gt; (advisor
     needs to mint a `status=sent` Travel Stall itinerary first via the
     Itineraries page in the CRM).

## What shipped today (11 commits, in order)

| Commit  | Layer    | What                                                                |
| ------- | -------- | ------------------------------------------------------------------- |
| `2b2c042` | backend  | Passport-key dedup helper for RFU pilgrims (PRD §4.5)               |
| `79b62b6` | backend  | `findDuplicateContact` tenant-scoped + compound `email_tenantId` finder (long-standing bug from 2026-04-16) |
| `ea817fb` | backend  | RFU profile `/check-duplicate` preflight + passport-collision 409 on POST/PATCH |
| `106b7dc` | frontend | RfuCustomerProfile dup-passport modal — "Open that contact" / "Edit passport" |
| `1286a66` | backend  | Travel Stall Family Travel Quiz seed (5 Qs, 3 family-tier bands, idempotent re-seed) |
| `1260caa` | backend  | Public diagnostics endpoints (`GET /banks` + `POST /submit`); lead dedup via `findDuplicateContactFull` |
| `9e4de70` | frontend | Public Travel Stall Family Travel Quiz page at `/travel-stall/quiz` |
| `8abf6f3` | backend  | Itinerary schema: `advancePaidAmount` / `advancePaidAt` / `paymentReference` nullable additions; public GET + record-advance endpoints; status-enum extended to `advance_paid` / `fully_paid` |
| `7912b79` | frontend | Public trip booking page at `/trip/:shareToken` — state-machine CTAs (Pay 50% / Pay balance / Fully paid) |
| `2c0160f` | backend  | Generic contacts POST gets the same Phase 2 dedup preflight; `?force=true` bypass for legitimate dup-creates |
| `4bd97f8` | tests    | Unblock api_tests: 3 contacts-dup fixture tests now use `force:true`; travel-diagnostics submit test asserts the correct nested response shape |

Across all 11, **zero new schema migrations** that needed bless markers
(3 new nullable additive columns on Itinerary; migration_check passed cleanly).

## Phase 2 menu — pick one to continue with

Three independent threads, in rough order of value:

### A) Wire `recommendedTier` from the diagnostic into Itinerary creation
**Why**: closes the analytics loop. Right now the diagnostic computes a
persona and recommended tier, but the advisor's Trip create form doesn't
know about it. Pre-selecting `productTier` on the new Itinerary from the
lead's latest diagnostic means the advisor doesn't re-key it (and the
tier-vs-actual-itinerary analytics — PRD §6.4 — actually start working).

**Scope**: small-medium. Find latest diagnostic for `contactId` → pull
`recommendedTier` → default it on the Itinerary form. Likely a new
helper in `backend/lib/` + a frontend default-value plumbed through the
Itineraries.jsx form. 1 commit, 1 day.

### B) Tunable per-tenant advance ratio
**Why**: `ADVANCE_RATIO = 0.5` is currently hardcoded in
[routes/travel_itineraries.js](../backend/routes/travel_itineraries.js).
Travel Stall is 50/50 but RFU pilgrim packages typically split 30/70 or
40/60, and TMC school trips have their own instalment plan
(`TripPaymentPlan` model already). Move to `TenantSetting` table with
a default + per-sub-brand override.

**Scope**: small. Reads from `TenantSetting` keyed by
`(tenantId, 'travel.advanceRatio.<subBrand>')`, falls back to 0.5. 1 commit,
half a day.

### C) Frontend modal on Contacts.jsx consuming the new 409 DUPLICATE_CONTACT
**Why**: backend returns the rich 409 with `existingContactId / matchedBy /
contact` projection, but [Contacts.jsx](../frontend/src/pages/Contacts.jsx)
currently only catches it as a toast error. Adding the same modal pattern
we built for RFU (`106b7dc`) closes the visible UX loop for the generic
contacts page. Pop-up offers "Open existing", "Edit details", or
"Create anyway" (which POSTs with `?force=true`).

**Scope**: medium. Mirror the `DuplicatePassportModal` pattern in a generic
`DuplicateContactModal`. 1 commit + vitest.

### Less urgent but worth picking up at some point
- **Passport-key extension into marketplace_leads.js** — the marketplace
  ingestion path uses the basic `findDuplicateContact(email, phone, tenantId)`.
  Could upgrade to `findDuplicateContactFull` if marketplace leads ever start
  carrying passport metadata. Currently they don't, so this is speculative.
- **Wire the real Razorpay/Stripe SDK** into `TripBooking.jsx` once Q9 /
  payment-provider creds settle. Today's demo-mode `record-advance-payment`
  endpoint was designed so the swap is one line in the page's `payAdvance`
  handler — open the gateway widget, wait for success, then POST.

## Cred-blocked items (no change today)

Still waiting on Yasin / Rishu / counsel — see TODOS.md "🚧 KEY BLOCKERS"
table at top for the canonical list. The big four for Phase 2 wrap-up:

- **Wati BSP creds (Q9)** — needed for the dispatch stubs in
  `contactGreetingsEngine` / `travelDiagnosticAdvisorAlerts` /
  `tripPostTripFeedback` / `tripPaymentReminders` to actually send WhatsApp,
  AND to deliver the diagnostic PDF + advance-paid receipt to the lead.
- **Razorpay/Stripe creds** — `record-advance-payment` is demo-mode until
  the gateway webhook fires real charges. The route's body shape already
  mirrors what the webhook payload will look like, so the cutover is
  small.
- **Yasin's Q13 Travel Stall brand copy** — the v1 quiz bank seeded today
  is placeholder content. Final 5 Qs land via the admin POST flow without
  touching the seed (it auto-bumps version).
- **Yasin's Q22 brand assets** — page colours are placeholder navy +
  warm gold pending the real palette / logo / typography handover.

## CI gate status as of last push (`4bd97f8`)

At handoff time the deploy is still running. Expected result: **green** —
both regression fixes are in. Verify with `gh run list --branch main --limit 1`
on next session start.

If the `4bd97f8` gate is red for any reason other than the two known
pre-existing flakes, fall back to the standing rule:
*"if api_tests is red on 2+ consecutive pushes, drop everything and run
[.claude/skills/triaging-stuck-deploy-gate/SKILL.md](../.claude/skills/triaging-stuck-deploy-gate/SKILL.md)"*.

## Open notes for future-you

- Pre-existing test flakes spotted today (retry-passed, not regressions):
  `field-permissions.spec.js:184` (POST/PUT/DELETE round-trip) +
  `wellness-read-audit-api.spec.js:190` (VISIT_LIST_READ count + filters).
  Both already in the "known flake" mental list — left alone for now.
- The `findDuplicateContact(email, phone, tenantId)` signature is now
  required-tenantId. `marketplace_leads.js` is the only caller and was
  updated in `79b62b6`. Any future caller that grabs the bare 2-arg form
  from old commits will throw at runtime — the helper guards explicitly.

— end of day, 2026-05-21
