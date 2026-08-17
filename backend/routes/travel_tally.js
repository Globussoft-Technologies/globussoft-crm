// Travel CRM — Tally ledger data and tax preview.
//
// Endpoint:
//   GET /api/travel/tally/ledger
//
// The endpoint reads existing invoices, expenses, contacts, itineraries, and
// tax fields from Prisma. It applies the requested sub-brand, trip, and date
// filters, then returns calculated ledger accounts for the Tally wizard.
// No invoice, expense, or tax record is created or modified by this route.

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { computeTcs } = require("../lib/tcsCalculation");
const { fiscalYearStart } = require("../lib/travelFiscalYear");

// Supported Travel CRM sub-brand identifiers.
const VALID_BRANDS = new Set(["tmc", "rfu", "travelstall", "visasure"]);

// Parse an inclusive date-range boundary for the ledger query.
const parseDate = (value, end = false) => {
  if (!value) return null;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Safely read JSON metadata stored on expense records.
const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value || "");
  } catch (_) {
    return fallback;
  }
};

// Identify overseas trips for the automatic TCS preview. The destination is
// supplied by the existing itinerary record; this route does not create trips.
const isInternationalDestination = (destination) =>
  Boolean(
    destination &&
    !/\b(india|goa|delhi|mumbai|kerala|rajasthan|jaipur|hyderabad|chennai|bengaluru|bangalore|kolkata)\b/i.test(
      destination,
    ),
  );

router.get(
  "/tally/ledger",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      // Validate the requested filters before querying tenant data.
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to, true);
      const subBrand = String(req.query.subBrand || "");
      const itineraryId = req.query.itineraryId
        ? Number(req.query.itineraryId)
        : null;
      if (
        req.query.itineraryId &&
        (!Number.isInteger(itineraryId) || itineraryId <= 0)
      )
        return res
          .status(400)
          .json({ error: "Invalid trip", code: "INVALID_TRIP" });
      if ((req.query.from && !from) || (req.query.to && !to))
        return res
          .status(400)
          .json({ error: "Invalid date range", code: "INVALID_DATE_RANGE" });
      if (from && to && to <= from)
        return res
          .status(400)
          .json({
            error: "To date must be after the From date",
            code: "INVALID_DATE_RANGE",
          });
      if (!subBrand)
        return res
          .status(400)
          .json({ error: "Sub-brand is required", code: "SUB_BRAND_REQUIRED" });
      if (subBrand && !VALID_BRANDS.has(subBrand))
        return res
          .status(400)
          .json({ error: "Invalid sub-brand", code: "INVALID_SUB_BRAND" });
      const dateWhere =
        from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {};

      // Fetch filtered accounting records together with date-range metadata
      // and the selected itinerary used by the TCS preview.
      const [invoices, expenses, rangeInvoices, rangeExpenses, selectedTrip] =
        await Promise.all([
          prisma.travelInvoice.findMany({
            where: {
              tenantId: req.travelTenant.id,
              status: { not: "Voided" },
              ...(subBrand ? { subBrand } : {}),
              ...(itineraryId ? { itineraryId } : {}),
              ...dateWhere,
            },
            select: {
              id: true,
              invoiceNum: true,
              itineraryId: true,
              totalAmount: true,
              currency: true,
              contactId: true,
              tcsAmount: true,
              tcsRate: true,
              totalTaxAmount: true,
              cgstAmount: true,
              sgstAmount: true,
              igstAmount: true,
              cgstPercent: true,
              sgstPercent: true,
              igstPercent: true,
            },
          }),
          prisma.expense.findMany({
            where: { tenantId: req.travelTenant.id, ...dateWhere },
            select: {
              id: true,
              title: true,
              amount: true,
              notes: true,
              category: true,
            },
          }),
          prisma.travelInvoice.findMany({
            where: {
              tenantId: req.travelTenant.id,
              status: { not: "Voided" },
              subBrand,
            },
            select: { createdAt: true },
          }),
          prisma.expense.findMany({
            where: { tenantId: req.travelTenant.id },
            select: { createdAt: true, notes: true },
          }),
          itineraryId
            ? prisma.itinerary.findFirst({
                where: { id: itineraryId, tenantId: req.travelTenant.id },
                select: {
                  id: true,
                  destination: true,
                  currency: true,
                  totalAmount: true,
                },
              })
          : null,
        ]);

      // Expenses keep sub-brand and itinerary references in their JSON notes;
      // narrow those records after the Prisma query and resolve trip labels.
      const rangeExpenseDates = rangeExpenses
        .filter((expense) => parseJson(expense.notes, {}).subBrand === subBrand)
        .map((expense) => expense.createdAt);
      const allRangeDates = [
        ...rangeInvoices.map((invoice) => invoice.createdAt),
        ...rangeExpenseDates,
      ]
        .filter(Boolean)
        .sort((a, b) => a - b);
      const matchingExpenses = expenses.filter((expense) => {
        const notes = parseJson(expense.notes, {});
        return (
          (!subBrand || notes.subBrand === subBrand) &&
          (!itineraryId || Number(notes.itineraryId) === itineraryId)
        );
      });
      const expenseItineraryIds = matchingExpenses
        .map((expense) => Number(parseJson(expense.notes, {}).itineraryId))
        .filter((id) => Number.isInteger(id) && id > 0);
      const itineraryIds = [
        ...new Set(
          [
            ...invoices.map((invoice) => invoice.itineraryId),
            ...expenseItineraryIds,
          ].filter(Boolean),
        ),
      ];
      const itineraryRows = itineraryIds.length
        ? await prisma.itinerary.findMany({
            where: { tenantId: req.travelTenant.id, id: { in: itineraryIds } },
            select: { id: true, destination: true },
          })
        : [];
      const itineraryMap = Object.fromEntries(
        itineraryRows.map((itinerary) => [itinerary.id, itinerary]),
      );
      const contactIds = [
        ...new Set(
          invoices.map((invoice) => invoice.contactId).filter(Boolean),
        ),
      ];
      const contacts = contactIds.length
        ? await prisma.contact.findMany({
            where: { tenantId: req.travelTenant.id, id: { in: contactIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
      const contactMap = Object.fromEntries(
        contacts.map((contact) => [contact.id, contact]),
      );

      // Calculate the Sales A/c, Purchase A/c, and persisted TCS totals.
      const calculated = {
        sales: invoices.reduce(
          (sum, invoice) => sum + Number(invoice.totalAmount || 0),
          0,
        ),
        purchase: matchingExpenses.reduce(
          (sum, expense) => sum + Number(expense.amount || 0),
          0,
        ),
        tcs: invoices.reduce(
          (sum, invoice) => sum + Number(invoice.tcsAmount || 0),
          0,
        ),
      };
      let automaticTcs = {
        taxableAmount: 0,
        tcsAmount: 0,
        rate: 0,
        finalInvoiceTotal: calculated.sales,
        international: false,
        requiresReview: false,
      };
      if (selectedTrip) {
        // For a selected trip, compare customer financial-year spend with the
        // TCS threshold and preview the applicable overseas-package amount.
        const contactIdsForTcs = [
          ...new Set(
            invoices.map((invoice) => invoice.contactId).filter(Boolean),
          ),
        ];
        const prior = contactIdsForTcs.length
          ? await prisma.travelInvoice.findMany({
              where: {
                tenantId: req.travelTenant.id,
                contactId: { in: contactIdsForTcs },
                createdAt: { gte: fiscalYearStart(new Date()) },
                NOT: { id: { in: invoices.map((invoice) => invoice.id) } },
              },
              select: { contactId: true, totalAmount: true },
            })
          : [];
        const priorByContact = prior.reduce(
          (map, invoice) => ({
            ...map,
            [invoice.contactId]:
              (map[invoice.contactId] || 0) + Number(invoice.totalAmount || 0),
          }),
          {},
        );
        const international = isInternationalDestination(
          selectedTrip.destination,
        );
        const preview = invoices.map((invoice) =>
          computeTcs({
            invoiceAmount: Number(invoice.totalAmount || 0),
            priorFySpend: priorByContact[invoice.contactId] || 0,
            isOverseasPackage: international,
          }),
        );
        automaticTcs = {
          taxableAmount: preview.reduce(
            (sum, result) => sum + result.exceedingAmount,
            0,
          ),
          tcsAmount: invoices.reduce(
            (sum, invoice, index) =>
              sum +
              (invoice.tcsAmount == null
                ? preview[index].tcsAmount
                : Number(invoice.tcsAmount)),
            0,
          ),
          rate: preview.find((result) => result.applies)?.rate || 0,
          finalInvoiceTotal:
            calculated.sales +
            preview.reduce(
              (sum, result, index) =>
                sum +
                (invoices[index].tcsAmount == null
                  ? result.tcsAmount
                  : Number(invoices[index].tcsAmount)),
              0,
            ),
          international,
          requiresReview:
            international &&
            invoices.some(
              (invoice) =>
                invoice.tcsAmount == null &&
                preview[invoices.indexOf(invoice)].applies,
            ),
        };
      }

      // Shape invoice rows for Customer A/c, including backend GST/TCS values
      // and the itinerary used by the frontend report tables.
      const customerDetails = invoices.map((invoice) => {
        const hasPersistedGst =
          invoice.totalTaxAmount != null ||
          invoice.cgstAmount != null ||
          invoice.sgstAmount != null ||
          invoice.igstAmount != null;
        const gstAmount =
          invoice.totalTaxAmount != null
            ? Number(invoice.totalTaxAmount)
            : Number(invoice.cgstAmount || 0) +
              Number(invoice.sgstAmount || 0) +
              Number(invoice.igstAmount || 0);
        const gstRate =
          invoice.igstPercent != null
            ? Number(invoice.igstPercent)
            : Number(invoice.cgstPercent || 0) +
              Number(invoice.sgstPercent || 0);
        return {
          reference: invoice.invoiceNum,
          name: contactMap[invoice.contactId]?.name || "Customer",
          email: contactMap[invoice.contactId]?.email || null,
          amount: Number(invoice.totalAmount || 0),
          gstAmount,
          gstRate,
          gstRetrieved: hasPersistedGst,
          tcsAmount: Number(invoice.tcsAmount || 0),
          tcsRate: invoice.tcsRate == null ? null : Number(invoice.tcsRate),
          itineraryId: invoice.itineraryId,
          tripName:
            itineraryMap[invoice.itineraryId]?.destination || "Unassigned",
          international: isInternationalDestination(
            itineraryMap[invoice.itineraryId]?.destination,
          ),
          currency: invoice.currency,
        };
      });

      // Shape filtered expenses for Supplier A/c using their stored metadata.
      const supplierDetails = matchingExpenses.map((expense) => {
        const notes = parseJson(expense.notes, {});
        const expenseTripId = Number(notes.itineraryId);
        return {
          reference: `EXP-${expense.id}`,
          name: expense.title,
          category: expense.category,
          amount: Number(expense.amount || 0),
          itineraryId:
            Number.isInteger(expenseTripId) && expenseTripId > 0
              ? expenseTripId
              : null,
          tripName: itineraryMap[expenseTripId]?.destination || "Unassigned",
        };
      });

      // Return the complete in-memory ledger payload consumed by Master,
      // Ledger, and Reports steps in the frontend wizard.
      res.json({
        filters: {
          from: req.query.from || null,
          to: req.query.to || null,
          subBrand,
          itineraryId,
        },
        trip: selectedTrip
          ? {
              ...selectedTrip,
              tcs: automaticTcs.tcsAmount || calculated.tcs,
              tcsPreview: automaticTcs,
            }
          : null,
        dateRange: {
          first: allRangeDates[0]?.toISOString().slice(0, 10) || null,
          last:
            allRangeDates[allRangeDates.length - 1]
              ?.toISOString()
              .slice(0, 10) || null,
        },
        accounts: [
          {
            id: "sales",
            name: "Sales A/c",
            type: "Sales",
            calculatedAmount: calculated.sales,
            amount: calculated.sales,
          },
          {
            id: "purchase",
            name: "Purchase A/c",
            type: "Purchase",
            calculatedAmount: calculated.purchase,
            amount: calculated.purchase,
          },
          {
            id: "inputGst",
            name: "GST %",
            type: "Tax",
            calculatedAmount: 0,
            amount: 0,
            manual: true,
          },
          {
            id: "tcsRate",
            name: "TCS %",
            type: "Tax / TCS",
            calculatedAmount: 0,
            amount: 0,
            manual: true,
          },
        ],
        customerDetails,
        supplierDetails,
      });
    } catch (error) {
      console.error("[travel-tally] ledger read failed:", error.message);
      res
        .status(500)
        .json({
          error: "Failed to calculate ledger totals",
          code: "TALLY_LEDGER_ERROR",
        });
    }
  },
);

module.exports = router;
