# Calendar Integration Gaps — Pickable Backlog

> **Audience:** any dev/agent picking up Google Calendar or Outlook work.
> **Snapshot date:** 2026-05-11
> **Source of truth:** [backend/routes/calendar_google.js](../backend/routes/calendar_google.js) (403 lines), [backend/routes/calendar_outlook.js](../backend/routes/calendar_outlook.js) (428 lines), [backend/prisma/schema.prisma:1609-1650](../backend/prisma/schema.prisma#L1609-L1650), [frontend/src/pages/CalendarSync.jsx](../frontend/src/pages/CalendarSync.jsx) (1,302 lines), specs at [e2e/tests/calendar_google.spec.js](../e2e/tests/calendar_google.spec.js) (7 tests) + [e2e/tests/calendar_outlook.spec.js](../e2e/tests/calendar_outlook.spec.js) (8 tests).
> **Companions:** [TODOS.md](../TODOS.md), [E2E_GAPS.md](E2E_GAPS.md), [PENDING_USER_AND_OPERATOR.md](PENDING_USER_AND_OPERATOR.md).

---

## What works today

| Capability | Google | Outlook |
|---|---|---|
| OAuth connect (`/connect` → `/callback`) | ✅ | ✅ |
| Token refresh on every API call | ✅ auto via SDK `tokens` event | ✅ manual `refreshTokenIfNeeded()` |
| `POST /sync` pull events into DB | ✅ last 30d + next 90d | ✅ next 90d only |
| `GET /events` list synced events | ✅ | ✅ |
| `POST /events` create event + persist | ✅ | ✅ |
| Past-time + overlap conflict rejection on POST | ✅ 409 / 400 | ✅ 409 / 400 |
| Online-meeting URL extraction | ✅ Meet (hangoutLink + conferenceData) | ✅ `onlineMeeting.joinUrl` |
| `DELETE /disconnect` | ✅ | ✅ |
| Multi-tenant scoping on `CalendarIntegration` + `CalendarEvent` | ✅ | ✅ |
| State CSRF defense on OAuth callback | ✅ base64 `{userId, tenantId, t}` envelope | 🟡 raw `userId` int (no timestamp) |

Mounted at `app.use("/api/calendar/google", ...)` + `app.use("/api/calendar/outlook", ...)` in [backend/server.js:512-513](../backend/server.js#L512-L513). Frontend lives at [frontend/src/pages/CalendarSync.jsx](../frontend/src/pages/CalendarSync.jsx).

---

## How to pick a task

1. Scan the **Priority backlog** below and grab the first unblocked card you can complete in your time window.
2. Read the card — it has the diagnosis, code references, fix sketch, and acceptance criteria.
3. Per [CLAUDE.md](../CLAUDE.md): every new `*-api.spec.js` MUST be wired into BOTH `deploy.yml` AND `coverage.yml` spec lists.
4. PR title format: `feat(calendar): <short>` or `fix(calendar): <short>`.
5. Mark the card ✅ in this file when merged (with commit SHA).

---

## Priority backlog (pick from top)

| ID | Title | Effort | Risk if skipped | Status |
|---|---|---|---|---|
| **CAL-1** | PUT/DELETE `/events/:id` on both providers — round-trip edits + cancels | 1-2 days | **High** — current state lets users edit events in the CRM that never reach the provider; the calendar diverges silently. | ⬜ open |
| **CAL-2** | Outlook backfill window — match Google's last-30d pull | 1-2h | Med — Outlook tenants see a partial history vs Google tenants for the same UI. Inconsistent product surface. | ⬜ open |
| **CAL-3** | Webhook subscriptions (Google push notifications + Graph subscriptions) — replace pull-only `/sync` polling | 3-5 days | Med — current poll-only path means changes made on phone / native app land in CRM only on the next `/sync` click. Worse UX, more provider quota burn under aggressive polling. | ⬜ open |
| **CAL-4** | Outlook state envelope hardening — match Google's base64-JSON `{userId, tenantId, t}` | 2-3h | Low-Med — current `state=${userId}` has no replay-window or tenantId binding. Not exploitable today but inconsistent defense-in-depth. | ⬜ open |
| **CAL-5** | Adopt `@microsoft/microsoft-graph-client` SDK for Outlook — replace raw `fetch()` for retry/throttling/pagination middleware | 4-6h | Low — current implementation works but hits Graph's 429 ceiling without backoff under load. | ⬜ open |
| **CAL-6** | E2E + vitest coverage extension — current 7 + 8 e2e tests don't exercise token-refresh, conflict 409, past-time 400, or `/events` POST sync-back-to-provider | 1 day | Med — provider integration is exactly the place silent regressions cost the most (broken sync surfaces hours later). | ⬜ open |
| **CAL-7** | Token encryption at rest — `CalendarIntegration.accessToken` / `.refreshToken` currently stored as plaintext `@db.Text` | 1 day | **High** for compliance posture — a DB leak surfaces every user's live Google + Outlook tokens. Material if pursuing SOC 2 / DPDP. | ⬜ open |

**Recommended first pickup:** CAL-7 (compliance posture) and CAL-1 (silent-divergence bug class) — both single-PR, no external dependency. CAL-3 is the biggest UX win but multi-day and needs operator buy-in for the webhook receiver URL.

---

## CAL-1 — PUT/DELETE `/events/:id` on both providers

**Diagnosis.** Both routes implement `POST /events` (create) but **no `PUT /events/:id` or `DELETE /events/:id`**. If a CRM user edits an event title, time, or attendees, the change either (a) updates only the local `CalendarEvent` row and silently drifts from the provider, or (b) is simply not surfaced in the UI because no edit endpoint exists.

**Why it matters.** Calendar integrations are tightly held to a "what I see in the CRM IS what the provider has" invariant. The current state breaks that invariant the moment any edit happens. Worse: a user who deletes an event in the CRM still has it scheduled on their calendar — they'll miss the implication and show up to a "canceled" meeting.

**Code references.**
- Create lives at [backend/routes/calendar_google.js:275-383](../backend/routes/calendar_google.js#L275-L383) (`router.post("/events", …)` calls `calendar.events.insert(…)` + upserts local row).
- Create lives at [backend/routes/calendar_outlook.js:290-412](../backend/routes/calendar_outlook.js#L290-L412) (`router.post("/events", …)` calls `POST ${GRAPH_BASE}/me/calendar/events` + upserts local row).
- **No matching `router.put(…)` or `router.delete(…)` on `/events/:id` in either file.**

**Fix sketch.**
1. Google: add `PUT /events/:id` calling `calendar.events.patch({ calendarId, eventId, requestBody })` + update local row. Add `DELETE /events/:id` calling `calendar.events.delete({ calendarId, eventId })` + delete local row.
2. Outlook: add `PUT /events/:id` calling `PATCH ${GRAPH_BASE}/me/calendar/events/${id}` with the changed fields + update local row. Add `DELETE /events/:id` calling `DELETE ${GRAPH_BASE}/me/calendar/events/${id}` + delete local row.
3. Both: re-run the past-time and overlap-conflict guards from the POST path so edits can't move an event into the past or into a conflict.
4. Both: emit `calendar.event_updated` / `calendar.event_deleted` events on the eventBus so workflows can subscribe.
5. Frontend: wire the existing edit/delete UI in `CalendarSync.jsx` to the new endpoints.

**Acceptance criteria.**
- `PUT /events/:id` on both providers returns 200 with the updated row; the change is verifiable in the provider's UI.
- `DELETE /events/:id` on both providers returns 204; the event disappears from the provider's UI.
- A round-trip test (POST → PUT → GET → confirm change → DELETE → GET → 404) passes in both `calendar_google.spec.js` and `calendar_outlook.spec.js`.
- The overlap-conflict guard is enforced on PUT (move-into-conflict → 409).

**Effort.** 1-2 days including specs and the frontend wire-up.

---

## CAL-2 — Outlook backfill window

**Diagnosis.** Google's `/sync` pulls `timeMin = now - 30d` to `timeMax = now + 90d`. Outlook's `/sync` pulls `start = now` to `end = now + 90d`. **Outlook never backfills past events.**

**Why it matters.** The CRM uses past events for activity timelines (e.g., "show me what I did with this contact last quarter"). Outlook users see a hole; Google users don't. Product UX inconsistency across providers.

**Code references.**
- Google's 30d back: [backend/routes/calendar_google.js:169-171](../backend/routes/calendar_google.js#L169-L171)
  ```js
  const now = Date.now();
  const timeMin = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString();
  ```
- Outlook's now-only: [backend/routes/calendar_outlook.js:177-179](../backend/routes/calendar_outlook.js#L177-L179)
  ```js
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + 90);
  ```

**Fix sketch.** Change `const start = new Date()` to `const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)` in `calendar_outlook.js:177`. The Graph `$filter` query already handles range correctly (lines 181-184). One-line change.

**Acceptance criteria.**
- Manual: connect an Outlook account with events in the last week, click Sync, see them appear in `GET /events`.
- Spec: add an assertion in `calendar_outlook.spec.js` that the request URL contains a `start/dateTime ge '<30d-ago>'` filter.

**Effort.** 1-2 hours including spec extension.

---

## CAL-3 — Webhook subscriptions (replace pull-only polling)

**Diagnosis.** Both routes only support pull-based sync via `POST /sync`. The CRM relies on the user manually clicking "Sync" (or a future cron poller). Events created on the user's phone or via the provider's native app land in the CRM only on the next sync click.

**Why it matters.** Modern calendar UX expects near-realtime mirroring. Polling at, say, 5 min intervals also burns provider API quota — Google Calendar has a daily 1M-request quota per project, Microsoft Graph has its own rate limits.

**Both providers support webhook subscriptions:**
- **Google:** `calendar.events.watch({ calendarId, requestBody: { id: <channelId>, type: 'web_hook', address: <publicUrl> } })` — Google POSTs to `<publicUrl>` whenever the calendar changes. Subscriptions expire after 7 days and need renewal.
- **Outlook:** `POST ${GRAPH_BASE}/subscriptions` with `{ changeType: 'created,updated,deleted', notificationUrl: <publicUrl>, resource: 'me/calendar/events', expirationDateTime: <ISO> }` — Graph POSTs to `<publicUrl>` on every change. Subscriptions expire after ~3 days and need renewal.

**Code references.**
- Only sync paths today: [backend/routes/calendar_google.js:159-242](../backend/routes/calendar_google.js#L159-L242), [backend/routes/calendar_outlook.js:160-257](../backend/routes/calendar_outlook.js#L160-L257).
- No `events.watch` or `/subscriptions` calls anywhere — verified via grep.

**Fix sketch.**
1. Add `POST /api/calendar/google/subscribe` + `POST /api/calendar/outlook/subscribe` — admin-gated. Persist channel/subscription ID + expiry to `CalendarIntegration` (add columns: `webhookChannelId String?`, `webhookExpiresAt DateTime?`).
2. Add `POST /api/calendar/google/webhook` + `POST /api/calendar/outlook/webhook` — **public** (no auth), but verify the `X-Goog-Channel-Id` / Outlook validation handshake. On notification, fire a partial sync for the affected user/event.
3. Add a daily cron (`webhookRenewalEngine`) to renew subscriptions before they expire.
4. The webhook receiver URLs need to be HTTPS and reachable from the public internet — coordinate with ops to add the routes to the Nginx allowlist if there's CSRF/rate-limit middleware that would otherwise reject unauth POSTs.

**Acceptance criteria.**
- Connect a Google account, run subscribe, edit an event in Google's web UI, see `CalendarEvent` row update in the CRM within ~10 seconds (no manual sync click).
- Same for Outlook.
- Subscription renewal cron extends the expiry without operator intervention.
- E2E spec mocks the webhook POST and asserts the upsert behavior.

**Effort.** 3-5 days. Most of the time is in (a) the webhook receiver security review (it's a public-no-auth endpoint, must be verified signed) and (b) renewal cron + failure handling.

**Operator dependency.** Public HTTPS URL must be reachable. If demo is firewalled, this needs a Cloudflare tunnel or similar.

---

## CAL-4 — Outlook state envelope hardening

**Diagnosis.** Google's OAuth state param is a base64-encoded JSON envelope: `encodeState({ userId, tenantId, t: Date.now() })` — see [backend/routes/calendar_google.js:89](../backend/routes/calendar_google.js#L89). Outlook's state is just the raw user ID: `state=${encodeURIComponent(userId)}` — see [backend/routes/calendar_outlook.js:77](../backend/routes/calendar_outlook.js#L77).

**Why it matters.**
- **No tenantId binding.** If a user belongs to multiple tenants (future, when `UserTenant` join table lands), the callback can't know which tenant the OAuth flow was started under.
- **No replay window.** A leaked state could be re-used indefinitely. Google's `t: Date.now()` lets a future check reject states older than N minutes.
- **Defense-in-depth inconsistency.** Two integrations, two state formats. The principle "do the same thing two ways" leaks.

**Fix sketch.**
1. Promote the `encodeState` / `decodeState` helpers from `calendar_google.js` to a shared module: `backend/lib/oauthState.js`.
2. Outlook: import and use the shared helpers. The callback at [calendar_outlook.js:92](../backend/routes/calendar_outlook.js#L92) becomes `const decoded = decodeState(state); const userId = decoded.userId; const tenantId = decoded.tenantId || 1;`.
3. Add a freshness check in `decodeState`: reject if `Date.now() - decoded.t > 10 * 60 * 1000` (10 min).

**Acceptance criteria.**
- Both `calendar_google.spec.js` and `calendar_outlook.spec.js` assert the connect URL's `state=` param decodes to `{userId, tenantId, t}` and a state older than 10 min is rejected.

**Effort.** 2-3 hours including the shared lib + spec assertions.

---

## CAL-5 — Adopt `@microsoft/microsoft-graph-client` SDK for Outlook

**Diagnosis.** [backend/routes/calendar_outlook.js](../backend/routes/calendar_outlook.js) uses raw `fetch()` for every Graph call. Token refresh, retry on 429, paginated `@odata.nextLink` traversal, and request batching are all hand-rolled or absent.

**Why it matters.**
- **No 429 backoff.** Graph returns 429 with a `Retry-After` header under load. Current code surfaces the 429 as a generic `502 "Graph fetch failed"`.
- **No paginated traversal.** Current sync uses `$top=250` and reads `data.value`. If the user has >250 events in the 90-day window, the tail is silently dropped (no `@odata.nextLink` follow).
- **Hand-rolled token refresh.** [refreshTokenIfNeeded](../backend/routes/calendar_outlook.js#L21-L61) duplicates what `@azure/msal-node` does already; bugs here are bugs no one else hits.

**Fix sketch.**
1. `npm install @microsoft/microsoft-graph-client @azure/msal-node`.
2. Replace the raw `fetch(TOKEN_URL, …)` token-exchange and `refreshTokenIfNeeded` with `ConfidentialClientApplication.acquireTokenByCode` / `acquireTokenByRefreshToken`.
3. Replace the raw `fetch(${GRAPH_BASE}/me/calendar/events, …)` calls with `Client.init(…).api('/me/calendar/events').get()` and iterate `@odata.nextLink` via the SDK's pagination helper.
4. The SDK's built-in retry middleware handles 429 backoff transparently.

**Acceptance criteria.**
- A user with 300+ events in the 90-day window sees all of them synced (current implementation drops events 251+).
- A 429 from Graph results in the SDK auto-retrying with `Retry-After` rather than surfacing 502 to the CRM.
- Spec extension covers the >250-events pagination case (mock-based).

**Effort.** 4-6 hours.

---

## CAL-6 — E2E + vitest coverage extension

**Diagnosis.** Current spec coverage is shallow:
- [e2e/tests/calendar_google.spec.js](../e2e/tests/calendar_google.spec.js) — 7 tests, mostly endpoint-existence smoke.
- [e2e/tests/calendar_outlook.spec.js](../e2e/tests/calendar_outlook.spec.js) — 8 tests, same.

**Untested branches found by grep + read:**
- Token refresh on expired access token (both providers).
- Conflict 409 on POST `/events` with overlapping time window.
- Past-time 400 on POST `/events` with `startTime < now`.
- `endTime <= startTime` 400.
- Meeting URL extraction from `hangoutLink` (Google) vs `conferenceData.entryPoints` (Google) vs `onlineMeeting.joinUrl` (Outlook).
- `/disconnect` idempotency — calling DELETE twice should both return 200, not 500 on the second.
- Cross-tenant isolation — a tenant A admin cannot read tenant B's `CalendarEvent` rows even by guessing IDs.

**Fix sketch.** Extend both spec files with the above branches. Mock the provider API responses where needed (use the pattern from [e2e/tests/cross-tenant-stripdangerous-api.spec.js](../e2e/tests/cross-tenant-stripdangerous-api.spec.js) for cross-tenant fingerprinting).

**Acceptance criteria.** Coverage on `calendar_google.js` and `calendar_outlook.js` reaches ≥80% lines via the vitest+e2e blend (currently ~40% per the last coverage report).

**Effort.** 1 day.

---

## CAL-7 — Token encryption at rest

**Diagnosis.** [backend/prisma/schema.prisma:1613-1614](../backend/prisma/schema.prisma#L1613-L1614):

```prisma
accessToken  String    @db.Text
refreshToken String?   @db.Text
```

Both stored as plaintext. A DB dump or backup leak surfaces **every** user's live Google + Outlook tokens, giving an attacker full read+write access to those calendars. Refresh tokens in particular are long-lived (until user revokes) and can be replayed indefinitely.

**Why it matters.** This is the highest-severity finding in this gap doc. Material for SOC 2 § CC6.1 (encryption of data at rest), DPDP § 8(1) (reasonable security practices), and any future enterprise customer due-diligence questionnaire.

**Code references.**
- Schema: [backend/prisma/schema.prisma:1610-1620](../backend/prisma/schema.prisma#L1610-L1620).
- Write callsites: [calendar_google.js:122-142](../backend/routes/calendar_google.js#L122-L142) (upsert on callback), [calendar_google.js:62-77](../backend/routes/calendar_google.js#L62-L77) (refresh-token persistence inside `client.on("tokens", …)`), [calendar_outlook.js:124-143](../backend/routes/calendar_outlook.js#L124-L143) (upsert on callback), [calendar_outlook.js:52-59](../backend/routes/calendar_outlook.js#L52-L59) (refresh-token persistence).
- Read callsites: [calendar_google.js:54-59](../backend/routes/calendar_google.js#L54-L59) (`client.setCredentials({ access_token: integration.accessToken, … })`), [calendar_outlook.js:188](../backend/routes/calendar_outlook.js#L188) (`Authorization: Bearer ${integration.accessToken}`).

**Fix sketch.** The repo already has [backend/lib/fieldEncryption.js](../backend/lib/fieldEncryption.js) — AES-256-GCM helper for patient PII fields, opt-in via `WELLNESS_FIELD_KEY` env var (per [CLAUDE.md "Libraries" section](../CLAUDE.md)). Pattern:

1. Add a `CALENDAR_TOKEN_KEY` env var (or reuse `WELLNESS_FIELD_KEY`).
2. Add an `encryptToken(plain)` / `decryptToken(stored)` pair to `fieldEncryption.js` (or a new `lib/tokenEncryption.js` if the wellness-field-key reuse is wrong scope).
3. At every WRITE site listed above, encrypt before passing to Prisma.
4. At every READ site, decrypt immediately after `findUnique`.
5. Add a migration: `npm run prisma migrate dev --name encrypt-calendar-tokens` adding a no-op schema bump + a one-shot data migration script that re-writes existing rows through the encryptor.

**Backwards compat.** Store encrypted values with a recognizable prefix (e.g. `ENC:v1:`) so the decrypt path can detect plaintext rows during the migration window and re-encrypt them lazily on next read. Match the existing wellness-field encryption envelope per `fieldEncryption.js`.

**Acceptance criteria.**
- A fresh `SELECT accessToken FROM CalendarIntegration LIMIT 1` query returns a `ENC:v1:` prefixed blob, not the JWT-shaped token.
- A connected user can still sync events end-to-end (decrypt path works).
- vitest in `backend/test/lib/tokenEncryption.test.js` covers round-trip + missing-key fail-closed + tampered-blob fail-closed.

**Effort.** 1 day including the data migration script.

---

## Not gaps — verified intentional

- **No SCIM or directory sync for calendar.** Each user connects their own account. Intentional — calendar access is per-user consent, not org-wide.
- **No support for shared / delegated calendars.** Both providers offer shared calendars (Google delegation, Outlook shared mailboxes); CRM scopes to the user's primary calendar via `calendarId: "primary"`. If a future enterprise customer asks, the schema already has `CalendarIntegration.calendarId` to extend cleanly.
- **No Exchange on-prem support.** Outlook integration speaks Graph (cloud only). On-prem Exchange would need a separate EWS-based path; explicitly out of scope per PRD §6.6.
- **Token-refresh persistence pattern.** Google uses an SDK event handler; Outlook uses a manual helper. Different mechanics, same outcome. Either approach is fine — CAL-5 unifies them via the SDK adoption.

---

## Footer

**Total estimated effort to close everything actionable:** ~3-4 dev-weeks if sequential, ~1.5 weeks if dispatched across 2-3 parallel engineers (CAL-3 webhook subscriptions is the only multi-day item; everything else is ≤1 day apiece).

**Recommended sequencing:**

1. **CAL-7 token encryption** (1 day, highest compliance leverage, no external dependency)
2. **CAL-1 PUT/DELETE events** (1-2 days, closes the silent-divergence bug class)
3. **CAL-2 Outlook backfill** (2h, trivial consistency win)
4. **CAL-4 state envelope** (2-3h, paired with CAL-1 since both touch both routes)
5. **CAL-6 spec coverage** (1 day, pairs with CAL-1's new endpoints)
6. **CAL-5 Graph SDK adoption** (4-6h, prerequisite for any future Outlook feature)
7. **CAL-3 webhook subscriptions** (3-5 days, requires operator coordination on public URL — file last)

**File this against:** an existing tracking issue or open a new one. Update this doc's status column on each close with the merge SHA.

**Last reviewed:** 2026-05-11.
