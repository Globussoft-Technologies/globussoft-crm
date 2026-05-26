# Excel Software for Travel — Accounting Bridge Product Requirements

**Status:** SPEC — implementation is vendor-docs-blocked on **Q8** ("Light
accounting integration with Excel Software for Travel: [API or file import — to
confirm]") per [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) and
Yasin's 2026-05-13 clarifications email §Decisions from our side. The decision
between API path vs CSV/file-import path has not landed yet; this PRD covers
both so the engineering work can start the moment Yasin picks. Two
implementation paths laid out (§2 + §3 + §6); design call **DC-1** in §5 picks
between them.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §7 (Financial +
accounting) + §4.7 (Travel Stall operating model).

**Audience:** Yasin (delivery owner of the Excel Software vendor docs +
DC-1..DC-6 design calls), Travel Stall CA / finance ops, GS engineering.

---

## 1. Background

**Excel Software for Travel** is Travel Stall's existing offline accounting
system — a vertical-specific Indian travel-accounting product, **not Microsoft
Excel**. The CA reads from it; the back-office reconciliation flow lives in it.
Today the friction is **manual data re-entry**: every invoice finalized in the
CRM has to be hand-typed into Excel Software at end-of-day before the CA's
reconciliation report can run. This PRD specifies the bridge that eliminates
that re-entry and makes the CRM → Excel Software flow automatic.

The CRM is the source of truth for invoicing + payment capture + GST tracking
(per-line HSN, CGST/SGST/IGST split, per-state tax rules). Excel Software is
the back-office reconciliation system the CA reads from. The bridge is
one-way push (CRM → Excel Software) for the primary flow + a corrections-only
back-path (Excel Software → CRM) for cases where the CA modifies a row inside
the books.

### 1.1 Source attribution + how the architecture evolved

The Excel Software integration originates from a **single line in Yasin's
clarifications email** (`travel-crm/Understanding and clarifications - Yasin.pdf`,
2026-05-13, under "Decisions from our side"):

> Light accounting integration with Excel Software for Travel: [API or file
> import — to confirm]

That one line carries the whole Q8 ambiguity: Yasin himself hasn't decided
which integration path to take. The vendor (Excel Software for Travel) may
offer a REST API, a file-import flow, or both — the docs haven't been
collected. **DC-1** in §5 is the design call that picks; until it lands the
GS-side implementation cannot start.

Yasin's same email §Additional clarifications also asks about "Tally CA
export sample" — Tally is **a different system** (Tally ERP, used by some
other tenants), already handled via `backend/lib/tallyXmlExport.js` +
`backend/routes/billing.js:130` `/export/tally.xml`. Don't conflate the two:
Tally export is shipped; Excel Software bridge is not.

**Source-of-truth chain:**
```
Yasin's email (2026-05-13)            ← original ask, 1 line, 1 decision
  └─ Q8 (vendor-docs-blocked)          ← blocker entry in TRAVEL_CRM_OPEN_QUESTIONS.md
       └─ portal matrix row O28        ← cross-cutting status
            └─ cluster C5               ← MANUAL_CODING_BACKLOG.md engineering scope
                 └─ this PRD (live)     ← full spec; serves as the reply to Yasin
                      └─ excelSoftwareClient.js stub (NOT YET WRITTEN)
                           └─ Q8 vendor docs handover ← outstanding (§5 below)
```

Travel Stall's CA operates entirely inside Excel Software today; pre-bridge,
the CRM is invisible to the CA's books. The bridge is what makes the CRM the
upstream source of truth for accounting, not a parallel system.

### 1.2 Why this is "light accounting integration" not "full ERP sync"

Yasin's phrasing — *"light accounting integration"* — is deliberate. The CRM
already ships:

- **Invoice + LineItem models** with HSN codes + per-line GST split
- **Payment model** linked to Invoice
- **Per-legal-entity routing** via `Invoice.legalEntityCode` (4 entities:
  TMC Nexus Pvt Ltd / Labbaik Tours & Travels INTL / Travel Stall / Visa Sure)
- **Tally XML export** + **CA-summary CSV** for other tenants
- **GSTIN per sub-brand** via `subBrandConfig` helper (commit `621aab7`)

What the CRM does NOT do, and what Excel Software handles:

- Period-end closing, ledger reconciliation, trial balance, P&L statement
- Multi-period adjustments (depreciation, prepaid expenses)
- Vendor / supplier-side invoice ingestion
- CA-side note tracking + journal entries

The bridge moves invoice + payment + cancellation data ONE WAY (CRM →
Excel Software) so the CA's reconciliation report is accurate without
re-entry. Full bidirectional sync (e.g. Excel Software's journal-entry
corrections flowing back to CRM as Invoice updates) is Phase 2.

---

## 2. Use cases — what the bridge enables

### 2.1 Primary push path (CRM → Excel Software)

| Event in CRM | Bridge action | Excel Software result |
|---|---|---|
| **Invoice finalized** (status flips `draft` → `final`) | POST invoice payload (API path) OR append to nightly CSV (CSV path) | New invoice row in Excel Software's ledger with `crmInvoiceId` for idempotency |
| **Payment recorded** (Razorpay / Stripe / cash / cheque receipt) | POST payment payload referencing `crmInvoiceId` | Payment row linked to the invoice; invoice marked paid when sum matches grand_total |
| **Invoice cancelled** (operator clicks "Cancel" on an issued invoice) | POST cancellation payload with `status=cancelled` | Excel Software's books reflect the cancellation; reconciliation knows not to count it |
| **Refund issued** (operator processes a refund on a paid invoice) | POST refund payload referencing the original payment | Negative payment row + invoice status flips to `refunded` |
| **Invoice line edited** (operator corrects HSN code / quantity / amount on a pre-final invoice) | No bridge event — edits to draft invoices are local-only | Only finalized invoices cross the bridge |

### 2.2 Reverse correction path (Excel Software → CRM)

When the CA modifies a value inside Excel Software (e.g. corrects a CGST
calculation that was slightly off, or reclassifies a line item), the
correction needs to flow back to the CRM as an **audit row + email alert to
the tenant operator**. This is NOT a full bidirectional sync — the CRM does
NOT overwrite its own data; it merely surfaces the discrepancy so the operator
can decide whether to update the CRM-side record manually.

| Event in Excel Software | Bridge action | CRM result |
|---|---|---|
| **Invoice value differs from CRM** (CA edited a line) | Periodic reconciliation cron compares Excel Software → CRM | New `AccountingDiscrepancy` audit row + operator notification email |
| **Invoice missing in Excel Software** (a finalized CRM invoice didn't make it across) | Same reconciliation cron | Retry queue → re-export attempt → admin alert if still missing after 3 retries |

### 2.3 Per-sub-brand isolation

Each of Travel Stall's 4 sub-brands has its **own legal entity + GSTIN**
already configured via `subBrandConfig`:

| Sub-brand | Legal entity | GSTIN |
|---|---|---|
| TMC | TMC Nexus Pvt Ltd | (per `subBrandConfig`) |
| RFU | Labbaik Tours & Travels INTL | (per `subBrandConfig`) |
| Travel Stall | Travel Stall | (per `subBrandConfig`) |
| Visa Sure | Visa Sure | (per `subBrandConfig`) |

Bridge exports carry the legal entity code per-invoice so Excel Software's
multi-entity ledger ingests them into the right book of accounts. Verify all
4 GSTINs are populated before enabling the bridge (DC-5).

---

## 3. Functional requirements

| FR-ID | Requirement | Status |
|---|---|---|
| FR-1 | NEW `backend/services/excelSoftwareClient.js` module — STUB pattern mirror of `backend/services/digilockerClient.js`. Header comment: `// STUB: Excel Software for Travel integration pending Q8 API docs + DC-1 design call (API vs CSV)`. Exposes `pushInvoice(invoice)` + `pushPayment(payment)` + `pushCancellation(invoice)` + `pushRefund(payment)` regardless of underlying transport. | 🔴 NOT-STARTED |
| FR-2 | **IF DC-1 = API path:** bidirectional webhook + poll. CRM POSTs invoice/payment events to a vendor-supplied endpoint; vendor returns confirmation IDs. Auth: per-tenant API key (similar to subBrandConfig pattern). Retry 3× with exponential backoff on 5xx. | 🔴 NOT-STARTED |
| FR-3 | **IF DC-1 = CSV path:** new `backend/cron/excelSoftwareCsvExport.js` runs nightly (configurable per tenant; default 23:00 IST). Writes a per-tenant CSV (or Excel-Software's proprietary format if specified) to a designated path (local directory OR SFTP). | 🔴 NOT-STARTED |
| FR-4 | **Per-tenant config** — new `TenantSetting` rows `excelSoftware.apiUrl` + `excelSoftware.apiKey` (API path) OR `excelSoftware.csvPath` + `excelSoftware.sftpHost/User/Key` (CSV path). Auth credentials encrypted via existing `lib/fieldEncryption.js`. | 🔴 NOT-STARTED |
| FR-5 | **Idempotency** — every export carries the existing `Invoice.id` (primary key) as `crmInvoiceId` so Excel Software can dedup. Re-imports of the same row are a no-op. | 🔴 NOT-STARTED |
| FR-6 | **Cancellation handling** — when `Invoice.status = cancelled` (existing column at `prisma/schema.prisma:790+`), the export carries `status=cancelled` so Excel Software's books reflect it. No separate "cancellation event" — same payload shape, different status value. | 🔴 NOT-STARTED |
| FR-7 | **GST compliance** — HSN codes + IGST/SGST/CGST split + per-state tax rules are already captured per invoice line in existing `Invoice` + `LineItem` models. The bridge exports them as-is; Excel Software's GST module consumes. No transformation needed. | ✅ SHIPPED (existing) |
| FR-8 | **Per-tenant legal-entity config** — each sub-brand has a distinct GSTIN + legal entity (TMC vs RFU vs Travel Stall vs Visa Sure); `subBrandConfig` helper (`backend/lib/subBrandConfig.js`, commit `621aab7`) already returns these per sub-brand. Bridge consumer reads via the helper; no per-callsite mapping logic. | ✅ SHIPPED (existing) |
| FR-9 | **Reconciliation report consumer (reverse path)** — new `AccountingDiscrepancy` Prisma model (additive — no `[allow-unique]` / `[allow-not-null]` markers needed). Triggered by a weekly cron diff between CRM invoice values + Excel Software's reported invoice values. Surfaces in a new `/accounting/discrepancies` admin page. Operator clicks "investigate" → notification email + audit row. | 🔴 NOT-STARTED |
| FR-10 | **Per-tenant ops visibility** — log call/file-write count for each tenant's bridge activity. Surface in existing admin observability surface (mirror the `/admin/llm-spend` pattern from `LlmCallLog`). No budget cap (free integration; offline). | 🔴 NOT-STARTED |
| FR-11 | **Audit log row per bridge event** — `writeAudit("excel-software.invoice.pushed", { invoiceId, status, transport })` for each push. Reconciles with existing audit trail. | 🔴 NOT-STARTED |
| FR-12 | **Cancellation propagation** — if a CRM invoice is finalized + exported, then cancelled, the bridge re-exports with `status=cancelled`. Excel Software's dedup-on-`crmInvoiceId` handles the update vs insert decision. (FR-6 + FR-5 combined behaviour pinned here.) | 🔴 NOT-STARTED |

**Nothing in FR-1..FR-6 + FR-9..FR-12 has code today.** FR-7 + FR-8 (the GST
capture + per-sub-brand routing) are already shipped — the bridge consumes
them. Everything else is post-DC-1 engineering work (~3-5 days depending on
path).

---

## 4. Non-functional requirements

| NFR | Target — API path | Target — CSV path |
|---|---|---|
| **Latency** (CRM event → Excel Software state) | < 1 s p95 per event POST | < 24 h (nightly cron at 23:00 IST → next-morning availability) |
| **Throughput** | Subject to vendor rate limits — assume 100 req/min per tenant unless docs say otherwise | One file write per tenant per night; trivial |
| **Reliability** | 5xx → retry 3× with 1/2/4 s backoff; persistent failure → ops alert + queue row marked `failed` | File-write failure → retry next tick (24 h later); >2 consecutive failures → ops alert |
| **Compliance** | Indian GST + audit-log retention (7 years per GST law) — already handled by existing CRM infra via `retentionEngine.js` | Same |
| **Reconciliation cadence** | Weekly auto-diff job (Mondays 06:00 IST) regardless of path; surfaces mismatches in admin queue | Same |
| **File format (CSV path only)** | N/A | Atomic write: write to `<file>.tmp` → rename to final name so Excel Software's import doesn't pick up a partial file |
| **Encryption at rest** | API key encrypted in `TenantSetting` via `lib/fieldEncryption.js` | SFTP private key encrypted same way; local directory uses filesystem permissions only |

---

## 5. Hand-over requirements — decisions Yasin owes

This is the section that unblocks every functional requirement in §3. The
work cannot start until Q8 vendor docs land + **DC-1** decision is made. The
6 sub-decisions below are also Yasin-owned; GS provides recommendations.

### 5.1 The blocker — Q8 vendor docs

**Yasin owes:**

- **Excel Software for Travel REST API documentation** (endpoints + auth +
  payload shapes + rate limits + error responses) **OR**
- **Sample CSV / file-import spec** (column headers + delimiters + encoding +
  date format + decimal separator + how cancellations / refunds are encoded)

**Recommended ask to vendor:** "Send us both if available — we'll pick based
on API maturity." If the API is half-baked (no idempotency, no error
semantics) or undocumented, CSV is more reliable. If the API is mature,
real-time push is the better operator experience.

### 5.2 Six design decisions GS needs Yasin to make

#### DC-1 — API path vs CSV path

**Question:** which transport does the bridge use?

**GS recommendation:** ask the vendor for both options. Default to **API** if
their docs show idempotency-by-external-id + structured error responses. Fall
back to **CSV** if (a) their API doesn't exist, (b) their API lacks
idempotency, or (c) Travel Stall's CA prefers the existing import flow they're
familiar with. CSV path is ~5 days; API path is ~3 days.

#### DC-2 — SFTP vs local directory (CSV path only)

**Question:** where does the CSV land — local filesystem (NFS mount) or
remote SFTP target?

**GS recommendation:** **SFTP** for both Travel Stall (on-prem) and any
future cloud-hosted deployment. Consistent ops; no NFS-mount fragility; easy
to rotate keys; standard tooling. If Excel Software runs on the same host as
the CRM today, SFTP loopback works fine.

#### DC-3 — Per-tenant directory structure (CSV path only)

**Question:** where do per-tenant CSVs land — `/tenants/<slug>/<date>.csv` or
single directory with tenant ID in filename?

**GS recommendation:** `/tenants/<slug>/<date>.csv`. Mirrors the S3 layout
pattern; per-tenant access control is trivial via directory permissions;
operator triage during an issue is easier ("look in the TMC folder").

#### DC-4 — Reconciliation discrepancy threshold

**Question:** when CRM + Excel Software disagree on an invoice value, what
threshold triggers an alert?

**GS recommendation:** **any diff** goes into the discrepancy queue (FR-9).
Operator (or CA) decides which to alert on. A `₹100 threshold` was considered
but rejected: small GST rounding differences are common + worth investigating
(may indicate a calculation drift); a paise-level diff is more often a
forensic signal than noise.

#### DC-5 — Per-sub-brand GSTIN / legal-entity mapping verification

**Question:** are all 4 sub-brands' GSTINs populated in `subBrandConfig`
before the bridge enables?

**GS recommendation:** GS will run a pre-flight check at bridge-enable time
that verifies each sub-brand's `legalEntityCode` resolves to a real GSTIN +
legal entity name. If any are missing, the enable flips refuse to start. This
is config-validation only; no code change beyond a `// REQUIRE`-style guard
in the new client.

#### DC-6 — Cancellation handling — re-export vs cancellation-notification

**Question:** when an invoice is cancelled mid-flight (after export), do we
re-export the same row with `status=cancelled` OR fire a separate "invoice
cancelled" notification event?

**GS recommendation:** **re-export with `status=cancelled`**. Simpler;
idempotent on Excel Software's side; one payload shape. FR-12 pins this
contract. Vendor must accept the same `crmInvoiceId` updating an existing
row vs inserting a new one — DC-1 vendor-docs check confirms.

### 5.3 What GS delivers post-Q8 + DC-1

Once the vendor docs land + DC-1 is decided:

1. **`backend/services/excelSoftwareClient.js`** — stub-mode-ready (mirrors
   `digilockerClient.js`); env-flag enables real-mode (`EXCEL_SOFTWARE_API_URL`
   + `EXCEL_SOFTWARE_API_KEY` OR `EXCEL_SOFTWARE_CSV_PATH` per tenant).
2. **Push triggers** — invoice / payment / cancellation / refund events fire
   into the client; idempotent on Excel Software's side via `crmInvoiceId`.
3. **Reconciliation cron** — weekly diff; surfaces in admin queue.
4. **Admin UI** — new `/accounting/discrepancies` page (mirrors the
   `LlmSpend.jsx` admin-observability pattern).
5. **E2E spec** — `e2e/tests/excel-software-bridge-api.spec.js` covers stub
   mode + happy path + retry + cancellation + reconciliation.
6. **Vitest unit tests** — `backend/test/services/excelSoftwareClient.test.js`
   pins the 4 push helper contracts.

**Total post-Q8 work:** ~3 days (API path) or ~5 days (CSV path due to
file-handling + atomic-write + retry-on-disk-error complexity).

---

## 6. Acceptance criteria

The integration is "done" when **all 6 of the following are demonstrable**:

| # | Test | Verifies |
|---|---|---|
| AC-1 | Operator finalizes an invoice in CRM → it arrives in Excel Software within X. X is path-dependent: **<1 s** for API path; **<24 h** (next morning) for CSV path. | FR-1 + FR-2 (API) OR FR-3 (CSV). |
| AC-2 | Operator cancels an invoice in CRM → status reflects as cancelled in Excel Software at the next push cycle. | FR-6 + FR-12. |
| AC-3 | Weekly reconciliation cron runs → any CRM/Excel-Software discrepancy surfaces in `/accounting/discrepancies` admin queue with diff details. | FR-9. |
| AC-4 | An invoice for a TMC trip → exports with TMC's GSTIN + `legalEntityCode = "TMC"`. Same for RFU / Travel Stall / Visa Sure. Cross-sub-brand exports never mix entities. | FR-8 + DC-5. |
| AC-5 | A Razorpay payment recorded in CRM → links to the corresponding Excel Software invoice via `crmInvoiceId`; sum-of-payments matches grand_total → invoice flips to paid in both systems. | FR-1 (push payment) + FR-5 (idempotency). |
| AC-6 | API path: Excel Software returns 5xx on a push → retry 3× with backoff; if persistent, ops alert fires + queue row marked `failed`. **CSV path:** file-write failure (disk full, permission denied, SFTP unreachable) → retry next tick; >2 consecutive failures → ops alert. | NFR reliability target. |

GS owns the e2e validation; Travel Stall + the CA own acknowledging acceptance
against their actual reconciliation workflow.

---

## 7. Out of scope

- **Two-way invoice editing** — only corrections-only audit path back from
  Excel Software → CRM (§2.2); full bidirectional sync (where Excel Software
  edits overwrite CRM values) is **Phase 2**.
- **TDS automation** — Indian tax flow for tax-deducted-at-source on
  supplier payments; separate accounting flow; **Phase 2**.
- **Multi-currency invoice** — assume tenant `defaultCurrency`; mixed-currency
  invoices are not in scope for V1.
- **Vendor / supplier invoice ingestion FROM Excel Software** — supplier-side
  reconciliation (Excel Software → CRM Vendor model) is **Phase 2**.
- **Other accounting systems** — Tally (already shipped via
  `tallyXmlExport.js`), Zoho Books, QuickBooks, etc. Travel Stall uses Excel
  Software specifically; this PRD covers only that.
- **Period-end closing operations** — trial balance, P&L generation,
  depreciation entries; handled inside Excel Software, not the bridge.
- **CA-side note tracking** — journal entries, audit notes, internal
  comments; handled inside Excel Software.

---

## 8. Dependencies + downstream

### 8.1 Existing infra (already shipped — bridge consumes)

- **Invoice + LineItem + Payment** Prisma models — `prisma/schema.prisma`
- **GSTIN per-sub-brand config** — `subBrandConfig` helper (`backend/lib/subBrandConfig.js`, commit `621aab7`)
- **`Invoice.legalEntityCode`** column (`prisma/schema.prisma:814`) — already
  drives per-legal-entity routing for Tally export
- **Audit log** infra — `lib/audit.js` + `AuditLog` model + `routes/audit.js`
- **Notification** model + email engine
- **Field encryption** — `lib/fieldEncryption.js` for the per-tenant API key /
  SFTP private key storage
- **Cron infra** — `node-cron` + `cron/` directory pattern (mirror
  `recurringInvoiceEngine.js` or `forecastSnapshotEngine.js`)
- **Existing Tally + CA-summary exports** — `lib/tallyXmlExport.js` +
  `lib/caCsvExport.js` + `routes/billing.js:130,181` — proven CA-facing
  export patterns to mirror in the CSV path

### 8.2 New schema (additive, no bless markers needed)

- **`AccountingDiscrepancy`** model — fields: `tenantId`, `invoiceId` (FK),
  `crmValue` (Decimal), `excelSoftwareValue` (Decimal), `diff` (Decimal),
  `detectedAt`, `resolvedAt?`, `resolvedBy?` (FK User), `notes?`
- **`TenantSetting`** rows (already exists) — new keys:
  `excelSoftware.transport` (`"api"` | `"csv"`), `excelSoftware.apiUrl?`,
  `excelSoftware.apiKey?` (encrypted), `excelSoftware.csvPath?`,
  `excelSoftware.sftpHost?`, `excelSoftware.sftpUser?`,
  `excelSoftware.sftpKey?` (encrypted)
- **Additive nullable column on Invoice** (only if API path; needed to store
  vendor's confirmation ID): `Invoice.excelSoftwareRef String?`. No bless
  marker (additive nullable per migration-safety detector).

### 8.3 Downstream consumers

- **Weekly reconciliation report** extends existing
  `backend/routes/attribution.js` accounting-side reports (Phase 2 polish —
  surface discrepancy aggregate stats per tenant)
- **CA-facing email digest** — extends existing
  `backend/cron/reportEngine.js`'s scheduled-report pattern with a "weekly
  accounting reconciliation" report
- **Operator notifications** — extends existing notification model with a
  new `AccountingDiscrepancy` notification type

### 8.4 No-impact dependencies (parallel, not blocking)

- Q1 (Callified.ai / AdsGPT) — orthogonal; no shared surface
- Q3 (DigiLocker) — orthogonal; no shared surface
- Q9 (Wati WhatsApp) — orthogonal; no shared surface
- Q11 (LLM API keys) — orthogonal; no shared surface
- Q19 (RateHawk) — orthogonal; the inventory side, not the accounting side

---

## 9. Open questions

| # | Question | Owner | Resolution path |
|---|---|---|---|
| OQ-1 | **Q8: API vs CSV path** — THE blocker. | Yasin + vendor | Yasin to share vendor docs OR sample CSV format; GS picks DC-1 accordingly |
| OQ-2 | **DC-1 / DC-2 / DC-3 / DC-4 / DC-5 / DC-6 design calls.** | Yasin | Schedule a single design call once vendor docs land; all 6 decisions resolvable in 1 hour |
| OQ-3 | **Invoice number format** — does Excel Software want CRM's `Invoice.invoiceNumber` verbatim or generate its own? | Vendor docs | Recommend: CRM is source of truth; Excel Software stores CRM's number as the canonical reference. If vendor disagrees, store the vendor-generated number as `Invoice.excelSoftwareRef` (additive nullable column) for round-trip lookup |
| OQ-4 | **Error reporting from Excel Software back to CRM** — does it provide structured errors (`{ code, message, details }`) or generic 500s? | Vendor docs | Affects retry strategy. Structured = targeted retry; generic = 3× exponential backoff then bail |
| OQ-5 | **Per-line GST breakdown granularity** — does Excel Software need each line's HSN code OR just total IGST/CGST/SGST split per invoice? | Vendor docs | Recommend: send per-line HSN. CRM has it; Excel Software's choice to consume |
| OQ-6 | **Backdated invoices** — when an operator corrects last month's invoice after period close, does Excel Software handle period-end-bypass? | Vendor docs | Out-of-scope for V1 if vendor doesn't support it; recommend: CRM blocks edits to invoices >30 days old via a UI guard rather than relying on vendor capability |
| OQ-7 | **Customer payments vs supplier payments** — does the bridge sync both, or only customer-side for V1? | Yasin | Recommend: customer-side only for V1 (matches "light accounting integration" framing). Supplier-side is Phase 2 if needed |
| OQ-8 | **GST e-invoicing IRN integration** — does Excel Software handle the IRN (Invoice Reference Number) push to the GST portal, OR does the CRM need to do that separately? | Yasin + CA | If Excel Software handles it, bridge is done. If not, separate scope item (likely Phase 2; not blocking this PRD). Tally export already includes the IRN field placeholder; Excel Software likely does too |
| OQ-9 | **Period-end reconciliation cadence** — weekly diff is the default (NFR table); should it be daily for higher-volume tenants like Travel Stall once mature? | Operator decision | Recommend: ship weekly; offer per-tenant toggle to daily in Phase 2 |
| OQ-10 | **Vendor's idempotency contract** — confirms that re-pushing the same `crmInvoiceId` is a no-op (or an UPDATE) rather than a duplicate row creation. | Vendor docs | Critical for FR-5; if vendor doesn't honour, GS implements server-side dedup before push (more complex, ~+1 day) |

---

## 10. Status snapshot

| Component | State |
|---|---|
| Invoice + Payment + LineItem schema | ✅ SHIPPED |
| HSN + GST per-line capture | ✅ SHIPPED |
| `Invoice.legalEntityCode` + per-sub-brand routing | ✅ SHIPPED |
| `subBrandConfig` helper (per-sub-brand GSTIN / legal entity) | ✅ SHIPPED (commit `621aab7`) |
| Tally export + CA-summary CSV (reference patterns for CSV path) | ✅ SHIPPED (commit `4a07fca`) |
| Audit log + notification + field-encryption infra | ✅ SHIPPED |
| `backend/services/excelSoftwareClient.js` | 🔴 NOT-STARTED (no stub exists today) |
| Push triggers on invoice/payment/cancellation/refund events | 🔴 NOT-STARTED |
| Reconciliation cron + `AccountingDiscrepancy` model | 🔴 NOT-STARTED |
| `/accounting/discrepancies` admin UI | 🔴 NOT-STARTED |
| E2E spec + vitest unit tests | 🔴 NOT-STARTED |
| **Q8 vendor docs (REST API spec OR CSV format)** | ⏸️ BLOCKED on Yasin |
| **DC-1..DC-6 design calls** | ⏸️ BLOCKED on Yasin |
| **Engineering time post-Q8 + design calls** | **~3 days (API path) or ~5 days (CSV path)** |

Once Yasin delivers Q8 vendor docs + makes DC-1 + the 5 sub-decisions,
expected time to a fully-live bridge: **3-5 days of GS engineering work +
1-2 days for vendor-side validation against real Travel Stall traffic**
(parallel to the engineering work).

---

**Ownership chain:**

- **Travel Stall (Yasin)** owes Q8 vendor docs + DC-1..DC-6 design decisions
  — outstanding per [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md)
  Q8 + Yasin's 2026-05-13 email §Decisions list.
- **Vendor (Excel Software for Travel)** owes documentation + (if API path)
  idempotency confirmation.
- **GS engineering** owes the `excelSoftwareClient.js` write + push triggers
  + reconciliation cron + admin UI + e2e + vitest (~3-5 days post-Q8).
- **Travel Stall CA** owes acceptance against the actual reconciliation
  workflow (AC-1..AC-6 demonstrable end-to-end).
