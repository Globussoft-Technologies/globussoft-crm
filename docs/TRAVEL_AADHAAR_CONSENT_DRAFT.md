# Aadhaar consent — Travel CRM (draft for counsel review)

**Status:** DRAFT — NOT YET COUNSEL-REVIEWED. Do not ship to production.
**Authoring context:** PRD §4.5 mandates Aadhaar capture for TMC trip
participants via DigiLocker (preferred path per Q3). The CRM must
present a clear, lawful consent screen at the moment of collection
and persist a timestamped record per [`docs/TRAVEL_CRM_PRD.md`](TRAVEL_CRM_PRD.md)
§4.7 ("Consent: explicit checkbox at start; record stored with
timestamp/IP/token; 24-month retention; in-app withdrawal triggers
retention-end workflow").

**What this doc IS:** the consent language Travel Stall would display
to parents/teachers during trip registration, drafted against
**Aadhaar Act §29** (use of Aadhaar information) and the **Digital
Personal Data Protection Act, 2023** (DPDP Act) §§5–8 (notice,
consent, withdrawal). Plus the operational footnotes that make the
display compliant in practice (timestamp, IP, withdrawal channel).

**What this doc is NOT:** legal advice. Travel Stall's counsel
reviews this draft, refines the language, and the FINAL approved
text becomes the live copy in the microsite registration flow.
Counsel-approved version supersedes this draft entirely.

---

## 1. Scope of consent

The CRM collects, processes, and stores Aadhaar-linked identity data
for travellers under the following specific circumstances:

- **TMC school trips** — students travelling internationally need
  passport + Aadhaar verification per airline / immigration / school-
  guardian-policy requirements.
- **RFU Umrah pilgrims** — Hajj Committee / Saudi visa frameworks
  require Aadhaar-anchored ID verification (downstream of the visa
  application; Travel Stall stores ONLY what the visa workflow returns).
- **Visa Sure applicants (Phase 3)** — explicit per-application
  consent; not in scope for the Phase 1 launch text below.

The consent screen is presented ONCE per trip-participant relationship.
A separate consent applies to each trip the same participant joins.

## 2. What is collected, what is stored

**Collected via the DigiLocker offline-KYC flow** (per PRD §4.5 / Q3):

- The participant's **masked Aadhaar last-4 digits** (e.g.
  `XXXX-XXXX-1234`). Full Aadhaar is NEVER seen by Travel Stall or
  stored anywhere in the CRM.
- A **signed Aadhaar XML reference token** issued by DigiLocker.
  This token is treated as a credential — encrypted at rest with
  AES-256-GCM (per the existing wellness-vertical pattern in
  `backend/lib/fieldEncryption.js`).
- The **DigiLocker authorisation timestamp** (when the user clicked
  "Share with Travel Stall").
- The participant's **name and date-of-birth** AS RETURNED BY
  DigiLocker (not as typed by the parent — provenance matters for
  ticket-purchase compliance).

**NOT collected:**

- Biometric data (no Aadhaar fingerprint / iris / face capture).
  Travel Stall does not implement Aadhaar Authentication (§4 of the
  Aadhaar Act); the DigiLocker offline path bypasses this entirely.
- Full Aadhaar number (the unmasked 12-digit string). The DigiLocker
  flow returns only the masked-last-4 + token.
- VID (Virtual ID). Travel Stall does not request VIDs; the
  DigiLocker flow handles the offline-KYC token translation natively.

## 3. Purpose limitation (per Aadhaar Act §29 + DPDP Act §6)

Travel Stall uses the Aadhaar-linked data **only** for:

- Passport-trip linkage verification at airline check-in.
- Hajj Committee / Saudi visa submission (RFU sub-brand only).
- School-parent guardianship verification (TMC sub-brand only).
- Internal audit log of who-shared-what-when (required for
  compliance under Aadhaar Act §29(2) and DPDP §11).

Travel Stall **does not**:

- Share Aadhaar data with marketing or advertising partners.
- Use Aadhaar data for any purpose other than the three listed above.
- Retain Aadhaar data beyond the retention window in §5 below.
- Combine Aadhaar data with social-profile / behaviour data for
  targeted advertising.

## 4. Consent text (the screen the participant sees)

**Display this verbatim** on the DigiLocker authorisation screen.
Variables wrapped in `{{…}}` are interpolated at render time.

```
═══════════════════════════════════════════════════════════════════
SHARE YOUR AADHAAR-LINKED ID WITH {{TRIP_NAME}}

Travel Stall (operating as {{LEGAL_ENTITY_NAME}}) needs to verify
your identity for the upcoming trip to {{DESTINATION}} on
{{DEPART_DATE}}.

When you click "Continue" below, we'll send you to **DigiLocker**
(an official Government of India service) where you can choose to
share these specific items with us:

  • Your name (as on your Aadhaar card)
  • Your date of birth
  • The last 4 digits of your Aadhaar number
  • A signed reference token from DigiLocker (we use this to
    confirm with Hajj Committee / the airline that your ID was
    verified by Aadhaar — we never see your full Aadhaar number)

We DO NOT collect:
  • Your full 12-digit Aadhaar number
  • Your fingerprints, iris scan, or photo from Aadhaar
  • Any other Aadhaar-linked data

We will use this only for:
  • Confirming your booking with {{AIRLINE_NAME}}
  • {{SUB_BRAND_PURPOSE}}    ← TMC: "Sharing with your school as
                                     guardian-verification."
                                RFU: "Hajj Committee + Saudi visa
                                     submission."

We keep this data for **24 months after the trip ends**. After that,
we delete it automatically. You can also delete it any time before
that by visiting {{WITHDRAWAL_URL}} or messaging us at
{{SUPPORT_WA_NUMBER}}.

By clicking "Continue", you tell us that:
  ☐ You're at least 18, OR you have parental/guardian permission
    (parent signs separately at the bottom of this page)
  ☐ You agree to Travel Stall using your Aadhaar-linked identity
    information as described above
  ☐ You understand that you can withdraw this consent any time

──────────────────────────────────────────────────────────────────
                          [ Continue → ]                          
──────────────────────────────────────────────────────────────────

Privacy details: {{PRIVACY_URL}}  •  Contact: {{DPO_EMAIL}}
═══════════════════════════════════════════════════════════════════
```

### Variable map for render-time interpolation

| Variable | Source |
|---|---|
| `{{TRIP_NAME}}` | `TmcTrip.tripCode` + `TmcTrip.destination` |
| `{{LEGAL_ENTITY_NAME}}` | `TmcTrip.legalEntity` → display name (TMC Nexus / RFU / Travel Stall) |
| `{{DESTINATION}}` | `TmcTrip.destination` |
| `{{DEPART_DATE}}` | `TmcTrip.departDate` formatted as "12 September 2026" |
| `{{AIRLINE_NAME}}` | derived from `ItineraryItem.detailsJson` first flight |
| `{{SUB_BRAND_PURPOSE}}` | per-sub-brand string from the variable map below |
| `{{WITHDRAWAL_URL}}` | `https://crm.globusdemos.com/p/consent/withdraw?token={{CONSENT_RECORD_TOKEN}}` |
| `{{SUPPORT_WA_NUMBER}}` | tenant.subBrandConfigJson → support_wa |
| `{{PRIVACY_URL}}` | tenant.subBrandConfigJson → privacy_url |
| `{{DPO_EMAIL}}` | tenant.subBrandConfigJson → dpo_email |

### Sub-brand purpose interpolation

| Sub-brand | `{{SUB_BRAND_PURPOSE}}` |
|---|---|
| TMC | "Sharing with your school as guardian-verification (your principal will see a confirmation that your ID is verified — but never your Aadhaar number or any biometric data)." |
| RFU | "Hajj Committee + Saudi consulate submission (we share the DigiLocker reference token via the official Hajj-Committee API; no Aadhaar number or biometric data leaves DigiLocker)." |

## 5. Retention + deletion

- **24-month retention** post-trip-end, per PRD §4.7. The retention
  clock starts on `TmcTrip.returnDate + 24 months` (or `Itinerary.endDate
  + 24 months` for RFU).
- **Automated purge** via the existing `retentionEngine.js` cron
  (modify the engine to include `TripParticipant.aadhaarLast4`,
  `aadhaarTokenId`, `aadhaarDob` columns in its scan).
- **In-app withdrawal** via `WITHDRAWAL_URL` triggers immediate hard-
  delete of the Aadhaar-linked fields on the participant row. The
  participant row itself stays (for trip-roster integrity); only the
  Aadhaar columns are nulled.
- **Audit log entry** on every consent grant, every Aadhaar-data read
  (via existing `lib/audit.js` `writeAudit` helper), and every
  withdrawal / purge. Audit log retained 36 months per PRD §4.7
  document-security model.

## 6. Operational footnotes for the consent record

When the participant clicks "Continue" on the screen above, the CRM
persists a `ConsentRecord` row with:

| Field | Value |
|---|---|
| `consentType` | `"aadhaar_digilocker_v1"` (versioned — new draft = `_v2`) |
| `consentText` | The exact text shown to the user (snapshot for audit) |
| `consentTextVersion` | Hash of the text, for fast equality on later sweeps |
| `participantId` | `TripParticipant.id` |
| `tripId` | `TmcTrip.id` |
| `tenantId` | Tenant scope |
| `grantedAt` | Server timestamp |
| `grantedFromIp` | Source IP (req.ip after trust-proxy) |
| `userAgent` | Browser User-Agent string |
| `digilockerAuthRef` | DigiLocker's own correlation id |
| `withdrawnAt` | Null until withdrawal; set on /p/consent/withdraw |
| `purgedAt` | Null until automated purge; set by retentionEngine |

The `ConsentRecord` model is **net-new** for this work — schema delta
to be designed in the same PR as the runtime code. (The Phase 1
schema delta in v3.9.0 added the participant columns but not the
consent-record audit trail.)

## 7. Counsel-review questions

When counsel reviews this draft, please confirm:

1. **Is the "share-with-school" path (TMC sub-brand) compliant
   without separate school consent?** If yes, the consent text in §4
   covers it. If no, we need a second checkbox for "the school will
   see a confirmation that my ID is verified."
2. **Is "24 months post-trip" the right retention window** under
   DPDP §8(7) (storage limitation), or should it be tied to a
   different anchor (e.g. last-airline-flight)?
3. **Is the masked-last-4-only disclosure ("we never see your full
   Aadhaar number") accurate under the current DigiLocker offline-
   KYC API?** Confirm with DigiLocker partner integration spec.
4. **Does the consent text need to be available in Hindi / Urdu /
   regional languages** at launch, or English-only acceptable for
   the v1 release? (PRD §4.1 mentions Eng/Hin/Urdu mid-call switching
   for voice — text may or may not parallel that.)
5. **Withdrawal mechanism** — is the `WITHDRAWAL_URL` link
   sufficient, or does Travel Stall need a phone/WhatsApp withdrawal
   channel under DPDP §6(8) (easily-withdrawable consent)?
6. **Children (TMC use case)** — is parent/guardian consent acceptable
   under DPDP §9 (processing of personal data of children), and is
   the checkbox structure correct? Some interpretations require BOTH
   the parent AND the child (if >12) to consent separately.

## 8. Implementation notes for the CRM team (post-counsel-approval)

Once counsel signs off on the language:

1. Replace this draft's `§4` block verbatim into a new template at
   `frontend/src/templates/aadhaar-consent.html` (or equivalent).
2. Add the `ConsentRecord` Prisma model per `§6`. Schema migration.
3. Wire the DigiLocker authorisation handshake in
   `routes/travel_microsites.js` (or a new `routes/travel_consent.js`
   if the surface grows) — endpoints already partially scaffolded
   per PRD §6.1 `travel_trip_microsite_public.js` line.
4. Extend `retentionEngine.js` to sweep aadhaar-linked columns at
   `returnDate + 24 months`.
5. Add a Playwright spec asserting the consent text matches the
   counsel-approved snapshot (so future copy drift fails the gate).

---

**Once counsel review lands, the next steps are tracked in
[TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) Q2 — "GS
owes Travel Stall: Aadhaar consent draft for counsel within W1."**
