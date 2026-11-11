const express = require("express");
const { verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
const { basisPointsAmount, rupeesToPaise, serializeMoneyObject } = require("../lib/plotPayoutEngine");
const { lockBooking, successfulPaymentTotal, reconcilePlotBookingPaymentWithClient } = require("../lib/plotBookingPayments");
const { syncPlotBookingInvoice } = require("../lib/plotBookingInvoice");
const prisma = require("../lib/prisma");

const router = express.Router();
const financeOnly = verifyRole(["ADMIN", "MANAGER"]);

const VALID_MARKUP_TYPES = new Set(["PERCENT", "FIXED"]);
const VALID_BASES = new Set(["COLLECTED_AMOUNT", "MARKUP_AMOUNT", "ACTUAL_AMOUNT"]);

function jsonError(res, status, error, code, extra = {}) {
  return res.status(status).json({ error, code, ...extra });
}

function parseId(value, field = "id") {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error(`${field} must be a positive integer`), { status: 400, code: `INVALID_${field.toUpperCase()}` });
  return id;
}

function text(value, maxLength) {
  const normalized = String(value || "").trim();
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}

function completionTargetPaise(plot, plan) {
  const actualAmountPaise = priceToPaise(plot.price || 0, "plot price");
  if (!plan) return actualAmountPaise;
  const thresholdPaise = plan.markupType === "PERCENT"
    ? basisPointsAmount(actualAmountPaise, BigInt(plan.markupBp || 0))
    : BigInt(plan.markupPaise || 0);
  return thresholdPaise > 0n ? thresholdPaise : actualAmountPaise;
}

function asRupees(value) {
  return value === null || value === undefined ? "0" : String(value);
}

function priceToPaise(value, field = "price") {
  return rupeesToPaise(asRupees(value), field);
}

function parseStaffIds(value) {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const ids = raw.map((entry) => Number(entry)).filter((id) => Number.isInteger(id) && id > 0);
  return [...new Set(ids)];
}

function parseStoredStaffIds(value) {
  if (!value) return [];
  try { return parseStaffIds(JSON.parse(value)); } catch { return []; }
}

function normalizeMarkup(body, basePricePaise) {
  const markupType = String(body?.markupType || "PERCENT").toUpperCase();
  if (!VALID_MARKUP_TYPES.has(markupType)) throw Object.assign(new Error("markupType must be PERCENT or FIXED"), { status: 400, code: "INVALID_MARKUP_TYPE" });
  const rawValue = body?.markupValue ?? body?.markupPercent ?? body?.markupAmount ?? 0;
  const markupValue = Number(rawValue);
  if (!Number.isFinite(markupValue) || markupValue < 0) throw Object.assign(new Error("Markup must be a non-negative number"), { status: 400, code: "INVALID_MARKUP_VALUE" });
  if (markupType === "PERCENT" && markupValue > 100) throw Object.assign(new Error("Percentage markup cannot exceed 100%"), { status: 400, code: "MARKUP_PERCENT_TOO_HIGH" });
  const markupBp = markupType === "PERCENT" ? Math.round(markupValue * 100) : 0;
  const markupPaise = markupType === "FIXED" ? priceToPaise(markupValue, "markupValue") : 0n;
  const targetPricePaise = markupType === "PERCENT" ? basisPointsAmount(basePricePaise, markupBp) : markupPaise;
  return { markupType, markupBp, markupPaise, targetPricePaise, markupValue };
}

function normalizeRules(rawRules, staffById) {
  if (!Array.isArray(rawRules)) throw Object.assign(new Error("rules must be an array"), { status: 400, code: "INVALID_RULES" });
  const rules = rawRules.map((rawRule, index) => {
    const name = String(rawRule?.name || `Commission rule ${index + 1}`).trim();
    if (!name) throw Object.assign(new Error("Every commission rule needs a name"), { status: 400, code: "RULE_NAME_REQUIRED" });
    const commissionBasis = String(rawRule?.commissionBasis || "COLLECTED_AMOUNT").toUpperCase();
    if (!VALID_BASES.has(commissionBasis)) throw Object.assign(new Error("Commission basis is invalid"), { status: 400, code: "INVALID_COMMISSION_BASIS" });
    const rate = Number(rawRule?.ratePercent ?? rawRule?.rate ?? 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw Object.assign(new Error("Commission percentage must be between 0 and 100"), { status: 400, code: "INVALID_COMMISSION_RATE" });
    const applyToAllStaff = Boolean(rawRule?.applyToAllStaff);
    const staffUserIds = applyToAllStaff ? [] : parseStaffIds(rawRule?.staffUserIds ?? rawRule?.staffIds);
    if (!applyToAllStaff && !staffUserIds.length) throw Object.assign(new Error(`Select at least one staff member for ${name}, or choose All staff`), { status: 400, code: "RULE_STAFF_REQUIRED" });
    if (!applyToAllStaff && staffUserIds.some((id) => !staffById.has(id))) throw Object.assign(new Error(`One or more staff members for ${name} are not active staff in this organization`), { status: 400, code: "RULE_STAFF_INVALID" });
    return {
      name,
      commissionBasis,
      rateBp: Math.round(rate * 100),
      ratePercent: rate,
      applyToAllStaff,
      staffUserIds,
    };
  });
  const allStaffIds = [...staffById.keys()];
  const assignments = new Map();
  const conflicts = [];
  rules.forEach((rule, ruleIndex) => {
    const assignedIds = rule.applyToAllStaff ? allStaffIds : rule.staffUserIds;
    assignedIds.forEach((staffId) => {
      const previous = assignments.get(staffId);
      if (previous) conflicts.push({ staffId, staffName: staffById.get(staffId)?.name || `Staff #${staffId}`, previousRule: previous.name, currentRule: rule.name });
      else assignments.set(staffId, { name: rule.name, ruleIndex });
    });
  });
  if (conflicts.length) {
    const names = [...new Set(conflicts.map((conflict) => conflict.staffName))];
    throw Object.assign(new Error(`${names.join(", ")} is already assigned to another commission rule for this plot`), { status: 409, code: "STAFF_ALREADY_ASSIGNED", conflicts });
  }
  return rules;
}

const staffSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  jobTitle: true,
  userRoles: {
    take: 1,
    orderBy: { assignedAt: "desc" },
    select: {
      role: { select: { id: true, key: true, name: true } },
    },
  },
};

function normalizeStaffRows(rows) {
  return rows
    .map((member) => {
      const role = member.userRoles?.[0]?.role || null;
      const normalized = {
        ...member,
        primaryRole: role ? { id: role.id, key: role.key, name: role.name } : null,
      };
      delete normalized.userRoles;
      return normalized;
    })
    // Admins can manage commission rules but must never receive a staff
    // commission assignment. Check both role sources because older users may
    // have only the legacy User.role value while newer users use UserRole.
    .filter((member) =>
      String(member.role || "").toUpperCase() !== "ADMIN" &&
      String(member.primaryRole?.key || "").toUpperCase() !== "ADMIN",
    );
}

async function loadActiveStaff(tenantId) {
  const rows = await prisma.user.findMany({
    where: {
      tenantId,
      userType: { in: ["STAFF", "OWNER"] },
      role: { not: "CUSTOMER" },
      deactivatedAt: null,
    },
    orderBy: { name: "asc" },
    select: staffSelect,
  });
  return normalizeStaffRows(rows);
}

async function loadOptions(tenantId) {
  const [plots, staff] = await Promise.all([
    prisma.plotSite.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ name: "asc" }, { plotNumber: "asc" }, { id: "asc" }],
      take: 1000,
      select: { id: true, name: true, plotNumber: true, block: true, price: true, availability: true },
    }),
    loadActiveStaff(tenantId),
  ]);
  return {
    plots: plots.map((plot) => ({ ...plot, price: plot.price === null ? null : Number(plot.price) })),
    staff,
  };
}

function staffForRule(rule, staff) {
  if (rule.applyToAllStaff) return staff;
  const ids = new Set(parseStoredStaffIds(rule.staffUserIdsJson));
  return staff.filter((member) => ids.has(member.id));
}

function publicPlan(plan, staff) {
  if (!plan) return null;
  return serializeMoneyObject({
    ...plan,
    markupValue: plan.markupType === "PERCENT" ? Number(plan.markupBp || 0) / 100 : Number(plan.markupPaise || 0) / 100,
    rules: (plan.rules || []).filter((rule) => rule.isActive).map((rule) => ({
      ...rule,
      staffUserIds: parseStoredStaffIds(rule.staffUserIdsJson),
      staff: staffForRule(rule, staff),
      ratePercent: Number(rule.rateBp || 0) / 100,
    })),
  });
}

function commissionBase(record, basis) {
  if (basis === "MARKUP_AMOUNT") return record.markupPaise;
  if (basis === "ACTUAL_AMOUNT") return record.actualAmountPaise;
  return record.collectedAmountPaise;
}

function buildRecord(plot, plan, staff, bookings, receiptTotals) {
  const actualAmountPaise = priceToPaise(plot.price || 0, "plot price");
  const markupPaise = plan
    ? plan.markupType === "PERCENT"
      ? basisPointsAmount(actualAmountPaise, BigInt(plan.markupBp || 0))
      : BigInt(plan.markupPaise || 0)
    : 0n;
  const targetPricePaise = plan && markupPaise > 0n ? markupPaise : actualAmountPaise;
  const matchingBookings = bookings.filter((booking) => booking.plotSiteId === plot.id);
  const collectedAmountPaise = matchingBookings.reduce((sum, booking) => {
    const stored = priceToPaise(booking.amountPaid || 0, "amountPaid");
    const receiptTotal = receiptTotals.get(booking.id) || 0n;
    return sum + (stored > receiptTotal ? stored : receiptTotal);
  }, 0n);
  const booking = matchingBookings[0] || null;
  const statusCode = collectedAmountPaise <= 0n ? "NO_PAYMENT_COLLECTED" : collectedAmountPaise >= targetPricePaise ? "COMPLETED" : "PENDING";
  const rules = (plan?.rules || []).filter((rule) => rule.isActive).map((rule) => {
    const assignedStaff = staffForRule(rule, staff);
    const basisPaise = commissionBase({ actualAmountPaise, markupPaise, collectedAmountPaise }, rule.commissionBasis);
    const commissionPaise = basisPointsAmount(basisPaise, rule.rateBp);
    return {
      id: rule.id,
      name: rule.name,
      basis: rule.commissionBasis,
      ratePercent: Number(rule.rateBp || 0) / 100,
      applyToAllStaff: rule.applyToAllStaff,
      staff: assignedStaff,
      staffNames: assignedStaff.map((member) => member.name),
      commissionPaise,
    };
  });
  return {
    plot: { id: plot.id, name: plot.name, plotNumber: plot.plotNumber, block: plot.block, availability: plot.availability },
    booking: booking ? { id: booking.id, bookingNumber: booking.bookingNumber, invoiceId: booking.invoiceId, paymentStatus: booking.paymentStatus, contact: booking.contact } : null,
    plan: plan ? { id: plan.id, markupType: plan.markupType, markupValue: plan.markupType === "PERCENT" ? Number(plan.markupBp || 0) / 100 : Number(plan.markupPaise || 0) / 100 } : null,
    actualAmountPaise,
    markupPaise,
    collectionTargetPaise: targetPricePaise,
    collectedAmountPaise,
    outstandingPaise: targetPricePaise > collectedAmountPaise ? targetPricePaise - collectedAmountPaise : 0n,
    status: statusCode,
    statusLabel: statusCode === "COMPLETED" ? "Completed" : statusCode === "PENDING" ? "Pending" : "No payment collected",
    rules,
    totalCommissionPaise: rules.reduce((sum, rule) => sum + rule.commissionPaise * BigInt(rule.staff.length), 0n),
  };
}

async function loadRecords(tenantId, options = null) {
  const loaded = options || await loadOptions(tenantId);
  const [plans, bookings] = await Promise.all([
    prisma.plotCommissionPlan.findMany({ where: { tenantId, isActive: true }, include: { rules: { where: { isActive: true }, orderBy: { id: "asc" } } } }),
    prisma.plotBooking.findMany({
      where: { tenantId, status: { not: "CANCELLED" } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, bookingNumber: true, contactId: true, plotSiteId: true, invoiceId: true, amountPaid: true, totalAmount: true, paymentStatus: true, updatedAt: true },
    }),
  ]);
  const contactIds = [...new Set(bookings.map((booking) => booking.contactId))];
  const contacts = contactIds.length ? await prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } }, select: { id: true, name: true, phone: true, email: true } }) : [];
  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
  const bookingRows = bookings.map((booking) => ({ ...booking, contact: contactById.get(booking.contactId) || null }));
  const receiptRows = bookings.length ? await prisma.paymentReceipt.findMany({ where: { tenantId, plotBookingId: { in: bookings.map((booking) => booking.id) }, status: "VERIFIED" }, select: { plotBookingId: true, amountPaise: true } }) : [];
  const receiptTotals = new Map();
  for (const receipt of receiptRows) receiptTotals.set(receipt.plotBookingId, (receiptTotals.get(receipt.plotBookingId) || 0n) + BigInt(receipt.amountPaise));
  const planByPlot = new Map(plans.map((plan) => [plan.plotSiteId, plan]));
  const records = loaded.plots.map((plot) => buildRecord(plot, planByPlot.get(plot.id), loaded.staff, bookingRows.filter((booking) => booking.plotSiteId === plot.id), receiptTotals));
  return { ...loaded, plans: plans.map((plan) => publicPlan(plan, loaded.staff)), records: serializeMoneyObject(records) };
}

router.get("/workspace", financeOnly, async (req, res) => {
  try {
    return res.json(await loadRecords(req.user.tenantId));
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "COMMISSION_WORKSPACE_READ_FAILED");
  }
});

router.get("/records", financeOnly, async (req, res) => {
  try {
    const workspace = await loadRecords(req.user.tenantId);
    const records = req.query.plotSiteId ? workspace.records.filter((record) => String(record.plot.id) === String(req.query.plotSiteId)) : workspace.records;
    return res.json({ records });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "COMMISSION_RECORDS_READ_FAILED");
  }
});

router.post("/records/:plotSiteId/invoice", financeOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const plotSiteId = parseId(req.params.plotSiteId, "plotSiteId");
    const invoiceNote = text(req.body?.note || req.body?.invoiceNote, 5000);
    const proofScreenshotUrl = text(req.body?.screenshotUrl || req.body?.proofScreenshotUrl, 2048);
    const proofScreenshotFilename = text(req.body?.screenshotFilename || req.body?.proofScreenshotFilename, 255);
    const [plot, booking] = await Promise.all([
      prisma.plotSite.findFirst({ where: { id: plotSiteId, tenantId, isActive: true }, select: { id: true, name: true, plotNumber: true, price: true } }),
      prisma.plotBooking.findFirst({
        where: { tenantId, plotSiteId, status: { not: "CANCELLED" } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, bookingNumber: true, contactId: true, plotSiteId: true, invoiceId: true, totalAmount: true, amountPaid: true, balance: true, paymentStatus: true },
      }),
    ]);
    if (!plot) return jsonError(res, 404, "Active plot not found", "PLOT_NOT_FOUND");
    if (!booking) return jsonError(res, 409, "Create a customer booking before generating an invoice.", "BOOKING_REQUIRED");

    let invoice;
    let created = false;
    await prisma.$transaction(async (tx) => {
      await lockBooking(tx, tenantId, booking.id);
      const current = await tx.plotBooking.findFirst({ where: { id: booking.id, tenantId, status: { not: "CANCELLED" } } });
      if (!current) throw Object.assign(new Error("The booking is no longer available."), { status: 409, code: "BOOKING_NOT_FOUND" });
      if (current.invoiceId) {
        invoice = await tx.invoice.findFirst({ where: { id: current.invoiceId, tenantId }, select: { id: true, invoiceNum: true, status: true, amount: true, amountPaid: true, balance: true, notes: true, proofScreenshotUrl: true, proofScreenshotFilename: true } });
        if (invoice) {
          const invoiceUpdates = {};
          if (invoiceNote) invoiceUpdates.notes = invoiceNote;
          if (proofScreenshotUrl) invoiceUpdates.proofScreenshotUrl = proofScreenshotUrl;
          if (proofScreenshotFilename) invoiceUpdates.proofScreenshotFilename = proofScreenshotFilename;
          if (Object.keys(invoiceUpdates).length) invoice = await tx.invoice.update({ where: { id: invoice.id }, data: invoiceUpdates });
          return;
        }
      }
      const totalAmount = Number(current.totalAmount || plot.price || 0);
      const amountPaid = Math.max(0, Number(current.amountPaid || 0));
      const balance = Math.max(0, Number(current.balance ?? totalAmount - amountPaid));
      invoice = await syncPlotBookingInvoice(tx, {
        tenantId,
        booking: { ...current, totalAmount, amountPaid, balance },
        amountPaid,
        balance,
        paidAt: new Date(),
      });
      if (invoice && (invoiceNote || proofScreenshotUrl || proofScreenshotFilename)) {
        invoice = await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            ...(invoiceNote ? { notes: invoiceNote } : {}),
            ...(proofScreenshotUrl ? { proofScreenshotUrl } : {}),
            ...(proofScreenshotFilename ? { proofScreenshotFilename } : {}),
          },
        });
      }
      created = Boolean(invoice);
    });
    if (!invoice) return jsonError(res, 409, "The booking does not have enough details to create an invoice.", "INVOICE_CREATE_FAILED");
    await writeAudit("PlotBooking", created ? "INVOICE_CREATE" : "INVOICE_VIEW", booking.id, req.user.userId, tenantId, { plotSiteId, invoiceId: invoice.id, invoiceNum: invoice.invoiceNum });
    return res.json({ invoice: serializeMoneyObject({ id: invoice.id, invoiceNum: invoice.invoiceNum, status: invoice.status, amount: invoice.amount, amountPaid: invoice.amountPaid, balance: invoice.balance, notes: invoice.notes || null, proofScreenshotUrl: invoice.proofScreenshotUrl || null, proofScreenshotFilename: invoice.proofScreenshotFilename || null }) });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PLOT_INVOICE_ACTION_FAILED");
  }
});

router.post("/records/:plotSiteId/complete-payment", financeOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const plotSiteId = parseId(req.params.plotSiteId, "plotSiteId");
    const paymentMode = text(req.body?.paymentMode || "bank_transfer", 32).toLowerCase();
    const transactionRef = text(req.body?.transactionRef, 128);
    const allowedPaymentModes = new Set(["bank_transfer", "upi", "cash", "card", "cheque", "manual"]);
    if (!allowedPaymentModes.has(paymentMode)) return jsonError(res, 400, "Choose a valid payment method.", "INVALID_PAYMENT_METHOD");
    if (!transactionRef) return jsonError(res, 400, "Enter a payment reference before marking the payment completed.", "PAYMENT_REFERENCE_REQUIRED");

    const [plot, plan, booking] = await Promise.all([
      prisma.plotSite.findFirst({ where: { id: plotSiteId, tenantId, isActive: true }, select: { id: true, name: true, plotNumber: true, price: true } }),
      prisma.plotCommissionPlan.findFirst({ where: { tenantId, plotSiteId, isActive: true }, select: { markupType: true, markupBp: true, markupPaise: true } }),
      prisma.plotBooking.findFirst({
        where: { tenantId, plotSiteId, status: { not: "CANCELLED" } },
        orderBy: { updatedAt: "desc" },
        select: { id: true, bookingNumber: true, contactId: true, plotSiteId: true, invoiceId: true, totalAmount: true, amountPaid: true, balance: true, paymentStatus: true },
      }),
    ]);
    if (!plot) return jsonError(res, 404, "Active plot not found", "PLOT_NOT_FOUND");
    if (!booking) return jsonError(res, 409, "Create a customer booking before recording payment.", "BOOKING_REQUIRED");
    const targetPaise = completionTargetPaise(plot, plan);
    if (targetPaise <= 0n) return jsonError(res, 409, "The plot must have a valid collection threshold.", "COLLECTION_THRESHOLD_REQUIRED");

    let payment;
    let invoice;
    let completionAmount;
    await prisma.$transaction(async (tx) => {
      await lockBooking(tx, tenantId, booking.id);
      const current = await tx.plotBooking.findFirst({ where: { id: booking.id, tenantId, status: { not: "CANCELLED" } } });
      if (!current) throw Object.assign(new Error("The booking is no longer available."), { status: 409, code: "BOOKING_NOT_FOUND" });
      const ledgerPaid = await successfulPaymentTotal(tx, tenantId, current.id);
      const collected = Math.max(Number(current.amountPaid || 0), ledgerPaid);
      const target = Number(targetPaise) / 100;
      const remainingToComplete = Math.max(0, target - collected);
      if (remainingToComplete <= 0.009) {
        const error = new Error("This plot has already reached its collection threshold.");
        error.status = 409;
        error.code = "PAYMENT_ALREADY_COMPLETED";
        throw error;
      }
      const requestedAmount = req.body?.amount === undefined || req.body?.amount === "" ? remainingToComplete : Number(req.body.amount);
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || Math.abs(requestedAmount - remainingToComplete) > 0.01) {
        const error = new Error(`Payment amount must equal the remaining collection threshold of ${remainingToComplete.toFixed(2)}.`);
        error.status = 400;
        error.code = "INVALID_COMPLETION_AMOUNT";
        throw error;
      }
      const bookingRemaining = Math.max(0, Number(current.totalAmount || 0) - ledgerPaid);
      if (requestedAmount > bookingRemaining + 0.01) {
        const error = new Error("The collection threshold is greater than the booking balance available to record.");
        error.status = 409;
        error.code = "COLLECTION_THRESHOLD_EXCEEDS_BALANCE";
        throw error;
      }
      const duplicate = await tx.payment.findFirst({ where: { tenantId, plotPaymentReference: transactionRef }, select: { id: true } });
      if (duplicate) throw Object.assign(new Error("That payment reference has already been recorded."), { status: 409, code: "DUPLICATE_PAYMENT_REFERENCE" });
      const paidAt = new Date();
      const metadata = { kind: "plot-booking-payment", plotBookingId: current.id, mode: "commission-record", thresholdCompletion: true };
      payment = await tx.payment.create({
        data: {
          contactId: current.contactId,
          description: `Collection threshold payment for plot booking ${current.bookingNumber}`,
          amount: requestedAmount,
          currency: "INR",
          gateway: paymentMode,
          gatewayId: transactionRef,
          plotPaymentReference: transactionRef,
          status: "SUCCESS",
          paidAt,
          tenantId,
          metadata: JSON.stringify(metadata),
        },
      });
      await reconcilePlotBookingPaymentWithClient(tx, payment, metadata, current.id);
      completionAmount = requestedAmount;
      const bookingAfter = await tx.plotBooking.findFirst({ where: { id: current.id, tenantId }, select: { invoiceId: true } });
      if (bookingAfter?.invoiceId) invoice = await tx.invoice.findFirst({ where: { id: bookingAfter.invoiceId, tenantId }, select: { id: true, invoiceNum: true, status: true, amount: true, amountPaid: true, balance: true } });
      await tx.plotWorkflowEvent.create({
        data: {
          tenantId,
          plotBookingId: current.id,
          contactId: current.contactId,
          plotSiteId,
          stage: "PAYMENT",
          eventType: "COMMISSION_PAYMENT_COMPLETED",
          label: "Collection threshold payment completed",
          toStatus: "COMPLETED",
          actorUserId: req.user.userId,
          metadataJson: JSON.stringify({ paymentId: payment.id, transactionRef, amount: requestedAmount, invoiceId: invoice?.id || null }),
        },
      });
    });
    if (!payment) return jsonError(res, 409, "The payment could not be recorded.", "PAYMENT_NOT_RECORDED");
    await writeAudit("PlotBooking", "PAYMENT_COMPLETED", booking.id, req.user.userId, tenantId, { plotSiteId, paymentId: payment.id, invoiceId: invoice?.id || null, amount: completionAmount, transactionRef });
    return res.json({ status: "COMPLETED", payment: { id: payment.id, amount: payment.amount, status: payment.status, reference: payment.gatewayId }, invoice: invoice ? serializeMoneyObject(invoice) : null });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PLOT_PAYMENT_COMPLETION_FAILED");
  }
});

router.put("/plots/:plotSiteId/rules", financeOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const plotSiteId = parseId(req.params.plotSiteId, "plotSiteId");
    const [plot, staff] = await Promise.all([
      prisma.plotSite.findFirst({ where: { id: plotSiteId, tenantId, isActive: true }, select: { id: true, price: true, name: true, plotNumber: true } }),
      loadActiveStaff(tenantId),
    ]);
    if (!plot) return jsonError(res, 404, "Active plot not found", "PLOT_NOT_FOUND");
    const basePricePaise = priceToPaise(plot.price || 0, "plot price");
    if (basePricePaise <= 0n) return jsonError(res, 409, "The selected plot does not have a valid price", "PLOT_PRICE_REQUIRED");
    const markup = normalizeMarkup(req.body || {}, basePricePaise);
    const staffById = new Map(staff.map((member) => [member.id, member]));
    const rules = normalizeRules(req.body?.rules || [], staffById);
    const plan = await prisma.$transaction(async (tx) => {
      const saved = await tx.plotCommissionPlan.upsert({
        where: { tenantId_plotSiteId: { tenantId, plotSiteId } },
        create: { tenantId, plotSiteId, basePricePaise, markupType: markup.markupType, markupBp: markup.markupBp, markupPaise: markup.markupPaise, targetPricePaise: markup.targetPricePaise, createdByUserId: req.user.userId },
        update: { basePricePaise, markupType: markup.markupType, markupBp: markup.markupBp, markupPaise: markup.markupPaise, targetPricePaise: markup.targetPricePaise, isActive: true, createdByUserId: req.user.userId },
      });
      await tx.plotCommissionRule.updateMany({ where: { tenantId, planId: saved.id, isActive: true }, data: { isActive: false } });
      for (const rule of rules) {
        await tx.plotCommissionRule.create({ data: { tenantId, planId: saved.id, name: rule.name, commissionBasis: rule.commissionBasis, rateBp: rule.rateBp, applyToAllStaff: rule.applyToAllStaff, staffUserIdsJson: rule.applyToAllStaff ? null : JSON.stringify(rule.staffUserIds), isActive: true, createdByUserId: req.user.userId } });
      }
      return tx.plotCommissionPlan.findFirst({ where: { id: saved.id, tenantId }, include: { rules: { where: { isActive: true }, orderBy: { id: "asc" } } } });
    });
    await writeAudit("PlotCommissionPlan", "UPSERT", plan.id, req.user.userId, tenantId, { plotSiteId, ruleCount: rules.length, targetPricePaise: String(markup.targetPricePaise) });
    return res.json({ plan: publicPlan(plan, staff) });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "COMMISSION_RULES_SAVE_FAILED", error.conflicts ? { conflicts: error.conflicts } : {});
  }
});

module.exports = router;
