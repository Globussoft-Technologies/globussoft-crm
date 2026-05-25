# Passport OCR — Product Requirements

**Status:** SPEC — wiring is cred-blocked on a vendor decision (Google Document
AI vs Azure Form Recognizer vs hybrid vs Indian alternative). The schema +
encryption infrastructure is already shipped; what's missing is the vendor
client (`backend/services/passportOcrClient.js`) + the operator verification
UI. The vendor decision (Product Call **PC-1** below) gates both.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §4.5 (Document
management — passport upload + checklist + status tracking) +
[TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md](TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md)
row T10 (TMC) + R20 (RFU) + Phase 3 Visa Sure reuse.

**Audience:** Yasin (vendor decision owner + cred drop after the decision),
TMC + RFU + Visa Sure ops, GS engineering.

**Sister document:** [DIGILOCKER_USE_CASE.md](DIGILOCKER_USE_CASE.md) — the
Aadhaar verification flow runs via DigiLocker (compliance route) and is
intentionally separate from this passport flow. Passport documents are not
DigiLocker-issued so OCR is the only viable extraction path.

---

## 1. Background

Indian travel (and the visa-applicant population that Visa Sure serves) is
passport-heavy. Every TMC school-trip parent uploads a child passport;
every RFU pilgrim uploads their own passport; every Visa Sure applicant
uploads the passport plus visa supporting docs. Without OCR, each upload
forces the parent / pilgrim / applicant to **manually type** 5 fields per
passport (passport number, full name, DOB, expiry, nationality) — at a
typical 30-student school trip that's 150 keystroke-fields plus the
typo-correction overhead, multiplied by the number of trips per season.

OCR turns the upload-and-confirm loop from a 5-minute manual-entry chore
into a 30-second photo-upload-and-tap-confirm interaction. The
operator-side reduction is the same: instead of an ops person checking
30 manually-typed passport numbers against 30 passport photos, they get a
side-by-side diff and approve/reject per row.

### 1.1 Source attribution + how the requirement arrived

The passport-OCR requirement originates from **two paragraphs** across the
TMC sub-brand brief and Yasin's clarifications email:

1. `travel-crm/TMC - CRM development.pdf` §4 ("Parent registration portal")
   names *"Passport upload with OCR extraction and manual verification"*
   as a Phase-1 W4 deliverable.
2. `travel-crm/Understanding and clarifications - Yasin.pdf` (2026-05-13)
   discusses the **sister Aadhaar flow** at length — *"Aadhaar OCR:
   compliance route — DigiLocker, offline KYC or direct OCR — and consent
   flow."* — but does not enumerate the parallel passport-side decisions.
   The DigiLocker route is not available for passports (DigiLocker only
   issues Indian-government-issued documents that exist as digitally-signed
   XML; the passport book itself is issued physically and is not a
   DigiLocker artifact), so passports stay an **OCR-only flow** by
   necessity.

This PRD pulls the Yasin clarifications onto the passport side explicitly:
the same "consent flow + counsel review + retention policy" Yasin asked
counsel to bless for Aadhaar is needed for passport too, just without the
DigiLocker leg.

**Source-of-truth chain:**
```
TMC brief (§4 row "Passport upload with OCR + manual verification")
  + Yasin clarifications (sister-Aadhaar flow, 2026-05-13)
    └─ portal feature matrix row T10 (TMC) + R20 (RFU) + Phase 3 VS reuse
         └─ this PRD (live)
              └─ schema + fieldEncryption shipped (TripParticipant + ContactAttachment)
                   └─ vendor decision PC-1 + cred chase
                        └─ services/passportOcrClient.js + operator UI
```

---

## 2. Use cases — who uses it and when

### 2.1 Customer-side (TMC parent / RFU pilgrim / Visa Sure applicant)

| Step | What happens | Today (no OCR) | After this PRD ships |
|---|---|---|---|
| 1. Upload | Parent / pilgrim opens trip microsite, picks "Upload passport" | Form has 5 empty text fields + a "Choose file" button | Single "Choose file" button + drag-and-drop area + camera-capture (mobile) |
| 2. OCR | Photo / PDF posted to backend | n/a | Backend POSTs to vendor; vendor returns extracted fields (sync or async webhook) |
| 3. Confirm | User sees populated fields | n/a | Auto-populated form with edit-in-place; "Looks right? Submit" CTA |
| 4. Persist | TripParticipant row updated | Manual values from text fields | Vendor-extracted values + confidence scores per field + raw vendor response stored on `Attachment.metaJson` |

### 2.2 Operator-side (verification UI)

| Feature | Cron / route | Today | After this PRD ships |
|---|---|---|---|
| **Pending-verification queue** | `routes/travel_trips.js` GET `/trips/:id/ops-dashboard` (Today shows `submittedCount=0` placeholder for T14 — passport-OCR result rows would feed this metric) | No queue surface | Ops dashboard shows "N passports pending verification" |
| **Side-by-side review** | New: `frontend/src/pages/travel/PassportVerificationQueue.jsx` | Operator opens TripDetail → Participants tab → eyeballs raw photo + types numbers into a sheet | Click row → side-by-side: passport photo on left, extracted fields on right, low-confidence fields highlighted, approve / reject (with reason) buttons |
| **Re-upload notification** | Existing notification engine + Q9 WhatsApp dispatch | Operator emails parent / texts them | Auto WA template "Your passport upload needs another shot — please re-upload" |

### 2.3 Visa Sure reuse (Phase 3)

Per portal matrix V13 (`VisaDocumentChecklistItem` model already seeded),
the **exact same** passport-OCR pipeline serves Visa Sure applicants —
just a different `Attachment.parentType` and a different operator queue
filter. No code duplication; the engineering work post-vendor-decision is
write-once.

### 2.4 Edge cases

- **Non-Indian passports** — covered (most vendors offer multi-country
  passport processors; Google DocAI has a global Passport processor that
  identifies country-of-issue from the MRZ). PC-1 vendor-choice impacts
  fallback shape: hybrid route per country if accuracy materially
  differs.
- **Expired passports** — surfaced at extraction time (`expiryDate < today`)
  → uploaded successfully but flagged with a `passportExpired=true` field
  on TripParticipant + an ops-dashboard surface; trip enrolment doesn't
  proceed until parent uploads a renewed passport OR operator overrides
  (for trips that exit and return before the expiry).
- **MRZ vs VIZ mismatch** — when the machine-readable zone (bottom of
  passport bio page) doesn't checksum-match the visual fields (top half),
  the upload is flagged for **mandatory manual verification** regardless
  of confidence scores (this is the canonical forgery / tampering signal).
- **Low-resolution photos** — vendors return confidence scores per field
  + an overall image-quality score; if `imageQuality < threshold` (PC-7
  open question — auto-reject threshold vs always-operator-decide?), prompt
  parent to re-upload with a clearer photo.
- **PDF uploads** — accepted (scanned passport PDFs are common from
  travel-agent-uploaded bulk packets); vendors handle multi-page PDFs
  natively.

---

## 3. Functional requirements

| FR-ID | Requirement | Status |
|---|---|---|
| FR-1 | Accept passport upload formats: JPG / PNG / PDF; max file size 5 MB; min resolution 1024×768 (warned but not blocked below this — vendor's image-quality score is the binding gate) | 🔴 NOT-STARTED — needs `routes/travel_trips.js` extension `POST /participants/:id/passport-upload` |
| FR-2 | Extract fields via vendor: `passportNumber`, `givenName`, `surname`, `fullName`, `dateOfBirth`, `expiryDate`, `issueDate`, `nationality`, `placeOfIssue`, `gender`, `mrzChecksum` | 🔴 NOT-STARTED — gated on PC-1 vendor choice; new `backend/services/passportOcrClient.js` |
| FR-3 | Sync-mode happy path: backend POSTs file to vendor → receives extraction JSON within 30 s → returns to caller | 🔴 NOT-STARTED — most vendors offer sync for single-page passports |
| FR-4 | Async-mode fallback: if vendor returns a job ID, register webhook → on webhook arrival, update Attachment + TripParticipant + notify operator queue | 🔴 NOT-STARTED — same client, separate code path |
| FR-5 | Persist OCR result on `Attachment.metaJson` (raw vendor response + per-field confidence scores); auto-populate `TripParticipant.passportNumber/Expiry/etc.` columns; store image in encrypted blob via `backend/lib/fieldEncryption.js` (existing infra, AES-256-GCM) | 🟡 PARTIAL — schema + encryption infra ✅ shipped; population logic not wired |
| FR-6 | Operator verification UI: side-by-side photo + extracted fields; per-field edit-in-place; approve/reject + reason; verified-at + verified-by columns on TripParticipant | 🔴 NOT-STARTED — new `frontend/src/pages/travel/PassportVerificationQueue.jsx` |
| FR-7 | Retry / replacement: parent can re-upload (up to PC-5 attempts) if rejected; each upload is a new `Attachment` row (audit trail preserved) | 🔴 NOT-STARTED |
| FR-8 | PII boundary: image visible only to `verifyRole(["ADMIN","MANAGER"])`; OCR'd field values visible to the assigned advisor; consent flag (PC-3) captured pre-upload | 🔴 NOT-STARTED — relies on existing `verifyRole` + `tenantWhere` pattern |
| FR-9 | Audit log: every upload + verify + reject event written via `writeAudit("passport.uploaded", ...)` etc. — log field NAMES not VALUES to keep PII out of audit trail | 🔴 NOT-STARTED — uses existing audit-log infra at `backend/lib/audit.js` |
| FR-10 | Expired-passport surface: `expiryDate < today` → flag `TripParticipant.passportExpired=true` + emit ops-dashboard alert | 🔴 NOT-STARTED — additive boolean column or computed field |
| FR-11 | Rejection notification: rejected upload triggers parent re-upload notification (WhatsApp template if Q9 lands; email + SMS fallback meanwhile) | 🟡 PARTIAL — email + SMS path live; WhatsApp leg pending Q9 (independent) |
| FR-12 | Vendor-failure fallback: 5xx from vendor → mark Attachment `ocrStatus=failed` + queue retry 3× with backoff + on persistent fail, fall through to manual entry form (parent can still proceed with the 5 text fields) | 🔴 NOT-STARTED |

**Nothing on the schema or encryption side needs more code.** What's
missing is the vendor client + the routes + the operator UI — gated on
PC-1.

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Latency** (upload → OCR complete, sync mode) | < 30 s p95; < 10 s p50 |
| **Latency** (upload → OCR complete, async mode) | < 5 min p95; < 90 s p50 (most vendors deliver async webhooks within this window for passports) |
| **Reliability** | 5xx from vendor → retry 3× with exponential backoff (1 s / 2 s / 4 s); persistent failure → fall through to manual entry; parent never blocked permanently |
| **Accuracy SLO** | ≥ 95 % on MRZ field extraction (passport number, expiry, DOB, nationality); ≥ 90 % on VIZ fields (full name spelling, place of issue) — discount from vendor's stated 99%+ because of real-world image-quality variance |
| **Throughput** | Per-tenant cap PC-6 (default $50/mo vendor spend or 1000 uploads/mo, whichever first) to prevent runaway-cost incidents |
| **Compliance** | DPDP Act 2023 + visa-applicant data (passport contains protected PII per DPDP §3); encrypted at rest; access logged; image retained until 30 d post-trip (after which automatic purge via existing `cron/retentionEngine.js` extension); per-vendor data-processing-addendum signed (vendor must commit to delete after processing — both Google DocAI and Azure FR offer this) |
| **Data residency** | Per PC-2: Indian-tenant data may need to stay in India per DPDP. Google DocAI offers `asia-south1` (Mumbai); Azure FR offers `centralindia`. Vendor decision constrained by this. |

---

## 5. Hand-over requirements / decisions needed

This section enumerates the **5 product calls** + the cred-chase that
follow each decision. None of this is engineering work — these are
stakeholder decisions, and the implementation is small once each lands.

### 5.1 The product calls (decisions needed before engineering can start)

| # | Decision | Owner | Options | GS recommendation |
|---|---|---|---|---|
| **PC-1** | **Which vendor?** | Yasin (final call) + GS engineering (cost / latency benchmark input) | (a) **Google Document AI** — best accuracy on Indian passports per public benchmarks; ~$1.50/page; OCR + entity extraction integrated; pre-trained Passport processor with global support. (b) **Azure Form Recognizer** — comparable accuracy; ~$1/page; integrates with Microsoft Cloud (matters if tenant moves to MS stack downstream). (c) **Hybrid** — route by passport country (Indian → Google; non-Indian → Azure); higher complexity but better cost. (d) **Indian alternative** (e.g. Sumadhura, Tarka, AISensy passport SDKs) — cheaper (~₹2-5/page); variable accuracy; smaller SDK ecosystem; possibly mandated by DPDP if data residency is strict. | **Google DocAI for V1** — single vendor minimises operational complexity; revisit hybrid in V2 if costs spike on the international passport mix. |
| **PC-2** | **Data residency** | Counsel + Yasin | (a) Strict — Indian-tenant data MUST stay in India → Google `asia-south1` (Mumbai) or Azure `centralindia`. (b) Loose — global is OK as long as the vendor signs a data-processing addendum + commits to delete after processing. | **Strict** — pin the vendor processor region to India per default; opt-in to global only if a specific tenant's contract permits it. Cheaper to start strict than to migrate later. |
| **PC-3** | **Consent text** (legal copy shown to parent / pilgrim / applicant before upload) | Counsel — same counsel queue as PC-3 of the Aadhaar flow | Draft: *"I authorise this image to be processed for trip enrollment / visa application. The image is auto-deleted 30 days post-trip / 90 days post-application. My data is not shared with third parties beyond the OCR vendor (Google / Azure / etc.), who is contractually bound to delete it after extraction. I understand my rights under the Digital Personal Data Protection Act 2023."* | **Mirror the Q2 Aadhaar consent format.** Counsel review the wording once; same wording applies cross-document. |
| **PC-4** | **Manual fallback SLA** | TMC + RFU ops | When OCR fails (vendor 5xx, low-quality image, or PC-7 auto-reject threshold trips), how fast must ops do the manual entry? (a) Same day (8h SLA). (b) 24h SLA. (c) Best-effort, no SLA. | **24h SLA for TMC + RFU; same-day for Visa Sure (visa-application deadlines are tighter).** Configurable per sub-brand. |
| **PC-5** | **Re-upload attempt limit** | TMC + RFU ops | How many times can a parent re-upload after rejection before operator must intervene? (a) 3 attempts then operator notified. (b) Unlimited (operator handles all rejections inline). (c) Per-trip-type variant. | **3 attempts then notify operator.** Catches the persistent low-quality-photo case quickly. |

### 5.2 The cred drop (after PC-1 lands)

Once Yasin picks the vendor, the cred drop is:

**For Google DocAI:**
- `GOOGLE_APPLICATION_CREDENTIALS` — path to service-account JSON key file
- `GOOGLE_DOCAI_PROJECT_ID` — GCP project ID
- `GOOGLE_DOCAI_PASSPORT_PROCESSOR_ID` — the pre-trained Passport processor ID
- `GOOGLE_DOCAI_LOCATION` — region pin (`asia-south1` per PC-2)

**For Azure Form Recognizer:**
- `AZURE_FORM_RECOGNIZER_ENDPOINT` — region endpoint
- `AZURE_FORM_RECOGNIZER_KEY` — API key

**For hybrid:** both bundles.

**Delivery time post-PC-1:** ~5 min for Yasin to generate + drop into a
secure vault for GS. Pattern mirrors the Q9 (WhatsApp) cred bundle.

### 5.3 What GS will build once PC-1 + creds land

| Item | File | Estimated time |
|---|---|---|
| Vendor client | `backend/services/passportOcrClient.js` (single-vendor) OR `passportOcrRouter.js` (hybrid) | 1 day for single-vendor; 1.5 days for hybrid |
| Upload route | `backend/routes/travel_trips.js` extension `POST /participants/:id/passport-upload` + sync/async result handling | 0.5 day |
| Webhook route (async path) | `backend/routes/travel_trips.js` extension `POST /passport-ocr/webhook/:state` + signature verification | 0.5 day |
| Operator UI | `frontend/src/pages/travel/PassportVerificationQueue.jsx` + verify/reject endpoints | 1.5 days |
| E2E spec | `e2e/tests/passport-ocr-api.spec.js` covering upload + verify + reject + re-upload + expired flag | 1 day |
| Vitest | `backend/test/services/passportOcrClient.test.js` covering stub-mode + real-mode + retry-on-5xx + webhook signature | 0.5 day |
| Retention extension | `backend/cron/retentionEngine.js` extension: purge passport images 30 d post-trip | 0.5 day |
| Audit hooks | `writeAudit` call sites + new `passport.uploaded` / `passport.verified` / `passport.rejected` action types | included in upload route + UI estimates |

**Total post-PC-1 engineering:** ~5 days (single-vendor) to ~6 days
(hybrid). Front-loaded on the client + upload route; the UI + spec work
parallelises.

### 5.4 Stub-mode pattern (interim, between this PRD and PC-1 landing)

While PC-1 is pending, GS can land a **stub** client at
`backend/services/passportOcrClient.js` that returns deterministic
synthetic values — same pattern as `backend/services/digilockerClient.js`
(commit `1babe1b`). The stub:

- Accepts the same `(file, options)` signature the real client will
- Returns canned `{ passportNumber: "P1234567", expiryDate: "2030-01-01", … }` values
- Logs `[passport-ocr-stub] upload participant=N (synthetic — pending PC-1 vendor decision + cred drop)`
- Pins the **contract** the real implementation must honour

This lets the upload route + UI + specs all ship and stay green
end-to-end on dev / demo / CI without any external dependency. Pattern
proven in the DigiLocker stub + the WhatsApp dispatch stubs (Q9). 0 cost,
~0.5 day to ship.

---

## 6. Acceptance criteria

The integration is "done" when **all 6 of the following are demonstrable**:

| # | Test | Verifies |
|---|---|---|
| AC-1 | A parent uploads a valid Indian passport JPG via the TMC microsite → 5 fields auto-populate within 30 s → parent confirms → TripParticipant row populated with vendor-extracted values + Attachment row created with encrypted image | FR-1, FR-2, FR-3, FR-5; sync-mode happy path |
| AC-2 | A parent uploads a non-Indian passport (e.g. UK / US) → same flow → MRZ-based extraction populates correctly (or routes to manual via PC-1 hybrid if chosen) | FR-2 multi-country; PC-1 vendor coverage |
| AC-3 | An operator opens "Pending verification" queue → sees side-by-side photo + extracted fields → low-confidence fields highlighted → approves → `TripParticipant.passportVerifiedAt = now()` + audit log row | FR-6 operator UI + FR-9 audit |
| AC-4 | Operator rejects an upload with reason "blurry photo" → parent receives notification (WhatsApp template after Q9 lands; email + SMS meanwhile) → parent re-uploads → flow continues | FR-7 re-upload + FR-11 notification |
| AC-5 | Parent uploads a passport with `expiryDate < today` → flag surfaces in ops dashboard + parent sees a "Passport expired — please use a renewed passport" warning + trip enrolment doesn't proceed without operator override | FR-10 expired-passport surface |
| AC-6 | Audit log shows every upload + verify + reject event with operator id + timestamp + action type — **and no field values** (field NAMES only, per PII boundary FR-9) | FR-8 PII boundary + FR-9 audit hygiene |

GS owns the e2e validation; ops + Yasin own acknowledging acceptance.

---

## 7. Out of scope

- **Visa-stamp extraction** from passport pages (a separate Phase 4 Visa
  Sure feature — visa stamps are not on the bio page that OCR processes
  here; needs multi-page passport scanning + page-classification + visa
  taxonomy).
- **Aadhaar OCR** (covered by the DigiLocker flow — see
  [DIGILOCKER_USE_CASE.md](DIGILOCKER_USE_CASE.md); intentionally separate
  because DigiLocker offers a compliance-grade non-OCR route that
  passports do not have).
- **Passport renewal reminder** (Phase 2 nice-to-have — cron checks
  `TripParticipant.passportExpiry` 6 months out + emits reminder; the
  data is already in place after this PRD ships, the reminder cron is
  trivial follow-on work).
- **ICAO photo-standards compliance check** (a visa-application security
  feature — verifies the photo meets ICAO 9303 standards for
  machine-readable travel documents; Phase 4 Visa Sure work).
- **Bulk passport upload** for ops staff (parents upload one passport at
  a time; bulk-upload — e.g. school office uploading 30 student passports
  on behalf of parents — is Phase 2).
- **Real-time face-match between passport photo and a selfie** (anti-fraud
  feature; Phase 3 Visa Sure work; not needed for the TMC + RFU initial
  scope).

---

## 8. Dependencies + downstream

### 8.1 Already shipped (this PRD does NOT need)

- **Schema:** `TripParticipant.passportNumber/Expiry/DocId` columns
  (`backend/prisma/schema.prisma:4325-4327`) — ✅ live + seeded
- **Encryption infra:** `backend/lib/fieldEncryption.js` AES-256-GCM
  (already in production for wellness PHI; passport image storage will
  use the same key + wrap pattern)
- **Attachment model:** `ContactAttachment` (and the TripParticipant
  reference `passportDocId`) — ✅ live; image storage path established
- **Audit log:** `backend/lib/audit.js` + `AuditLog` Prisma model — ✅
  live; new action types (`passport.uploaded` / `passport.verified` /
  `passport.rejected`) are additive string values
- **Retention engine:** `backend/cron/retentionEngine.js` already cleans
  GDPR-driven retention; extension to add a "passport image 30 d
  post-trip" rule is ~30 min
- **`verifyRole` + `tenantWhere` middleware:** PII boundary enforcement
  (FR-8) reuses these existing primitives

### 8.2 Orthogonal dependencies (independent of this PRD's vendor decision)

- **Q9 (WhatsApp / Wati BSP)** — needed for FR-11 rejection-notification
  via WA template. Independent of PC-1; email + SMS fallback works without
  Q9 landing first.
- **Q2 (Aadhaar consent counsel review)** — sister flow; counsel will
  likely review the passport consent text (PC-3) in the same review
  batch.

### 8.3 Downstream — what this PRD unblocks

- **TMC T10** (Passport upload with OCR extraction + manual verification)
  — flips from ⏸️ BLOCKED → ✅ SHIPPED
- **RFU R20** (Document management — passport uploads + checklist + status
  tracking) — flips from 🟡 PARTIAL → ✅ SHIPPED for the passport leg
- **Visa Sure Phase 3 B3** (visa application document checklist) — will
  reuse the exact same pipeline for VisaApplication.passportNumber +
  supporting document OCR; no second integration build
- **Travel Stall Phase 2** — to the extent Travel Stall handles
  international family-holiday bookings that need passport verification,
  same pipeline applies (TS6 "Operations — passenger data collation"
  reuses the participant flow shape)
- **Operator dashboard T15** — `submittedCount=0` placeholder for T14
  per-participant doc tracking can flip to a real value once
  passport-verification events land

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | Which vendor — Google DocAI / Azure FR / hybrid / Indian alternative? (PC-1) | Yasin (final call) + GS engineering benchmark input |
| OQ-2 | Data residency requirement — strict (India-only) or loose (global with DPA)? (PC-2) | Counsel + Yasin |
| OQ-3 | Consent text — counsel-reviewed wording for the parent-facing upload screen (PC-3) | Counsel — bundled with Q2 Aadhaar review |
| OQ-4 | Manual fallback SLA — same-day / 24h / no-SLA per sub-brand? (PC-4) | TMC + RFU + Visa Sure ops |
| OQ-5 | Re-upload attempt limit — 3 / unlimited / per-trip-type variant? (PC-5) | TMC + RFU ops |
| OQ-6 | Per-tenant monthly cost cap — default $50/mo or 1000 uploads (whichever first)? Configurable per tenant? (PC-6 — implicit) | GS engineering with Yasin sign-off |
| OQ-7 | Auto-reject threshold on low-quality images — vendor `imageQuality < N` auto-prompts re-upload without ops review, or always-operator-decide? (PC-7 — implicit) | TMC + RFU ops, after first month of real-traffic data |
| OQ-8 | If hybrid (PC-1d), where's the country-routing fallback when MRZ doesn't yield a `nationality` field? Default to Google? Or always-fall-back-to-manual? | GS engineering, only material if PC-1 = hybrid |

---

## 10. Status snapshot

- **Schema** (`TripParticipant` + `ContactAttachment` + columns) ✅ SHIPPED
- **Encryption infrastructure** (`backend/lib/fieldEncryption.js`) ✅ SHIPPED
- **Audit log infrastructure** ✅ SHIPPED
- **Retention engine extension** (30 d post-trip image purge) 🔴 NOT-STARTED (~0.5 day post-PC-1)
- **Stub client** (`backend/services/passportOcrClient.js`) 🔴 NOT-STARTED — interim ~0.5 day land; STUB-mode-ready pattern per `digilockerClient.js`
- **Vendor client real-mode** 🔴 NOT-STARTED — gated on PC-1 + cred drop (~1-1.5 days post-cred)
- **Upload route + webhook** 🔴 NOT-STARTED (~1 day post-stub-or-real)
- **Operator verification UI** 🔴 NOT-STARTED (~1.5 days post-route)
- **E2E spec + vitest** 🔴 NOT-STARTED (~1.5 days total)
- **WhatsApp rejection notification (FR-11)** ⏸️ depends on Q9 (independent; email + SMS fallback works meanwhile)

**Total engineering time post-PC-1 vendor-decision + cred-drop:**
~5 days (single-vendor) to ~6 days (hybrid). Interim stub-mode landing
~0.5 day if Yasin wants the upload route + UI in dev / demo / CI ahead
of the vendor decision.

---

**Ownership chain:**

- **Yasin** owes the vendor decision (PC-1) + the cred drop after that
  decision. ~5 min cred-chase work once PC-1 lands.
- **Counsel** owes the consent text review (PC-3) — bundled with the Q2
  Aadhaar consent counsel review.
- **TMC + RFU ops** owe the SLA / re-upload-limit decisions (PC-4, PC-5)
  + post-launch image-quality-threshold tuning (OQ-7).
- **GS engineering** owes the stub (interim) + real client (post-cred) +
  route + UI + tests + retention extension. ~5-6 days of focused work
  after PC-1 lands.
