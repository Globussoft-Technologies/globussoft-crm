# PRD — Staff / Employee Detail Depth (HR Profile Extension to User Identity)

**Status:** NOT STARTED — PRD draft only; design call required (the DD-5.1 User-extension-vs-sibling-EmployeeProfile choice + DD-5.2 statutory-ID field set + DD-5.3 RBAC visibility on salary fields determine the implementation shape materially)
**Source:** GH #852 — [Gap][STAFF-001] Staff/Employees detail depth — field-level diff vs Zylu's 26-field employee schema
**Tier:** P3 — Operator productivity / HR enablement (no traffic-blocked workflow today; operators store HR data in spreadsheets / WhatsApp groups / paper files; the cost is silent — duplication, leakage risk, no audit trail, no payroll-ready data when month-end rolls around, no compliance-ready record when an inspection happens). Material when the clinic scales past 5-10 employees + manual HR record-keeping breaks; material when statutory-compliance audits (PF, ESIC, professional tax) request employee documentation; material when an operator wants to export a payroll-ready CSV for outside accountants.
**Authored:** 2026-05-25 (tick #194 / Agent B, autonomous overnight cron arc — Bonus PRD #8 in this batch wave)
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8) · `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment governance, D9) · `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, D10) · `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery surface, D11) · `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, D12) · `PRD_AI_CHAT_HISTORY.md` (tick #192 — AI audit + recall surface, D13) · `PRD_CUSTOMER_SEGMENTS.md` (tick #193 — saved-filter audience targeting, D14)
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D15**; see §10.
**Cred dependency:** none external. Pure internal model + endpoints + admin page + encryption wiring + document-upload + tests + 4 audit-event actions.

---

## §1 Background + source attribution

The CRM today has a minimalist `User` model at [backend/prisma/schema.prisma:348-395](../backend/prisma/schema.prisma#L348-L395). Auth identity, RBAC role, 2FA, SSO, wellness sub-role, theme preference, sub-brand access. **Auth surface. Nothing HR.**

That's correct for an identity model — `User` is the JWT subject + RBAC carrier — but it's woefully incomplete as an EMPLOYEE record. Zylu (the salon CRM reference cited in #852) ships **26 fields per employee** covering statutory IDs (PAN, Aadhaar), HR metadata (DOB, joining date, employment type), payroll inputs (base salary, commission %), bank details (account number, IFSC, bank name), emergency contact, document attachments (passport scan, education certs, signed offer letter), photo, address, and notes.

Today's pattern (denormalised, lossy):

1. **Operator onboards a new wellness doctor** via `frontend/src/pages/Staff.jsx` — captures: email, name, role, wellnessRole, password. Done.
2. **Operator records the doctor's PAN / Aadhaar / bank details in a spreadsheet** — fragile (private to one operator), unauditable, accessible to nobody else when the operator is on leave.
3. **Month-end payroll** — accountant asks "give me account numbers + IFSC + base salary for all 12 doctors". Operator opens the spreadsheet → copy/paste → exports CSV → emails accountant. No audit trail of who-saw-what.
4. **PF / ESIC audit** — auditor asks "show me Aadhaar for every employee on the rolls". Operator scrambles through email + WhatsApp + paper files. Half the records are stale.
5. **Doctor resigns** — operator deletes the spreadsheet row. No record of joining-date or salary-history. New accountant can't reconcile salary YTD.
6. **Emergency** — receptionist asks "who's the emergency contact for Dr Mehta who just collapsed in the consult room?". Operator can't find it.

Per GH issue #852 verbatim:

> **Priority:** Medium
>
> **Current state:** Staff/Employees CRUD exists. Backed by `User` model — auth identity only (email, password, role, wellnessRole, name, optional 2FA + SSO + theme).
>
> **Gap:**
> Compared to Zylu's 26-field employee schema, today's `User` model misses:
> - Statutory IDs (PAN, Aadhaar / SSN equivalent per region)
> - HR metadata (DOB, joining date, end date, employment type)
> - Payroll inputs (base salary, commission %)
> - Banking (account number, IFSC, bank name)
> - Emergency contact (name, relation, phone)
> - Address (line1/2, city, state, postcode, country)
> - Document attachments (passport, education certs, signed offer letter)
> - Profile photo
> - Free-text notes
> - Tenant-custom fields
>
> **Requirements:**
> - Field-level extension to capture the 26 fields (or equivalent regional set).
> - Encryption-at-rest for PAN, Aadhaar, bank account number.
> - RBAC: USER sees only own profile (read-only); MANAGER sees own + subordinates (no salary); ADMIN sees all + edits.
> - Document upload pluggable (local-disk OR S3).
> - Audit log for create / update / document upload + salary-view (high-sensitivity field-view event).
>
> **Impact:** HR record-keeping leakage; no payroll-ready data on-demand; no audit trail; statutory-compliance fragility.
>
> **Notes:** Consider sibling model `EmployeeProfile` (1:1 with User) rather than ballooning the auth identity surface.

### Today's `User` surface vs Zylu's reference set

| Layer | Today (User) | Zylu reference (26 fields) | Gap |
|-------|--------------|----------------------------|-----|
| Identity | email, password, name, role, wellnessRole | name, email, role | — |
| HR metadata | createdAt | DOB, joiningDate, endDate, employmentType (FT/PT/Contract/Intern) | MISSING |
| Statutory IDs | (none) | PAN, Aadhaar (India) / SSN (US) / NI (UK) — region-specific | MISSING |
| Bank / payroll | (none) | bankAccountNumber, bankIfsc, bankName, baseSalaryCents, commissionPercent | MISSING |
| Personal | (none) | DOB, bloodGroup, address (line1/2/city/state/postcode/country) | MISSING |
| Emergency contact | (none) | name, relation, phone | MISSING |
| Documents | (none) | passport scan, education cert, signed offer letter, work-permit | MISSING |
| Photo | (none) | photoUrl + thumbnail | MISSING |
| Custom | (none) | per-tenant custom fields (UDF) | MISSING |
| Audit | createdAt | createdAt, updatedAt, statusHistory, salaryHistory | PARTIAL |
| 2FA / SSO | googleId, microsoftId, ssoProvider, twoFactorEnabled, twoFactorSecret, backupCodes | (Zylu: SSO only) | — |

### Why this is NOT a privacy concern (operator-side data, not patient-side)

This work is OPERATOR HR DATA — the clinic owns its employees' records. Per CLAUDE.md §Privacy + the wellness PHI policy at `project_wellness_phi_policy.md`, the PHI gate covers PATIENT data; employee HR data is operator-managed and falls outside the PHI scope. However, **statutory IDs (Aadhaar, PAN, bank account) are themselves regulated** (Aadhaar Act 2016 §29 governs storage + sharing; banking-secrecy rules govern bank account number visibility), so encryption-at-rest + RBAC-on-view + audit-on-access are non-negotiable. This is HR-hygiene, not PHI.

### Why a sibling `EmployeeProfile` model, NOT ballooning `User`?

Per DD-5.1 (recommended path): the User model is the AUTH IDENTITY — JWT-subject, RBAC-carrier, 2FA-anchor, SSO-anchor. Twelve fields max; tight scope; loaded into req.user on every request. Extending it with 26 HR fields:

- Bloats the JWT-decode + req.user-load path with HR fields nobody needs on 99% of API calls (only the EmployeeProfile detail page needs the HR fields).
- Mixes the auth surface (security-critical) with HR surface (business-data) — different change cadences, different audit semantics, different RBAC contracts.
- Forces every existing User-related query to either select-out the new fields or carry 30 unnecessary fields in memory.
- Encryption-on-User-fields complicates the password-hash + 2FA-secret encryption story (different keys / different rotation / different access patterns).

A sibling `EmployeeProfile` model with a 1:1 FK to User cleanly separates concerns. Auth queries hit User (unchanged); HR queries hit `EmployeeProfile` (new + only when needed). Encryption applies to `EmployeeProfile` fields without touching User. Audit events partition cleanly: `USER_*` vs `EMPLOYEE_PROFILE_*`. The User model stays minimal + auditable; the HR surface grows independently.

### Source attribution

- GH issue #852 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/852](https://github.com/Globussoft-Technologies/globussoft-crm/issues/852)
- `backend/prisma/schema.prisma:348-395` — current `User` model
- `backend/routes/staff.js` — current staff CRUD endpoints (lists, creates, edits the User row)
- `frontend/src/pages/Staff.jsx` — current operator UI for staff management
- `backend/lib/fieldEncryption.js` — AES-256-GCM helper (already shipped per v3.1 wellness PHI work) — re-used here for PAN / Aadhaar / bank account
- `backend/prisma/schema.prisma:4061` — existing `CommissionProfile` model — REUSE via FK link rather than duplicating commission scheme into EmployeeProfile
- `backend/prisma/schema.prisma:3663` — existing `Attendance` model — sibling; out-of-scope for this PRD per §7
- `backend/prisma/schema.prisma:795` — existing `Attachment` model — re-used as the polymorphic document storage for EmployeeProfile documents
- `backend/lib/audit.js` `writeAudit()` — new `EMPLOYEE_PROFILE_*` action set flows through the existing tamper-evident chain
- `routes/wellness.js` photo-upload pattern — re-used for EmployeeProfile photo + documents

---

## §2 Use cases

1. **ADMIN onboards a new wellness doctor — captures full HR profile in one form.** ADMIN navigates `/staff` → "Add Staff" → 2-step modal: Step 1 captures auth identity (name, email, password, role=USER, wellnessRole=doctor, sub-brand access). Step 2 captures the HR profile: PAN, Aadhaar, DOB, joiningDate, employmentType=FULL_TIME, baseSalaryCents=8500000 (₹85,000/month), commissionPercent=15, bankAccountNumber (masked-after-save), bankIfsc, bankName, emergencyContact (name + relation + phone), address (line1/2/city/state/postcode/country), bloodGroup=B+, notes. Uploads photo + signed offer letter PDF + Aadhaar scan. Saves. Audit chain captures `EMPLOYEE_PROFILE_CREATED` + `EMPLOYEE_PROFILE_DOC_UPLOADED ×3`. Sensitive fields (PAN / Aadhaar / bank account) are encrypted at rest via `fieldEncryption.js`.

2. **Accountant exports payroll CSV — bank account + IFSC + base salary + commission %.** Month-end. Accountant (role=MANAGER with `payrollExportEnabled=true` per Q3) navigates `/staff/payroll-export` → selects month → clicks Export → backend returns CSV with columns: name, email, employeeCode, bankAccountNumber, bankIfsc, bankName, baseSalaryCents, commissionPercent, joiningDate, employmentType. Accountant sends to outside payroll service. Audit chain captures `EMPLOYEE_SALARY_VIEWED ×12` (one per row) — high-sensitivity field-view audit kept indefinitely per §4. Bank account number visibility is governed by Q3 (masking last-4 to MANAGER, full to ADMIN — operator-configurable).

3. **Compliance — Aadhaar visible only to ADMIN.** A doctor's Aadhaar is requested for PF / ESIC filing. ADMIN navigates that doctor's `/staff/<userId>/profile` → views the Aadhaar field (decrypted from `fieldEncryption.js`). Audit chain captures `EMPLOYEE_AADHAAR_VIEWED`. A MANAGER on the same page sees `Aadhaar: ****-****-1234` (last-4 only, per Q3). A USER (the doctor themselves) viewing their own profile sees full Aadhaar (their own data, no privacy concern); viewing OTHER doctors' profile returns 403.

4. **Emergency — receptionist needs emergency contact for an unconscious doctor.** Doctor collapses in the consult room. Receptionist (role=USER, wellnessRole=helper) navigates `/staff/<userId>/profile` for that doctor — gets 403 (only own profile readable by USER). Receptionist asks a MANAGER on duty → MANAGER opens the profile → sees emergency contact (name + relation + phone) → calls. Audit chain captures `EMPLOYEE_PROFILE_VIEWED`. **Per Q5, emergency contact MAY be exempted from the USER-only-own-profile rule** — surface a per-tenant config flag `emergencyContactVisibleToAll Boolean @default(false)`.

5. **Document attachments — passport / education certs / signed offer letter / work-visa.** ADMIN onboards a foreign-national doctor (UAE clinic). Uploads passport scan + medical-degree cert + signed offer letter + work-visa scan. Per Q4 (recommended YES): each document has an expiryDate column. The visa expires in 18 months. Cron `documentExpiryEngine.js` (out-of-scope per §7 — Phase 2) flags expiring documents at T-60d / T-30d / T-7d. ADMIN gets an in-app notification + email.

---

## §3 Functional requirements

### FR-3.1 New Prisma model `EmployeeProfile` (1:1 with User)

```prisma
model EmployeeProfile {
  id                    Int       @id @default(autoincrement())
  userId                Int       @unique // 1:1 FK; cascade-delete on User deletion
  tenantId              Int       // denormalised for scope-by-tenant queries

  // HR metadata
  employeeCode          String?   // operator-chosen short code, e.g. "DR-MEHTA-01"
  dob                   DateTime?
  joiningDate           DateTime?
  endDate               DateTime?
  employmentType        String?   // 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERN' | 'CONSULTANT'
  bloodGroup            String?   // 'A+' | 'A-' | 'B+' | ... | 'O-' (8 ABO-Rh combos)

  // Statutory IDs (encrypted-at-rest via fieldEncryption.js per FR-3.4)
  panNumberEncrypted    String?   @db.Text
  aadhaarEncrypted      String?   @db.Text
  // Future regional extensions (per Q1) — keep as nullable additive columns:
  // ssnEncrypted (US) / niEncrypted (UK) / iqamaEncrypted (Saudi) — Phase 2

  // Bank / payroll (PII; encrypted-at-rest)
  bankAccountEncrypted  String?   @db.Text
  bankIfsc              String?   // routing code — not encrypted (low PII)
  bankName              String?
  baseSalaryCents       Int?      // monthly base salary in tenant default currency cents
  commissionProfileId   Int?      // FK to existing CommissionProfile (link, do NOT duplicate)

  // Personal
  addressJson           String?   @db.Text // JSON-stringified: { line1, line2, city, state, postcode, country }
  emergencyContactJson  String?   @db.Text // JSON-stringified: { name, relation, phone }
  photoUrl              String?   // FK-equivalent to Attachment.id OR direct S3 / local path
  notes                 String?   @db.Text
  customFieldsJson      String?   @db.Text // JSON-stringified: per-tenant UDF map

  // Audit + timestamps
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  createdByUserId       Int?      // who created this profile (typically ADMIN)
  lastEditedByUserId    Int?      // who last edited
  lastEditedAt          DateTime?

  user                  User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant                Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  commissionProfile     CommissionProfile? @relation(fields: [commissionProfileId], references: [id])

  // Polymorphic Attachment links (documents) via dedicated join table — FR-3.6
  documents             EmployeeProfileDocument[]

  @@unique([tenantId, employeeCode])
  @@index([tenantId])
  @@index([commissionProfileId])
}

model EmployeeProfileDocument {
  id                Int      @id @default(autoincrement())
  employeeProfileId Int
  attachmentId      Int      // FK to existing Attachment model
  documentType      String   // 'PASSPORT' | 'AADHAAR_SCAN' | 'PAN_SCAN' | 'EDUCATION_CERT' | 'OFFER_LETTER' | 'WORK_VISA' | 'OTHER'
  documentLabel     String?  // operator-chosen label, e.g. "MBBS certificate (KGMC 2018)"
  expiryDate        DateTime? // YES for passport / work-visa; NULL for Aadhaar / PAN / certs (no expiry)
  uploadedAt        DateTime @default(now())
  uploadedByUserId  Int

  employeeProfile   EmployeeProfile @relation(fields: [employeeProfileId], references: [id], onDelete: Cascade)
  attachment        Attachment      @relation(fields: [attachmentId], references: [id], onDelete: Cascade)

  @@index([employeeProfileId])
  @@index([attachmentId])
  @@index([expiryDate]) // for the Phase 2 documentExpiryEngine cron
}
```

Additive — no existing data needs backfill (greenfield). Schema passes `migration_check` gate without bless markers (additive only, all FKs are SET-cascade-safe).

**User.employeeProfile relation:** add to existing User model — `employeeProfile EmployeeProfile?` (back-relation; nullable; doesn't bloat User row data, just enables the include).

### FR-3.2 New routes — `backend/routes/employees.js`

| Method | Path                                          | Auth gate                                              | Behaviour                                                                 |
|--------|-----------------------------------------------|--------------------------------------------------------|---------------------------------------------------------------------------|
| GET    | `/api/employees/:userId/profile`              | `verifyToken` + visibility check (FR-3.3)              | Read EmployeeProfile by userId. Decrypts statutory IDs per RBAC scope (FR-3.3). Writes `EMPLOYEE_PROFILE_VIEWED` audit. |
| PUT    | `/api/employees/:userId/profile`              | `verifyToken` + `verifyRole(['ADMIN'])` OR self-edit on own profile (FR-3.3) | Upsert (create-or-update) EmployeeProfile. Encrypts statutory ID fields. Writes `EMPLOYEE_PROFILE_CREATED` or `_UPDATED` audit. |
| POST   | `/api/employees/:userId/documents`            | `verifyToken` + `verifyRole(['ADMIN'])`                | Upload a new document. Multipart form: `file`, `documentType`, `documentLabel`, `expiryDate?`. Stores via Attachment (local-disk OR S3 per DD-5.4). Writes `EMPLOYEE_PROFILE_DOC_UPLOADED` audit. |
| DELETE | `/api/employees/:userId/documents/:docId`     | `verifyToken` + `verifyRole(['ADMIN'])` + ownership-check | Delete a document. Writes `EMPLOYEE_PROFILE_DOC_DELETED` audit. |
| GET    | `/api/employees/:userId/documents/:docId/file`| `verifyToken` + visibility check                       | Stream the document file. Writes `EMPLOYEE_PROFILE_DOC_VIEWED` audit. |
| GET    | `/api/employees/payroll-export`               | `verifyToken` + `verifyRole(['ADMIN'])` (+ MANAGER if Q3 path b) | CSV download — bank + salary + commission% for all tenant employees. Writes `EMPLOYEE_SALARY_VIEWED ×N` audits (one per row). |
| POST   | `/api/employees/:userId/profile/photo`        | `verifyToken` + `verifyRole(['ADMIN'])` OR self-upload | Upload + crop + thumbnail photo. Replaces existing photoUrl. Writes `EMPLOYEE_PROFILE_PHOTO_UPLOADED` audit. |

Cross-tenant guard: every endpoint scopes by `req.user.tenantId` AND verifies target User belongs to same tenant before any read/write. Per CLAUDE.md `tenantWhere` helper pattern. ESLint rule blocks `req.body.tenantId`.

### FR-3.3 RBAC: USER sees own / MANAGER sees own + subordinates (no salary) / ADMIN sees all + edits

| Field group | USER reads own | USER reads other | MANAGER reads any | ADMIN reads any | USER edits own | ADMIN edits any |
|-------------|----------------|------------------|-------------------|-----------------|----------------|-----------------|
| Identity (name, email, role) | YES | NO (403) | YES | YES | NO (admin-managed) | YES |
| Personal (DOB, bloodGroup, address) | YES | NO | YES | YES | YES (own only — Q6) | YES |
| Statutory IDs (PAN, Aadhaar) | YES (full) | NO | YES (last-4 masked, per Q3) | YES (full) | NO | YES |
| Bank account | YES (full, own only) | NO | YES (last-4 masked, per Q3) | YES (full) | YES (own only — Q7) | YES |
| Bank IFSC + Bank name | YES | NO | YES | YES | YES | YES |
| Base salary | YES (own only) | NO | NO (hidden) | YES | NO | YES |
| Commission % | YES (own only) | NO | NO (hidden) | YES | NO | YES |
| Emergency contact | YES (own) | NO (per default Q5 — toggle-able) | YES | YES | YES | YES |
| Notes | NO (admin-only) | NO | NO | YES | NO | YES |
| Documents | YES (own — read + delete-own per Q8) | NO | YES (read) | YES (read + edit + delete) | UPLOAD own per Q8 | YES |
| Payroll export | NO | — | Path B per Q3 — YES with explicit per-user flag | YES | — | — |

**ADMIN role bypasses all visibility checks within their tenant.** Cross-tenant access is structurally impossible (every query scoped by tenantId).

**Wellness sub-role (doctor / professional / telecaller / helper) DOES NOT affect EmployeeProfile RBAC** — wellness sub-role drives clinical-data PHI gating, NOT HR-data visibility. The RBAC scope on EmployeeProfile is RBAC-role only (USER / MANAGER / ADMIN).

### FR-3.4 Encryption-at-rest for PAN / Aadhaar / bank account

Three fields go through `backend/lib/fieldEncryption.js` (existing AES-256-GCM helper shipped v3.1):

- `panNumberEncrypted` — encrypted at write; decrypted at read per RBAC scope.
- `aadhaarEncrypted` — encrypted at write; decrypted at read per RBAC scope.
- `bankAccountEncrypted` — encrypted at write; decrypted at read per RBAC scope.

Encryption key sourced from `WELLNESS_FIELD_KEY` env var (already in deploy + local-dev `.env`). Key rotation: when `WELLNESS_FIELD_KEY` rotates, a one-shot `backend/scripts/rotate-employee-profile-encryption.js` re-encrypts in-place (read with old key + write with new key). Out-of-scope for v1 — Phase 2.

**Masking on read** (per FR-3.3): MANAGER reads return last-4 chars only (e.g. `"****-****-1234"`); ADMIN reads return full. The route inspects `req.user.role` + applies masking before returning the response. Audit chain captures the full action (`EMPLOYEE_AADHAAR_VIEWED` / `EMPLOYEE_BANK_VIEWED`) regardless of mask status.

### FR-3.5 Document upload — pluggable local-disk + S3 backends

Re-uses the existing `Attachment` model + storage pattern shipped for wellness photo-upload at `backend/routes/wellness.js`. New `EmployeeProfileDocument` join table (FR-3.1) links EmployeeProfile → Attachment with `documentType` + `documentLabel` + `expiryDate` metadata.

**Per DD-5.4:** v1 ships local-disk-default; S3 backend is a pluggable option toggled by `EMPLOYEE_DOC_STORAGE=local|s3` env var. Both backends conform to the `Attachment.storageProvider` field already shipped.

**Upload limits:** photo ≤2 MB (jpg/png only); documents ≤5 MB (pdf/jpg/png). Enforced server-side via Multer's `limits.fileSize` + MIME-type allowlist. Larger documents (passport+work-visa combo PDFs sometimes exceed 5 MB) → operator splits into multiple uploads.

### FR-3.6 Audit log integration

New audit chain entity `EMPLOYEE_PROFILE` with actions (mirrors AI_HISTORY taxonomy from PRD_AI_CHAT_HISTORY.md):

- `EMPLOYEE_PROFILE_CREATED` — on first PUT /api/employees/:userId/profile creating a row
- `EMPLOYEE_PROFILE_UPDATED` — on subsequent PUT (incl. salary / bank / address / emergency-contact changes)
- `EMPLOYEE_PROFILE_VIEWED` — on GET /api/employees/:userId/profile (throttled — once per (session-id, target-userId) per 5 min, per Q9)
- `EMPLOYEE_PROFILE_DOC_UPLOADED` — on POST /api/employees/:userId/documents
- `EMPLOYEE_PROFILE_DOC_DELETED` — on DELETE /api/employees/:userId/documents/:docId
- `EMPLOYEE_PROFILE_DOC_VIEWED` — on GET /api/employees/:userId/documents/:docId/file (throttled per same scheme)
- `EMPLOYEE_PROFILE_PHOTO_UPLOADED` — on POST /api/employees/:userId/profile/photo
- `EMPLOYEE_AADHAAR_VIEWED` — on read of decrypted Aadhaar (NOT throttled — high-sensitivity field-view)
- `EMPLOYEE_PAN_VIEWED` — on read of decrypted PAN (NOT throttled)
- `EMPLOYEE_BANK_VIEWED` — on read of decrypted bank account (NOT throttled)
- `EMPLOYEE_SALARY_VIEWED` — on read of baseSalary OR commissionPercent (NOT throttled)
- `EMPLOYEE_PAYROLL_EXPORTED` — on /api/employees/payroll-export (with row count metadata)

All events go through `backend/lib/audit.js` `writeAudit()` for tamper-evident hashing. **Salary + statutory-ID + bank view events are kept INDEFINITELY** (no retention purge) per compliance — `retentionEngine.js` retention policy excludes `EMPLOYEE_*_VIEWED` actions.

### FR-3.7 New frontend page — `frontend/src/pages/admin/EmployeeProfile.jsx` linked from Staff page

- **Route registration** in `frontend/src/App.jsx`: `/staff/:userId/profile`. Lazy-loaded.
- **Sidebar entry:** none directly — accessed via the existing Staff page's per-row "Profile" link.
- **Header strip:** photo (large, with Edit overlay for ADMIN/self) + name + role + wellnessRole + email + employmentType pill + joiningDate.
- **Tab strip** (mirrors PatientDetail.jsx pattern):
  - **Personal** (default) — DOB, bloodGroup, address, emergency contact.
  - **Statutory IDs** — PAN, Aadhaar (region-aware per Q1; future Phase 2 surfaces SSN/NI/Iqama).
  - **Bank / Payroll** — bankAccountNumber (masked-after-save), bankIfsc, bankName, baseSalary, commissionPercent + CommissionProfile picker.
  - **Documents** — document table with type / label / expiryDate / uploadedAt / uploaded-by-user; "Upload" button.
  - **Audit log** — per-employee audit trail (filtered from main audit log to action=`EMPLOYEE_*` AND targetUserId=:userId).
  - **Notes** — free-text notes (ADMIN-only — per FR-3.3).
- **Edit affordance** — each tab has an Edit button (gated per FR-3.3 RBAC). Save calls PUT /api/employees/:userId/profile. Audit chain captures `EMPLOYEE_PROFILE_UPDATED` with field-level diff in `meta`.
- **Document upload modal** — multi-step: pick file → pick type → optional label + expiryDate → upload. Shows progress bar. Server validates MIME + size before persistence.

Lazy-loaded per existing App.jsx pattern. ~30-50 KB gzipped (form fields + document table + audit log table).

### FR-3.8 Staff page integration — link to EmployeeProfile

`frontend/src/pages/Staff.jsx` (existing) gains a per-row "Profile" link icon in the actions column. Clicking opens `/staff/:userId/profile`.

Additionally, the existing Staff "Add Staff" + "Edit Staff" modals are EXTENDED with a Step 2: HR profile fields. Step 1 stays (auth identity). Step 2 captures all EmployeeProfile fields. Both steps post in a single POST /api/staff transaction that creates User + EmployeeProfile atomically.

For backward compatibility, if Step 2 is skipped (operator just creates a User without HR profile), EmployeeProfile row is NOT created. Subsequent PUT /api/employees/:userId/profile creates the row on-demand.

### FR-3.9 Payroll CSV export

`GET /api/employees/payroll-export?month=YYYY-MM` (ADMIN-only by default; MANAGER per Q3 path b).

CSV columns:

- employeeCode, name, email, wellnessRole, employmentType, joiningDate
- baseSalaryCents (in cents per tenant default currency)
- commissionPercent
- bankAccountNumber (full — never masked in export; export is gated to ADMIN+ + audit-trail captures the export)
- bankIfsc, bankName
- panNumber (full — same gating)
- (regional fields per Q1 — Phase 2)

The export captures membership at request-time. Audit chain captures `EMPLOYEE_PAYROLL_EXPORTED { rowCount, month }` + `EMPLOYEE_SALARY_VIEWED ×N` (per row).

### FR-3.10 Self-edit affordance for non-ADMIN users

Per FR-3.3 + Q6/Q7, USER can edit own personal data (address, emergency contact, bank, DOB) but NOT own salary, commission, or statutory IDs (those stay ADMIN-managed). Operator-facing affordance: the EmployeeProfile page detects `req.user.userId === route.userId` + surfaces an Edit button on Personal tab + Bank tab + Documents tab; hides Edit on Statutory IDs tab + Bank Payroll fields (baseSalary / commissionPercent).

---

## §4 Non-functional

- **Per-tenant scoping enforced.** Every endpoint scopes by `req.user.tenantId`; target userId must belong to same tenant (cross-tenant access returns 404 — not 403, to avoid existence-disclosure).
- **Encryption.** PAN, Aadhaar, bank account ≥ AES-256-GCM via existing `lib/fieldEncryption.js`. Key in `WELLNESS_FIELD_KEY` env var (already deployed).
- **Audit retention.** `EMPLOYEE_*_VIEWED` (salary, statutory-ID, bank) events kept INDEFINITELY (compliance). Other `EMPLOYEE_PROFILE_*` events flow through normal retentionEngine policy (default 365d, per-tenant configurable).
- **Upload size limits.** Photo: jpg/png max 2 MB. Documents: pdf/jpg/png max 5 MB. MIME-type allowlist server-side; client-side reject before upload.
- **The new model is ADDITIVE** to User — zero schema change to User itself (just a back-relation declaration). Passes `migration_check` gate without bless markers.
- **Read latency.** EmployeeProfile detail load (FR-3.7) P95 target <600ms — single Prisma query with includes; field decryption ~5-10ms per encrypted field; 3 encrypted fields = ~30ms total. Tail latency from photo + document attachment load is decoupled (lazy-loads on the Documents tab).
- **Storage cost.** Per employee: ~2 KB row + 200 KB photo + ~5 MB × 4 docs typical = ~20 MB/employee. Per tenant of 20 employees = ~400 MB. Across 50 tenants = 20 GB total storage. Local-disk fine for now; S3 for multi-tenant scale (DD-5.4).
- **Browser bundle.** New page lazy-loaded; ~30-50 KB gzipped.
- **Mobile responsive.** Tab strip degrades to dropdown at <768px. Document table degrades to card list. Form fields stack vertically.
- **i18n-ready.** All operator-facing labels route through `LanguageSwitcher.jsx`. Employee names + addresses are user-content (NOT translated).
- **PII discipline.** Photo URLs are NOT sensitive (typically a smiling headshot); statutory IDs + bank are sensitive (encrypted + RBAC-gated + audit-logged on view).
- **Backward compatibility.** Existing Staff CRUD continues to work unchanged. EmployeeProfile is purely additive — if a tenant never creates an EmployeeProfile for a User, that User behaves exactly as today.
- **PHI policy.** Per `project_wellness_phi_policy.md`, employee HR data is OPERATOR-OWNED and outside the PHI gate (which covers PATIENT data). EmployeeProfile is NOT gated by `phiReadGate`; it IS gated by the RBAC scope per FR-3.3.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / engineering sign-off before any code lands)

- **DD-5.1 User model extension vs sibling EmployeeProfile model.** Two paths:
  - **(a) BALLOON USER.** Add the 26 HR fields directly to `User`. Pro: simpler — one model; auth identity + HR profile in one row. Con: bloats every JWT-decode + req.user-load with HR fields; mixes auth + HR change cadences; complicates encryption (mixing password-hash with HR encryption keys); forces every existing User query to handle 30 unnecessary fields.
  - **(b) SIBLING EmployeeProfile (current proposal).** New model `EmployeeProfile` with 1:1 FK to User. Pro: clean separation; auth surface stays minimal + auditable; HR surface grows independently; encryption applies only to EmployeeProfile fields; audit events partition cleanly. Con: 1 extra Prisma include on the detail page; slightly more complex schema (1 new model + 1 join table for documents).
  - **(c) HYBRID — minor HR fields on User, sensitive HR fields on sibling.** Photo + DOB on User; PAN / Aadhaar / bank / salary on EmployeeProfile. Pro: simpler queries for cheap fields. Con: arbitrary partition — what counts as "minor"? Drift over time.
  - **Recommendation: (b) SIBLING EmployeeProfile.** Cleanest separation; matches CLAUDE.md "User is auth identity" pattern; lets HR + auth evolve independently.

- **DD-5.2 Statutory ID field set — region-aware single set (current proposal: India-default PAN+Aadhaar) vs multi-region polymorphic.** Two paths:
  - **(a) INDIA-DEFAULT.** Ship PAN + Aadhaar in v1; add region-specific columns (SSN/NI/Iqama) as nullable additive in Phase 2. Pro: simpler v1; matches the current production tenants (all Indian); incremental rollout. Con: clunky to extend per region in the future; nullable column proliferation.
  - **(b) POLYMORPHIC `EmployeeStatutoryId { userId, idType, idValueEncrypted }`.** Pro: arbitrarily extensible per region without schema change; one row per ID type. Con: harder to query ("show me all Aadhaars" requires join + filter); operator UX has to handle "add another statutory ID" affordance.
  - **(c) JSON-BLOB `statutoryIdsJson String? @db.Text`.** Pro: ultimate flexibility; no schema migration per new region. Con: hard to audit field-level access; hard to encrypt-per-field; can't index.
  - **Recommendation: (a) INDIA-DEFAULT for v1.** Today's tenants are India-only; ship PAN + Aadhaar; revisit (b) polymorphic in Phase 2 once a UAE / US / UK tenant lands.

- **DD-5.3 RBAC visibility on salary — strict MANAGER+ (current proposal) or operator-configurable.** Two paths:
  - **(a) STRICT MANAGER+ HIDES SALARY (current proposal, FR-3.3).** MANAGER role does NOT see baseSalary / commissionPercent — only ADMIN sees. Pro: salary stays tightly held; reduces operator-side gossip risk. Con: some tenants want managers to see their team's salary (e.g. for performance reviews).
  - **(b) OPERATOR-CONFIGURABLE.** Per-tenant flag `managerSeesSalaryEnabled Boolean @default(false)`. ADMIN toggles per business preference. Pro: tenant-flexibility. Con: surface complexity; tracking which tenants opted in becomes ops complexity.
  - **(c) PER-USER FLAG.** Per-MANAGER flag `payrollVisibilityEnabled` so only specific managers (typically HR head / payroll-admin) get salary visibility. Pro: most granular. Con: even more surface.
  - **Recommendation: (a) STRICT MANAGER+ for v1; (c) per-user flag in Phase 2 if real demand surfaces.** Default to privacy; let operators opt-in to looser controls when business demands.

- **DD-5.4 Document storage backend — local-disk default with pluggable S3 (current proposal) vs S3-only.** Two paths:
  - **(a) LOCAL-DISK DEFAULT + S3 OPT-IN (current proposal, FR-3.5).** Env var `EMPLOYEE_DOC_STORAGE=local|s3`. Pro: zero infra dependency for self-hosted tenants; matches existing photo-upload pattern; cheap. Con: backup + multi-server replication is operator's problem.
  - **(b) S3-ONLY.** Force all document storage to S3 (or compatible). Pro: scales infinitely; multi-server-ready; backup is S3's problem. Con: requires AWS creds per tenant; cost; not feasible for self-hosted-air-gapped tenants.
  - **Recommendation: (a) LOCAL-DISK + S3 OPT-IN.** Matches existing pattern; lets self-hosted tenants stay simple; large-scale tenants migrate to S3 when needed.

- **DD-5.5 Commission scheme — link to existing CommissionProfile (current proposal) vs duplicate scheme on EmployeeProfile.** Two paths:
  - **(a) FK LINK (current proposal).** EmployeeProfile.commissionProfileId FK → CommissionProfile. Pro: single source of truth; commission rules don't drift per employee; matches existing model. Con: cap on commission expression flexibility (whatever CommissionProfile supports).
  - **(b) DUPLICATE INLINE.** EmployeeProfile has its own commission-scheme columns. Pro: max flexibility; per-employee custom schemes possible. Con: schema bloat; data-drift risk; loses the existing CommissionProfile abstraction.
  - **Recommendation: (a) FK LINK.** Re-use existing model; consistent commission abstraction across employees + services.

- **DD-5.6 Contract employee (employmentType=CONTRACT) — same form OR separate sub-form?** Two paths:
  - **(a) SAME FORM (current proposal).** Contract employees fill the same EmployeeProfile form; some fields stay null (e.g. baseSalary if paid per-invoice). Pro: simpler operator UX; one consistent form. Con: contract-specific fields like "issues invoices to clinic" / "GST registration number" / "vendor agreement attached" aren't first-class.
  - **(b) SEPARATE SUB-FORM.** When employmentType=CONTRACT, surface a sub-form with contractor-specific fields (GST number, vendor agreement, hourly-rate vs flat-fee, invoice cadence). Pro: contract-relationship is materially different from employment-relationship; HR audit cleanly separates them. Con: schema complexity; sub-form surface area.
  - **Recommendation: (b) SEPARATE SUB-FORM in Phase 2.** v1 ships same-form (recommendation a); Phase 2 evaluates whether contract-specific fields warrant a `ContractorAgreement` sub-model based on real operator pain.

### Cred chase

- **None external for v1.** Pure internal model + endpoints + page + encryption + 4 audit-event actions.
- **Phase 2 multi-region (DD-5.2) — needs SSN/NI/Iqama field requirements per region; minor cred chase on UK/Saudi statutory-data legality.**

### Vendor docs

- N/A for v1. Internal pattern reuse only.
- **Internal doc dependency:** `lib/fieldEncryption.js` (existing) — re-used as-is. New `lib/employeeProfileAccess.js` documents the RBAC scope rules (FR-3.3) for future contributors.
- **Internal doc dependency:** the `frontend/src/pages/admin/EmployeeProfile.jsx` header JSDoc documents the tab structure + per-tab RBAC + audit-event mapping.

---

## §6 Acceptance criteria

- **AC-6.1** ADMIN navigates Staff page → clicks "Add Staff" → fills Step 1 (auth identity) + Step 2 (HR profile incl. PAN / Aadhaar / bank account / baseSalary / commissionPercent / emergencyContact / address / DOB / joiningDate / employmentType=FULL_TIME) → uploads photo + signed offer letter + Aadhaar scan → saves. User row + EmployeeProfile row + 3 EmployeeProfileDocument rows + 4 audit events (`EMPLOYEE_PROFILE_CREATED`, `EMPLOYEE_PROFILE_DOC_UPLOADED ×3`) created atomically. PAN + Aadhaar + bank account are encrypted in DB (verify via raw SQL — column value is opaque hex/b64, NOT plain text).

- **AC-6.2** MANAGER navigates EmployeeProfile of any tenant employee → reads Personal + Statutory IDs (masked: `"****-****-1234"`) + Bank (masked) → CANNOT see Base Salary / Commission % (field hidden in UI + 403 on raw API call). USER (the employee themselves) navigates own EmployeeProfile → sees all fields including own salary (full). USER attempts to read another USER's profile → 403. ADMIN sees everything across all employees in tenant.

- **AC-6.3** ADMIN navigates `/api/employees/payroll-export?month=2026-05` → CSV downloads with all employees + full PAN + full bank account + baseSalary + commissionPercent. Audit chain captures `EMPLOYEE_PAYROLL_EXPORTED { rowCount, month }` + `EMPLOYEE_SALARY_VIEWED ×N` events. MANAGER attempts same endpoint → 403 (unless Q3 path b operator-configured for this MANAGER). USER attempts → 403.

- **AC-6.4** USER navigates own EmployeeProfile → edits address + emergency contact → saves successfully (audit captures `EMPLOYEE_PROFILE_UPDATED { changedFields: ['address', 'emergencyContact'] }`). USER attempts to edit own baseSalary via raw API → 403 (only ADMIN can edit salary). USER attempts to edit own PAN via raw API → 403 (only ADMIN can edit statutory IDs).

- **AC-6.5** Document upload: ADMIN uploads a 5.2 MB PDF → server returns 413 (file too large). ADMIN uploads a 3 MB exe file → server returns 415 (MIME-type not in allowlist). ADMIN uploads a valid 2 MB jpg as photo + 4 MB pdf as Aadhaar scan → both succeed; thumbnail generated for photo; audit captures `EMPLOYEE_PROFILE_PHOTO_UPLOADED` + `EMPLOYEE_PROFILE_DOC_UPLOADED`. ADMIN deletes a document → file removed from disk/S3 + DB row deleted + audit captures `EMPLOYEE_PROFILE_DOC_DELETED`. Cross-tenant access: tenant A ADMIN tries `GET /api/employees/<tenant-B-userId>/profile` → 404 (not 403; existence-disclosure prevention).

---

## §7 Out of scope

- **Payroll calculation engine** (compute month-end salary including attendance + leave + commission earnings + tax deductions + PF/ESIC withholdings + net-pay generation). Phase 2 — separate PRD (`PRD_PAYROLL.md`, not yet written). THIS PRD captures the INPUTS to payroll (baseSalary + commissionPercent + bank); payroll output stays manual via CSV export.
- **Attendance + Leave tracking** — already covered by existing `Attendance` model + Leave models. Out of scope here; EmployeeProfile is the HR-detail layer, NOT the attendance layer.
- **Performance reviews / appraisals** — separate Phase 2 feature.
- **Onboarding workflow** (e.g. multi-step approval before employee row is created — HR drafts → manager reviews → ADMIN approves). Phase 2.
- **Off-boarding workflow** (deactivation + final settlement + exit interview + access revocation). Phase 2.
- **Multi-region statutory IDs** (SSN/NI/Iqama). Per DD-5.2 deferred to Phase 2.
- **Document expiry cron** (`documentExpiryEngine.js` flagging expiring passport / work-visa at T-60d / T-30d / T-7d). Phase 2 — explicit Q4 path (a).
- **Contractor sub-form** (employmentType=CONTRACT-specific fields like GST registration number, vendor agreement, hourly-rate vs flat-fee, invoice cadence). Per DD-5.6 deferred to Phase 2.
- **Self-onboarding portal** (employee invited via email, completes own EmployeeProfile, ADMIN approves). Phase 3.
- **Encryption-key rotation** (rotating `WELLNESS_FIELD_KEY` + re-encrypting all EmployeeProfile rows). Phase 2 — one-shot `rotate-employee-profile-encryption.js` script.
- **Field-level audit history** (who changed `baseSalary` from 80000 → 85000 on what date — beyond what the existing audit log captures). Phase 2 — needs an EmployeeProfileChangeLog model.
- **Multi-currency baseSalary** (today: cents in tenant default currency only). Phase 2 — needs to honour Tenant.defaultCurrency + per-employee override.
- **External HR integrations** (Zoho People, BambooHR, GreytHR sync). Phase 3 — overlaps with `PRD_INTEGRATIONS_HUB.md`.
- **Travel-vertical employee variant** (TMC sales rep / RFU operator / Visa Sure consultant with sub-brand-specific commission schemes). v1 ships generic + wellness only; travel variant in Phase 2.
- **Employee-org-chart visualisation** (reporting-manager tree, hierarchical view). Phase 2.

---

## §8 Dependencies

- **`User` model** at `backend/prisma/schema.prisma:348-395` — gains a back-relation `employeeProfile EmployeeProfile?` (no field changes).
- **`backend/lib/fieldEncryption.js`** — re-used as-is for PAN + Aadhaar + bank account encryption.
- **`backend/lib/audit.js` `writeAudit()`** — new `EMPLOYEE_PROFILE_*` action set flows through the existing tamper-evident chain. No schema change.
- **`backend/middleware/auth.js`** `verifyToken` + `verifyRole` — gates the new endpoints.
- **`backend/routes/staff.js`** (existing) — extended to surface a "Profile" link in the list response + post EmployeeProfile alongside User on `POST /api/staff` (atomic).
- **`backend/routes/audit.js`** `/verify` endpoint — accepts the EMPLOYEE_PROFILE_* event family without code change (entity = `EMPLOYEE_PROFILE`, actions per FR-3.6).
- **`backend/routes/retention.js`** (or retentionEngine config) — `EMPLOYEE_*_VIEWED` actions excluded from retention purge (kept indefinitely).
- **Existing `CommissionProfile` model** at `backend/prisma/schema.prisma:4061` — FK target for EmployeeProfile.commissionProfileId.
- **Existing `Attachment` model** at `backend/prisma/schema.prisma:795` — re-used as document storage; linked via new `EmployeeProfileDocument` join table.
- **Existing `Tenant` model** at `backend/prisma/schema.prisma:58` — FK target for EmployeeProfile.tenantId.
- **`WELLNESS_FIELD_KEY` env var** — already deployed; no new ops setup.
- **`EMPLOYEE_DOC_STORAGE=local|s3` env var** — new; defaults to `local`; documented in `.env.example`.
- **Multer middleware** (already in dependencies) — file upload with size + MIME-type limits.
- **Lucide icons** (already in dependencies) — `User`, `FileText`, `Lock`, `Eye`, `EyeOff`, `Upload`, `Download`, `Trash2`.
- **`React.lazy()` code-splitting** per existing App.jsx pattern.
- **New file `backend/routes/employees.js`** — 7 endpoints per FR-3.2.
- **New file `backend/lib/employeeProfileAccess.js`** — RBAC scope rules (FR-3.3) + field-masking helpers.
- **New file `frontend/src/pages/admin/EmployeeProfile.jsx`** — admin page (5 tabs).
- **New file `frontend/src/lib/employeeProfileApi.js`** — client-side API helpers (matches `wellnessApi.js` pattern).
- **CI gate-spec wiring** — `e2e/tests/employees-api.spec.js` added to both `.github/workflows/deploy.yml` and `.github/workflows/coverage.yml` gate-spec lists per the `wiring-spec-into-gate` skill.
- **Vitest unit tests** at `backend/test/lib/employeeProfileAccess.test.js` per the `writing-vitest-unit-test` skill — covers FR-3.3 RBAC scope rules + FR-3.4 masking logic.

---

## §9 Open questions

- **Q1 Statutory ID fields — which region's set in v1?** Per DD-5.2 the proposal is India-default (PAN + Aadhaar) for v1; SSN/NI/Iqama as additive nullable columns in Phase 2. Confirm — or push back if a multi-region tenant is imminent (UAE / US / UK), in which case (b) polymorphic `EmployeeStatutoryId` becomes attractive earlier.

- **Q2 Salary visibility — strict MANAGER+ (current proposal, DD-5.3) or operator-configurable?** Recommend strict MANAGER+; confirm. If operator-configurable: per-tenant flag `managerSeesSalaryEnabled Boolean @default(false)` OR per-user flag `payrollVisibilityEnabled` (more granular)?

- **Q3 Bank-account masking — last-4-to-MANAGER + full-to-ADMIN (current proposal, FR-3.4) or fully-hidden-from-MANAGER?** Recommend last-4-to-MANAGER (useful for matching against deposit slips) + full-to-ADMIN. Alternative: fully hidden from MANAGER (only ADMIN sees any digits). What's the right policy?

- **Q4 Document expiry tracking — track expiryDate column + Phase 2 cron auto-reminder (current proposal) or just track expiryDate without auto-reminder (manual operator review)?** Recommend track + Phase 2 cron (`documentExpiryEngine.js` daily 09:30 IST, T-60d / T-30d / T-7d alerts). What's the right cadence + retention?

- **Q5 Photo policy — required or optional? Where displayed?** Recommend optional. Surfaces today: Staff page (avatar column), Calendar (event-owner avatar), Patient detail (Care Team chip). Phase 2 surfaces: Sequences (sender avatar), Tickets (assignee avatar). Confirm — or specify additional surfaces.

- **Q6 Emergency contact visibility — default USER-only-own-profile (current proposal, FR-3.3) or default visible to all tenant users?** Recommend per-tenant flag `emergencyContactVisibleToAll Boolean @default(false)` — defaults to USER-only but operator can opt-in to tenant-wide visibility (useful for receptionist scenario per §2.4). Confirm — or push back if always-tenant-wide is the right operator default.

- **Q7 Self-edit scope — USER can edit own personal data only (current proposal, FR-3.3 + FR-3.10) or USER cannot edit own profile at all (ADMIN-managed entirely)?** Recommend USER-edits-own-personal-data (DOB / address / emergency contact / bank account); USER does NOT edit own statutory IDs / salary / commission. Confirm — or push back if zero-self-edit is the right policy.

- **Q8 Document upload by USER — USER can upload own documents (current proposal, FR-3.3 + FR-3.10) or ADMIN-only document uploads?** Recommend USER-uploads-own (employees know which docs they have); ADMIN-deletes-or-approves. Alternative: ADMIN-only (every upload requires ADMIN action). What's the right policy?

- **Q9 Audit-event throttling — once per (session-id, target-userId) per 5 min (current proposal, FR-3.6) or unthrottled?** Recommend throttled for `EMPLOYEE_PROFILE_VIEWED` + `EMPLOYEE_PROFILE_DOC_VIEWED` (high-volume non-sensitive events); UNTHROTTLED for `EMPLOYEE_AADHAAR_VIEWED` / `EMPLOYEE_PAN_VIEWED` / `EMPLOYEE_BANK_VIEWED` / `EMPLOYEE_SALARY_VIEWED` (high-sensitivity events warranting every-access record). Confirm — or push back if zero-throttling is the right audit policy for compliance.

- **Q10 Travel-vertical employee fields — sub-brand assignment (TMC / RFU / Travel Stall / Visa Sure) + sub-brand-specific commission schemes — bundle into v1 or defer to Phase 2 travel-vertical PRD?** v1 ships generic + wellness only; travel sub-brand fields deferred. Confirm — or push back if travel needs to ship simultaneously.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 / DD-5.2 / DD-5.3 + Q1 / Q2 / Q6 / Q7 before any code lands. **DD-5.1 (User extension vs sibling EmployeeProfile) is the highest-leverage decision** — it determines the model shape + query patterns + encryption boundary across the entire surface.

**Owner:** TBD per product call. Likely allocation:

- Prisma `EmployeeProfile` + `EmployeeProfileDocument` models + User back-relation (additive nullable, passes `migration_check` gate) — backend engineer ~0.5 day
- `backend/lib/employeeProfileAccess.js` (RBAC scope + masking helpers) + `lib/fieldEncryption.js` integration — backend engineer ~0.5 day
- `backend/routes/employees.js` (7 endpoints per FR-3.2 + Multer upload setup + MIME allowlist) — backend engineer ~1.25 days
- Payroll CSV export endpoint (FR-3.9) + audit `EMPLOYEE_SALARY_VIEWED ×N` event flow — backend engineer ~0.5 day
- Staff page integration (FR-3.8 — extend POST /api/staff to atomically create EmployeeProfile when Step 2 fields present) — backend engineer ~0.25 day
- Audit log integration (FR-3.6 — 11 new event actions wired through `writeAudit()`) — backend engineer ~0.5 day
- Frontend `frontend/src/pages/admin/EmployeeProfile.jsx` (5 tabs: Personal + Statutory IDs + Bank/Payroll + Documents + Audit + Notes) — frontend engineer ~2 days
- Frontend Staff page extension — 2-step Add/Edit Staff modal (Step 2 = HR profile fields) — frontend engineer ~0.75 day
- Frontend document-upload modal + photo-upload affordance — frontend engineer ~0.5 day
- Frontend RBAC field-hiding logic per FR-3.3 (per-tab + per-field visibility based on `req.user.role` + self-edit detection) — frontend engineer ~0.5 day
- Tests (api-spec for 7 endpoints + RBAC matrix coverage + vitest for `employeeProfileAccess.js`) — backend engineer ~1 day
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists — backend engineer ~0.25 day

**Total estimated effort post-design: 5-7 engineering days** (model + 7 endpoints + payroll export + admin page + 26 form fields + encryption wiring + document upload + audit integration + tests).

**Sibling PRDs in this cluster:**

- `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance, cluster D9)
- `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, cluster D10)
- `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery / status / governance surface, cluster D11)
- `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, cluster D12)
- `PRD_AI_CHAT_HISTORY.md` (tick #192 — unified AI audit + recall surface, cluster D13)
- `PRD_CUSTOMER_SEGMENTS.md` (tick #193 — saved-filter audience targeting, cluster D14)

**Blocks before frontend impl can start:**

- DD-5.1 (User extension vs sibling EmployeeProfile) — MUST resolve (model shape)
- DD-5.2 (India-default vs polymorphic statutory IDs) — MUST resolve (schema flexibility)
- DD-5.3 (strict MANAGER+ hides salary vs operator-configurable) — MUST resolve (RBAC surface)
- Q1 (region in v1) — MUST resolve (statutory ID field set)
- Q2 (salary visibility per Q3 / DD-5.3) — MUST resolve (RBAC surface; tied to DD-5.3)
- Q6 (emergency contact default visibility) — MUST resolve (RBAC surface; tenant flag yes/no)
- Q7 (self-edit scope) — MUST resolve (FR-3.10 surface)

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**

- **Slice 1** (~1.5 days): Prisma `EmployeeProfile` + `EmployeeProfileDocument` models + User back-relation + `employeeProfileAccess.js` + 3 of 7 endpoints (GET profile + PUT profile + POST profile/photo) + `fieldEncryption.js` integration + audit integration for CREATED / UPDATED / VIEWED / SALARY_VIEWED / AADHAAR_VIEWED / PAN_VIEWED / BANK_VIEWED events + api-spec tests for 3 endpoints. Ships the persistence + read/write API for HR fields.

- **Slice 2** (~1 day): Document upload endpoints (POST documents + DELETE document + GET document file) + Multer setup + MIME allowlist + DOC_UPLOADED / DOC_DELETED / DOC_VIEWED audit events + api-spec tests. Ships the document storage surface.

- **Slice 3** (~0.75 day): Payroll CSV export (FR-3.9) + Staff page integration (POST /api/staff atomic User + EmployeeProfile) + PAYROLL_EXPORTED audit event + api-spec tests. Ships the payroll surface.

- **Slice 4** (~2.5 days): Frontend `EmployeeProfile.jsx` (5 tabs) + Staff page Add/Edit Staff modal extension (Step 2) + document-upload modal + RBAC field-hiding per FR-3.3. Ships the operator-facing admin surface.

- **Slice 5** (~0.5 day): vitest for `employeeProfileAccess.js` (RBAC matrix coverage) + CI gate-spec wiring (`coverage.yml` + `deploy.yml`).

Slices 1 + 2 + 3 must ship in order. Slice 4 + 5 can ship in parallel after slice 3 if dispatched file-disjoint.

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session — though staff/employee HR is vertical-agnostic and helps every tenant; wellness gets the most leverage because doctor + professional + telecaller staffing complexity is highest). Proposal: add a new entry **D15. Staff/Employee Detail (#852)** under cluster D — sibling to D8 (Purchase Orders), D9 (Payment Gateway Config), D10 (Import/Export Jobs), D11 (Integrations Hub), D12 (Tags Master), D13 (AI Chat History), D14 (Customer Segments). Cross-references to D10 (Import/Export Jobs — payroll CSV export flows through the async job infra for >50 employees) + D11 (Integrations Hub — Phase 3 HR sync to Zoho People / BambooHR / GreytHR surfaces as a hub card) + D13 (AI Chat History — Phase 2 AI-summarisation of audit log "who viewed Aadhaar last week").

**Cross-PRD coordination check:** Before implementation starts, confirm:

- `routes/audit.js` `/verify` endpoint accepts the EMPLOYEE_PROFILE_* + EMPLOYEE_*_VIEWED event families without code change (entity = `EMPLOYEE_PROFILE` or per-action entity).
- `lib/fieldEncryption.js` (existing) is wired into `routes/employees.js` correctly — encryption tested against the existing wellness PII encryption pattern.
- `EmployeeProfile.commissionProfileId` FK to existing `CommissionProfile` model is correctly nullable (employee may not have a commission scheme) + doesn't break existing CommissionProfile queries.
- `Attachment` model (existing) accepts the new `EmployeeProfileDocument` join-table linkage without breaking existing patient-photo + ticket-attachment use cases.
- `WELLNESS_FIELD_KEY` env var documented in `.env.example` + deploy pipeline (already deployed; verify on CI).
- `EMPLOYEE_DOC_STORAGE=local|s3` new env var added to `.env.example` + `deploy.yml` env block (defaults to `local`).
- The `retentionEngine.js` retention-policy exclusion for `EMPLOYEE_*_VIEWED` actions is implemented (these stay indefinitely per compliance).
- `frontend/src/pages/Staff.jsx` (existing) gracefully handles the case where an employee has NO EmployeeProfile row (legacy users created before this PRD ships).
- The 2-step Add Staff modal continues to support Step 1-only creation (HR profile is optional at creation time — operator can fill in later).
