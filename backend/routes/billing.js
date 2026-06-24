const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");

const router = express.Router();
const prisma = require("../lib/prisma");
const { writeAudit, diffFields } = require("../lib/audit");
const { formatMoney } = require("../utils/formatMoney");
// #577 — wire fieldFilter into Invoice routes so the FieldPermissions UI
// rules are actually enforced (not just stored). Mirrors the deals.js +
// contacts.js adoption pattern from #464.
const { filterReadFields, filterWriteFields } = require("../middleware/fieldFilter");
// PRD §4.4 — CA / Tally file-download exporters. Pure helpers; the
// route handler does the Prisma fetch + shape mapping then delegates.
const { buildTallyXml } = require("../lib/tallyXmlExport");
const { buildCaCsv } = require("../lib/caCsvExport");

// ────────────────────────────────────────────────────────────────
// Shared helpers for the two CA / Tally export endpoints below.
// ────────────────────────────────────────────────────────────────

// Default to the current Indian financial year (Apr 1 → Mar 31). Used
// when the caller doesn't pass ?from / ?to. CA exports are FY-shaped by
// convention; this default matches what an accountant would intuitively
// request mid-year.
function currentFinancialYearRange() {
  const now = new Date();
  const y = now.getFullYear();
  // FY starts in April. Before April → previous calendar year.
  const startYear = now.getMonth() < 3 ? y - 1 : y;
  const from = new Date(startYear, 3, 1, 0, 0, 0, 0);
  const to = new Date(startYear + 1, 2, 31, 23, 59, 59, 999);
  return { from, to };
}

function parseDateRange(query) {
  const { from: defFrom, to: defTo } = currentFinancialYearRange();
  const from = query && query.from ? new Date(query.from) : defFrom;
  const to = query && query.to ? new Date(query.to) : defTo;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return null;
  }
  // If caller passed a date-only "YYYY-MM-DD" for `to`, push to end-of-day
  // so the inclusive range matches user expectation.
  if (query && query.to && /^\d{4}-\d{2}-\d{2}$/.test(String(query.to))) {
    to.setHours(23, 59, 59, 999);
  }
  return { from, to };
}

// Quick ASCII slug for filename use. Avoids smuggling unicode / spaces /
// path separators into the Content-Disposition value where a browser may
// refuse to save the file.
function fileSlug(s) {
  return String(s || "tenant")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "tenant";
}

// Derive seller-state from tenant.country + locale. The schema doesn't
// store a per-tenant state explicitly today (Tenant.country is the only
// geo column), so for non-IN tenants we leave it empty (CA / Tally
// export is India-shaped; non-IN tenants will see all sales fall to
// the default-intrastate branch which is fine — they don't use GST).
function sellerStateFromTenant(tenant) {
  if (!tenant) return "";
  // If a future migration adds tenant.state, prefer that. For now use
  // locale as a soft hint (en-IN-* → "IN") but leave the actual state
  // empty — accountants typically import per-state separately anyway.
  return "";
}

// Map a Prisma Invoice row (with `contact` included) into the shape both
// helpers consume. GST is NOT stored on the Invoice today — `amount` is
// the gross figure. The exporter treats the full amount as subtotal +
// zero GST so the helper still emits a valid voucher; an accountant can
// post-process in Tally / Excel to break out GST manually until per-line
// GST columns ship. This keeps the export honest (no fabricated tax
// figures) while still unlocking the W5 exit gate today.
function mapInvoiceToExportShape(inv) {
  const total = Number(inv.amount) || 0;
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNum || `INV-${inv.id}`,
    issueDate: inv.issuedDate || inv.createdAt,
    contactName: inv.contact ? inv.contact.name || "Unknown" : "Unknown",
    billingAddress: "", // schema has no billing-address column today
    billingState: "",   // ditto for state
    buyerState: "",     // helper defaults to sellerState (intrastate)
    subtotal: total,
    cgstAmount: 0,
    sgstAmount: 0,
    igstAmount: 0,
    totalAmount: total,
    status: inv.status || "UNPAID",
    subBrand: inv.contact ? inv.contact.subBrand || "" : "",
    notes: inv.legalEntityCode || "",
  };
}

// Build the Prisma where clause shared by both export endpoints.
async function buildInvoiceWhere(req, range) {
  const where = {
    tenantId: req.user.tenantId,
    issuedDate: { gte: range.from, lte: range.to },
  };
  if (req.query.legalEntity) {
    where.legalEntityCode = String(req.query.legalEntity).slice(0, 64);
  }
  // subBrand lives on Contact, not Invoice. Use a relational filter so the
  // exporter scopes correctly when a travel tenant wants per-sub-brand
  // exports (e.g. ?subBrand=travelstall).
  if (req.query.subBrand) {
    where.contact = { subBrand: String(req.query.subBrand).slice(0, 32) };
  }
  return where;
}

// ────────────────────────────────────────────────────────────────
// GET /api/billing/export/tally.xml
//
// PRD §4.4 — TallyPrime / Tally.ERP 9 importable envelope. ADMIN or
// MANAGER only (financial data — USER role excluded). Placed BEFORE the
// `/:id` route below so the static path doesn't get parseInt'd.
// ────────────────────────────────────────────────────────────────
router.get(
  "/export/tally.xml",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const range = parseDateRange(req.query);
      if (!range) {
        return res.status(400).json({ error: "invalid from/to date", code: "INVALID_DATE_RANGE" });
      }

      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true, slug: true, country: true, locale: true },
      });
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const where = await buildInvoiceWhere(req, range);
      const invoices = await prisma.invoice.findMany({
        where,
        include: { contact: { select: { name: true, email: true, subBrand: true } } },
        orderBy: { issuedDate: "asc" },
      });

      const xml = buildTallyXml({
        companyName: tenant.name,
        sellerState: sellerStateFromTenant(tenant),
        invoices: invoices.map(mapInvoiceToExportShape),
      });

      const fromIso = range.from.toISOString().slice(0, 10);
      const toIso = range.to.toISOString().slice(0, 10);
      const filename = `tally-export-${fileSlug(tenant.slug)}-${fromIso}-${toIso}.xml`;
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.status(200).send(xml);
    } catch (err) {
      console.error("[billing/export/tally.xml]", err);
      res.status(500).json({ error: "Failed to generate Tally XML export" });
    }
  }
);

// ────────────────────────────────────────────────────────────────
// GET /api/billing/export/ca-summary.csv
//
// PRD §4.4 — accountant-friendly tabular summary (one row per invoice,
// GST broken out). ADMIN or MANAGER only.
// ────────────────────────────────────────────────────────────────
router.get(
  "/export/ca-summary.csv",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const range = parseDateRange(req.query);
      if (!range) {
        return res.status(400).json({ error: "invalid from/to date", code: "INVALID_DATE_RANGE" });
      }

      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { name: true, slug: true },
      });
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const where = await buildInvoiceWhere(req, range);
      const invoices = await prisma.invoice.findMany({
        where,
        include: { contact: { select: { name: true, subBrand: true } } },
        orderBy: { issuedDate: "asc" },
      });

      const csv = buildCaCsv(invoices.map(mapInvoiceToExportShape));

      const fromIso = range.from.toISOString().slice(0, 10);
      const toIso = range.to.toISOString().slice(0, 10);
      const filename = `ca-summary-${fileSlug(tenant.slug)}-${fromIso}-${toIso}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.status(200).send(csv);
    } catch (err) {
      console.error("[billing/export/ca-summary.csv]", err);
      res.status(500).json({ error: "Failed to generate CA summary CSV" });
    }
  }
);

// Fetch all ledgers for current tenant
// GET /api/billing?fields=summary
router.get("/", verifyToken, async (req, res) => {
  try {
    // #920 slice 31: ?fields=summary slim-shape opt-in. Mirrors slices 1-30.
    // The default list handler eager-loads `contact: true` + `deal: true` —
    // two heavy joins that the Invoices/Payments/Billing pages don't need
    // when rendering ledger chrome (status chip, invoice number, amount,
    // due date). When the caller passes ?fields=summary we drop both joins
    // + tenantId + createdAt + updatedAt + the recurrence metadata
    // (isRecurring, recurFrequency, nextRecurDate, parentInvoiceId, paidAt,
    // legalEntityCode, visitId), returning only the columns needed for the
    // ledger row + status filter. Opt-in additive — existing callers (no
    // ?fields, or any non-exact value) get the full nested row shape
    // unchanged. fieldFilter still runs on the slim-shape result so
    // FieldPermissions UI rules continue to strip restricted columns.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where: { tenantId: req.user.tenantId },
      orderBy: [{ status: "desc" }, { dueDate: "asc" }],
    };
    // Travel vertical — optional ?subBrand= filter for the per-brand ledger.
    // Matches invoices explicitly tagged with the brand OR (back-compat with
    // pre-subBrand rows) untagged invoices whose CONTACT is that brand. Other
    // verticals never pass ?subBrand, so this is a no-op for them.
    const sb = req.query.subBrand ? String(req.query.subBrand).slice(0, 32) : null;
    if (sb) {
      findManyArgs.where.OR = [
        { subBrand: sb },
        { subBrand: null, contact: { is: { subBrand: sb } } },
      ];
    }
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        invoiceNum: true,
        amount: true,
        status: true,
        dueDate: true,
        issuedDate: true,
        contactId: true,
        dealId: true,
      };
    } else {
      findManyArgs.include = { contact: true, deal: true };
    }
    let invoices;
    try {
      invoices = await prisma.invoice.findMany(findManyArgs);
    } catch (e) {
      // Graceful degrade: if the Invoice.subBrand column hasn't been migrated
      // yet (`npx prisma db push` pending), the OR clause referencing it throws.
      // Fall back to filtering by the CONTACT's subBrand (a column that already
      // exists) so the ledger + brand filter keep working; invoice-level tagging
      // lights up once the migration runs. Any other error rethrows to the 500.
      if (sb && /subBrand/i.test(String(e && e.message))) {
        delete findManyArgs.where.OR;
        findManyArgs.where.contact = { is: { subBrand: sb } };
        invoices = await prisma.invoice.findMany(findManyArgs);
      } else {
        throw e;
      }
    }
    // #577: strip read-restricted fields per the caller's role.
    const filtered = await filterReadFields(invoices, req.user.role, "Invoice", req.user.tenantId);
    res.json(filtered);
  } catch (_err) {
    res.status(500).json({ error: "Failed to locate invoice ledger" });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/billing/stats
//
// Wellness/CRM billing polish — first /stats aggregate for the Invoice
// CRUD route. Read-only tenant-wide KPI surface backing the owner
// dashboard's billing tile. Mirrors travel_suppliers.js /stats posture —
// anodyne aggregate, NO audit row written.
//
// Auth follows the GET / list handler above: verifyToken only (USERs
// can read aggregate totals; per-row PHI / restricted columns are
// stripped from list/detail endpoints via fieldFilter, but counts +
// sums of `amount` are not PHI). ADMIN-readable in practice — UI tile
// is gated on the frontend.
//
// Schema notes — actual Invoice columns: amount (Float), status
// (default UNPAID; live values UNPAID/PAID/OVERDUE/VOIDED/REFUNDED/
// CREDIT_NOTE from the surrounding handlers above), dueDate, createdAt.
// No separate amountPaid column — paid-ness is tracked via status flip.
// totalPaid = sum(amount where status=PAID); totalIssued = sum(amount
// for rows that represent real receivables, excluding VOIDED +
// CREDIT_NOTE which would corrupt the figure with negative amounts).
//
// Query params:
//   ?from / ?to — optional ISO date bounds on createdAt. Invalid → 400
//                 INVALID_DATE. Both optional and independent.
//
// Response envelope:
//   { total, byStatus, totalIssued, totalPaid, totalOutstanding,
//     overdueCount, lastInvoiceAt }
// ────────────────────────────────────────────────────────────────
router.get("/stats", verifyToken, async (req, res) => {
  try {
    // Validate optional date bounds. Independent validation so a bad
    // ?from doesn't get masked by a missing ?to and vice-versa.
    const createdAtClause = {};
    if (req.query.from !== undefined) {
      const fromDate = new Date(req.query.from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: "invalid from date", code: "INVALID_DATE" });
      }
      createdAtClause.gte = fromDate;
    }
    if (req.query.to !== undefined) {
      const toDate = new Date(req.query.to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ error: "invalid to date", code: "INVALID_DATE" });
      }
      createdAtClause.lte = toDate;
    }

    const where = { tenantId: req.user.tenantId };
    if (Object.keys(createdAtClause).length > 0) {
      where.createdAt = createdAtClause;
    }

    // Pull just the columns we need to aggregate. Avoids dragging the
    // full row (including contact/deal joins) into memory just to sum.
    const rows = await prisma.invoice.findMany({
      where,
      select: { status: true, amount: true, dueDate: true, createdAt: true },
    });

    const total = rows.length;
    const byStatus = {};
    let issuedSum = 0;
    let paidSum = 0;
    let overdueCount = 0;
    let lastCreatedAt = null;
    const now = new Date();
    // Statuses that exit the "issued, awaiting payment" funnel — exclude
    // their amounts from totalIssued. VOIDED + CREDIT_NOTE in particular
    // carry negative amounts (credit-note) or write-offs (void).
    const EXCLUDE_FROM_ISSUED = new Set(["VOIDED", "CREDIT_NOTE"]);
    const NOT_OVERDUE_STATUSES = new Set(["PAID", "VOIDED", "REFUNDED", "CREDIT_NOTE"]);

    for (const r of rows) {
      const status = r.status || "UNPAID";
      byStatus[status] = (byStatus[status] || 0) + 1;
      const amt = Number(r.amount) || 0;
      if (!EXCLUDE_FROM_ISSUED.has(status)) {
        issuedSum += amt;
      }
      if (status === "PAID") {
        paidSum += amt;
      }
      if (r.dueDate && new Date(r.dueDate) < now && !NOT_OVERDUE_STATUSES.has(status)) {
        overdueCount += 1;
      }
      if (r.createdAt && (lastCreatedAt === null || new Date(r.createdAt) > lastCreatedAt)) {
        lastCreatedAt = new Date(r.createdAt);
      }
    }

    // Half-up 2dp rounding helper. EPSILON tweak collapses JS float noise
    // (0.1+0.2 type artefacts) so 100.555 rounds to 100.56 not 100.55.
    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const totalIssued = round2(issuedSum);
    const totalPaid = round2(paidSum);
    // Clamp negative outstanding (over-payment / credit-note artefacts) to 0.
    const totalOutstanding = round2(Math.max(0, totalIssued - totalPaid));

    res.json({
      total,
      byStatus,
      totalIssued,
      totalPaid,
      totalOutstanding,
      overdueCount,
      lastInvoiceAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[billing/stats]", err);
    res.status(500).json({ error: "Failed to compute billing stats" });
  }
});

// #196: deep-link / portal / SMS-link load — fetch a single invoice by id.
router.get("/:id", verifyToken, async (req, res) => {
  try {
    // #196: validate the path param before letting it reach Prisma —
    // parseInt("foo") returns NaN and findFirst({where:{id:NaN}}) throws,
    // which the catch translated to a generic 500 (caught by the new
    // billing-api spec). Match the pattern already in PATCH /:id and
    // /mark-paid for consistency.
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid invoice id", code: "INVALID_ID" });
    }
    const invoice = await prisma.invoice.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { contact: true, deal: true }
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    // #577: strip read-restricted fields per the caller's role.
    const filtered = await filterReadFields(invoice, req.user.role, "Invoice", req.user.tenantId);
    res.json(filtered);
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch invoice" });
  }
});

// Draft new Invoice
router.post("/", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    // #577: strip write-restricted fields BEFORE the field-level validation
    // below so a denied field can't slip through into the create payload.
    req.body = await filterWriteFields(req.body, req.user.role, "Invoice", req.user.tenantId);
    const { amount, dueDate, contactId, dealId } = req.body;
    // #158 #177: validate amount > 0 and within sane cap, dueDate >= today.
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "amount must be greater than 0", code: "INVALID_AMOUNT" });
    }
    if (amt > 1e10) {
      return res.status(400).json({ error: "amount exceeds maximum allowed", code: "AMOUNT_TOO_HIGH" });
    }
    // #198: reject sub-paise precision. The smallest currency unit is 0.01 —
    // anything finer drifts under aggregation and breaks GST filings. The
    // 1e-9 epsilon swallows JS float noise (0.1+0.2 type artefacts) while
    // still catching genuine 6-decimal inputs like 123.456789.
    if (Math.abs(amt - Math.round(amt * 100) / 100) > 1e-9) {
      return res.status(400).json({ error: "amount must have at most 2 decimal places", code: "INVALID_AMOUNT_PRECISION" });
    }
    const due = dueDate ? new Date(dueDate) : null;
    if (!due || Number.isNaN(due.getTime())) {
      return res.status(400).json({ error: "dueDate is required and must be a valid date", code: "INVALID_DUE_DATE" });
    }
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    if (due < todayStart) {
      return res.status(400).json({ error: "dueDate cannot be in the past", code: "DUE_DATE_IN_PAST" });
    }
    if (!contactId) {
      return res.status(400).json({ error: "contactId is required", code: "CONTACT_REQUIRED" });
    }
    const invNum = `INV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    // Travel vertical — optional sub-brand tag (tmc | rfu | travelstall |
    // visasure). Validated against the known set; anything else → null. Other
    // verticals don't send it, so it stays null and behaviour is unchanged.
    const subBrandRaw = typeof req.body.subBrand === "string" ? req.body.subBrand.trim().toLowerCase() : "";
    const subBrand = ["tmc", "rfu", "travelstall", "visasure"].includes(subBrandRaw) ? subBrandRaw : null;

    const baseData = {
      invoiceNum: invNum,
      amount: Math.round(amt * 100) / 100, // #198: store to-the-paise; reject was above
      dueDate: due,
      contactId: parseInt(contactId),
      dealId: dealId ? parseInt(dealId) : null,
      tenantId: req.user.tenantId,
    };
    let invoice;
    try {
      invoice = await prisma.invoice.create({
        data: { ...baseData, subBrand },
        include: { contact: true, deal: true },
      });
    } catch (e) {
      // Graceful degrade: if the Invoice.subBrand column isn't migrated yet,
      // create the invoice WITHOUT the tag so the flow still works (the contact
      // still carries the brand). Re-run `npx prisma db push` to persist the tag.
      if (/subBrand/i.test(String(e && e.message))) {
        invoice = await prisma.invoice.create({
          data: baseData,
          include: { contact: true, deal: true },
        });
      } else {
        throw e;
      }
    }
    // #179: audit invoice creation.
    await writeAudit('Invoice', 'CREATE', invoice.id, req.user.userId, req.user.tenantId, {
      invoiceNum: invoice.invoiceNum,
      amount: invoice.amount,
      contactId: invoice.contactId,
      dealId: invoice.dealId,
      dueDate: invoice.dueDate,
    });
    // PRD Gap §13 wave-6a — emit invoice.created for downstream automations.
    // Wrapped: workflow failures must NEVER fail the invoice creation.
    try {
      require("../lib/eventBus").emitEvent(
        "invoice.created",
        {
          invoiceId: invoice.id,
          invoiceNum: invoice.invoiceNum,
          amount: invoice.amount,
          contactId: invoice.contactId,
          dealId: invoice.dealId,
          dueDate: invoice.dueDate,
          status: invoice.status,
        },
        req.user.tenantId,
        req.io
      );
    } catch (_e) {}
    res.status(201).json(invoice);
  } catch (_err) {
    res.status(500).json({ error: "Invoice compilation and issuance failed" });
  }
});

// #202: PATCH /:id — safe field updates on an invoice. Whitelist of mutable
// fields only (the schema has flat `amount`, no line items / taxRate / discount
// / notes columns — see prisma/schema.prisma → model Invoice). Status-machine
// rule per Conventions §1: PAID/VOIDED invoices are terminal — return 422
// INVALID_INVOICE_TRANSITION (also REFUNDED/CREDIT_NOTE for completeness).
// `amount` is intentionally NOT in the whitelist — money corrections happen via
// /refund or /credit-note so the audit trail records *why*, not just *what*.
router.patch("/:id", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid invoice id", code: "INVALID_ID" });
    }
    // #577: strip write-restricted fields BEFORE applying the whitelist below.
    req.body = await filterWriteFields(req.body, req.user.role, "Invoice", req.user.tenantId);
    const before = await prisma.invoice.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!before) return res.status(404).json({ error: "Invoice not found" });

    // Terminal-status guard. PAID + VOIDED + REFUNDED + CREDIT_NOTE are all
    // immutable from the editor's perspective.
    if (["PAID", "VOIDED", "REFUNDED", "CREDIT_NOTE"].includes(before.status)) {
      return res.status(422).json({
        error: `Cannot update invoice in status ${before.status}`,
        code: "INVALID_INVOICE_TRANSITION",
        currentStatus: before.status,
      });
    }

    // Whitelist of mutable fields. Anything not here is silently ignored.
    const data = {};
    if (req.body.dueDate !== undefined) {
      const due = new Date(req.body.dueDate);
      if (Number.isNaN(due.getTime())) {
        return res.status(400).json({ error: "dueDate is invalid", code: "INVALID_DUE_DATE" });
      }
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      if (due < todayStart) {
        return res.status(400).json({ error: "dueDate cannot be in the past", code: "DUE_DATE_IN_PAST" });
      }
      data.dueDate = due;
    }
    if (req.body.isRecurring !== undefined) {
      data.isRecurring = !!req.body.isRecurring;
    }
    if (req.body.recurFrequency !== undefined) {
      const allowed = [null, "monthly", "quarterly", "yearly"];
      const v = req.body.recurFrequency || null;
      if (!allowed.includes(v)) {
        return res.status(400).json({ error: "recurFrequency must be one of monthly/quarterly/yearly", code: "INVALID_RECUR_FREQUENCY" });
      }
      data.recurFrequency = v;
    }
    // Reject attempts to mutate `amount` directly — money changes go through
    // /refund or /credit-note (which write their own audit trail with reason).
    if (req.body.amount !== undefined) {
      return res.status(400).json({
        error: "amount cannot be changed via PATCH — issue a credit-note or refund instead",
        code: "AMOUNT_IMMUTABLE",
      });
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields supplied", code: "NO_UPDATES" });
    }

    const after = await prisma.invoice.update({
      where: { id: before.id },
      data,
      include: { contact: true, deal: true },
    });
    // #179: audit the update with a real diff so reviewers see what actually changed.
    await writeAudit('Invoice', 'INVOICE_UPDATE', after.id, req.user.userId, req.user.tenantId,
      diffFields(before, after, Object.keys(data)));
    res.json(after);
  } catch (err) {
    console.error("[billing] patch error:", err);
    res.status(500).json({ error: "Failed to update invoice" });
  }
});

// #202: POST /:id/mark-paid — explicit, idempotent payment marker. Sister
// route to PUT/POST /:id/pay (kept for back-compat); this one accepts the
// `{ paidAt, paymentMethod, transactionRef }` body and writes a Payment row
// when the schema model exists. Idempotent: re-marking a PAID invoice returns
// 200 { idempotent: true } per Conventions §1, NOT 422. VOIDED/REFUNDED/
// CREDIT_NOTE return 422 INVALID_INVOICE_TRANSITION.
router.post("/:id/mark-paid", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "invalid invoice id", code: "INVALID_ID" });
    }
    const existing = await prisma.invoice.findFirst({ where: { id, tenantId: req.user.tenantId }, include: { contact: true } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });

    // Idempotency — re-marking a PAID invoice is a no-op success.
    if (existing.status === "PAID") {
      return res.status(200).json({ idempotent: true, invoice: existing });
    }
    // Terminal non-PAID statuses are not transitionable to PAID.
    if (["VOIDED", "REFUNDED", "CREDIT_NOTE"].includes(existing.status)) {
      return res.status(422).json({
        error: `Cannot mark ${existing.status} invoice as paid`,
        code: "INVALID_INVOICE_TRANSITION",
        currentStatus: existing.status,
      });
    }

    // Body is optional. Default paidAt = now.
    let paidAt = new Date();
    if (req.body && req.body.paidAt) {
      const p = new Date(req.body.paidAt);
      if (Number.isNaN(p.getTime())) {
        return res.status(400).json({ error: "paidAt is invalid", code: "INVALID_PAID_AT" });
      }
      paidAt = p;
    }
    const paymentMethod = (req.body && typeof req.body.paymentMethod === "string") ? req.body.paymentMethod.slice(0, 64) : null;
    const transactionRef = (req.body && typeof req.body.transactionRef === "string") ? req.body.transactionRef.slice(0, 128) : null;

    const invoice = await prisma.invoice.update({
      where: { id: existing.id },
      data: { status: "PAID", paidAt },
      include: { contact: true, deal: true },
    });

    // Write a Payment row if the schema has one. Wrapped because Payment is
    // optional context here — failure to log payment shouldn't unwind the
    // invoice flip (the audit row covers the actual state change).
    let payment = null;
    try {
      payment = await prisma.payment.create({
        data: {
          invoiceId: invoice.id,
          amount: Number(invoice.amount),
          gateway: paymentMethod || "manual",
          gatewayId: transactionRef || null,
          status: "SUCCESS",
          paidAt,
          tenantId: req.user.tenantId,
        },
      });
    } catch (e) {
      console.warn("[billing] mark-paid: Payment row write skipped:", e.message);
    }

    // Convention §6 — emit invoice.paid for downstream automations.
    try {
      require("../lib/eventBus").emitEvent(
        "invoice.paid",
        {
          invoiceId: invoice.id,
          amount: invoice.amount,
          contactId: invoice.contactId,
          paidAt: invoice.paidAt,
          paymentMethod,
          transactionRef,
        },
        req.user.tenantId,
        req.io
      );
    } catch (_e) {}
    // PRD Gap §13 wave-6a — invoice.completed mirrors invoice.paid for the
    // canonical "this invoice has reached its terminal PAID state" lifecycle
    // event used by analytics dashboards (P&L, completion rate). Decoupled
    // from invoice.paid so a workflow author can subscribe to either intent
    // without coupling completion analytics to the payment side.
    try {
      require("../lib/eventBus").emitEvent(
        "invoice.completed",
        {
          invoiceId: invoice.id,
          invoiceNum: invoice.invoiceNum,
          amount: invoice.amount,
          contactId: invoice.contactId,
          dealId: invoice.dealId,
          paidAt: invoice.paidAt,
          status: invoice.status,
        },
        req.user.tenantId,
        req.io
      );
    } catch (_e) {}
    // PRD Gap §13 wave-6a — emit payment.collected so downstream automations
    // (cashflow KPIs, gateway-by-channel reports) can react to the money-in
    // event, NOT just the invoice flip. Method is the gateway/payment-method
    // enum value (manual/stripe/razorpay/etc.).
    try {
      require("../lib/eventBus").emitEvent(
        "payment.collected",
        {
          invoiceId: invoice.id,
          paymentId: payment ? payment.id : null,
          amount: Number(invoice.amount),
          method: paymentMethod || "manual",
          currency: payment ? payment.currency : null,
          transactionRef,
          paidAt: invoice.paidAt,
        },
        req.user.tenantId,
        req.io
      );
    } catch (_e) {}

    // #179: audit the transition.
    await writeAudit('Invoice', 'MARK_PAID', invoice.id, req.user.userId, req.user.tenantId, {
      invoiceNum: invoice.invoiceNum,
      amount: invoice.amount,
      paidAt: invoice.paidAt,
      paymentMethod,
      transactionRef,
      paymentId: payment ? payment.id : null,
    });
    res.json({ ...invoice, payment });
  } catch (err) {
    console.error("[billing] mark-paid error:", err);
    res.status(500).json({ error: "Payment reconciliation operation failed" });
  }
});

// #177: POST /:id/pay alias for the existing PUT /:id/pay so older clients
// (and the bug reporter's POST attempts) work without the API contract gymnastics.
router.post("/:id/pay", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    const wasPaid = existing.status === "PAID";
    const data = { status: "PAID" };
    if (!wasPaid) data.paidAt = new Date();
    const invoice = await prisma.invoice.update({ where: { id: existing.id }, data, include: { contact: true } });
    if (!wasPaid) {
      try {
        require("../lib/eventBus").emitEvent(
          "invoice.paid",
          { invoiceId: invoice.id, amount: invoice.amount, contactId: invoice.contactId, paidAt: invoice.paidAt },
          req.user.tenantId,
          req.io
        );
      } catch(_e) {}
      // PRD Gap §13 wave-6a — invoice.completed + payment.collected mirror
      // the mark-paid path so all three "money in" routes emit the same trio.
      try {
        require("../lib/eventBus").emitEvent(
          "invoice.completed",
          { invoiceId: invoice.id, invoiceNum: invoice.invoiceNum, amount: invoice.amount, contactId: invoice.contactId, dealId: invoice.dealId, paidAt: invoice.paidAt, status: invoice.status },
          req.user.tenantId,
          req.io
        );
      } catch(_e) {}
      try {
        require("../lib/eventBus").emitEvent(
          "payment.collected",
          { invoiceId: invoice.id, paymentId: null, amount: Number(invoice.amount), method: "manual", currency: null, paidAt: invoice.paidAt },
          req.user.tenantId,
          req.io
        );
      } catch(_e) {}
      // #179: audit only on the actual UNPAID -> PAID transition.
      await writeAudit('Invoice', 'MARK_PAID', invoice.id, req.user.userId, req.user.tenantId, {
        invoiceNum: invoice.invoiceNum,
        amount: invoice.amount,
        paidAt: invoice.paidAt,
      });
    }
    res.json(invoice);
  } catch (_err) {
    res.status(500).json({ error: "Payment reconciliation operation failed" });
  }
});

// Reconcile Payment (Mark as Paid)
router.put("/:id/pay", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    // #119: stamp paidAt so "Paid This Month" KPI can filter on it. Don't overwrite
    // if already paid (preserves the original payment date).
    const wasPaid = existing.status === "PAID";
    const data = { status: "PAID" };
    if (!wasPaid) data.paidAt = new Date();
    const invoice = await prisma.invoice.update({
      where: { id: existing.id },
      data,
      include: { contact: true }
    });
    if (!wasPaid) {
      try {
        require("../lib/eventBus").emitEvent(
          "invoice.paid",
          { invoiceId: invoice.id, amount: invoice.amount, contactId: invoice.contactId, paidAt: invoice.paidAt },
          req.user.tenantId,
          req.io
        );
      } catch(_e) {}
      // PRD Gap §13 wave-6a — invoice.completed + payment.collected mirror
      // the mark-paid path so all three "money in" routes emit the same trio.
      try {
        require("../lib/eventBus").emitEvent(
          "invoice.completed",
          { invoiceId: invoice.id, invoiceNum: invoice.invoiceNum, amount: invoice.amount, contactId: invoice.contactId, dealId: invoice.dealId, paidAt: invoice.paidAt, status: invoice.status },
          req.user.tenantId,
          req.io
        );
      } catch(_e) {}
      try {
        require("../lib/eventBus").emitEvent(
          "payment.collected",
          { invoiceId: invoice.id, paymentId: null, amount: Number(invoice.amount), method: "manual", currency: null, paidAt: invoice.paidAt },
          req.user.tenantId,
          req.io
        );
      } catch(_e) {}
      // #179: audit only on the actual UNPAID -> PAID transition.
      await writeAudit('Invoice', 'MARK_PAID', invoice.id, req.user.userId, req.user.tenantId, {
        invoiceNum: invoice.invoiceNum,
        amount: invoice.amount,
        paidAt: invoice.paidAt,
      });
    }
    res.json(invoice);
  } catch (_err) {
    res.status(500).json({ error: "Payment reconciliation operation failed" });
  }
});

// Generate Invoice PDF
// Public payment confirmation — no auth. Called by the success page after
// Razorpay redirects back. Verifies the Razorpay callback signature with the
// tenant's own key secret, then marks the Payment + Invoice as PAID.
// This is the localhost/no-webhook fallback; the webhook handler in
// routes/payments.js is the primary reconciler in production.
router.post("/public/confirm-payment", async (req, res) => {
  const crypto = require("crypto");
  const { getTenantRazorpayCreds } = require("../lib/tenantPaymentGateway");
  try {
    const {
      razorpay_payment_link_id,
      razorpay_payment_link_reference_id,
      razorpay_payment_link_status,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_payment_link_id || razorpay_payment_link_status !== "paid") {
      return res.status(400).json({ error: "Payment not completed" });
    }

    const payment = await prisma.payment.findFirst({
      where: { gateway: "razorpay", gatewayId: razorpay_payment_link_id },
    });
    if (!payment) return res.status(404).json({ error: "Payment record not found" });

    // Verify signature using tenant's own key secret
    const creds = await getTenantRazorpayCreds(payment.tenantId);
    if (creds && razorpay_signature) {
      const body = `${razorpay_payment_link_id}|${razorpay_payment_link_reference_id}|${razorpay_payment_link_status}|${razorpay_payment_id}`;
      const expected = crypto.createHmac("sha256", creds.keySecret).update(body).digest("hex");
      if (expected !== razorpay_signature) {
        return res.status(400).json({ error: "Signature verification failed" });
      }
    }

    if (payment.status !== "SUCCESS") {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "SUCCESS",
          paidAt: new Date(),
          // Keep gatewayId as the plink_ ID so receipt lookup keeps working.
          // Store the actual razorpay_payment_id in metadata for audit trail.
          metadata: JSON.stringify({ mode: "payment_link", plinkId: razorpay_payment_link_id, razorpayPaymentId: razorpay_payment_id }),
        },
      });
      // Mark invoice paid
      if (payment.invoiceId) {
        const inv = await prisma.invoice.findFirst({ where: { id: payment.invoiceId } });
        if (inv && inv.status !== "PAID") {
          await prisma.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });
        }
      }
    }

    res.json({ ok: true, plinkId: razorpay_payment_link_id });
  } catch (err) {
    console.error("[PublicConfirmPayment] error:", err.message);
    res.status(500).json({ error: "Failed to confirm payment" });
  }
});

// Public invoice PDF receipt — no auth. Accessed after a Razorpay payment-link
// callback. The `plinkId` (plink_…) is Razorpay-generated and unguessable; we
// require status=SUCCESS so partial/failed payments can't pull the PDF.
router.get("/public/receipt", async (req, res) => {
  try {
    const { plinkId } = req.query;
    if (!plinkId || !String(plinkId).startsWith("plink_")) {
      return res.status(400).json({ error: "Invalid payment link ID" });
    }
    const payment = await prisma.payment.findFirst({
      where: {
        gateway: "razorpay",
        status: "SUCCESS",
        OR: [
          { gatewayId: plinkId },
          { metadata: { contains: plinkId } },
        ],
      },
    });
    if (!payment) return res.status(404).json({ error: "Paid payment not found for this link" });

    const invoice = await prisma.invoice.findFirst({
      where: { id: payment.invoiceId },
      include: { contact: true },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const tenant = await prisma.tenant.findUnique({
      where: { id: payment.tenantId },
      select: { name: true, defaultCurrency: true, locale: true },
    });
    const currency = tenant?.defaultCurrency || "INR";
    const locale = tenant?.locale || undefined;
    const tenantName = tenant?.name || "Your Company";

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const filename = `${invoice.invoiceNum || "INV-" + invoice.id}-receipt.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.on("error", (err) => {
      console.error("[PublicReceipt] PDF stream error:", err);
      try { res.end(); } catch (_) {}
    });
    doc.pipe(res);

    // Header
    doc.fontSize(24).font("Helvetica-Bold").text(tenantName, 50, 50);
    doc.fontSize(10).font("Helvetica").fillColor("#666666").text("Payment Receipt", 50, 80);

    // Invoice details
    doc.fillColor("#000000").fontSize(14).font("Helvetica-Bold")
      .text(`Invoice: ${invoice.invoiceNum || "N/A"}`, 50, 130);
    doc.fontSize(10).font("Helvetica").fillColor("#333333");
    doc.text(`Status: PAID`, 50, 155);
    doc.text(`Issue Date: ${new Date(invoice.createdAt).toLocaleDateString()}`, 50, 172);
    doc.text(`Paid On: ${new Date(payment.paidAt || Date.now()).toLocaleDateString()}`, 50, 189);

    // Contact
    doc.fontSize(12).font("Helvetica-Bold").fillColor("#000000").text("Bill To:", 50, 225);
    doc.fontSize(10).font("Helvetica").fillColor("#333333")
      .text(invoice.contact?.name || "Customer", 50, 245)
      .text(invoice.contact?.email || "", 50, 260);

    doc.moveTo(50, 300).lineTo(545, 300).strokeColor("#cccccc").stroke();

    // Amount table
    doc.fillColor("#ffffff").rect(50, 315, 495, 30).fill("#10b981");
    doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
      .text("Description", 60, 323)
      .text("Amount", 450, 323, { width: 85, align: "right" });

    doc.fillColor("#333333").font("Helvetica").fontSize(10)
      .text("Invoice Charge", 60, 360)
      .text(formatMoney(invoice.amount, currency, locale), 450, 360, { width: 85, align: "right" });

    doc.moveTo(50, 390).lineTo(545, 390).strokeColor("#cccccc").stroke();
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#000000")
      .text("Total Paid:", 350, 405)
      .text(formatMoney(invoice.amount, currency, locale), 450, 405, { width: 85, align: "right" });

    doc.fontSize(8).font("Helvetica").fillColor("#999999")
      .text("Thank you for your payment.", 50, 750, { align: "center" });

    doc.end();
  } catch (err) {
    console.error("[PublicReceipt] error:", err);
    if (res.headersSent) { try { res.end(); } catch (_) {} }
    else res.status(500).json({ error: "Failed to generate receipt" });
  }
});

router.get("/:id/pdf", verifyToken, async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
      include: { contact: true },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    // #286/#330: render currency through formatMoney(tenant.defaultCurrency)
    // so wellness/INR invoices show ₹ not $.
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { defaultCurrency: true, locale: true },
    });
    const currency = tenant?.defaultCurrency || "USD";
    const locale = tenant?.locale || undefined;

    const doc = new PDFDocument({ size: "A4", margin: 50 });

    const filename = `${invoice.invoiceNum || "INV-" + invoice.id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // If PDFKit emits an error mid-stream we can't send a JSON envelope (headers
    // are flushed on first chunk), but we MUST detach the pipe and end the
    // response cleanly so the browser doesn't hang on a half-written body.
    doc.on("error", (err) => {
      console.error("[PDF Generation Error] (stream):", err);
      try { res.end(); } catch (_) { /* already destroyed */ }
    });
    doc.pipe(res);

    // Header
    doc.fontSize(24).font("Helvetica-Bold").text("Globussoft CRM", 50, 50);
    doc.fontSize(10).font("Helvetica").fillColor("#666666")
      .text("Enterprise Invoice", 50, 80);

    // Invoice details box
    doc.fillColor("#000000").fontSize(14).font("Helvetica-Bold")
      .text(`Invoice: ${invoice.invoiceNum || "N/A"}`, 50, 130);

    doc.fontSize(10).font("Helvetica").fillColor("#333333");
    const statusLabel = invoice.status || "UNPAID";
    doc.text(`Status: ${statusLabel}`, 50, 155);
    doc.text(`Issue Date: ${new Date(invoice.createdAt).toLocaleDateString()}`, 50, 172);
    doc.text(`Due Date: ${new Date(invoice.dueDate).toLocaleDateString()}`, 50, 189);

    // Contact info
    doc.fontSize(12).font("Helvetica-Bold").fillColor("#000000")
      .text("Bill To:", 50, 225);
    doc.fontSize(10).font("Helvetica").fillColor("#333333")
      .text(invoice.contact?.name || "Unknown Contact", 50, 245)
      .text(invoice.contact?.email || "", 50, 260)
      .text(invoice.contact?.company || "", 50, 275);

    // Line separator
    doc.moveTo(50, 310).lineTo(545, 310).strokeColor("#cccccc").stroke();

    // Amount table header
    doc.fillColor("#ffffff").rect(50, 325, 495, 30).fill("#3b82f6");
    doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
      .text("Description", 60, 333)
      .text("Amount", 450, 333, { width: 85, align: "right" });

    // Amount row
    doc.fillColor("#333333").font("Helvetica").fontSize(10)
      .text("Invoice Charge", 60, 370)
      .text(formatMoney(invoice.amount, currency, locale), 450, 370, { width: 85, align: "right" });

    // Total
    doc.moveTo(50, 400).lineTo(545, 400).strokeColor("#cccccc").stroke();
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#000000")
      .text("Total:", 350, 415)
      .text(formatMoney(invoice.amount, currency, locale), 450, 415, { width: 85, align: "right" });

    // Footer
    doc.fontSize(8).font("Helvetica").fillColor("#999999")
      .text("Generated by Globussoft CRM", 50, 750, { align: "center" });

    doc.end();
  } catch (err) {
    console.error("[PDF Generation Error]:", err);
    if (res.headersSent) {
      try { res.end(); } catch (_) { /* already destroyed */ }
    } else {
      res.status(500).json({ error: err?.message || "Failed to generate invoice PDF" });
    }
  }
});

// Set invoice as recurring
router.put("/:id/recurring", verifyToken, async (req, res) => {
  try {
    const { isRecurring, recurFrequency } = req.body;
    const invoice = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const nextDate = isRecurring ? new Date() : null;
    if (nextDate && recurFrequency) {
      switch (recurFrequency) {
        case "monthly": nextDate.setMonth(nextDate.getMonth() + 1); break;
        case "quarterly": nextDate.setMonth(nextDate.getMonth() + 3); break;
        case "yearly": nextDate.setFullYear(nextDate.getFullYear() + 1); break;
      }
    }

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { isRecurring: !!isRecurring, recurFrequency: recurFrequency || null, nextRecurDate: nextDate },
      include: { contact: true }
    });
    res.json(updated);
  } catch (_err) {
    res.status(500).json({ error: "Failed to update recurring status" });
  }
});

// Soft-void: status flips to VOIDED, row + audit trail preserved.
// This is what the UI's "Void" button calls.
async function voidInvoiceHandler(req, res) {
  try {
    const existing = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (existing.status === "PAID") return res.status(400).json({ error: "Cannot void a paid invoice — use /refund instead", code: "INVOICE_ALREADY_PAID" });
    if (existing.status === "VOIDED") return res.json({ ...existing, idempotent: true });
    const invoice = await prisma.invoice.update({
      where: { id: existing.id },
      data: { status: "VOIDED" },
      include: { contact: true, deal: true }
    });
    // #179: audit the void. reason is optional — accepted via body for the
    // POST/PUT /:id/void endpoints, omitted for the legacy DELETE /:id alias.
    await writeAudit('Invoice', 'VOID', invoice.id, req.user?.userId || null, req.user.tenantId, {
      invoiceNum: invoice.invoiceNum,
      amount: invoice.amount,
      reason: req.body?.reason || null,
      via: req.method,
    });
    // PRD Gap §13 wave-6a — emit invoice.voided so downstream automations
    // (write-off analytics, AR adjustments, accounting sync) can react.
    try {
      require("../lib/eventBus").emitEvent(
        "invoice.voided",
        {
          invoiceId: invoice.id,
          invoiceNum: invoice.invoiceNum,
          amount: invoice.amount,
          contactId: invoice.contactId,
          dealId: invoice.dealId,
          reason: req.body?.reason || null,
          via: req.method,
          status: invoice.status,
        },
        req.user.tenantId,
        req.io
      );
    } catch (_e) {}
    res.json(invoice);
  } catch (_err) {
    res.status(500).json({ error: "Failed to void invoice" });
  }
}
router.put("/:id/void", verifyToken, verifyRole(["ADMIN", "MANAGER"]), voidInvoiceHandler);
// #193: POST alias so callers that follow REST conventions (POST for actions) work.
router.post("/:id/void", verifyToken, verifyRole(["ADMIN", "MANAGER"]), voidInvoiceHandler);

// Generate a hosted Razorpay Payment Link for an invoice using the tenant's
// own BYOK keys. Returns { url, gateway } the admin can copy and share.
router.post("/:id/payment-link", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  const { createInvoicePaymentLink } = require("../lib/paymentLink");
  try {
    const tenantId = req.user.tenantId;
    const [invoice, tenant] = await Promise.all([
      prisma.invoice.findFirst({
        where: { id: parseInt(req.params.id), tenantId },
        include: { contact: { select: { name: true, email: true, phone: true } } },
      }),
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    ]);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === "PAID") return res.status(400).json({ error: "Invoice is already paid" });
    if (invoice.status === "VOIDED") return res.status(400).json({ error: "Cannot generate a link for a voided invoice" });

    const result = await createInvoicePaymentLink({
      tenantId,
      invoice: { id: invoice.id, invoiceNum: invoice.invoiceNum, amount: invoice.amount },
      contact: invoice.contact || undefined,
      currency: invoice.currency || "INR",
      gatewayPref: "razorpay",
      tenantName: tenant?.name || undefined,
    });

    if (result.error) return res.status(502).json({ error: result.error, code: result.code });
    res.json({ url: result.url, gateway: result.gateway });
  } catch (err) {
    console.error("[billing] payment-link error:", err.message);
    res.status(500).json({ error: "Failed to generate payment link" });
  }
});

// #193: refund a PAID invoice. Status flips to REFUNDED; original paidAt
// preserved so we still know when money came in. Partial refunds are not
// supported here yet — for partial reversals issue a credit-note instead.
router.post("/:id/refund", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const existing = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Invoice not found" });
    if (existing.status !== "PAID") {
      return res.status(400).json({ error: "Only PAID invoices can be refunded", code: "INVOICE_NOT_PAID" });
    }
    const invoice = await prisma.invoice.update({
      where: { id: existing.id },
      data: { status: "REFUNDED" },
      include: { contact: true, deal: true }
    });
    // #179: audit refund. Original paidAt is preserved on the row, so we don't
    // duplicate it here — caller can read it from the invoice row directly.
    await writeAudit('Invoice', 'REFUND', invoice.id, req.user.userId, req.user.tenantId, {
      invoiceNum: invoice.invoiceNum,
      amount: invoice.amount,
      reason: req.body?.reason || null,
    });
    // PRD Gap §13 wave-6a — emit invoice.refunded so downstream automations
    // (refund-rate KPIs, accounting reversal sync, NPS dampening) can react.
    try {
      require("../lib/eventBus").emitEvent(
        "invoice.refunded",
        {
          invoiceId: invoice.id,
          invoiceNum: invoice.invoiceNum,
          amount: invoice.amount,
          contactId: invoice.contactId,
          dealId: invoice.dealId,
          reason: req.body?.reason || null,
          status: invoice.status,
        },
        req.user.tenantId,
        req.io
      );
    } catch (_e) {}
    res.json(invoice);
  } catch (err) {
    console.error("[billing] refund error:", err);
    res.status(500).json({ error: "Failed to refund invoice" });
  }
});

// #193: GST-compliant credit note — creates a NEW invoice with a negative
// amount, linked back to the original via parentInvoiceId. The original row
// is left as-is (PAID stays PAID), the credit note carries its own CN- number
// and shows up alongside the original in the ledger.
router.post("/:id/credit-note", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const original = await prisma.invoice.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!original) return res.status(404).json({ error: "Invoice not found" });
    if (original.status === "VOIDED") return res.status(400).json({ error: "Cannot issue credit note against a voided invoice", code: "INVOICE_VOIDED" });

    const requestedAmount = req.body.amount !== undefined ? Number(req.body.amount) : Number(original.amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      return res.status(400).json({ error: "credit-note amount must be greater than 0", code: "INVALID_AMOUNT" });
    }
    if (requestedAmount > Number(original.amount) + 1e-9) {
      return res.status(400).json({ error: "credit-note amount cannot exceed the original invoice amount", code: "AMOUNT_EXCEEDS_ORIGINAL" });
    }
    const cnAmount = -1 * (Math.round(requestedAmount * 100) / 100);
    const cnNum = `CN-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const creditNote = await prisma.invoice.create({
      data: {
        invoiceNum: cnNum,
        amount: cnAmount,
        dueDate: original.dueDate,
        contactId: original.contactId,
        dealId: original.dealId,
        parentInvoiceId: original.id,
        status: "CREDIT_NOTE",
        tenantId: req.user.tenantId,
      },
      include: { contact: true, deal: true }
    });
    // #179: audit credit note issuance. Two-sided trail — the original gets a
    // CREDIT_NOTE_ISSUED row pointing forward; the new credit-note row gets a
    // CREATE row with via=credit-note so it's clearly distinguished from a
    // standard manual invoice.
    await writeAudit('Invoice', 'CREDIT_NOTE_ISSUED', original.id, req.user.userId, req.user.tenantId, {
      creditNoteId: creditNote.id,
      creditNoteNum: creditNote.invoiceNum,
      amount: cnAmount,
      reason: req.body.reason || null,
    });
    await writeAudit('Invoice', 'CREATE', creditNote.id, req.user.userId, req.user.tenantId, {
      invoiceNum: creditNote.invoiceNum,
      amount: cnAmount,
      parentInvoiceId: original.id,
      via: 'credit-note',
    });
    res.status(201).json({ creditNote, originalInvoiceId: original.id, reason: req.body.reason || null });
  } catch (err) {
    console.error("[billing] credit-note error:", err);
    res.status(500).json({ error: "Failed to issue credit note" });
  }
});

// #122 reopen: DELETE was a hard delete that destroyed billing records. Now
// it's a soft-void — same code path as PUT/POST /:id/void. The verb stays
// for backwards-compat with any old client, but the data is preserved.
router.delete("/:id", verifyToken, verifyRole(["ADMIN"]), voidInvoiceHandler);

// ─── POST /recurring/run ─────────────────────────────────────────
// G-9: Manual trigger for the recurring-invoice cron engine. Mirrors
// POST /api/forecasting/snapshot/run + /api/wellness/ops/run.
// Drives cron/recurringInvoiceEngine.processRecurringInvoices logic, but
// scoped to the requesting tenant only (the cron version is all-tenant).
// Reusing the engine's per-tenant body keeps cron + manual paths aligned
// on field semantics (nextRecurDate window, recurFrequency advancement,
// audit row write). Gated to ADMIN — generating an invoice is a
// money-mutating action.
//
// Returns { success, tenantId, processed, generated, errors } where
// `processed` is the count of due rows we walked, `generated` is the
// count of new Invoice rows created, and `errors` is any per-row
// failures (mirrors the engine's try/catch shape).
function addInterval(date, frequency) {
  const d = new Date(date);
  switch (frequency) {
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  return d;
}

router.post("/recurring/run", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const now = new Date();
    // Mirror engine query but scoped to req.user.tenantId. Engine excludes
    // status='VOID'; we follow that contract so paused/voided templates
    // never re-generate. (Engine uses 'VOID' literal — schema supports
    // 'VOIDED' as a synonym in /void route; we accept either by excluding
    // BOTH so any state that the void route writes is honoured.)
    const due = await prisma.invoice.findMany({
      where: {
        tenantId,
        isRecurring: true,
        status: { notIn: ["VOID", "VOIDED"] },
        nextRecurDate: { lte: now },
      },
      include: { contact: true },
    });

    let generated = 0;
    const errors = [];
    for (const inv of due) {
      try {
        const invNum = `INV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        const newDueDate = addInterval(now, inv.recurFrequency);
        await prisma.invoice.create({
          data: {
            invoiceNum: invNum,
            amount: inv.amount,
            status: "UNPAID",
            dueDate: newDueDate,
            contactId: inv.contactId,
            dealId: inv.dealId,
            parentInvoiceId: inv.id,
            tenantId,
          },
        });
        // Advance nextRecurDate by the recurrence interval. Mirror the
        // engine: advance OFF the existing nextRecurDate (not now), so
        // a missed-tick recovery still lands on the correct schedule.
        const nextDate = addInterval(inv.nextRecurDate, inv.recurFrequency);
        await prisma.invoice.update({
          where: { id: inv.id },
          data: { nextRecurDate: nextDate },
        });
        // Audit, mirroring the engine's write so the manual + cron paths
        // emit identical AuditLog rows.
        await prisma.auditLog.create({
          data: {
            action: "CREATE",
            entity: "Invoice",
            entityId: inv.id,
            details: JSON.stringify({
              source: "Recurring",
              parentInvoice: inv.invoiceNum,
              newInvoice: invNum,
              via: "manual",
            }),
            tenantId,
            userId: req.user.userId || null,
          },
        }).catch(() => { /* best-effort */ });
        generated++;
      } catch (err) {
        errors.push({ id: inv.id, error: err.message });
      }
    }

    res.json({
      success: true,
      tenantId,
      processed: due.length,
      generated,
      errors,
    });
  } catch (err) {
    console.error("[billing/recurring/run]", err);
    res.status(500).json({ error: "Failed to run recurring invoice engine", detail: err.message });
  }
});

module.exports = router;
