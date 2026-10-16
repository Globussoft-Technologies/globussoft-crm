const crypto = require("crypto");
const prisma = require("./prisma");
const { normalizeGenericWhatsAppThreadPhone } = require("./phoneFormatting");
const { upsertGenericWhatsAppThread } = require("./genericWebFormWhatsApp");

function parseStoredArray(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function assignmentPairs(person) {
  const stored = parseStoredArray(person?.assignmentPairsJson)
    .map((row) => ({ customerId: Number(row?.customerId), plotSiteId: Number(row?.plotSiteId) }))
    .filter((row) => Number.isInteger(row.customerId) && Number.isInteger(row.plotSiteId));
  if (stored.length > 0) return stored;
  const customerIds = parseStoredArray(person?.customerIdsJson).map(Number).filter(Number.isInteger);
  const plotIds = parseStoredArray(person?.plotSiteIdsJson).map(Number).filter(Number.isInteger);
  return customerIds.map((customerId, index) => ({
    customerId,
    plotSiteId: plotIds[index] || plotIds[0] || null,
  })).filter((row) => Number.isInteger(row.plotSiteId));
}

function pairKey(pair) {
  return `${pair.customerId}:${pair.plotSiteId}`;
}

async function resolveNewPairs({ tenantId, person, previousPerson, contactId, db }) {
  if (person) {
    const previousKeys = new Set(assignmentPairs(previousPerson).map(pairKey));
    return assignmentPairs(person).filter((pair) => !previousKeys.has(pairKey(pair)));
  }
  const people = await db.transportPerson.findMany({
    where: { tenantId, isActive: true },
    select: { customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true },
  });
  return people.flatMap(assignmentPairs).filter((pair) => pair.customerId === Number(contactId));
}

async function notifyCustomerPickupPlotAssignments({ tenantId, person = null, previousPerson = null, contactId = null, db = prisma }) {
  const pairs = [...new Map(
    (await resolveNewPairs({ tenantId, person, previousPerson, contactId, db }))
      .map((pair) => [pairKey(pair), pair]),
  ).values()];
  if (pairs.length === 0) return { sent: 0, code: "NO_NEW_ASSIGNMENTS" };

  const customerIds = [...new Set(pairs.map((pair) => pair.customerId))];
  const plotIds = [...new Set(pairs.map((pair) => pair.plotSiteId))];
  const [tenant, config, contacts, pickups, plots] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } }),
    db.whatsAppConfig.findFirst({ where: { tenantId, isActive: true }, select: { phoneNumberId: true } }),
    db.contact.findMany({
      where: { tenantId, id: { in: customerIds }, deletedAt: null },
      select: { id: true, name: true, phone: true, whatsappPhone: true },
    }),
    db.customerPickup.findMany({
      where: { tenantId, contactId: { in: customerIds } },
      select: { contactId: true, pickupAddress: true },
    }),
    db.plotSite.findMany({
      where: { tenantId, id: { in: plotIds } },
      select: { id: true, name: true, plotNumber: true, address: true },
    }),
  ]);
  if (tenant?.vertical !== "generic") return { sent: 0, code: "GENERIC_ONLY" };
  if (!config?.phoneNumberId) return { sent: 0, code: "WHATSAPP_NOT_CONFIGURED" };

  const contactMap = new Map(contacts.map((row) => [row.id, row]));
  const pickupMap = new Map(pickups.map((row) => [row.contactId, row]));
  const plotMap = new Map(plots.map((row) => [row.id, row]));
  let sent = 0;

  for (const pair of pairs) {
    const contact = contactMap.get(pair.customerId);
    const pickup = pickupMap.get(pair.customerId);
    const plot = plotMap.get(pair.plotSiteId);
    const recipient = normalizeGenericWhatsAppThreadPhone(contact?.whatsappPhone || contact?.phone);
    if (!contact || !pickup?.pickupAddress || !plot || !recipient) continue;

    const signature = crypto.createHash("sha256").update(JSON.stringify({
      contactId: contact.id,
      pickupAddress: pickup.pickupAddress,
      plotSiteId: plot.id,
    })).digest("hex");
    const duplicate = await db.whatsAppMessage.findFirst({
      where: {
        tenantId,
        contactId: contact.id,
        interactiveJson: { contains: `"assignmentSignature":"${signature}"` },
      },
      select: { id: true },
    });
    if (duplicate) continue;

    const plotLabel = plot.plotNumber ? `${plot.name} (${plot.plotNumber})` : plot.name;
    const body = [
      `Hi ${contact.name || "there"}, your pickup and plot have been assigned.`,
      `Pickup: ${pickup.pickupAddress}`,
      `Assigned plot: ${plotLabel}${plot.address ? ` - ${plot.address}` : ""}`,
      "Our team will contact you with the next steps.",
    ].join("\n");
    const thread = await upsertGenericWhatsAppThread({
      db,
      tenantId,
      phone: recipient,
      data: { contactName: contact.name || undefined, contactId: contact.id },
    });
    const message = await db.whatsAppMessage.create({
      data: {
        to: recipient.replace(/\D/g, ""),
        from: config.phoneNumberId,
        body,
        direction: "OUTBOUND",
        status: "QUEUED",
        contactId: contact.id,
        tenantId,
        threadId: thread.id,
        interactiveJson: JSON.stringify({
          source: "pickup_plot_assignment",
          contactId: contact.id,
          plotSiteId: plot.id,
          assignmentSignature: signature,
        }),
      },
    });
    await require("./whatsappQueue").getQueue().enqueueSend({ messageId: message.id, tenantId });
    sent += 1;
  }
  return { sent };
}

async function safeNotifyCustomerPickupPlotAssignments(args) {
  try {
    return await notifyCustomerPickupPlotAssignments(args);
  } catch (error) {
    console.error("[pickup-plot] customer WhatsApp assignment notification failed:", error.message);
    return { sent: 0, code: "WHATSAPP_SEND_FAILED" };
  }
}

module.exports = {
  assignmentPairs,
  notifyCustomerPickupPlotAssignments,
  safeNotifyCustomerPickupPlotAssignments,
};
