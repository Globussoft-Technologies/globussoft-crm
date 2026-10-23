const crypto = require("crypto");
const prisma = require("./prisma");
const { decryptCredential } = require("./credentialMasking");
const { sanitizeJsonForStringColumn } = require("./sanitizeJson");
const provider = require("../services/whatsappProvider");

const PAGE_SIZE = 9; // Meta permits at most 10 rows; reserve one for "More".
const SOURCE = "Selected by customer in WhatsApp chat";

function parseStoredIds(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function truncate(value, max) {
  const text = String(value || "").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function inboundChoice(message) {
  return message?.interactive?.list_reply?.id
    || message?.interactive?.button_reply?.id
    || null;
}

function parseAction(message) {
  const choice = inboundChoice(message);
  if (choice === "pickup_plot:start") return { type: "plots", page: 0 };

  let match = /^pickup_plot:plots:(\d+)$/.exec(choice || "");
  if (match) return { type: "plots", page: Number(match[1]) };
  match = /^pickup_plot:plot:(\d+)$/.exec(choice || "");
  if (match) return { type: "plot", plotId: Number(match[1]) };
  match = /^pickup_plot:pickups:(\d+):(\d+)$/.exec(choice || "");
  if (match) return { type: "pickups", plotId: Number(match[1]), page: Number(match[2]) };
  match = /^pickup_plot:pickup:(\d+):(\d+)$/.exec(choice || "");
  if (match) return { type: "pickup", plotId: Number(match[1]), pickupLocationId: Number(match[2]) };

  return null;
}

function plotPickupIds(plot) {
  const ids = parseStoredIds(plot?.pickupLocationIdsJson);
  if (ids.length === 0 && Number.isInteger(Number(plot?.pickupLocationId))) {
    ids.push(Number(plot.pickupLocationId));
  }
  return [...new Set(ids)];
}

async function resolveContext({ tenantId, from, contactId, threadId, db }) {
  const [tenant, config] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } }),
    db.whatsAppConfig.findFirst({ where: { tenantId, isActive: true } }),
  ]);
  if (tenant?.vertical !== "generic") return { skip: "GENERIC_ONLY" };
  if (!config?.accessToken || !config?.phoneNumberId) return { skip: "WHATSAPP_NOT_CONFIGURED" };

  let contact = contactId
    ? await db.contact.findFirst({ where: { id: Number(contactId), tenantId, deletedAt: null }, select: { id: true, name: true } })
    : null;
  if (!contact) {
    const digits = String(from || "").replace(/\D/g, "");
    if (digits.length >= 7) {
      contact = await db.contact.findFirst({
        where: {
          tenantId,
          deletedAt: null,
          OR: [{ phone: { contains: digits.slice(-10) } }, { whatsappPhone: { contains: digits.slice(-10) } }],
        },
        select: { id: true, name: true },
      });
    }
  }
  return { tenantId, from, threadId, contact, config };
}

async function persistReply({ context, body, metaType, interactive, result, db }) {
  await db.whatsAppMessage.create({
    data: {
      to: context.from,
      from: context.config.phoneNumberId,
      body,
      direction: "OUTBOUND",
      status: result.success ? "SENT" : "FAILED",
      providerMsgId: result.providerMsgId || null,
      errorMessage: result.error || null,
      metaType,
      interactiveJson: interactive ? sanitizeJsonForStringColumn(interactive) : null,
      contactId: context.contact?.id || null,
      tenantId: context.tenantId,
      threadId: context.threadId || null,
    },
  });
  if (context.threadId) {
    await db.whatsAppThread.update({ where: { id: context.threadId }, data: { lastMessageAt: new Date() } }).catch(() => {});
  }
  return result;
}

async function sendTextReply(context, body, db) {
  const result = await provider.sendText({
    to: context.from,
    body,
    phoneNumberId: context.config.phoneNumberId,
    accessToken: decryptCredential(context.config.accessToken),
  });
  return persistReply({ context, body, metaType: "text", interactive: null, result, db });
}

async function sendListReply(context, { body, button, rows, footer }, db) {
  const action = { button, sections: [{ title: "Available options", rows }] };
  const interactive = { type: "list", body: { text: body }, action, ...(footer ? { footer: { text: footer } } : {}) };
  const result = await provider.sendInteractive({
    to: context.from,
    type: "list",
    body,
    footer,
    action,
    phoneNumberId: context.config.phoneNumberId,
    accessToken: decryptCredential(context.config.accessToken),
  });
  return persistReply({ context, body, metaType: "interactive", interactive, result, db });
}

function paginatedRows(items, page, rowMapper, nextId) {
  const safePage = Number.isInteger(page) && page >= 0 ? page : 0;
  const start = safePage * PAGE_SIZE;
  const rows = items.slice(start, start + PAGE_SIZE).map(rowMapper);
  if (start + PAGE_SIZE < items.length) {
    rows.push({ id: nextId(safePage + 1), title: "More options", description: "Show the next available choices" });
  }
  return rows;
}

async function sendPlots(context, page, db) {
  const plots = await db.plotSite.findMany({
    where: { tenantId: context.tenantId, isActive: true, availability: "AVAILABLE", plotNumber: { not: null } },
    orderBy: [{ name: "asc" }, { plotNumber: "asc" }],
    select: {
      id: true, name: true, plotNumber: true, block: true, address: true,
      pickupLocationId: true, pickupLocationIdsJson: true,
    },
  });
  if (plots.length === 0) return sendTextReply(context, "No plots are currently available. Our team will contact you shortly.", db);
  const rows = paginatedRows(
    plots,
    page,
    (plot) => ({
      id: `pickup_plot:plot:${plot.id}`,
      title: truncate(`Plot ${plot.plotNumber}`, 24),
      description: truncate([plot.name, plot.block ? `Block ${plot.block}` : null, plot.address].filter(Boolean).join(" · "), 72),
    }),
    (nextPage) => `pickup_plot:plots:${nextPage}`,
  );
  return sendListReply(context, {
    body: `Hi ${context.contact?.name || "there"}, please select an available plot.`,
    button: "View plots",
    rows,
    footer: "Select one plot to continue.",
  }, db);
}

async function sendPickups(context, plotId, page, db) {
  const plot = await db.plotSite.findFirst({
    where: { id: plotId, tenantId: context.tenantId, isActive: true, availability: "AVAILABLE" },
    select: { id: true, name: true, plotNumber: true, pickupLocationId: true, pickupLocationIdsJson: true },
  });
  if (!plot) return sendTextReply(context, "That plot is no longer available. Please ask our team to send the selection request again.", db);
  const locationIds = plotPickupIds(plot);
  if (locationIds.length === 0) {
    return sendTextReply(context, "No pickup location is assigned to that plot yet. Please contact our team to choose another plot.", db);
  }
  const locations = await db.pickupLocation.findMany({
    where: { tenantId: context.tenantId, id: { in: locationIds }, isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, address: true, googleMapsLink: true },
  });
  if (locations.length === 0) return sendTextReply(context, "The pickup points for that plot are currently unavailable. Please contact our team to choose another plot.", db);
  const rows = paginatedRows(
    locations,
    page,
    (location) => ({
      id: `pickup_plot:pickup:${plot.id}:${location.id}`,
      title: truncate(location.name, 24),
      description: truncate(location.address, 72),
    }),
    (nextPage) => `pickup_plot:pickups:${plot.id}:${nextPage}`,
  );
  return sendListReply(context, {
    body: `You selected Plot ${plot.plotNumber || plot.name}. Now select a pickup location available for this plot.`,
    button: "Pickup locations",
    rows,
  }, db);
}

async function saveSelection(context, plotId, pickupLocationId, db) {
  if (!context.contact) return sendTextReply(context, "We could not match this WhatsApp number to your enquiry. Please contact our team for help.", db);
  const [plot, pickupLocation] = await Promise.all([
    db.plotSite.findFirst({
      where: { id: plotId, tenantId: context.tenantId, isActive: true },
      select: { id: true, name: true, plotNumber: true, price: true, availability: true, pickupLocationId: true, pickupLocationIdsJson: true },
    }),
    db.pickupLocation.findFirst({
      where: { id: pickupLocationId, tenantId: context.tenantId, isActive: true },
      select: { id: true, name: true, address: true, googleMapsLink: true },
    }),
  ]);
  if (!plot || String(plot.availability).toUpperCase() !== "AVAILABLE") {
    return sendTextReply(context, "That plot is no longer available. Please ask our team to send the selection request again.", db);
  }
  if (!pickupLocation || !plotPickupIds(plot).includes(pickupLocation.id)) {
    return sendTextReply(context, "That pickup location is not available for the selected plot. Please ask our team to send the selection request again.", db);
  }

  let saved;
  try {
    saved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Contact WHERE id = ${context.contact.id} AND tenantId = ${context.tenantId} FOR UPDATE`;
      const completed = await tx.plotBooking.findFirst({
        where: { tenantId: context.tenantId, contactId: context.contact.id, status: { not: "CANCELLED" } },
        select: { id: true },
      });
      if (completed) {
        const error = new Error("Selection already completed");
        error.code = "SELECTION_ALREADY_COMPLETED";
        throw error;
      }
      await tx.contact.update({
        where: { id: context.contact.id },
        data: { interestedPlotArea: `${plot.name}${plot.plotNumber ? ` - Plot ${plot.plotNumber}` : ""}` },
      });
      const pickup = await tx.customerPickup.upsert({
        where: { tenantId_contactId: { tenantId: context.tenantId, contactId: context.contact.id } },
        create: { tenantId: context.tenantId, contactId: context.contact.id, pickupAddress: pickupLocation.address, sourceExcerpt: SOURCE },
        update: { pickupAddress: pickupLocation.address, sourceExcerpt: SOURCE },
      });
      const booking = await tx.plotBooking.create({
        data: {
          bookingNumber: `BOOK-${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
          tenantId: context.tenantId,
          contactId: context.contact.id,
          customerPickupId: pickup.id,
          plotSiteId: plot.id,
          status: "PLOT_ASSIGNED",
          paymentStatus: "UNPAID",
          totalAmount: Number(plot.price || 0),
          balance: Number(plot.price || 0),
        },
        select: { id: true },
      });
      return { pickup, booking };
    });
  } catch (error) {
    if (error?.code === "SELECTION_ALREADY_COMPLETED") {
      return sendTextReply(context, "Your plot and pickup selection has already been recorded. Our team will contact you with the next steps.", db);
    }
    throw error;
  }

  require("./eventBus").emitEvent("pickup_plot.selected", {
    contactId: context.contact.id,
    pickupPointId: saved.pickup.id,
    pickupLocationId,
    plotSiteId: plot.id,
    bookingId: saved.booking.id,
  }, context.tenantId).catch((error) => console.error("[pickup-plot WhatsApp] selection event failed:", error.message));

  const mapsLine = pickupLocation.googleMapsLink ? `\nMap: ${pickupLocation.googleMapsLink}` : "";
  return sendTextReply(
    context,
    `Thank you. Your selection is confirmed.\nPlot: ${plot.plotNumber ? `Plot ${plot.plotNumber} · ` : ""}${plot.name}\nPickup: ${pickupLocation.name} — ${pickupLocation.address}${mapsLine}`,
    db,
  );
}

async function shouldStartFromPreviousTemplate({ tenantId, threadId, db }) {
  if (!threadId) return false;
  const previous = await db.whatsAppMessage.findFirst({
    where: { tenantId, threadId, direction: "OUTBOUND" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { templateName: true, metaType: true, interactiveJson: true },
  });
  if (!previous?.templateName || !previous.interactiveJson) return false;
  try {
    const metadata = JSON.parse(previous.interactiveJson);
    return Boolean(
      metadata?.pickupPlotFlow === true
      && metadata?.sequenceKey
      && metadata?.sequenceEnrollmentId
      && metadata?.sequenceId,
    );
  } catch {
    return false;
  }
}

async function handleInboundPickupPlotFlow({ tenantId, from, contactId = null, threadId = null, message, db = prisma }) {
  let action = parseAction(message);
  if (!action && !await shouldStartFromPreviousTemplate({ tenantId, threadId, db })) return { handled: false };
  if (!action) action = { type: "plots", page: 0 };

  const context = await resolveContext({ tenantId, from, contactId, threadId, db });
  if (context.skip) return { handled: false, code: context.skip };

  if (action.type === "plots") await sendPlots(context, action.page, db);
  else if (action.type === "plot" || action.type === "pickups") await sendPickups(context, action.plotId, action.page || 0, db);
  else if (action.type === "pickup") await saveSelection(context, action.plotId, action.pickupLocationId, db);
  else return { handled: false };
  return { handled: true, action: action.type };
}

async function safeHandleInboundPickupPlotFlow(args) {
  try {
    return await handleInboundPickupPlotFlow(args);
  } catch (error) {
    console.error("[pickup-plot WhatsApp] flow failed:", error.message);
    return { handled: false, code: "FLOW_FAILED" };
  }
}

module.exports = {
  handleInboundPickupPlotFlow,
  safeHandleInboundPickupPlotFlow,
  _internal: { inboundChoice, parseAction, parseStoredIds, plotPickupIds, truncate },
};
