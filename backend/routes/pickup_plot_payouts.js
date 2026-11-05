const express = require("express");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const { encrypt } = require("../lib/fieldEncryption");
const prisma = require("../lib/prisma");
const { verifyRole } = require("../middleware/auth");
const { getSetting, setSetting } = require("../lib/tenantSettings");
const { writeAudit } = require("../lib/audit");
const {
  toPaise,
  rupeesToPaise,
  computeEntitlements,
  computeCustomEntitlements,
  allocatePayment,
  serializeMoneyObject,
} = require("../lib/plotPayoutEngine");
const {
  reconcilePlotBookingPaymentWithClient,
  lockBooking,
} = require("../lib/plotBookingPayments");
const { sendSms, resolveProviderConfig } = require("../services/smsProvider");
const { applyRupeeCapableFonts } = require("../services/pdfRenderer");

const router = express.Router();
const FEATURE_KEY = "deposit_split_enabled";
const adminOnly = verifyRole(["ADMIN"]);
const financeOnly = verifyRole(["ADMIN", "MANAGER"]);
const staffOnly = verifyRole(["ADMIN", "MANAGER", "USER"]);

const DEFAULT_SETTINGS = {
  scopeKey: "TENANT",
  pricingModel: "MARKUP",
  splitMethod: "PRO_RATA",
  companyMarkupBp: 0,
  cpCapBp: 0,
  floorMarginPaise: 0n,
  companyCommissionBp: 100,
  holdTrigger: "AGREEMENT_SIGNED",
  holdValue: "AGREEMENT_SIGNED",
  ownerRelease: "ON_VERIFY",
  dualApprovalThresholdPaise: 5000000n,
  allowCustomSplit: false,
  maxTotalCommissionBp: 1000,
  reraEnabled: false,
  reraEscrowLabel: null,
};

function jsonError(res, status, error, code, extra = {}) {
  return res.status(status).json({ error, code, ...extra });
}

function parseId(value, field = "id") {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid ${field}`);
  return id;
}

function readPaise(body, paiseKey, rupeeKey, required = true) {
  if (body?.[paiseKey] !== undefined && body?.[paiseKey] !== null && body?.[paiseKey] !== "") return toPaise(body[paiseKey], paiseKey);
  if (body?.[rupeeKey] !== undefined && body?.[rupeeKey] !== null && body?.[rupeeKey] !== "") return rupeesToPaise(body[rupeeKey], rupeeKey);
  if (required) throw new Error(`${paiseKey} or ${rupeeKey} is required`);
  return null;
}

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function isAdminUser(req) {
  return String(req.user?.role || "").toUpperCase() === "ADMIN";
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

function createOtp() {
  if (process.env.NODE_ENV !== "production" && process.env.PAYOUT_DEMO_OTP) return String(process.env.PAYOUT_DEMO_OTP);
  return String(crypto.randomInt(100000, 1000000));
}

function keyForLine(row) {
  return `${row.partyType}:${row.payoutPartnerId ?? "company"}:${row.kind}`;
}

function isFeatureValueEnabled(value) {
  return String(value || "").toLowerCase() === "true";
}

async function featureEnabled(req, res, next) {
  try {
    const enabled = await getSetting(req.user.tenantId, FEATURE_KEY, { coerce: isFeatureValueEnabled, fallback: false });
    if (!enabled) return jsonError(res, 404, "Not found", "DEPOSIT_SPLIT_DISABLED");
    return next();
  } catch (error) {
    console.error("deposit split feature check failed:", error);
    return jsonError(res, 503, "Deposit distribution is temporarily unavailable", "DEPOSIT_SPLIT_UNAVAILABLE");
  }
}

async function loadSettings(tenantId, plotSiteId = null) {
  const scopeKey = plotSiteId ? `PLOT:${plotSiteId}` : "TENANT";
  const row = await prisma.payoutSettings.findFirst({ where: { tenantId, scopeKey } });
  if (row) return row;
  if (scopeKey !== "TENANT") {
    const tenantRow = await prisma.payoutSettings.findFirst({ where: { tenantId, scopeKey: "TENANT" } });
    if (tenantRow) return tenantRow;
  }
  return { ...DEFAULT_SETTINGS, tenantId, id: null };
}

function publicSettings(settings) {
  return serializeMoneyObject({
    ...settings,
    floorMarginPaise: settings.floorMarginPaise ?? 0n,
    dualApprovalThresholdPaise: settings.dualApprovalThresholdPaise ?? 0n,
  });
}

async function findBooking(tenantId, bookingId) {
  return prisma.plotBooking.findFirst({ where: { id: bookingId, tenantId } });
}

async function normalizeCustomSplit(tenantId, body, owners, finalPricePaise) {
  const splitMode = String(body?.splitMode || "").toUpperCase();
  if (!["CUSTOM_PERSON", "CUSTOM_INSTALLMENT"].includes(splitMode)) return null;
  const source = body?.customSplit || {};
  const rawLines = Array.isArray(source.lines) ? source.lines : Array.isArray(body?.customLines) ? body.customLines : [];
  if (!rawLines.length) throw Object.assign(new Error("Add at least one custom split line"), { status: 400, code: "CUSTOM_SPLIT_REQUIRED" });
  const defaultKindByPartyType = { OWNER: "OWNER_SHARE", CHANNEL_PARTNER: "CP_COMMISSION", BROKER: "BROKER_COMMISSION", COMPANY: "COMPANY_SHARE" };
  const allowedKindsByPartyType = {
    OWNER: new Set(["OWNER_SHARE"]),
    CHANNEL_PARTNER: new Set(["CP_MARKUP", "CP_COMMISSION"]),
    BROKER: new Set(["BROKER_COMMISSION"]),
    COMPANY: new Set(["COMPANY_SHARE"]),
  };
  const lines = rawLines.map((line) => {
    const partyType = String(line.partyType || "").toUpperCase();
    const kind = line.kind ? String(line.kind).toUpperCase() : defaultKindByPartyType[partyType];
    const normalized = {
      partyType,
      partnerId: line.partnerId == null || line.partnerId === "" ? null : parseId(line.partnerId, "partnerId"),
      kind,
      amountPaise: readPaise(line, "amountPaise", "amount"),
    };
    if (splitMode === "CUSTOM_INSTALLMENT") {
      const installmentNumber = Number(line.installmentNumber);
      if (!Number.isInteger(installmentNumber) || installmentNumber <= 0) throw new Error("Each custom installment line needs a positive installmentNumber");
      normalized.installmentNumber = installmentNumber;
    }
    return normalized;
  });
  const partnerIds = [...new Set(lines.filter((line) => line.partnerId).map((line) => line.partnerId))];
  const partners = partnerIds.length
    ? await prisma.payoutPartner.findMany({ where: { tenantId, id: { in: partnerIds }, status: "ACTIVE" }, select: { id: true, partnerType: true } })
    : [];
  if (partners.length !== partnerIds.length) throw Object.assign(new Error("Every custom split recipient must be an active payout partner"), { status: 409, code: "CUSTOM_PARTNER_INVALID" });
  const partnerById = new Map(partners.map((partner) => [partner.id, partner]));
  for (const line of lines) {
    if (!["OWNER", "CHANNEL_PARTNER", "BROKER", "COMPANY"].includes(line.partyType)) throw new Error("Custom split recipient type is invalid");
    if (line.partyType === "COMPANY" && line.partnerId) throw new Error("Company split lines cannot have a partnerId");
    if (line.partyType !== "COMPANY" && !line.partnerId) throw new Error("Every non-company split line needs a partnerId");
    if (line.partyType !== "COMPANY" && partnerById.get(line.partnerId)?.partnerType !== line.partyType) throw new Error("Custom split recipient type does not match the partner type");
    if (!allowedKindsByPartyType[line.partyType]?.has(line.kind)) throw new Error("Custom split share type does not match the recipient type");
  }
  const normalizedTotal = lines.reduce((sum, line) => sum + toPaise(line.amountPaise), 0n);
  if (normalizedTotal !== finalPricePaise) throw Object.assign(new Error("Custom split amounts must exactly equal the final price"), { status: 400, code: "CUSTOM_SPLIT_TOTAL_MISMATCH" });
  const ownerTotals = new Map();
  for (const line of lines) if (line.partyType === "OWNER") ownerTotals.set(line.partnerId, (ownerTotals.get(line.partnerId) || 0n) + line.amountPaise);
  const ownerPriceReduction = owners.some((owner) => (ownerTotals.get(owner.payoutPartnerId) || 0n) < toPaise(owner.askedPricePaise));
  return { mode: splitMode, lines, ownerPriceReduction };
}

function calculationForSnapshot(snapshot, receipt = null) {
  const rules = parseJson(snapshot.rulesJson, {});
  if (snapshot.splitMode === "CUSTOM_PERSON" || snapshot.splitMode === "CUSTOM_INSTALLMENT") {
    const custom = parseJson(snapshot.customSplitJson, { lines: [] });
    const lines = snapshot.splitMode === "CUSTOM_INSTALLMENT" && receipt?.installmentNumber
      ? custom.lines.filter((line) => Number(line.installmentNumber) === Number(receipt.installmentNumber))
      : custom.lines;
    return computeCustomEntitlements({
      basePricePaise: snapshot.basePricePaise,
      listPricePaise: snapshot.listPricePaise,
      finalPricePaise: snapshot.splitMode === "CUSTOM_INSTALLMENT" && receipt?.installmentNumber
        ? lines.reduce((sum, line) => sum + toPaise(line.amountPaise), 0n)
        : snapshot.finalPricePaise,
      lines,
    });
  }
  return computeEntitlements({
    basePricePaise: snapshot.basePricePaise,
    listPricePaise: snapshot.listPricePaise,
    finalPricePaise: snapshot.finalPricePaise,
    owners: rules.owners || [],
    channelPartnerId: rules.channelPartnerId,
    brokerPartnerId: rules.brokerPartnerId,
    cpMarkupBp: rules.cpMarkupBp,
    brokerRule: rules.brokerRule,
    cpCommissionRule: rules.cpCommissionRule,
    settings: rules.settings || {},
  });
}

async function buildPreview(tenantId, body) {
  const plotBookingId = parseId(body?.plotBookingId, "plotBookingId");
  const booking = await findBooking(tenantId, plotBookingId);
  if (!booking) throw Object.assign(new Error("Plot booking not found"), { status: 404, code: "PLOT_BOOKING_NOT_FOUND" });
  const plotSite = await prisma.plotSite.findFirst({ where: { id: booking.plotSiteId, tenantId } });
  if (!plotSite) throw Object.assign(new Error("Plot site not found"), { status: 404, code: "PLOT_SITE_NOT_FOUND" });
  const owners = await prisma.plotOwnership.findMany({ where: { tenantId, plotSiteId: plotSite.id }, orderBy: { id: "asc" } });
  if (!owners.length) throw Object.assign(new Error("Configure plot ownership before creating a payout preview"), { status: 409, code: "OWNERSHIP_REQUIRED" });
  const ownerPartnerIds = owners.map((row) => row.payoutPartnerId);
  const partners = await prisma.payoutPartner.findMany({ where: { tenantId, id: { in: ownerPartnerIds } }, select: { id: true, partnerType: true, status: true } });
  if (partners.length !== ownerPartnerIds.length || partners.some((partner) => partner.status !== "ACTIVE")) {
    throw Object.assign(new Error("Every configured owner must be an active payout partner"), { status: 409, code: "OWNER_PARTNER_INVALID" });
  }
  const settings = await loadSettings(tenantId, plotSite.id);
  const listPricePaise = readPaise({ listPricePaise: body?.listPricePaise, listPrice: body?.listPrice ?? String(plotSite.price ?? 0) }, "listPricePaise", "listPrice");
  const basePricePaise = body?.basePricePaise || body?.basePrice
    ? readPaise(body, "basePricePaise", "basePrice")
    : owners.reduce((sum, owner) => sum + toPaise(owner.askedPricePaise), 0n);
  const finalPricePaise = body?.finalPricePaise || body?.finalPrice
    ? readPaise(body, "finalPricePaise", "finalPrice")
    : listPricePaise;
  const channelPartnerId = body?.channelPartnerId ? parseId(body.channelPartnerId, "channelPartnerId") : null;
  const brokerPartnerId = body?.brokerPartnerId
    ? parseId(body.brokerPartnerId, "brokerPartnerId")
    : booking.plotBrokerId
      ? (await prisma.payoutPartner.findFirst({ where: { tenantId, plotBrokerId: booking.plotBrokerId, partnerType: "BROKER" } }))?.id || null
      : null;
  const requestedPartnerIds = [channelPartnerId, brokerPartnerId].filter(Boolean);
  if (requestedPartnerIds.length) {
    const activePartners = await prisma.payoutPartner.findMany({ where: { tenantId, id: { in: requestedPartnerIds }, status: "ACTIVE" }, select: { id: true } });
    if (activePartners.length !== new Set(requestedPartnerIds).size) throw Object.assign(new Error("The selected channel partner or broker is not active"), { status: 409, code: "PAYOUT_PARTNER_INVALID" });
  }
  const brokerRule = brokerPartnerId
    ? await prisma.payoutCommissionRule.findFirst({ where: { tenantId, payoutPartnerId: brokerPartnerId, OR: [{ plotSiteId: plotSite.id }, { plotSiteId: null }] }, orderBy: [{ plotSiteId: "desc" }, { createdAt: "desc" }] })
    : null;
  const cpMarkupBp = Number(body?.cpMarkupBp ?? 0);
  const cpCommissionRule = channelPartnerId
    ? await prisma.payoutCommissionRule.findFirst({ where: { tenantId, payoutPartnerId: channelPartnerId, OR: [{ plotSiteId: plotSite.id }, { plotSiteId: null }] }, orderBy: [{ plotSiteId: "desc" }, { createdAt: "desc" }] })
    : null;
  const automaticCalculation = computeEntitlements({
    basePricePaise,
    listPricePaise,
    finalPricePaise,
    owners: owners.map((owner) => ({ partnerId: owner.payoutPartnerId, ownershipBp: owner.ownershipBp, askedPricePaise: owner.askedPricePaise })),
    channelPartnerId,
    brokerPartnerId,
    cpMarkupBp,
    brokerRule,
    cpCommissionRule,
    defaultBrokerRateBp: 100,
    settings,
  });
  const customSplit = await normalizeCustomSplit(tenantId, body, owners, finalPricePaise);
  const calculation = customSplit
    ? computeCustomEntitlements({ basePricePaise, listPricePaise, finalPricePaise, lines: customSplit.lines })
    : automaticCalculation;
  return {
    booking,
    plotSite,
    owners,
    settings,
    channelPartnerId,
    brokerPartnerId,
    brokerRule,
    cpCommissionRule,
    cpMarkupBp,
    splitMode: customSplit?.mode || "AUTOMATIC",
    customSplit,
    calculation,
  };
}

function calculationRules(preview) {
  return JSON.stringify({
    owners: preview.owners.map((owner) => ({ partnerId: owner.payoutPartnerId, ownershipBp: owner.ownershipBp, askedPricePaise: String(owner.askedPricePaise) })),
    channelPartnerId: preview.channelPartnerId,
    brokerPartnerId: preview.brokerPartnerId,
    cpMarkupBp: preview.cpMarkupBp,
    splitMode: preview.splitMode,
    customSplit: preview.customSplit,
    brokerRule: preview.brokerRule,
    cpCommissionRule: preview.cpCommissionRule,
    settings: publicSettings(preview.settings),
  }, bigintReplacer);
}

function readIdempotencyKey(req) {
  const key = String(req.get("Idempotency-Key") || "").trim();
  if (!key || key.length > 128) throw Object.assign(new Error("Idempotency-Key header is required"), { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  return key;
}

async function returnExistingIdempotency(tenantId, scope, key, res) {
  const row = await prisma.idempotencyRecord.findFirst({ where: { tenantId, scope, key } });
  if (!row) return false;
  return res.status(row.statusCode).json(parseJson(row.responseJson, { error: "Stored response unavailable", code: "IDEMPOTENCY_REPLAY" }));
}

async function ensurePayoutSettings(tenantId, scopeKey, data) {
  return prisma.payoutSettings.upsert({
    where: { tenantId_scopeKey: { tenantId, scopeKey } },
    create: { ...DEFAULT_SETTINGS, ...data, tenantId, scopeKey },
    update: data,
  });
}

// The feature endpoint is intentionally outside featureEnabled so an admin can
// turn the additive workflow on for a tenant while all legacy endpoints stay
// available and unchanged.
router.get("/feature", staffOnly, async (req, res) => {
  const enabled = await getSetting(req.user.tenantId, FEATURE_KEY, { coerce: isFeatureValueEnabled, fallback: false });
  return res.json({ enabled, key: FEATURE_KEY });
});

router.put("/feature", adminOnly, async (req, res) => {
  const enabled = req.body?.enabled === true || String(req.body?.enabled).toLowerCase() === "true";
  await setSetting(req.user.tenantId, FEATURE_KEY, String(enabled), { category: "feature-flag" });
  await writeAudit("TenantSetting", "DEPOSIT_SPLIT_FEATURE_UPDATED", null, req.user.userId, req.user.tenantId, { key: FEATURE_KEY, enabled });
  return res.json({ enabled, key: FEATURE_KEY });
});

// Partner confirmation is intentionally token-scoped rather than staff-JWT
// scoped. The token is random, single-purpose, and stored only as a hash.
router.get("/public/details", async (req, res) => {
  try {
    const token = String(req.query?.token || "").trim();
    if (!token) return jsonError(res, 400, "A confirmation token is required", "PAYOUT_CONFIRMATION_INPUT_INVALID");
    const confirmation = await prisma.payoutConfirmation.findFirst({ where: { publicTokenHash: hashOtp(token) } });
    if (!confirmation) return jsonError(res, 404, "Payout confirmation link is invalid", "PAYOUT_CONFIRMATION_NOT_FOUND");
    const [payout, partner] = await Promise.all([
      prisma.payout.findFirst({ where: { id: confirmation.payoutId, tenantId: confirmation.tenantId }, select: { id: true, totalNetPaise: true, utr: true, paidOn: true, status: true, acknowledgedAt: true } }),
      prisma.payoutPartner.findFirst({ where: { id: confirmation.payoutPartnerId, tenantId: confirmation.tenantId }, select: { name: true } }),
    ]);
    return res.json({ payout: serializeMoneyObject({ ...payout, partnerName: partner?.name || "Partner", mobile: `••••${confirmation.mobile.slice(-4)}`, confirmationStatus: confirmation.status, expiresAt: confirmation.expiresAt }) });
  } catch (error) {
    return jsonError(res, 400, error.message, error.code || "PAYOUT_CONFIRMATION_READ_FAILED");
  }
});

router.post("/public/confirm", async (req, res) => {
  try {
    const token = String(req.body?.token || req.query?.token || "").trim();
    const otp = String(req.body?.otp || "").trim();
    if (!token || !/^\d{6}$/.test(otp)) return jsonError(res, 400, "A confirmation token and six-digit OTP are required", "PAYOUT_CONFIRMATION_INPUT_INVALID");
    const confirmation = await prisma.payoutConfirmation.findFirst({ where: { publicTokenHash: hashOtp(token) } });
    if (!confirmation) return jsonError(res, 404, "Payout confirmation link is invalid", "PAYOUT_CONFIRMATION_NOT_FOUND");
    if (confirmation.status === "VERIFIED") return res.json({ confirmed: true, verifiedAt: confirmation.verifiedAt });
    if (confirmation.expiresAt < new Date()) return jsonError(res, 400, "The payout confirmation OTP has expired", "PAYOUT_OTP_EXPIRED");
    if (confirmation.attempts >= 5) return jsonError(res, 429, "Too many invalid OTP attempts", "PAYOUT_OTP_LOCKED");
    if (hashOtp(otp) !== confirmation.otpHash) {
      await prisma.payoutConfirmation.update({ where: { id: confirmation.id }, data: { attempts: { increment: 1 } } });
      return jsonError(res, 400, "Incorrect payout confirmation OTP", "PAYOUT_OTP_INVALID");
    }
    const verifiedAt = new Date();
    await prisma.$transaction([
      prisma.payoutConfirmation.update({ where: { id: confirmation.id }, data: { status: "VERIFIED", verifiedAt } }),
      prisma.payout.updateMany({ where: { id: confirmation.payoutId, tenantId: confirmation.tenantId }, data: { acknowledgedAt: verifiedAt } }),
    ]);
    return res.json({ confirmed: true, verifiedAt });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PAYOUT_CONFIRMATION_FAILED");
  }
});

router.get("/public/advice.pdf", async (req, res) => {
  try {
    const token = String(req.query?.token || "").trim();
    const confirmation = token ? await prisma.payoutConfirmation.findFirst({ where: { publicTokenHash: hashOtp(token) } }) : null;
    if (!confirmation) return jsonError(res, 404, "Payout confirmation link is invalid", "PAYOUT_CONFIRMATION_NOT_FOUND");
    const payout = await prisma.payout.findFirst({ where: { id: confirmation.payoutId, tenantId: confirmation.tenantId } });
    if (!payout) return jsonError(res, 404, "Payout not found", "PAYOUT_NOT_FOUND");
    const partner = await prisma.payoutPartner.findFirst({ where: { id: payout.payoutPartnerId, tenantId: confirmation.tenantId }, select: { name: true } });
    const lines = await prisma.payoutLine.findMany({ where: { tenantId: confirmation.tenantId, payoutId: payout.id }, select: { distributionLineId: true } });
    const distributionLines = lines.length ? await prisma.distributionLine.findMany({ where: { tenantId: confirmation.tenantId, id: { in: lines.map((line) => line.distributionLineId) } }, select: { plotBookingId: true, kind: true } }) : [];
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    applyRupeeCapableFonts(doc);
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    const pdfDone = new Promise((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
    doc.fontSize(20).text("Partner payout advice", { align: "center" });
    doc.moveDown();
    doc.fontSize(11).text(`Payout ID: ${payout.id}`);
    doc.text(`Partner: ${partner?.name || "Partner"}`);
    doc.text(`UTR: ${payout.utr}`);
    doc.text(`Paid on: ${new Date(payout.paidOn).toLocaleString("en-IN")}`);
    doc.moveDown();
    doc.fontSize(14).text(`Gross approved amount: ₹${(Number(payout.grossNetPaise || payout.totalNetPaise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
    if (toPaise(payout.clawbackPaise || 0) > 0n) doc.fontSize(11).text(`Clawback recovered from this payout: ₹${(Number(payout.clawbackPaise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
    doc.fontSize(14).text(`Net amount paid: ₹${(Number(payout.totalNetPaise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
    doc.moveDown();
    doc.fontSize(10).text("This document records the company payout and its bank reference. Please retain it for your records.");
    for (const line of distributionLines) doc.fontSize(10).text(`Booking #${line.plotBookingId} — ${line.kind}`);
    doc.end();
    const buffer = await pdfDone;
    return res.status(200).set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="payout-advice-${payout.id}.pdf"`, "Content-Length": buffer.length }).end(buffer);
  } catch (error) {
    return jsonError(res, 400, error.message, "PAYOUT_ADVICE_FAILED");
  }
});

router.use(featureEnabled);

router.get("/settings", staffOnly, async (req, res) => {
  try {
    const settings = await loadSettings(req.user.tenantId, req.query.plotSiteId ? parseId(req.query.plotSiteId, "plotSiteId") : null);
    return res.json({ settings: publicSettings(settings) });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "SETTINGS_READ_FAILED");
  }
});

router.put("/settings", adminOnly, async (req, res) => {
  try {
    const plotSiteId = req.body?.plotSiteId ? parseId(req.body.plotSiteId, "plotSiteId") : null;
    const scopeKey = plotSiteId ? `PLOT:${plotSiteId}` : "TENANT";
    const allowed = ["pricingModel", "splitMethod", "companyMarkupBp", "cpCapBp", "floorMarginPaise", "dualApprovalThresholdPaise", "holdTrigger", "holdValue", "ownerRelease", "allowCustomSplit", "maxTotalCommissionBp", "reraEnabled", "reraEscrowLabel"];
    const data = {};
    for (const field of allowed) if (req.body?.[field] !== undefined) data[field] = req.body[field];
    for (const field of ["companyMarkupBp", "cpCapBp", "maxTotalCommissionBp"]) if (data[field] !== undefined) data[field] = Number(data[field]);
    for (const field of ["floorMarginPaise", "dualApprovalThresholdPaise"]) if (data[field] !== undefined) data[field] = readPaise({ [field]: data[field] }, field, field);
    if (data.allowCustomSplit !== undefined) data.allowCustomSplit = Boolean(data.allowCustomSplit);
    if (data.reraEnabled !== undefined) data.reraEnabled = Boolean(data.reraEnabled);
    const settings = await ensurePayoutSettings(req.user.tenantId, scopeKey, data);
    await writeAudit("PayoutSettings", "UPDATE", settings.id, req.user.userId, req.user.tenantId, { scopeKey, changedFields: Object.keys(data) });
    return res.json({ settings: publicSettings(settings) });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "SETTINGS_UPDATE_FAILED");
  }
});

router.get("/bookings", financeOnly, async (req, res) => {
  try {
    const bookings = await prisma.plotBooking.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { updatedAt: "desc" },
      take: Math.min(Number(req.query.limit) || 100, 200),
      select: { id: true, bookingNumber: true, contactId: true, plotSiteId: true, status: true, paymentStatus: true, totalAmount: true, amountPaid: true, balance: true, updatedAt: true },
    });
    const plotSiteIds = [...new Set(bookings.map((booking) => booking.plotSiteId))];
    const contactIds = [...new Set(bookings.map((booking) => booking.contactId))];
    const [plotSites, contacts, snapshots] = await Promise.all([
      plotSiteIds.length ? prisma.plotSite.findMany({ where: { tenantId: req.user.tenantId, id: { in: plotSiteIds } }, select: { id: true, name: true, plotNumber: true, price: true } }) : [],
      contactIds.length ? prisma.contact.findMany({ where: { tenantId: req.user.tenantId, id: { in: contactIds } }, select: { id: true, name: true, phone: true } }) : [],
      prisma.bookingPricingSnapshot.findMany({ where: { tenantId: req.user.tenantId, plotBookingId: { in: bookings.map((booking) => booking.id) } }, select: { id: true, plotBookingId: true, bookingStatus: true, splitMode: true, lockedAt: true, finalPricePaise: true } }),
    ]);
    const siteById = new Map(plotSites.map((site) => [site.id, site]));
    const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
    const snapshotByBooking = new Map(snapshots.map((snapshot) => [snapshot.plotBookingId, snapshot]));
    return res.json({ bookings: serializeMoneyObject(bookings.map((booking) => ({
      ...booking,
      plotSite: siteById.get(booking.plotSiteId) || null,
      contact: contactById.get(booking.contactId) || null,
      snapshot: snapshotByBooking.get(booking.id) || null,
    }))) });
  } catch (error) {
    return jsonError(res, 400, error.message, "PAYOUT_BOOKINGS_READ_FAILED");
  }
});

router.get("/plots", financeOnly, async (req, res) => {
  try {
    const plots = await prisma.plotSite.findMany({
      where: { tenantId: req.user.tenantId, isActive: true },
      orderBy: [{ name: "asc" }, { plotNumber: "asc" }, { id: "asc" }],
      take: Math.min(Number(req.query.limit) || 500, 1000),
      select: { id: true, name: true, plotNumber: true, block: true, area: true, areaUnit: true, price: true, availability: true },
    });
    if (!plots.length) return res.json({ plots: [] });

    const bookings = await prisma.plotBooking.findMany({
      where: { tenantId: req.user.tenantId, plotSiteId: { in: plots.map((plot) => plot.id) }, status: { not: "CANCELLED" } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, bookingNumber: true, contactId: true, plotSiteId: true, status: true, paymentStatus: true, updatedAt: true },
    });
    const contactIds = [...new Set(bookings.map((booking) => booking.contactId))];
    const contacts = contactIds.length
      ? await prisma.contact.findMany({ where: { tenantId: req.user.tenantId, id: { in: contactIds } }, select: { id: true, name: true, phone: true } })
      : [];
    const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
    const bookingsByPlot = new Map();
    for (const booking of bookings) {
      const rows = bookingsByPlot.get(booking.plotSiteId) || [];
      rows.push({ ...booking, contact: contactById.get(booking.contactId) || null });
      bookingsByPlot.set(booking.plotSiteId, rows);
    }
    return res.json({ plots: plots.map((plot) => ({ ...plot, bookings: bookingsByPlot.get(plot.id) || [] })) });
  } catch (error) {
    return jsonError(res, 400, error.message, "PAYOUT_PLOTS_READ_FAILED");
  }
});

router.get("/customers", financeOnly, async (req, res) => {
  try {
    const customers = await prisma.contact.findMany({
      where: { tenantId: req.user.tenantId, deletedAt: null },
      orderBy: { name: "asc" },
      take: Math.min(Number(req.query.limit) || 500, 1000),
      select: { id: true, name: true, phone: true, email: true },
    });
    return res.json({ customers });
  } catch (error) {
    return jsonError(res, 400, error.message, "PAYOUT_CUSTOMERS_READ_FAILED");
  }
});

router.post("/customer-bookings", financeOnly, async (req, res) => {
  try {
    const contactId = parseId(req.body?.contactId, "contactId");
    const plotSiteId = parseId(req.body?.plotSiteId, "plotSiteId");
    const [contact, plot, customerPickup, existingBooking] = await Promise.all([
      prisma.contact.findFirst({ where: { id: contactId, tenantId: req.user.tenantId, deletedAt: null }, select: { id: true, name: true, phone: true, email: true } }),
      prisma.plotSite.findFirst({ where: { id: plotSiteId, tenantId: req.user.tenantId, isActive: true } }),
      prisma.customerPickup.findUnique({ where: { tenantId_contactId: { tenantId: req.user.tenantId, contactId } }, select: { id: true } }),
      prisma.plotBooking.findFirst({ where: { tenantId: req.user.tenantId, contactId, plotSiteId, status: { not: "CANCELLED" } }, orderBy: { updatedAt: "desc" } }),
    ]);
    if (!contact) return jsonError(res, 404, "Customer not found", "CUSTOMER_NOT_FOUND");
    if (!plot) return jsonError(res, 404, "Active inventory plot not found", "PLOT_NOT_FOUND");
    if (existingBooking) return jsonError(res, 409, "This customer already has a booking for this plot", "PLOT_BOOKING_EXISTS", { bookingId: existingBooking.id });
    if (String(plot.availability || "").toUpperCase() !== "AVAILABLE") return jsonError(res, 409, `This plot is currently ${String(plot.availability || "unavailable").toLowerCase()}`, "PLOT_NOT_AVAILABLE");

    const booking = await prisma.$transaction(async (tx) => {
      const reserved = await tx.plotSite.updateMany({ where: { id: plotSiteId, tenantId: req.user.tenantId, isActive: true, availability: "AVAILABLE" }, data: { availability: "RESERVED" } });
      if (reserved.count !== 1) throw Object.assign(new Error("The plot is no longer available. Refresh and choose another plot."), { status: 409, code: "PLOT_NOT_AVAILABLE" });
      const created = await tx.plotBooking.create({ data: {
        bookingNumber: `BOOK-${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
        tenantId: req.user.tenantId,
        contactId,
        customerPickupId: customerPickup?.id || null,
        plotSiteId,
        status: "PLOT_ASSIGNED",
        paymentStatus: "UNPAID",
        totalAmount: Number(plot.price || 0),
        balance: Number(plot.price || 0),
      } });
      await tx.plotWorkflowEvent.create({ data: {
        tenantId: req.user.tenantId,
        plotBookingId: created.id,
        contactId,
        plotSiteId,
        stage: "PLOT",
        eventType: "PLOT_ASSIGNED",
        label: "Plot assigned",
        fromStatus: "AVAILABLE",
        toStatus: "PLOT_ASSIGNED",
        actorUserId: req.user.userId,
        metadataJson: JSON.stringify({ createdFrom: "deposit-distribution" }),
      } });
      return created;
    });
    await writeAudit("PlotBooking", "CREATE", booking.id, req.user.userId, req.user.tenantId, { contactId, plotSiteId, createdFrom: "deposit-distribution" });
    return res.status(201).json({ booking: { ...booking, contact, plotSite: plot } });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "CUSTOMER_BOOKING_CREATE_FAILED");
  }
});

router.get("/partners", staffOnly, async (req, res) => {
  const partners = await prisma.payoutPartner.findMany({ where: { tenantId: req.user.tenantId, ...(req.query.type ? { partnerType: String(req.query.type).toUpperCase() } : {}) }, orderBy: { name: "asc" } });
  return res.json({ partners: partners.map((partner) => ({ ...partner, bankAccountCiphertext: undefined })) });
});

router.post("/partners", adminOnly, async (req, res) => {
  try {
    const partnerType = String(req.body?.partnerType || "").toUpperCase();
    if (!["OWNER", "CHANNEL_PARTNER", "BROKER"].includes(partnerType)) throw new Error("partnerType must be OWNER, CHANNEL_PARTNER, or BROKER");
    const name = String(req.body?.name || "").trim();
    if (!name) throw new Error("Partner name is required");
    const account = req.body?.bankAccount ? String(req.body.bankAccount).trim() : null;
    const partner = await prisma.payoutPartner.create({ data: {
      tenantId: req.user.tenantId,
      partnerType,
      name,
      mobile: req.body?.mobile ? String(req.body.mobile).trim() : null,
      email: req.body?.email ? String(req.body.email).trim().toLowerCase() : null,
      pan: req.body?.pan ? String(req.body.pan).trim().toUpperCase() : null,
      gstin: req.body?.gstin ? String(req.body.gstin).trim().toUpperCase() : null,
      bankAccountCiphertext: account ? encrypt(account) : null,
      bankAccountLast4: account ? account.slice(-4) : null,
      ifsc: req.body?.ifsc ? String(req.body.ifsc).trim().toUpperCase() : null,
      plotBrokerId: req.body?.plotBrokerId ? parseId(req.body.plotBrokerId, "plotBrokerId") : null,
    } });
    await writeAudit("PayoutPartner", "CREATE", partner.id, req.user.userId, req.user.tenantId, { partnerType, name });
    return res.status(201).json({ partner: { ...partner, bankAccountCiphertext: undefined } });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PARTNER_CREATE_FAILED");
  }
});

router.put("/partners/:id", adminOnly, async (req, res) => {
  try {
    const id = parseId(req.params.id, "partner id");
    const existing = await prisma.payoutPartner.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return jsonError(res, 404, "Partner not found", "PARTNER_NOT_FOUND");
    const data = {};
    for (const field of ["name", "mobile", "email", "pan", "gstin", "ifsc", "status"]) if (req.body?.[field] !== undefined) data[field] = req.body[field] == null ? null : String(req.body[field]).trim();
    if (data.email) data.email = data.email.toLowerCase();
    if (data.pan) data.pan = data.pan.toUpperCase();
    if (data.gstin) data.gstin = data.gstin.toUpperCase();
    if (data.ifsc) data.ifsc = data.ifsc.toUpperCase();
    if (req.body?.bankAccount !== undefined) {
      const account = String(req.body.bankAccount || "").trim();
      data.bankAccountCiphertext = account ? encrypt(account) : null;
      data.bankAccountLast4 = account ? account.slice(-4) : null;
      data.bankVerified = false;
    }
    const partner = await prisma.payoutPartner.update({ where: { id }, data });
    await writeAudit("PayoutPartner", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: Object.keys(data) });
    return res.json({ partner: { ...partner, bankAccountCiphertext: undefined } });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PARTNER_UPDATE_FAILED");
  }
});

router.post("/partners/:id/verify-bank", financeOnly, async (req, res) => {
  try {
    const id = parseId(req.params.id, "partner id");
    const partner = await prisma.payoutPartner.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!partner) return jsonError(res, 404, "Partner not found", "PARTNER_NOT_FOUND");
    if (!partner.ifsc || !partner.bankAccountLast4) return jsonError(res, 409, "Bank account and IFSC are required", "BANK_DETAILS_REQUIRED");
    const updated = await prisma.payoutPartner.update({ where: { id }, data: { bankVerified: true } });
    await writeAudit("PayoutPartner", "BANK_VERIFIED", id, req.user.userId, req.user.tenantId, { bankAccountLast4: updated.bankAccountLast4, ifsc: updated.ifsc });
    return res.json({ partner: { ...updated, bankAccountCiphertext: undefined } });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "BANK_VERIFY_FAILED");
  }
});

router.get("/plots/:plotSiteId/owners", staffOnly, async (req, res) => {
  try {
    const plotSiteId = parseId(req.params.plotSiteId, "plotSiteId");
    const owners = await prisma.plotOwnership.findMany({ where: { tenantId: req.user.tenantId, plotSiteId }, orderBy: { id: "asc" } });
    return res.json({ owners: serializeMoneyObject(owners) });
  } catch (error) {
    return jsonError(res, 400, error.message, "OWNERS_READ_FAILED");
  }
});

router.put("/plots/:plotSiteId/owners", adminOnly, async (req, res) => {
  try {
    const plotSiteId = parseId(req.params.plotSiteId, "plotSiteId");
    const owners = Array.isArray(req.body?.owners) ? req.body.owners : [];
    if (!owners.length) throw new Error("At least one owner is required");
    const normalized = owners.map((owner) => ({
      payoutPartnerId: parseId(owner.partnerId, "partnerId"),
      ownershipBp: Number(owner.ownershipBp),
      askedPricePaise: readPaise(owner, "askedPricePaise", "askedPrice"),
    }));
    if (normalized.some((owner) => !Number.isInteger(owner.ownershipBp) || owner.ownershipBp < 0)) throw new Error("Ownership percentages must be non-negative basis points");
    if (normalized.reduce((sum, owner) => sum + owner.ownershipBp, 0) !== 10_000) throw new Error("Owner shares must total 10000 basis points");
    const partnerIds = normalized.map((owner) => owner.payoutPartnerId);
    const partnerCount = await prisma.payoutPartner.count({ where: { tenantId: req.user.tenantId, id: { in: partnerIds }, partnerType: "OWNER", status: "ACTIVE" } });
    if (partnerCount !== new Set(partnerIds).size) throw new Error("All owners must be active OWNER partners");
    const rows = await prisma.$transaction(async (tx) => {
      await tx.plotOwnership.deleteMany({ where: { tenantId: req.user.tenantId, plotSiteId } });
      await tx.plotOwnership.createMany({ data: normalized.map((owner) => ({ ...owner, tenantId: req.user.tenantId, plotSiteId })) });
      return tx.plotOwnership.findMany({ where: { tenantId: req.user.tenantId, plotSiteId }, orderBy: { id: "asc" } });
    });
    await writeAudit("PlotOwnership", "REPLACE", plotSiteId, req.user.userId, req.user.tenantId, { ownerCount: rows.length });
    return res.json({ owners: serializeMoneyObject(rows) });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "OWNERS_UPDATE_FAILED");
  }
});

router.post("/bookings/preview", financeOnly, async (req, res) => {
  try {
    const preview = await buildPreview(req.user.tenantId, req.body || {});
    return res.json({ preview: serializeMoneyObject({
      bookingId: preview.booking.id,
      plotSiteId: preview.plotSite.id,
      splitMode: preview.splitMode,
      customSplit: preview.customSplit,
      settings: preview.settings,
      ...preview.calculation,
    }) });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PAYOUT_PREVIEW_FAILED");
  }
});

router.post("/bookings", financeOnly, async (req, res) => {
  try {
    const preview = await buildPreview(req.user.tenantId, req.body || {});
    const existing = await prisma.bookingPricingSnapshot.findFirst({ where: { tenantId: req.user.tenantId, plotBookingId: preview.booking.id } });
    if (existing) return jsonError(res, 409, "A payout pricing snapshot already exists for this booking", "PRICING_SNAPSHOT_EXISTS");
    const snapshot = await prisma.bookingPricingSnapshot.create({ data: {
      tenantId: req.user.tenantId,
      plotBookingId: preview.booking.id,
      plotSiteId: preview.plotSite.id,
      contactId: preview.booking.contactId,
      ownerPartnerIdsJson: JSON.stringify(preview.owners.map((owner) => owner.payoutPartnerId)),
      channelPartnerId: preview.channelPartnerId,
      brokerPartnerId: preview.brokerPartnerId,
      basePricePaise: preview.calculation.basePricePaise,
      listPricePaise: preview.calculation.listPricePaise,
      finalPricePaise: preview.calculation.finalPricePaise,
      cpMarkupPaise: preview.calculation.cpMarkupPaise,
      brokerCommissionPaise: preview.calculation.brokerCommissionPaise,
      cpCommissionPaise: preview.calculation.cpCommissionPaise,
      pricingModel: preview.settings.pricingModel,
      splitMethod: preview.settings.splitMethod,
      splitMode: preview.splitMode,
      customSplitJson: preview.customSplit ? JSON.stringify(preview.customSplit, bigintReplacer) : null,
      bookingStatus: "PENDING_SPLIT_APPROVAL",
      holdTrigger: preview.settings.holdTrigger,
      ownerRelease: preview.settings.ownerRelease,
      rulesJson: calculationRules(preview),
      createdByUserId: req.user.userId,
    } });
    await writeAudit("BookingPricingSnapshot", "CREATE", snapshot.id, req.user.userId, req.user.tenantId, { plotBookingId: snapshot.plotBookingId, finalPricePaise: String(snapshot.finalPricePaise) });
    return res.status(201).json({ snapshot: serializeMoneyObject(snapshot) });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PRICING_SNAPSHOT_CREATE_FAILED");
  }
});

router.post("/bookings/:bookingId/approve", financeOnly, async (req, res) => {
  try {
    const bookingId = parseId(req.params.bookingId, "bookingId");
    const snapshot = await prisma.bookingPricingSnapshot.findFirst({ where: { tenantId: req.user.tenantId, plotBookingId: bookingId } });
    if (!snapshot) return jsonError(res, 404, "Pricing snapshot not found", "PRICING_SNAPSHOT_NOT_FOUND");
    if (snapshot.bookingStatus !== "PENDING_SPLIT_APPROVAL") return res.json({ snapshot: serializeMoneyObject(snapshot) });
    if ((snapshot.splitMode === "CUSTOM_PERSON" || snapshot.splitMode === "CUSTOM_INSTALLMENT") && !isAdminUser(req)) {
      return jsonError(res, 403, "An Admin must approve a custom split", "CUSTOM_SPLIT_ADMIN_APPROVAL_REQUIRED");
    }
    const updated = await prisma.bookingPricingSnapshot.update({ where: { id: snapshot.id }, data: { bookingStatus: "BOOKED", approvedByUserId: req.user.userId, approvedAt: new Date(), lockedAt: new Date() } });
    await writeAudit("BookingPricingSnapshot", "APPROVE", snapshot.id, req.user.userId, req.user.tenantId, { bookingStatus: "BOOKED" });
    return res.json({ snapshot: serializeMoneyObject(updated) });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "BOOKING_APPROVAL_FAILED");
  }
});

router.get("/bookings/:bookingId/distribution", staffOnly, async (req, res) => {
  try {
    const bookingId = parseId(req.params.bookingId, "bookingId");
    const snapshot = await prisma.bookingPricingSnapshot.findFirst({ where: { tenantId: req.user.tenantId, plotBookingId: bookingId } });
    if (!snapshot) return jsonError(res, 404, "Pricing snapshot not found", "PRICING_SNAPSHOT_NOT_FOUND");
    const [receipts, lines] = await Promise.all([
      prisma.paymentReceipt.findMany({ where: { tenantId: req.user.tenantId, plotBookingId: bookingId }, orderBy: { receivedOn: "asc" } }),
      prisma.distributionLine.findMany({ where: { tenantId: req.user.tenantId, plotBookingId: bookingId }, orderBy: { createdAt: "asc" } }),
    ]);
    return res.json({ snapshot: serializeMoneyObject(snapshot), receipts: serializeMoneyObject(receipts), lines: serializeMoneyObject(lines) });
  } catch (error) {
    return jsonError(res, 400, error.message, "DISTRIBUTION_READ_FAILED");
  }
});

router.post("/bookings/:bookingId/release-hold", financeOnly, async (req, res) => {
  try {
    const bookingId = parseId(req.params.bookingId, "bookingId");
    const snapshot = await prisma.bookingPricingSnapshot.findFirst({ where: { tenantId: req.user.tenantId, plotBookingId: bookingId } });
    if (!snapshot) return jsonError(res, 404, "Pricing snapshot not found", "PRICING_SNAPSHOT_NOT_FOUND");
    const updated = await prisma.distributionLine.updateMany({ where: { tenantId: req.user.tenantId, plotBookingId: bookingId, status: "PENDING_HOLD" }, data: { status: "PENDING_APPROVAL" } });
    await writeAudit("DistributionLine", "HOLD_RELEASED", null, req.user.userId, req.user.tenantId, { bookingId, releasedCount: updated.count, trigger: snapshot.holdTrigger });
    return res.json({ releasedCount: updated.count });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PAYOUT_HOLD_RELEASE_FAILED");
  }
});

router.post("/bookings/:bookingId/cancel", financeOnly, async (req, res) => {
  try {
    const bookingId = parseId(req.params.bookingId, "bookingId");
    const reason = String(req.body?.reason || "Booking cancelled").trim();
    const response = await prisma.$transaction(async (tx) => {
      const snapshot = await tx.bookingPricingSnapshot.findFirst({ where: { tenantId: req.user.tenantId, plotBookingId: bookingId } });
      if (!snapshot) throw Object.assign(new Error("Pricing snapshot not found"), { status: 404, code: "PRICING_SNAPSHOT_NOT_FOUND" });
      if (snapshot.bookingStatus === "CANCELLED") return { snapshot, clawbackCount: 0 };
      const lines = await tx.distributionLine.findMany({ where: { tenantId: req.user.tenantId, plotBookingId: bookingId, status: { not: "CANCELLED" } } });
      let clawbackCount = 0;
      for (const line of lines) {
        if (line.status === "PAID" && line.payoutPartnerId && toPaise(line.netPaise) > 0n) {
          const existing = await tx.payoutClawback.findFirst({ where: { tenantId: req.user.tenantId, distributionLineId: line.id, status: "PENDING_RECOVERY" } });
          if (!existing) {
            const payoutLine = await tx.payoutLine.findUnique({ where: { distributionLineId: line.id }, select: { payoutId: true } });
            await tx.payoutClawback.create({ data: { tenantId: req.user.tenantId, plotBookingId: bookingId, payoutPartnerId: line.payoutPartnerId, distributionLineId: line.id, originalPayoutId: payoutLine?.payoutId || null, amountPaise: line.netPaise, reason } });
            clawbackCount += 1;
          }
        }
      }
      await tx.distributionLine.updateMany({ where: { tenantId: req.user.tenantId, plotBookingId: bookingId, status: { in: ["PENDING_HOLD", "PENDING_APPROVAL", "FINANCE_APPROVED", "APPROVED"] } }, data: { status: "CANCELLED" } });
      const updatedSnapshot = await tx.bookingPricingSnapshot.update({ where: { id: snapshot.id }, data: { bookingStatus: "CANCELLED", cancelledAt: new Date(), cancellationReason: reason } });
      await tx.plotBooking.updateMany({ where: { id: bookingId, tenantId: req.user.tenantId }, data: { status: "CANCELLED" } });
      return { snapshot: updatedSnapshot, clawbackCount };
    });
    await writeAudit("BookingPricingSnapshot", "CANCEL", response.snapshot.id, req.user.userId, req.user.tenantId, { bookingId, reason, clawbackCount: response.clawbackCount });
    return res.json({ snapshot: serializeMoneyObject(response.snapshot), clawbackCount: response.clawbackCount });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PAYOUT_BOOKING_CANCEL_FAILED");
  }
});

router.post("/bookings/:bookingId/payments", financeOnly, async (req, res) => {
  const tenantId = req.user.tenantId;
  let key;
  try {
    key = readIdempotencyKey(req);
    if (await returnExistingIdempotency(tenantId, `receipt:${req.params.bookingId}`, key, res)) return;
    const bookingId = parseId(req.params.bookingId, "bookingId");
    const amountPaise = readPaise(req.body || {}, "amountPaise", "amount");
    const mode = String(req.body?.mode || "").toUpperCase();
    if (!["UPI", "BANK_TRANSFER", "CASH", "CARD", "CHEQUE", "PAYMENT_LINK"].includes(mode)) throw new Error("Choose a valid payment mode");
    const installmentNumber = req.body?.installmentNumber == null || req.body?.installmentNumber === "" ? null : Number(req.body.installmentNumber);
    if (installmentNumber !== null && (!Number.isInteger(installmentNumber) || installmentNumber <= 0)) throw new Error("installmentNumber must be a positive integer");
    const snapshot = await prisma.bookingPricingSnapshot.findFirst({ where: { tenantId, plotBookingId: bookingId } });
    if (!snapshot) return jsonError(res, 404, "Pricing snapshot not found", "PRICING_SNAPSHOT_NOT_FOUND");
    if (snapshot.bookingStatus !== "BOOKED") return jsonError(res, 409, "Approve the split booking before recording a payment", "BOOKING_NOT_PAYABLE");
    if (snapshot.splitMode === "CUSTOM_INSTALLMENT" && installmentNumber === null) return jsonError(res, 400, "installmentNumber is required for an installment split", "INSTALLMENT_REQUIRED");
    const existingReceipts = await prisma.paymentReceipt.findMany({ where: { tenantId, plotBookingId: bookingId, status: { not: "REJECTED" }, ...(installmentNumber ? { installmentNumber } : {}) }, select: { amountPaise: true } });
    const collected = existingReceipts.reduce((sum, row) => sum + toPaise(row.amountPaise), 0n);
    const rules = parseJson(snapshot.customSplitJson, { lines: [] });
    const installmentTotal = snapshot.splitMode === "CUSTOM_INSTALLMENT" && installmentNumber
      ? rules.lines.filter((line) => Number(line.installmentNumber) === installmentNumber).reduce((sum, line) => sum + toPaise(line.amountPaise), 0n)
      : toPaise(snapshot.finalPricePaise);
    if (installmentTotal <= 0n) return jsonError(res, 400, "That installment does not exist in the approved split", "INSTALLMENT_NOT_FOUND");
    if (collected + amountPaise > installmentTotal) return jsonError(res, 400, "Payment exceeds the outstanding split booking amount", "PAYMENT_EXCEEDS_BALANCE");
    const referenceNo = req.body?.referenceNo ? String(req.body.referenceNo).trim() : null;
    if (referenceNo && await prisma.paymentReceipt.findFirst({ where: { tenantId, referenceNo, mode } })) return jsonError(res, 409, "That receipt reference already exists", "DUPLICATE_RECEIPT_REFERENCE");
    const receivedOn = req.body?.receivedOn ? new Date(req.body.receivedOn) : new Date();
    if (Number.isNaN(receivedOn.getTime())) throw new Error("receivedOn must be a valid date");
    const response = await prisma.$transaction(async (tx) => {
      const receipt = await tx.paymentReceipt.create({ data: {
        tenantId, plotBookingId: bookingId, bookingSnapshotId: snapshot.id, amountPaise, mode, referenceNo, receivedOn, installmentNumber,
        proofDocumentId: req.body?.proofDocumentId ? parseId(req.body.proofDocumentId, "proofDocumentId") : null,
        receivedInAccount: req.body?.receivedInAccount ? String(req.body.receivedInAccount).trim() : null,
        createdByUserId: req.user.userId,
      } });
      const result = { receipt: serializeMoneyObject(receipt) };
      await tx.idempotencyRecord.create({ data: { tenantId, scope: `receipt:${bookingId}`, key, statusCode: 201, responseJson: JSON.stringify(result) } });
      return result;
    });
    await writeAudit("PaymentReceipt", "CREATE", response.receipt.id, req.user.userId, tenantId, { bookingId, amountPaise: String(amountPaise), mode });
    return res.status(201).json(response);
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "RECEIPT_CREATE_FAILED");
  }
});

router.post("/payments/:receiptId/verify", financeOnly, async (req, res) => {
  const tenantId = req.user.tenantId;
  let key;
  try {
    key = readIdempotencyKey(req);
    if (await returnExistingIdempotency(tenantId, `verify:${req.params.receiptId}`, key, res)) return;
    const receiptId = parseId(req.params.receiptId, "receiptId");
    const response = await prisma.$transaction(async (tx) => {
      const receipt = await tx.paymentReceipt.findFirst({ where: { id: receiptId, tenantId } });
      if (!receipt) throw Object.assign(new Error("Payment receipt not found"), { status: 404, code: "RECEIPT_NOT_FOUND" });
      if (receipt.status !== "RECORDED") throw Object.assign(new Error("Payment receipt is no longer awaiting verification"), { status: 409, code: "RECEIPT_NOT_VERIFYABLE" });
      if (receipt.createdByUserId === req.user.userId) throw Object.assign(new Error("The receipt creator cannot verify the same receipt"), { status: 403, code: "MAKER_CHECKER_REQUIRED" });
      const snapshot = await tx.bookingPricingSnapshot.findFirst({ where: { id: receipt.bookingSnapshotId || 0, tenantId } });
      if (!snapshot) throw Object.assign(new Error("Pricing snapshot not found"), { status: 404, code: "PRICING_SNAPSHOT_NOT_FOUND" });
      await lockBooking(tx, tenantId, receipt.plotBookingId);
      const paymentReference = receipt.referenceNo || `DEP-RECEIPT-${receipt.id}`;
      const payment = await tx.payment.create({ data: {
        contactId: snapshot.contactId,
        description: `Deposit distribution payment for booking ${receipt.plotBookingId}`,
        amount: Number(receipt.amountPaise) / 100,
        currency: "INR",
        gateway: receipt.mode.toLowerCase(),
        gatewayId: receipt.referenceNo,
        plotPaymentReference: paymentReference,
        status: "SUCCESS",
        paidAt: receipt.receivedOn,
        tenantId,
        metadata: JSON.stringify({ kind: "plot-booking-payment", plotBookingId: receipt.plotBookingId, payoutReceiptId: receipt.id }),
      } });
      await reconcilePlotBookingPaymentWithClient(tx, payment);
      const calculation = calculationForSnapshot(snapshot, receipt);
      const relevantReceiptRows = await tx.paymentReceipt.findMany({ where: { tenantId, plotBookingId: receipt.plotBookingId, status: { in: ["RECORDED", "VERIFIED"] }, ...(snapshot.splitMode === "CUSTOM_INSTALLMENT" ? { installmentNumber: receipt.installmentNumber } : {}) }, select: { id: true, amountPaise: true } });
      const previousLines = await tx.distributionLine.findMany({ where: { tenantId, plotBookingId: receipt.plotBookingId, paymentReceiptId: { in: relevantReceiptRows.map((row) => row.id) } } });
      const previousReceiptTotalRows = relevantReceiptRows;
      const cumulativePayment = previousReceiptTotalRows.reduce((sum, row) => sum + toPaise(row.amountPaise), 0n);
      const cumulativeLines = allocatePayment(cumulativePayment, calculation.entitlements);
      const previousByKey = new Map();
      for (const line of previousLines) previousByKey.set(keyForLine(line), (previousByKey.get(keyForLine(line)) || 0n) + toPaise(line.grossPaise));
      const holdStatus = snapshot.bookingStatus === "BOOKED" && snapshot.ownerRelease === "ON_VERIFY" ? "PENDING_APPROVAL" : "PENDING_HOLD";
      const createdLines = [];
      for (const line of cumulativeLines) {
        const delta = line.amountPaise - (previousByKey.get(keyForLine(line)) || 0n);
        if (delta <= 0n) continue;
        const isCommission = ["CHANNEL_PARTNER", "BROKER"].includes(line.partyType);
        const status = line.partyType === "COMPANY"
          ? "AVAILABLE"
          : isCommission && snapshot.holdTrigger !== "IMMEDIATE"
            ? "PENDING_HOLD"
            : holdStatus;
        createdLines.push(await tx.distributionLine.create({ data: {
          tenantId,
          plotBookingId: receipt.plotBookingId,
          paymentReceiptId: receipt.id,
          payoutPartnerId: line.partnerId,
          partyType: line.partyType,
          kind: line.kind,
          grossPaise: delta,
          netPaise: delta,
          status,
          holdUntil: isCommission && snapshot.holdTrigger !== "IMMEDIATE" ? null : undefined,
        } }));
      }
      await tx.paymentReceipt.update({ where: { id: receipt.id }, data: { status: "VERIFIED", verifiedByUserId: req.user.userId, verifiedAt: new Date(), paymentId: payment.id } });
      const result = { receipt: serializeMoneyObject({ ...receipt, status: "VERIFIED", paymentId: payment.id }), payment: serializeMoneyObject(payment), lines: serializeMoneyObject(createdLines) };
      await tx.idempotencyRecord.create({ data: { tenantId, scope: `verify:${receiptId}`, key, statusCode: 200, responseJson: JSON.stringify(result) } });
      return result;
    });
    await writeAudit("PaymentReceipt", "VERIFY", receiptId, req.user.userId, tenantId, { distributionLineCount: response.lines.length });
    return res.json(response);
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "RECEIPT_VERIFY_FAILED");
  }
});

router.get("/distribution-lines/queue", financeOnly, async (req, res) => {
  const lines = await prisma.distributionLine.findMany({ where: { tenantId: req.user.tenantId, status: { in: ["PENDING_HOLD", "PENDING_APPROVAL", "FINANCE_APPROVED", "APPROVED"] } }, orderBy: { createdAt: "asc" } });
  return res.json({ lines: serializeMoneyObject(lines) });
});

router.post("/distribution-lines/approve", financeOnly, async (req, res) => {
  try {
    const lineIds = Array.isArray(req.body?.lineIds) ? req.body.lineIds.map((id) => parseId(id, "lineId")) : [];
    if (!lineIds.length) throw new Error("lineIds is required");
    const stage = String(req.body?.stage || "FINANCE").toUpperCase();
    if (!["FINANCE", "MANAGER"].includes(stage)) throw new Error("stage must be FINANCE or MANAGER");
    if (stage === "MANAGER" && !isAdminUser(req)) return jsonError(res, 403, "Manager approval requires an Admin", "MANAGER_APPROVAL_REQUIRED");
    const lines = await prisma.distributionLine.findMany({ where: { tenantId: req.user.tenantId, id: { in: lineIds }, status: { in: stage === "FINANCE" ? ["PENDING_APPROVAL"] : ["FINANCE_APPROVED"] } } });
    if (lines.length !== lineIds.length) return jsonError(res, 409, `One or more lines are not ready for ${stage.toLowerCase()} approval`, "DISTRIBUTION_LINES_NOT_READY");
    if (stage === "MANAGER" && lines.some((line) => line.financeApprovedByUserId === req.user.userId)) return jsonError(res, 409, "Finance and manager approval must be completed by different users", "DUAL_APPROVAL_REQUIRED");
    const now = new Date();
    const data = stage === "FINANCE"
      ? { status: "FINANCE_APPROVED", financeApprovedByUserId: req.user.userId, financeApprovedAt: now }
      : { status: "APPROVED", approvedByUserId: req.user.userId, approvedAt: now, managerApprovedByUserId: req.user.userId, managerApprovedAt: now };
    const updated = await prisma.distributionLine.updateMany({ where: { tenantId: req.user.tenantId, id: { in: lineIds }, status: stage === "FINANCE" ? "PENDING_APPROVAL" : "FINANCE_APPROVED" }, data });
    await writeAudit("DistributionLine", `${stage}_APPROVE`, null, req.user.userId, req.user.tenantId, { lineIds, stage });
    return res.json({ approvedCount: updated.count, stage });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "DISTRIBUTION_APPROVAL_FAILED");
  }
});

router.post("/payouts", financeOnly, async (req, res) => {
  const tenantId = req.user.tenantId;
  try {
    const key = readIdempotencyKey(req);
    if (await returnExistingIdempotency(tenantId, "payout", key, res)) return;
    const payoutPartnerId = parseId(req.body?.payoutPartnerId, "payoutPartnerId");
    const lineIds = Array.isArray(req.body?.lineIds) ? req.body.lineIds.map((id) => parseId(id, "lineId")) : [];
    if (!lineIds.length) throw new Error("lineIds is required");
    const partner = await prisma.payoutPartner.findFirst({ where: { tenantId, id: payoutPartnerId, status: "ACTIVE" } });
    if (!partner) return jsonError(res, 404, "Payout partner not found", "PARTNER_NOT_FOUND");
    if (!partner.bankVerified) return jsonError(res, 409, "Bank details must be verified before payout", "BANK_NOT_VERIFIED");
    const utr = String(req.body?.utr || "").trim();
    if (!utr) throw new Error("UTR is required");
    const paidOn = req.body?.paidOn ? new Date(req.body.paidOn) : new Date();
    if (Number.isNaN(paidOn.getTime())) throw new Error("paidOn must be a valid date");
    const response = await prisma.$transaction(async (tx) => {
      const lines = await tx.distributionLine.findMany({ where: { tenantId, id: { in: lineIds }, payoutPartnerId, status: "APPROVED" } });
      if (lines.length !== lineIds.length) throw Object.assign(new Error("All payout lines must belong to the partner and be approved"), { status: 409, code: "PAYOUT_LINES_NOT_APPROVED" });
      const grossNetPaise = lines.reduce((sum, line) => sum + toPaise(line.netPaise), 0n);
      const pendingClawbacks = await tx.payoutClawback.findMany({ where: { tenantId, payoutPartnerId, status: "PENDING_RECOVERY" }, orderBy: { createdAt: "asc" } });
      let clawbackRemaining = grossNetPaise;
      let clawbackPaise = 0n;
      const clawbackRecoveries = [];
      for (const clawback of pendingClawbacks) {
        if (clawbackRemaining <= 0n) break;
        const outstanding = toPaise(clawback.amountPaise) - toPaise(clawback.recoveredPaise);
        const recovered = outstanding < clawbackRemaining ? outstanding : clawbackRemaining;
        if (recovered <= 0n) continue;
        clawbackRemaining -= recovered;
        clawbackPaise += recovered;
        clawbackRecoveries.push({ id: clawback.id, recovered, fullyRecovered: recovered === outstanding });
      }
      const totalNetPaise = grossNetPaise - clawbackPaise;
      const payout = await tx.payout.create({ data: { tenantId, payoutPartnerId, grossNetPaise, clawbackPaise, totalNetPaise, utr, paidOn, bankProofDocumentId: req.body?.bankProofDocumentId ? parseId(req.body.bankProofDocumentId, "bankProofDocumentId") : null, createdByUserId: req.user.userId } });
      await tx.payoutLine.createMany({ data: lines.map((line) => ({ tenantId, payoutId: payout.id, distributionLineId: line.id, amountPaise: line.netPaise })) });
      await tx.distributionLine.updateMany({ where: { tenantId, id: { in: lineIds }, status: "APPROVED" }, data: { status: "PAID" } });
      for (const recovery of clawbackRecoveries) {
        const clawback = pendingClawbacks.find((row) => row.id === recovery.id);
        const recoveredPaise = toPaise(clawback.recoveredPaise) + recovery.recovered;
        await tx.payoutClawback.update({ where: { id: recovery.id }, data: { recoveredPaise, recoveredPayoutId: payout.id, status: recovery.fullyRecovered ? "RECOVERED" : "PENDING_RECOVERY", recoveredAt: recovery.fullyRecovered ? new Date() : null } });
      }
      const result = { payout: serializeMoneyObject(payout), lineIds, grossNetPaise: serializeMoneyObject(grossNetPaise), clawbackPaise: serializeMoneyObject(clawbackPaise) };
      await tx.idempotencyRecord.create({ data: { tenantId, scope: "payout", key, statusCode: 201, responseJson: JSON.stringify(result) } });
      return result;
    });
    const adviceDocument = await prisma.payoutDocument.create({ data: { tenantId, kind: "PAYOUT_ADVICE", fileUrl: `/api/pickup-plot-payouts/payouts/${response.payout.id}/advice.pdf`, fileName: `payout-advice-${response.payout.id}.pdf`, mimeType: "application/pdf", uploadedByUserId: req.user.userId } });
    await prisma.payout.update({ where: { id: response.payout.id }, data: { advicePdfDocumentId: adviceDocument.id } });
    response.adviceDocument = adviceDocument;
    await writeAudit("Payout", "CREATE", response.payout.id, req.user.userId, tenantId, { payoutPartnerId, lineIds, utr });
    return res.status(201).json(response);
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PAYOUT_CREATE_FAILED");
  }
});

router.get("/payouts/:payoutId/advice.pdf", financeOnly, async (req, res) => {
  try {
    const payoutId = parseId(req.params.payoutId, "payoutId");
    const payout = await prisma.payout.findFirst({ where: { id: payoutId, tenantId: req.user.tenantId } });
    if (!payout) return jsonError(res, 404, "Payout not found", "PAYOUT_NOT_FOUND");
    const [partner, payoutLines] = await Promise.all([
      prisma.payoutPartner.findFirst({ where: { id: payout.payoutPartnerId, tenantId: req.user.tenantId }, select: { name: true, mobile: true, email: true } }),
      prisma.payoutLine.findMany({ where: { tenantId: req.user.tenantId, payoutId }, select: { amountPaise: true, distributionLineId: true } }),
    ]);
    const lineIds = payoutLines.map((line) => line.distributionLineId);
    const distributionLines = lineIds.length ? await prisma.distributionLine.findMany({ where: { tenantId: req.user.tenantId, id: { in: lineIds } }, select: { plotBookingId: true, kind: true } }) : [];
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    applyRupeeCapableFonts(doc);
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    const pdfDone = new Promise((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
    doc.fontSize(20).text("Partner payout advice", { align: "center" });
    doc.moveDown();
    doc.fontSize(11).text(`Payout ID: ${payout.id}`);
    doc.text(`Partner: ${partner?.name || "Partner"}`);
    doc.text(`UTR: ${payout.utr}`);
    doc.text(`Paid on: ${new Date(payout.paidOn).toLocaleString("en-IN")}`);
    doc.moveDown();
    doc.fontSize(14).text(`Gross approved amount: ₹${(Number(payout.grossNetPaise || payout.totalNetPaise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
    if (toPaise(payout.clawbackPaise || 0) > 0n) doc.fontSize(11).text(`Clawback recovered from this payout: ₹${(Number(payout.clawbackPaise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
    doc.fontSize(14).text(`Net amount paid: ₹${(Number(payout.totalNetPaise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
    doc.moveDown();
    doc.fontSize(10).text("This document records the company payout and its bank reference. Please confirm receipt using the OTP sent by the company.");
    if (distributionLines.length) {
      doc.moveDown();
      doc.fontSize(11).text("Included distribution lines:");
      for (const line of distributionLines) doc.fontSize(10).text(`Booking #${line.plotBookingId} — ${line.kind}`);
    }
    doc.end();
    const buffer = await pdfDone;
    res.status(200).set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="payout-advice-${payout.id}.pdf"`, "Content-Length": buffer.length }).end(buffer);
  } catch (error) {
    return jsonError(res, 400, error.message, "PAYOUT_ADVICE_FAILED");
  }
});

router.post("/payouts/:payoutId/send-confirmation", financeOnly, async (req, res) => {
  try {
    const payoutId = parseId(req.params.payoutId, "payoutId");
    const payout = await prisma.payout.findFirst({ where: { id: payoutId, tenantId: req.user.tenantId } });
    if (!payout) return jsonError(res, 404, "Payout not found", "PAYOUT_NOT_FOUND");
    const partner = await prisma.payoutPartner.findFirst({ where: { id: payout.payoutPartnerId, tenantId: req.user.tenantId }, select: { name: true, mobile: true } });
    if (!partner?.mobile) return jsonError(res, 409, "The payout partner does not have a mobile number", "PARTNER_MOBILE_REQUIRED");
    const otp = createOtp();
    const confirmationToken = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.payoutConfirmation.upsert({ where: { payoutId }, create: { tenantId: req.user.tenantId, payoutId, payoutPartnerId: payout.payoutPartnerId, mobile: partner.mobile, otpHash: hashOtp(otp), publicTokenHash: hashOtp(confirmationToken), status: "PENDING", sentAt: new Date(), expiresAt }, update: { mobile: partner.mobile, otpHash: hashOtp(otp), publicTokenHash: hashOtp(confirmationToken), status: "PENDING", sentAt: new Date(), expiresAt, attempts: 0, verifiedAt: null } });
    let delivery = { sent: false, reason: "SMS_PROVIDER_NOT_CONFIGURED" };
    const provider = await resolveProviderConfig(prisma, req.user.tenantId);
    if (provider) {
      try { delivery = await sendSms({ ...provider, to: partner.mobile, body: `Your payout of ₹${(Number(payout.totalNetPaise) / 100).toFixed(2)} has been sent. Confirm: ${process.env.FRONTEND_URL || ""}/payout-confirmation?token=${confirmationToken}. Advice PDF: ${process.env.FRONTEND_URL || ""}/api/pickup-plot-payouts/public/advice.pdf?token=${confirmationToken}. OTP: ${otp}.` }); } catch (error) { delivery = { sent: false, reason: error.message }; }
    }
    await writeAudit("PayoutConfirmation", "OTP_SENT", payoutId, req.user.userId, req.user.tenantId, { delivery: delivery.sent, mobileLast4: partner.mobile.slice(-4) });
    return res.json({ payoutId, mobile: `••••${partner.mobile.slice(-4)}`, delivery, publicConfirmationUrl: `${process.env.FRONTEND_URL || ""}/payout-confirmation?token=${confirmationToken}`, publicAdviceUrl: `${process.env.FRONTEND_URL || ""}/api/pickup-plot-payouts/public/advice.pdf?token=${confirmationToken}`, publicConfirmationEndpoint: "/api/pickup-plot-payouts/public/confirm", ...(process.env.NODE_ENV !== "production" ? { testOtp: otp, testToken: confirmationToken } : {}) });
  } catch (error) {
    return jsonError(res, 400, error.message, error.code || "PAYOUT_CONFIRMATION_SEND_FAILED");
  }
});

router.post("/payouts/:payoutId/confirm", staffOnly, async (req, res) => {
  try {
    const payoutId = parseId(req.params.payoutId, "payoutId");
    const otp = String(req.body?.otp || "").trim();
    if (!/^\d{6}$/.test(otp)) throw new Error("A six-digit OTP is required");
    const confirmation = await prisma.payoutConfirmation.findFirst({ where: { payoutId, tenantId: req.user.tenantId } });
    if (!confirmation) return jsonError(res, 404, "Payout confirmation has not been sent", "PAYOUT_CONFIRMATION_NOT_FOUND");
    if (confirmation.status === "VERIFIED") return res.json({ confirmed: true, verifiedAt: confirmation.verifiedAt });
    if (confirmation.expiresAt < new Date()) return jsonError(res, 400, "The payout confirmation OTP has expired", "PAYOUT_OTP_EXPIRED");
    if (confirmation.attempts >= 5) return jsonError(res, 429, "Too many invalid OTP attempts", "PAYOUT_OTP_LOCKED");
    if (hashOtp(otp) !== confirmation.otpHash) {
      await prisma.payoutConfirmation.update({ where: { id: confirmation.id }, data: { attempts: { increment: 1 } } });
      return jsonError(res, 400, "Incorrect payout confirmation OTP", "PAYOUT_OTP_INVALID");
    }
    const verifiedAt = new Date();
    await prisma.$transaction([
      prisma.payoutConfirmation.update({ where: { id: confirmation.id }, data: { status: "VERIFIED", verifiedAt } }),
      prisma.payout.updateMany({ where: { id: payoutId, tenantId: req.user.tenantId }, data: { acknowledgedAt: verifiedAt } }),
    ]);
    await writeAudit("PayoutConfirmation", "OTP_VERIFIED", payoutId, req.user.userId, req.user.tenantId, {});
    return res.json({ confirmed: true, verifiedAt });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "PAYOUT_CONFIRMATION_FAILED");
  }
});

router.post("/documents", financeOnly, async (req, res) => {
  try {
    const fileUrl = String(req.body?.fileUrl || "").trim();
    if (!fileUrl) throw new Error("fileUrl is required");
    const document = await prisma.payoutDocument.create({ data: { tenantId: req.user.tenantId, kind: String(req.body?.kind || "OTHER").toUpperCase(), fileUrl, fileName: req.body?.fileName ? String(req.body.fileName) : null, mimeType: req.body?.mimeType ? String(req.body.mimeType) : null, sizeBytes: req.body?.sizeBytes ? Number(req.body.sizeBytes) : null, uploadedByUserId: req.user.userId } });
    await writeAudit("PayoutDocument", "CREATE", document.id, req.user.userId, req.user.tenantId, { kind: document.kind });
    return res.status(201).json({ document });
  } catch (error) {
    return jsonError(res, error.status || 400, error.message, error.code || "DOCUMENT_CREATE_FAILED");
  }
});

module.exports = router;
