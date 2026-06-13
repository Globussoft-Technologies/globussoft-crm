// PRD_TRAVEL_GST_COMPLIANCE — GST ledger endpoints cluster.
//
// Ships 3 GET endpoints under /api/travel/invoices/* — JSON or CSV per
// the ?format= flag. All three are read-only analytics surfaces sourced
// from existing schema rows; no schema persistence happens here.
//
// Endpoints (all mounted at /api/travel via server.js):
//   GET /invoices/customer-ledger?gstin=&fy=YYYY-YY&contactId=&format=  — G030 (FR-3.4.4)
//   GET /invoices/tds-register?fy=YYYY-YY&section=&format=              — G031 (FR-3.4.6)
//   GET /invoices/commission-ledger?fy=YYYY-YY&type=&format=            — G032 (FR-3.4.7)
//
// Standing rules honoured (CLAUDE.md):
//   - JWT user = req.user.userId (never req.user.id)
//   - stripDangerous middleware strips dangerous body fields
//   - tenantId is scoped via req.travelTenant.id (verifyTravelTenant)
//   - Sub-brand isolation via getSubBrandAccessSet (where applicable)
//
// Auth posture: all routes verifyToken + requireTravelTenant. The data
// itself does not need an elevated role beyond the travel-tenant guard
// — these are read-only finance reports for the Admin / Manager / User
// roles. The Form-26Q CSV export shape is suitable for the operator's
// CA to upload to TRACES.

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const prisma = require('../lib/prisma');
const { requireTravelTenant, getSubBrandAccessSet, canAccessSubBrand } = require('../middleware/travelGuards');
const {
  buildCustomerLedger,
  buildCustomerLedgerCsv,
  fyBoundaries,
} = require('../lib/customerLedger');
const {
  buildTdsRegister,
  buildTdsRegisterCsv,
  isValidSection,
} = require('../lib/tdsRegister');
const {
  buildCommissionLedger,
  buildCommissionLedgerCsv,
  isValidType,
} = require('../lib/commissionLedger');
const { isValidFyLongLabel, fiscalYearLabelLong } = require('../lib/travelFiscalYear');

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function isValidGstinShape(g) {
  if (g == null || g === '') return true; // empty / null treated as no-filter
  if (typeof g !== 'string') return false;
  // 15-char canonical shape; checksum-validation deferred to FR-3.3.1 helper.
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/i.test(g.trim());
}

function parseIntStrict(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

function sendCsv(res, filename, body) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

// ---------------------------------------------------------------------------
// GET /invoices/customer-ledger — G030 (FR-3.4.4)
// ---------------------------------------------------------------------------

router.get('/invoices/customer-ledger', verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const fy = req.query.fy ? String(req.query.fy) : fiscalYearLabelLong(new Date());
    if (!isValidFyLongLabel(fy)) {
      return res.status(400).json({
        error: 'fy must be FY<startYear>-<endTwo> e.g. FY2025-26',
        code: 'INVALID_FISCAL_YEAR',
      });
    }
    const gstinRaw = req.query.gstin ? String(req.query.gstin).trim() : '';
    if (gstinRaw && !isValidGstinShape(gstinRaw)) {
      return res.status(400).json({
        error: 'gstin must be 15-character GSTIN shape',
        code: 'INVALID_GSTIN',
      });
    }
    const contactId = parseIntStrict(req.query.contactId);
    if (req.query.contactId && contactId == null) {
      return res.status(400).json({
        error: 'contactId must be a number',
        code: 'INVALID_CONTACT_ID',
      });
    }

    if (!gstinRaw && contactId == null) {
      return res.status(400).json({
        error: 'one of gstin or contactId is required',
        code: 'MISSING_FILTER',
      });
    }

    // Resolve target contacts.
    // Sibling GST agent adds Contact.gstin + Contact.billingStateCode in
    // parallel; we only filter on Contact.gst (legacy column that exists
    // today). When the sibling lands their migration the route is wire-in
    // ready: just OR-clause both fields. The B2B foundation slice has
    // Contact.gst as the canonical 15-char GSTIN value.
    const contactWhere = { tenantId: req.travelTenant.id };
    if (contactId != null) contactWhere.id = contactId;
    if (gstinRaw) {
      contactWhere.gst = gstinRaw.toUpperCase();
    }

    const contacts = await prisma.contact.findMany({
      where: contactWhere,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        stateCode: true,
        gst: true,
      },
    });

    if (contacts.length === 0) {
      return res.status(404).json({
        error: 'No contact found matching filter',
        code: 'CONTACT_NOT_FOUND',
      });
    }

    const contactIds = contacts.map((c) => c.id);
    const currency = req.travelTenant.defaultCurrency || 'INR';

    // Sub-brand scoping for the invoice query.
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const invoiceWhere = {
      tenantId: req.travelTenant.id,
      contactId: { in: contactIds },
    };
    if (allowed) {
      invoiceWhere.subBrand = { in: [...allowed] };
    }

    const [invoices, scheduleRows] = await Promise.all([
      prisma.travelInvoice.findMany({
        where: invoiceWhere,
        select: {
          id: true,
          invoiceNum: true,
          totalAmount: true,
          currency: true,
          status: true,
          docType: true,
          dueDate: true,
          paidAt: true,
          createdAt: true,
          subBrand: true,
        },
      }),
      prisma.travelPaymentSchedule.findMany({
        where: {
          tenantId: req.travelTenant.id,
          invoice: { contactId: { in: contactIds } },
          receivedAmount: { gt: 0 },
          paidAt: { not: null },
        },
        select: {
          id: true,
          invoiceId: true,
          receivedAmount: true,
          paidAt: true,
          milestoneOrder: true,
          invoice: { select: { invoiceNum: true, subBrand: true } },
        },
      }),
    ]);

    // Normalize payment shape — pull invoiceNum + subBrand into the row
    // so the ledger builder doesn't need to re-join.
    const payments = scheduleRows.map((s) => ({
      id: s.id,
      invoiceId: s.invoiceId,
      receivedAmount: s.receivedAmount,
      paidAt: s.paidAt,
      milestoneOrder: s.milestoneOrder,
      invoiceNum: s.invoice?.invoiceNum,
      subBrand: s.invoice?.subBrand,
    }));

    const { fyStart, fyEnd } = fyBoundaries(fy);
    const ledger = buildCustomerLedger({ invoices, payments, fyStart, fyEnd });

    const primaryContact = contacts[0];
    const responseBase = {
      fiscalYear: fy,
      gstin: gstinRaw ? gstinRaw.toUpperCase() : null,
      contact: gstinRaw && contacts.length > 1
        ? { ids: contactIds, count: contacts.length }
        : {
            id: primaryContact.id,
            name: primaryContact.name,
            email: primaryContact.email,
            gstin: gstinRaw ? gstinRaw.toUpperCase() : (primaryContact.gst || null),
            billingStateCode: primaryContact.stateCode || null,
          },
      openingBalance: {
        amount: ledger.openingBalance,
        currency,
        asOfDate: fyStart.toISOString(),
      },
      transactions: ledger.transactions,
      closingBalance: {
        amount: ledger.closingBalance,
        currency,
        asOfDate: fyEnd.toISOString(),
      },
      summary: ledger.summary,
    };

    const fmt = req.query.format ? String(req.query.format).toLowerCase() : 'json';
    if (fmt === 'csv') {
      const csv = buildCustomerLedgerCsv(ledger, {
        contactName: primaryContact.name,
        gstin: gstinRaw,
        fiscalYear: fy,
        currency,
      });
      const filename = `customer-ledger-${primaryContact.id}-${fy}.csv`;
      return sendCsv(res, filename, csv);
    }

    res.json(responseBase);
  } catch (e) {
    console.error('[travel-invoice-ledgers] customer-ledger error:', e.message);
    res.status(500).json({ error: 'Failed to build customer ledger', code: 'CUSTOMER_LEDGER_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// GET /invoices/tds-register — G031 (FR-3.4.6)
// ---------------------------------------------------------------------------
//
// SCOPE DRIFT NOTE (mirrors backend/lib/tdsRegister.js header):
// The PRD originally framed this as customer-side TDS (TDS deducted BY
// CUSTOMERS when they pay the operator). Customer-side TDS columns
// do not exist on the current schema. This implementation pivots to
// the SUPPLIER-SIDE TDS register (TDS WE deduct when WE pay suppliers /
// commission agents — Section 194H by default per DD-5.5). The schema
// surface backing this exists today (TravelSupplierCommissionEntry.tdsAmount).
//
// Customer-side TDS stays open for a future slice once Payment.tdsAmount
// (or similar) lands. Operators who need the customer-side report should
// file a follow-up issue.

router.get('/invoices/tds-register', verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const fy = req.query.fy ? String(req.query.fy) : fiscalYearLabelLong(new Date());
    if (!isValidFyLongLabel(fy)) {
      return res.status(400).json({
        error: 'fy must be FY<startYear>-<endTwo> e.g. FY2025-26',
        code: 'INVALID_FISCAL_YEAR',
      });
    }
    const section = req.query.section ? String(req.query.section) : 'all';
    if (!isValidSection(section)) {
      return res.status(400).json({
        error: "section must be one of 194H | 194J | 194C | all",
        code: 'INVALID_SECTION',
      });
    }

    // Sub-brand scoping — filter the commission entries via the joined
    // supplier's subBrand when caller is narrowed.
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const where = {
      tenantId: req.travelTenant.id,
      fiscalYear: fy,
      tdsAmount: { gt: 0 },
    };
    if (allowed) {
      where.supplier = { subBrand: { in: [...allowed] } };
    }

    const commissionEntries = await prisma.travelSupplierCommissionEntry.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            subBrand: true,
            gstin: true,
            kyc: { select: { panNumber: true } },
          },
        },
      },
    });

    const register = buildTdsRegister({
      commissionEntries,
      supplierPayables: [], // future: load when Payable.tdsAmount lands
      section,
      fiscalYear: fy,
    });

    const fmt = req.query.format ? String(req.query.format).toLowerCase() : 'json';
    if (fmt === 'csv') {
      const csv = buildTdsRegisterCsv(register);
      const filename = `tds-register-${fy}${section !== 'all' ? `-${section}` : ''}.csv`;
      return sendCsv(res, filename, csv);
    }

    res.json(register);
  } catch (e) {
    console.error('[travel-invoice-ledgers] tds-register error:', e.message);
    res.status(500).json({ error: 'Failed to build TDS register', code: 'TDS_REGISTER_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// GET /invoices/commission-ledger — G032 (FR-3.4.7)
// ---------------------------------------------------------------------------

router.get('/invoices/commission-ledger', verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const fy = req.query.fy ? String(req.query.fy) : fiscalYearLabelLong(new Date());
    if (!isValidFyLongLabel(fy)) {
      return res.status(400).json({
        error: 'fy must be FY<startYear>-<endTwo> e.g. FY2025-26',
        code: 'INVALID_FISCAL_YEAR',
      });
    }
    const type = req.query.type ? String(req.query.type) : 'all';
    if (!isValidType(type)) {
      return res.status(400).json({
        error: 'type must be one of iata_inward | hotel | air | tour | visa | other | all',
        code: 'INVALID_TYPE',
      });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    const where = {
      tenantId: req.travelTenant.id,
      fiscalYear: fy,
    };
    if (allowed) {
      where.supplier = { subBrand: { in: [...allowed] } };
    }

    const entries = await prisma.travelSupplierCommissionEntry.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            subBrand: true,
            supplierCategory: true,
            commissionPercent: true,
          },
        },
      },
    });

    const ledger = buildCommissionLedger({ entries, type, fiscalYear: fy });

    const fmt = req.query.format ? String(req.query.format).toLowerCase() : 'json';
    if (fmt === 'csv') {
      const csv = buildCommissionLedgerCsv(ledger);
      const filename = `commission-ledger-${fy}${type !== 'all' ? `-${type}` : ''}.csv`;
      return sendCsv(res, filename, csv);
    }

    res.json(ledger);
  } catch (e) {
    console.error('[travel-invoice-ledgers] commission-ledger error:', e.message);
    res.status(500).json({ error: 'Failed to build commission ledger', code: 'COMMISSION_LEDGER_ERROR' });
  }
});

module.exports = router;
