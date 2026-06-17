// Travel customer-portal in-app notification inbox (2026-06-17). Contact-scoped
// — the travel customer is a Contact with a portal login — and SEPARATE from
// the staff Notification table (userId-scoped). Mirrors
// lib/patientNotificationService.js. Every producer is best-effort: emit calls
// are wrapped by callers so a notification failure never breaks the trip/
// payment flow that triggered it.

const prisma = require("./prisma");

const MAX_LIMIT = 200;

// Create one notification for a travel customer (Contact). Throws on bad input
// so a caller bug surfaces in dev; producers wrap this in try/catch so a real
// failure is non-fatal to the itinerary/payment flow.
async function createTravelPortalNotification({ contactId, tenantId, title, message, type = "info", link = null }) {
  if (!contactId || !tenantId) throw new Error("contactId and tenantId are required");
  if (!title || !message) throw new Error("title and message are required");
  return prisma.travelPortalNotification.create({
    data: { contactId, tenantId, title, message, type, link: link || null },
  });
}

// Best-effort wrapper used at emit sites (itinerary send/revise, payment) — logs
// and swallows any error so the triggering request never fails on a notify hiccup.
async function safeNotifyTravelCustomer(args) {
  try {
    if (!args || !args.contactId) return null;
    return await createTravelPortalNotification(args);
  } catch (e) {
    console.error(`[travelPortalNotification] emit failed (non-fatal): ${e.message}`);
    return null;
  }
}

// List a customer's notifications (newest first) + the live unread count.
async function listTravelPortalNotifications(contactId, { limit = 50, unreadOnly = false } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_LIMIT);
  const where = { contactId };
  if (unreadOnly) where.isRead = false;
  const [items, unreadCount] = await Promise.all([
    prisma.travelPortalNotification.findMany({ where, orderBy: { createdAt: "desc" }, take }),
    prisma.travelPortalNotification.count({ where: { contactId, isRead: false } }),
  ]);
  return { items, unreadCount };
}

// Mark ONE read — scoped to contactId so a customer can never touch another
// customer's row. Returns the updated row, or null when the id isn't theirs.
async function markTravelPortalNotificationRead(contactId, id) {
  const existing = await prisma.travelPortalNotification.findFirst({ where: { id, contactId } });
  if (!existing) return null;
  if (existing.isRead) return existing; // idempotent
  return prisma.travelPortalNotification.update({
    where: { id: existing.id },
    data: { isRead: true, readAt: new Date() },
  });
}

// Mark ALL of a customer's unread notifications read. Returns the count updated.
async function markAllTravelPortalNotificationsRead(contactId) {
  const r = await prisma.travelPortalNotification.updateMany({
    where: { contactId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return r.count;
}

// Public projection — strip the internal tenantId.
function toPublic(n) {
  if (!n) return n;
  const { tenantId: _t, ...rest } = n;
  return rest;
}

module.exports = {
  createTravelPortalNotification,
  safeNotifyTravelCustomer,
  listTravelPortalNotifications,
  markTravelPortalNotificationRead,
  markAllTravelPortalNotificationsRead,
  toPublic,
};
