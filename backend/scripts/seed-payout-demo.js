/*
 * Seed a repeatable payout fixture for local development only.
 *
 * This script is intentionally opt-in and refuses both production mode and
 * non-local database hosts. It is never imported by server startup, CI, or
 * deployment workflows.
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const prisma = require("../lib/prisma");

const TENANT_ID = Number(process.env.PAYOUT_DEMO_TENANT_ID || 1);
const OWNER_NAME = "payel Roy";
const CHANNEL_PARTNER_NAME = "Local Channel Partner QA";
const BROKER_NAME = "Local Broker QA";

function assertLocalOnly() {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("Refusing to seed payout demo data while NODE_ENV=production");
  }
  if (process.env.ALLOW_PAYOUT_DEMO_SEED !== "1") {
    throw new Error("Set ALLOW_PAYOUT_DEMO_SEED=1 to opt into the local payout demo seed");
  }
  const raw = process.env.DATABASE_URL || "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is missing or invalid");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error(`Refusing to seed payout demo data into non-local database: ${url.hostname}`);
  }
}

function priceToPaise(price, percentage = 1) {
  return BigInt(Math.round(Number(price || 0) * 100 * percentage));
}

async function findExistingCustomer(excludeId = null) {
  const customer = await prisma.contact.findFirst({
    where: { tenantId: TENANT_ID, deletedAt: null, status: "Customer", ...(excludeId ? { id: { not: excludeId } } : {}) },
    orderBy: { id: "asc" },
    select: { id: true, name: true },
  });
  if (!customer) throw new Error(`No existing Customer contact found for tenant ${TENANT_ID}`);
  return customer;
}

async function ensurePartner(data) {
  const existing = await prisma.payoutPartner.findFirst({ where: { tenantId: TENANT_ID, name: data.name, partnerType: data.partnerType } });
  if (existing) {
    return prisma.payoutPartner.update({
      where: { id: existing.id },
      data: { bankVerified: true, status: "ACTIVE", ...(data.plotBrokerId ? { plotBrokerId: data.plotBrokerId } : {}) },
    });
  }
  return prisma.payoutPartner.create({
    data: {
      tenantId: TENANT_ID,
      partnerType: data.partnerType,
      name: data.name,
      mobile: data.mobile,
      email: data.email,
      bankAccountLast4: data.bankAccountLast4,
      ifsc: data.ifsc,
      bankVerified: true,
      status: "ACTIVE",
      plotBrokerId: data.plotBrokerId || null,
    },
  });
}

async function ensureOwnership(plot, owner) {
  return prisma.plotOwnership.upsert({
    where: { tenantId_plotSiteId_payoutPartnerId: { tenantId: TENANT_ID, plotSiteId: plot.id, payoutPartnerId: owner.id } },
    create: { tenantId: TENANT_ID, plotSiteId: plot.id, payoutPartnerId: owner.id, ownershipBp: 10000, askedPricePaise: priceToPaise(plot.price, 0.8) },
    update: { ownershipBp: 10000, askedPricePaise: priceToPaise(plot.price, 0.8) },
  });
}

async function ensureBooking({ plot, customer, broker, label }) {
  const bookingNumber = `BOOK-LOCAL-${label}-${plot.id}-${customer.id}`;
  const existing = await prisma.plotBooking.findUnique({ where: { bookingNumber } });
  const linkedExisting = existing || await prisma.plotBooking.findFirst({
    where: { tenantId: TENANT_ID, plotSiteId: plot.id, contactId: customer.id, status: { not: "CANCELLED" } },
    orderBy: { updatedAt: "desc" },
  });
  if (linkedExisting) {
    if (!linkedExisting.plotBrokerId) return prisma.plotBooking.update({ where: { id: linkedExisting.id }, data: { plotBrokerId: broker.id } });
    return linkedExisting;
  }
  if (String(plot.availability || "").toUpperCase() !== "AVAILABLE") throw new Error(`Plot ${plot.name} ${plot.plotNumber || plot.id} is not available for the ${label} demo booking`);
  return prisma.$transaction(async (tx) => {
    await tx.plotSite.update({ where: { id: plot.id }, data: { availability: "RESERVED" } });
    const booking = await tx.plotBooking.create({
      data: {
        bookingNumber,
        tenantId: TENANT_ID,
        contactId: customer.id,
        plotSiteId: plot.id,
        plotBrokerId: broker.id,
        status: "PLOT_ASSIGNED",
        paymentStatus: "UNPAID",
        totalAmount: plot.price || 0,
        amountPaid: 0,
        balance: plot.price || 0,
      },
    });
    await tx.plotWorkflowEvent.create({
      data: {
        tenantId: TENANT_ID,
        plotBookingId: booking.id,
        contactId: customer.id,
        plotSiteId: plot.id,
        stage: "PLOT",
        eventType: "PLOT_ASSIGNED",
        label: `Local ${label} payout demo booking assigned`,
        fromStatus: "AVAILABLE",
        toStatus: "PLOT_ASSIGNED",
        metadataJson: JSON.stringify({ createdFrom: "local-payout-demo", linkedExistingCustomer: true, linkedExistingPlot: true }),
      },
    });
    return booking;
  });
}

async function main() {
  assertLocalOnly();

  const customer = await findExistingCustomer();
  const secondCustomer = await findExistingCustomer(customer.id).catch(() => customer);
  const [automaticPlot, customPlot] = await Promise.all([
    prisma.plotSite.findFirst({ where: { tenantId: TENANT_ID, isActive: true, plotNumber: "F-601" } }),
    prisma.plotSite.findFirst({ where: { tenantId: TENANT_ID, isActive: true, plotNumber: "F-602" } }),
  ]);
  if (!automaticPlot || !customPlot) throw new Error("Expected local demo plots F-601 and F-602 were not found");

  const existingBroker = await prisma.plotBroker.findFirst({ where: { tenantId: TENANT_ID, name: BROKER_NAME } });
  const broker = existingBroker || await prisma.plotBroker.create({
    data: { tenantId: TENANT_ID, name: BROKER_NAME, phone: "9000000002", email: "broker.qa@example.test", agency: "Local payout QA", commissionPercent: 1, plotSiteId: automaticPlot.id, isActive: true },
  });
  const owner = await ensurePartner({ name: OWNER_NAME, partnerType: "OWNER", mobile: "9000000001", email: "owner.qa@example.test", bankAccountLast4: "1234", ifsc: "HDFC0001234" });
  const channelPartner = await ensurePartner({ name: CHANNEL_PARTNER_NAME, partnerType: "CHANNEL_PARTNER", mobile: "9000000003", email: "channel.qa@example.test", bankAccountLast4: "5678", ifsc: "ICIC0005678" });
  const brokerPartner = await ensurePartner({ name: BROKER_NAME, partnerType: "BROKER", mobile: "9000000002", email: "broker.qa@example.test", bankAccountLast4: "9012", ifsc: "SBIN0009012", plotBrokerId: broker.id });

  await ensureOwnership(automaticPlot, owner);
  await ensureOwnership(customPlot, owner);
  const automaticBooking = await ensureBooking({ plot: automaticPlot, customer, broker, label: "AUTO" });
  const customBooking = await ensureBooking({ plot: customPlot, customer: secondCustomer, broker, label: "CUSTOM" });

  const brokerRule = await prisma.payoutCommissionRule.findFirst({ where: { tenantId: TENANT_ID, payoutPartnerId: brokerPartner.id, plotSiteId: automaticPlot.id } });
  await prisma.payoutCommissionRule.upsert({
    where: { id: brokerRule?.id || -1 },
    create: { tenantId: TENANT_ID, payoutPartnerId: brokerPartner.id, plotSiteId: automaticPlot.id, ruleType: "PCT_FINAL", rateBp: 100, flatPaise: 0, paidFrom: "COMPANY_MARGIN" },
    update: { ruleType: "PCT_FINAL", rateBp: 100, flatPaise: 0, paidFrom: "COMPANY_MARGIN" },
  });
  const channelRule = await prisma.payoutCommissionRule.findFirst({ where: { tenantId: TENANT_ID, payoutPartnerId: channelPartner.id, plotSiteId: null } });
  await prisma.payoutCommissionRule.upsert({
    where: { id: channelRule?.id || -1 },
    create: { tenantId: TENANT_ID, payoutPartnerId: channelPartner.id, plotSiteId: null, ruleType: "PCT_FINAL", rateBp: 100, flatPaise: 0, paidFrom: "COMPANY_MARGIN" },
    update: { ruleType: "PCT_FINAL", rateBp: 100, flatPaise: 0, paidFrom: "COMPANY_MARGIN" },
  });
  await prisma.payoutSettings.upsert({
    where: { tenantId_scopeKey: { tenantId: TENANT_ID, scopeKey: "TENANT" } },
    create: { tenantId: TENANT_ID, scopeKey: "TENANT", pricingModel: "MARKUP", splitMethod: "PRO_RATA", cpCapBp: 500, allowCustomSplit: true, maxTotalCommissionBp: 1000, holdTrigger: "AGREEMENT_SIGNED", ownerRelease: "ON_VERIFY" },
    update: { cpCapBp: 500, allowCustomSplit: true, maxTotalCommissionBp: 1000, holdTrigger: "AGREEMENT_SIGNED", ownerRelease: "ON_VERIFY" },
  });

  console.log(JSON.stringify({
    tenantId: TENANT_ID,
    existingCustomer: customer,
    existingSecondCustomer: secondCustomer,
    owner: { id: owner.id, name: owner.name },
    channelPartner: { id: channelPartner.id, name: channelPartner.name },
    brokerPartner: { id: brokerPartner.id, name: brokerPartner.name },
    automaticBooking: { id: automaticBooking.id, bookingNumber: automaticBooking.bookingNumber, plot: `${automaticPlot.name} ${automaticPlot.plotNumber}`, customer: customer.name },
    customBooking: { id: customBooking.id, bookingNumber: customBooking.bookingNumber, plot: `${customPlot.name} ${customPlot.plotNumber}`, customer: secondCustomer.name },
    next: "Open /plot-payouts locally. Automatic booking includes the broker rule; custom booking is ready for custom recipient lines.",
  }, null, 2));
}

main().catch((error) => {
  console.error(`[seed-payout-demo] ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
