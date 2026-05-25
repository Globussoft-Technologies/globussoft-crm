# DigiLocker integration — Travel CRM spec

**Status:** SPEC — wiring is cred-blocked on Q3 ("DigiLocker partner
credentials" per [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md)).
This document is the engineering blueprint the implementation PR
follows once the partner creds arrive from Travel Stall.

**Scope:** Aadhaar offline-KYC + masked-last-4 storage for TMC trip
participants (PRD §4.5 / §4.7), per the consent draft at
[TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md).
RFU pilgrim Aadhaar flow follows the same pattern with a different
downstream consumer (Hajj Committee API instead of guardian-
notification).

---

## 1. Why DigiLocker (not direct Aadhaar OCR)

Per PRD §4.5 / Q3, Travel Stall opted for DigiLocker over direct
Aadhaar OCR because:

- **Aadhaar Act §29 risk** — direct OCR + storage of the unmasked
  Aadhaar number requires UIDAI authorisation (Section 4 of the Act).
  DigiLocker's offline-KYC path bypasses this entirely: Travel Stall
  receives a **signed XML reference token** from DigiLocker, not the
  raw Aadhaar number.
- **No biometric surface** — DigiLocker authenticates the user
  upstream; Travel Stall never collects fingerprint / iris / face.
- **Government-issued provenance** — the XML token is signed by
  UIDAI's DigiLocker service, so downstream consumers (Hajj
  Committee, airline check-in) can verify the ID was Aadhaar-anchored
  without Travel Stall ever holding the full number.
- **Compliance ceiling** — masked-last-4 + signed-token is the
  minimum collection that satisfies the downstream verification need
  AND DPDP §8 (data minimisation).

## 2. High-level flow

```
Parent / participant                Travel Stall CRM             DigiLocker
─────────────────────              ──────────────────             ──────────
1. Clicks "Verify Aadhaar"
   on microsite registration  →   POST /verify/aadhaar/start
                                  (creates DigilockerSession)
                                  Returns 302 redirect URL  →    OAuth-style
                                                                  authorise endpoint
                                                                  (state=<session.id>)

2. Sees DigiLocker consent
   screen, taps Approve     →                                ←   redirect to
                                                                  TS callback URL with
                                                                  ?code=<auth_code>

3. Sees TS "Verified ✓"
   on microsite             ←   POST /verify/aadhaar/callback
                                  Exchanges code → token,
                                  pulls offline-KYC XML,
                                  parses last-4 + name + DOB,
                                  stores TripParticipant.{aadhaarLast4,
                                  aadhaarTokenId, aadhaarVerifiedAt}
                                  Creates ConsentRecord row.
```

Two endpoints on the Travel Stall side. Both unauthenticated (parent-
facing) but session-bound and rate-limited.

## 3. New routes (to be added to `routes/travel_microsites.js`)

### 3.1 POST `/microsites/public/:publicUuid/verify/aadhaar/start`

**Request body:**
```json
{
  "participantId": 123,
  "consentRecordId": 456
}
```

**Pre-conditions:**
- `:publicUuid` resolves to a non-expired `TripMicrosite`.
- `participantId` belongs to the trip the microsite is for.
- `consentRecordId` is in `granted` state (consent screen was clicked
  through — see [TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md)).
- No active DigiLocker session for the same `participantId` in the
  last 5 minutes (replay guard).

**Response (201):**
```json
{
  "sessionId": "dl-session-<uuid>",
  "authoriseUrl": "https://api.digitallocker.gov.in/public/oauth2/1/authorize?client_id=<TS_CLIENT_ID>&response_type=code&redirect_uri=https%3A%2F%2Fcrm.globusdemos.com%2Fapi%2Ftravel%2Fmicrosites%2Fpublic%2F<publicUuid>%2Fverify%2Faadhaar%2Fcallback&state=<sessionId>",
  "expiresAt": "2026-09-12T14:35:00Z"
}
```

**Side-effect:** creates a `DigilockerSession` row (new model, see §5)
with `status='initiated'` and a 10-minute `expiresAt`.

**Errors:**
- 400 `INVALID_UUID`
- 400 `MISSING_FIELDS`
- 404 `PARTICIPANT_NOT_FOUND`
- 409 `SESSION_IN_FLIGHT` — replay guard
- 410 `MICROSITE_GONE`
- 503 `DIGILOCKER_UNREACHABLE` — DigiLocker API down

### 3.2 GET `/microsites/public/:publicUuid/verify/aadhaar/callback`

**Query string** (sent by DigiLocker on user-approve):
```
?code=<auth_code>&state=<sessionId>
```

**Server actions:**
1. Validate `state` resolves to an `initiated` DigilockerSession that
   isn't expired and matches `:publicUuid`.
2. Exchange `code` for an access token via DigiLocker's `/token`
   endpoint.
3. Pull the offline-KYC XML via DigiLocker's `/oauth2/1/files/issued`
   API. Parse `<DocumentType>AADHAAR</DocumentType>` for:
   - `<Doc>` → the signed Aadhaar XML
   - `<UID>` (masked, e.g. `xxxxxxxx1234`)
   - `<Poi name="..." dob="..." gender="..." />`
4. Verify the XML signature against UIDAI's published public key.
5. Persist on `TripParticipant`:
   - `aadhaarLast4 = "1234"`
   - `aadhaarTokenId = <stored as AES-256-GCM ciphertext via
     lib/fieldEncryption.js>`
   - `aadhaarVerifiedAt = now`
   - `aadhaarVerifiedName = <name from XML>` (per consent §3 — name
     as returned by DigiLocker, not as typed by the parent)
   - `aadhaarVerifiedDob = <dob from XML>`
6. Flip `DigilockerSession.status` → `'completed'`.
7. Write an `AuditLog` entry per [lib/audit.js](backend/lib/audit.js)
   pattern: `entityType=DigilockerSession`, `action=COMPLETED`.
8. Redirect the parent to a success page on the microsite:
   `302 → /p/trip/:publicUuid?verified=1`.

**Errors (302-redirect to error page rather than JSON):**
- `?error=invalid_state` — session not found / expired
- `?error=signature_invalid` — UIDAI signature didn't verify
- `?error=digilocker_token` — token exchange failed
- `?error=user_denied` — DigiLocker returned `error=access_denied`

**Why GET (not POST)** — DigiLocker's OAuth flow sends the callback
as a browser redirect, which is always GET. Tradeoff acknowledged:
the code is in the URL query and may appear in browser history /
proxy logs. The code is single-use (DigiLocker invalidates on first
exchange) and only the partner-credentialled `:CLIENT_SECRET` can
exchange it, so the practical risk is bounded.

## 4. Configuration / secrets

Three secrets per environment, sourced from Travel Stall's DigiLocker
partner onboarding (Q3 cred drop):

| Env var | Source |
|---|---|
| `DIGILOCKER_CLIENT_ID` | DigiLocker partner portal — issued on registration |
| `DIGILOCKER_CLIENT_SECRET` | DigiLocker partner portal — confidential |
| `DIGILOCKER_BASE_URL` | `https://api.digitallocker.gov.in` (prod) or partner-provided UAT URL |

Pattern: read in `backend/config/secrets.js` alongside `JWT_SECRET`
+ `FIELD_ENCRYPTION_KEY`. Service file at
`backend/services/digilockerClient.js` wraps the HTTP calls (token
exchange + offline-KYC fetch + signature verification).

## 5. Schema delta

New `DigilockerSession` model (additive — no destructive migration):

```prisma
model DigilockerSession {
  id              String   @id @default(cuid())
  tenantId        Int      @default(1)
  micrositeId    Int
  participantId  Int
  consentRecordId Int?
  status          String   @default("initiated") // initiated | completed | expired | failed
  failureReason   String?  // populated on failed; null otherwise
  expiresAt       DateTime
  createdAt       DateTime @default(now())
  completedAt     DateTime?

  microsite       TripMicrosite   @relation(fields: [micrositeId], references: [id], onDelete: Cascade)
  participant     TripParticipant @relation(fields: [participantId], references: [id], onDelete: Cascade)
  tenant          Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId, status, expiresAt])
  @@index([participantId, status])
}
```

Extensions to existing `TripParticipant` (additive nullable columns —
no required-field migration risk):

```prisma
model TripParticipant {
  // ... existing columns ...
  aadhaarLast4         String?   // "1234"
  aadhaarTokenId       String?   @db.Text   // AES-256-GCM ciphertext
  aadhaarVerifiedName  String?
  aadhaarVerifiedDob   DateTime?
  aadhaarVerifiedAt    DateTime?

  digilockerSessions   DigilockerSession[]
}
```

`aadhaarTokenId` is the encrypted DigiLocker XML reference — never
the plaintext Aadhaar number. The "tokenId" naming is intentional:
downstream consumers (Hajj Committee, airline) receive the decrypted
token, not the Aadhaar number itself.

## 6. Failure handling

| Scenario | Behaviour | Surface |
|---|---|---|
| DigiLocker API 5xx during /token exchange | Mark session `failed`, write audit, redirect with `?error=digilocker_token`. Retry NOT automatic (user re-tries from the consent screen) | Microsite |
| UIDAI signature verification fails | Mark session `failed` with `failureReason='signature_invalid'`, alert via Notification (type=warning, priority=high) to ops, redirect with `?error=signature_invalid` | Microsite + advisor dashboard |
| User clicks Deny in DigiLocker | Mark session `failed` with `failureReason='user_denied'`, redirect with `?error=user_denied`. The participant can re-trigger from the microsite registration screen | Microsite |
| Session expires (10 min) before callback | A cron extension to `retentionEngine.js` (or a new `digilockerSessionCleanup.js`) marks `initiated` sessions older than 10m as `expired` and purges | Internal |
| Same participant has TWO trips with different microsites | Each microsite gets its own DigilockerSession; the TripParticipant.aadhaar* fields are shared across trips (one verification serves multiple trips for the same person) | N/A |

## 7. Retention

- `DigilockerSession` rows retained 6 months post-`completedAt` (audit
  log requirement; see PRD §4.7 document-security model — 24 month
  online + 36 month cold).
- `TripParticipant.aadhaar*` columns retained 24 months post-trip,
  per the consent text in [TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md)
  §5. Existing `retentionEngine.js` extension sweeps these columns
  at `TmcTrip.returnDate + 24 months`.

## 8. Rate limiting

The two new public endpoints inherit the global `apiLimiter`
(5000 req / 15 min). Add a per-`(micrositeId, ip)` extra limit:
**5 verify-aadhaar/start requests per microsite per IP per 15 min**.
Excess returns 429 `OTP_COOLDOWN`-style error with a backoff hint.

## 9. Test plan

Mirror the existing `travel-microsites-api.spec.js` pattern. The
DigiLocker HTTP calls are stubbed via a sandbox URL (UAT base URL +
fixture XML files) so the gate spec runs deterministically. Real
DigiLocker contact is only in the e2e-full release validation, gated
on `DIGILOCKER_CLIENT_ID` being set in the workflow env.

Tests:
- 400 INVALID_UUID on garbage publicUuid
- 400 MISSING_FIELDS on missing participantId / consentRecordId
- 409 SESSION_IN_FLIGHT on rapid retry
- 410 MICROSITE_GONE on expired microsite
- 201 happy-path returns authoriseUrl with `state=<sessionId>`
- Callback with invalid `state` → 302 with `?error=invalid_state`
- Callback with valid sandbox code → 302 with `?verified=1` + assert
  TripParticipant.aadhaarLast4 + aadhaarTokenId populated + audit
  row written
- Per-IP rate limit: 6th request in 15 min → 429

## 10. Implementation order (post-cred-drop)

1. Add the `DIGILOCKER_*` env vars to `backend/.env.example` + Vault.
2. Schema migration: `DigilockerSession` model + `TripParticipant`
   additive columns. Single `prisma db push` (no destructive change).
3. Author `backend/services/digilockerClient.js` (token exchange +
   offline-KYC fetch + signature verification).
4. Wire the two routes in `routes/travel_microsites.js` under the
   existing `/microsites/public/:publicUuid` prefix.
5. Extend `retentionEngine.js` to sweep `aadhaar*` columns and
   `DigilockerSession.completedAt` rows.
6. Author the gate spec extension (sandbox XML fixtures committed
   under `e2e/fixtures/digilocker/`).
7. Add `/api/travel/microsites/public/.../verify/aadhaar/*` to the
   server.js public openPaths allowlist if needed — actually
   `/travel/microsites/public` prefix already covers them.
8. Front-end: extend `MicrositeTab` in `TripDetail.jsx` to surface
   "Verify Aadhaar (DigiLocker)" button on the participant row when
   `aadhaarVerifiedAt == null`.

**Pre-cred-drop autonomous follow-ups** (can land before Q3 arrives):

- Schema delta (step 2) — purely additive, harmless on demo.
- `digilockerClient.js` stub that simulates a happy-path response
  for local dev (returns a fixed last-4 = `9999` + dummy token).
- Gate spec scaffold with stubs only (skipped tests pending creds).

---

**Ownership chain:**
- GS owes the implementation PR — gated on Q3.
- Travel Stall owes the partner credentials — outstanding per
  [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) Q3.
- Counsel reviews the consent screen language ([TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md)).
