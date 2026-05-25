# DigiLocker in Travel CRM — Use Case

**Audience:** product / commercial / compliance — anyone who needs to understand
*why* the Travel CRM integrates with DigiLocker and what the operator + traveller
actually experience.

**Engineering blueprint:** [DIGILOCKER_INTEGRATION_SPEC.md](DIGILOCKER_INTEGRATION_SPEC.md)
(route shapes, schema delta, retention, test plan). This document is the
narrative layer above it.

**Consent / legal:** [TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md)
(the wording the parent / pilgrim approves on screen, pending counsel review per Q2).

**PRD anchor:** PRD §4.5 (identity & document collection) + §4.7 (Travel Stall
operating model) — see [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md).

---

## 1. The problem DigiLocker solves

Travel Stall needs to prove that every trip participant is who they say they
are, with a **government-anchored identity check** that downstream consumers
trust. Two consumers drive the requirement:

| Sub-brand | Why Aadhaar-anchored ID is non-negotiable |
|---|---|
| **TMC** (school trips) | Parental-consent + minor-traveller compliance; airline + state-board checks before group travel. |
| **RFU** (Umrah pilgrims) | The **Hajj Committee API** mandates Aadhaar-anchored identity for every pilgrim filed under a tour operator. |
| **Both** | Airline / hotel check-in friction drops sharply when the ID is already government-verified ahead of departure. |

The core tension: Travel Stall must *prove* the ID is real without *holding*
the Aadhaar number itself (Aadhaar Act §29 + DPDP §8 data-minimisation).
DigiLocker is how that tension resolves.

---

## 2. Why DigiLocker — not direct Aadhaar OCR

Per PRD §4.5 / Q3, Travel Stall explicitly chose DigiLocker over direct
Aadhaar OCR. Four reasons:

1. **Aadhaar Act §29 risk vanishes.** Direct OCR plus storage of the
   unmasked 12-digit Aadhaar requires UIDAI authorisation under Section 4 of
   the Act. DigiLocker's offline-KYC path bypasses this entirely — Travel
   Stall receives a **signed XML reference token**, never the raw number.

2. **No biometric surface.** DigiLocker authenticates the user upstream
   (the parent / pilgrim logs in to DigiLocker themselves). Travel Stall
   never collects fingerprint, iris, or face data.

3. **Government-issued provenance.** The XML token is signed by UIDAI's
   DigiLocker service, so the Hajj Committee, airline, or any other
   downstream verifier can confirm the ID was Aadhaar-anchored *without
   Travel Stall ever holding the full number*. The trust chain runs back to
   UIDAI, not to Travel Stall.

4. **DPDP §8 data minimisation.** Masked-last-4 plus the signed token is
   the minimum collection that satisfies the downstream verification need.
   Anything more would be over-collection under DPDP.

---

## 3. The traveller's experience

The parent / pilgrim sees **three screens** end-to-end. The middle screen is
on DigiLocker; the outer two are on Travel Stall's microsite.

```
Parent / participant                Travel Stall CRM             DigiLocker
─────────────────────              ──────────────────             ──────────
1. On the trip microsite,
   taps "Verify Aadhaar"     →    POST /verify/aadhaar/start
                                  (creates DigilockerSession)
                                  Returns a 302 redirect       →   OAuth-style
                                                                    consent screen

2. Sees DigiLocker consent
   screen, taps Approve     →                                  ←   redirect back to TS
                                                                    with ?code=<auth_code>

3. Sees "Verified ✓" on
   the microsite           ←     POST /verify/aadhaar/callback
                                  - exchanges code → token
                                  - pulls offline-KYC XML
                                  - verifies UIDAI signature
                                  - stores: aadhaarLast4 ("1234"),
                                            aadhaarTokenId (AES-256-GCM
                                              ciphertext of the signed XML),
                                            aadhaarVerifiedName,
                                            aadhaarVerifiedDob,
                                            aadhaarVerifiedAt
                                  - writes ConsentRecord + AuditLog rows
```

From the parent's side this is a 30-second flow. From Travel Stall's side,
the `TripParticipant` row flips from `aadhaarVerifiedAt == null` to a
verified state, and the participant becomes eligible for downstream
submission to the Hajj Committee / airline.

---

## 4. What gets stored — and what does not

This is the heart of the compliance design. Travel Stall holds the *minimum*
needed to prove the verification happened.

| Stored on `TripParticipant` | NOT stored |
|---|---|
| `aadhaarLast4` — e.g. `"1234"` | The full 12-digit Aadhaar number |
| `aadhaarTokenId` — encrypted XML signed by UIDAI (the "reference token") | Biometric data of any kind |
| `aadhaarVerifiedName` — name as returned by DigiLocker | The unmasked UID |
| `aadhaarVerifiedDob` — DOB from the XML | The Aadhaar address (unless explicitly needed; default off) |
| `aadhaarVerifiedAt` — timestamp | |

The "tokenId" naming is deliberate. Downstream consumers (Hajj Committee,
airline check-in) receive the **decrypted XML token**, not the Aadhaar number
itself. The token is what they verify against UIDAI's public key.

---

## 5. Where it surfaces in the product

| Surface | What changes |
|---|---|
| **Microsite registration page** (parent-facing, public) | New "Verify Aadhaar (DigiLocker)" button on each participant row. Disabled once `aadhaarVerifiedAt` is set. |
| **TripDetail → MicrositeTab** (advisor-facing) | Per-participant verification badge — `Verified ✓` with date, or `Pending` with a "remind via WhatsApp" action once Wati BSP creds (Q9) arrive. |
| **Hajj Committee export** (RFU pilgrim filing) | Pulls the decrypted token + last-4 + name + DOB for each pilgrim; refuses pilgrims with `aadhaarVerifiedAt == null`. |
| **AuditLog** | Each verification event is `entityType=DigilockerSession, action=COMPLETED` — full immutable record for compliance review. |

---

## 6. Failure modes and how the product handles them

| Scenario | What the parent sees | What ops sees |
|---|---|---|
| Parent clicks **Deny** on DigiLocker consent screen | Microsite shows "Verification cancelled. You can retry from the participant card." | Session row marked `failed`, `failureReason='user_denied'`. No alert. |
| DigiLocker API 5xx during token exchange | "DigiLocker is temporarily unavailable. Please try again in a few minutes." | Session `failed` with `failureReason='digilocker_token'`. Not automatically retried — user-initiated only. |
| UIDAI signature verification fails | "Your Aadhaar token didn't verify. Please contact support." | Session `failed` with `failureReason='signature_invalid'`. High-priority Notification raised to ops dashboard (this is rare and usually a tampered token or DigiLocker outage). |
| Session expires (10 min) before the parent completes | "Verification expired. Please start again." | Cleanup cron flips `initiated` sessions older than 10m to `expired` and purges. |
| Same participant tries to verify twice in 5 minutes | Modal: "Verification already in progress — finish that one first." | 409 SESSION_IN_FLIGHT — replay guard. |

---

## 7. Retention

- **`DigilockerSession` rows** — retained 6 months past `completedAt` for
  audit purposes, then purged. Driven by an extension to `retentionEngine.js`.
- **`TripParticipant.aadhaar*` columns** — retained 24 months past the
  trip's `returnDate`, per the consent text in
  [TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md) §5.
  After that the columns null out automatically; the `AuditLog` row of the
  original verification stays for the longer DPDP audit window.
- **AuditLog rows** — follow PRD §4.7 document-security model (24 months
  online + 36 months cold). The DigiLocker verification event survives
  even after the `aadhaar*` columns null out.

---

## 8. Status today — what's blocking it

The whole integration is shovel-ready behind **one cred drop**:

| Status | Item |
|---|---|
| 🔴 **Blocked** | `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET` from Travel Stall's DigiLocker partner-portal registration (Q3 in [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md)). |
| 🟢 **Ready to ship** | Engineering spec ([DIGILOCKER_INTEGRATION_SPEC.md](DIGILOCKER_INTEGRATION_SPEC.md)) signed off; consent draft ([TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md)) drafted, pending Travel Stall counsel's review (Q2). |
| 🟡 **Pre-cred autonomous follow-ups that can land now** | The additive schema delta (`DigilockerSession` model + `TripParticipant` extension columns), a `digilockerClient.js` stub returning a fixed `last-4 = 9999` for local dev, and the gate-spec scaffold with stubs (skipped tests pending real creds). |

Once the partner creds arrive, the implementation order (per the SPEC §10)
is roughly:

1. Add `DIGILOCKER_*` env vars to `backend/.env.example` and the secret store.
2. Apply the schema migration (`prisma db push` — additive only).
3. Author `backend/services/digilockerClient.js` (token exchange +
   offline-KYC fetch + signature verification).
4. Wire the two routes in `routes/travel_microsites.js`.
5. Extend `retentionEngine.js` to sweep the new columns + session rows.
6. Author the gate-spec extension with sandbox XML fixtures.
7. Front-end: surface the "Verify Aadhaar" button on `TripDetail →
   MicrositeTab` participant rows.

---

## 9. One-sentence summary

> DigiLocker lets Travel Stall **prove** every participant's Aadhaar-anchored
> identity to the Hajj Committee, airlines, and schools — without ever
> **holding** the raw Aadhaar number, satisfying Aadhaar Act §29 and DPDP §8
> by design.

---

**Ownership chain:**

- **GS** owes the implementation PR — gated on the partner cred drop (Q3).
- **Travel Stall** owes the partner credentials — outstanding per
  [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) Q3.
- **Travel Stall's counsel** reviews the consent screen language drafted in
  [TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md) (Q2).
