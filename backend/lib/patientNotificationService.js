// Patient-portal notification inbox service.
//
// Backs the wellness portal endpoints in routes/wellness.js
// (/portal/me/notifications*) and is the single producer/consumer surface for
// the PatientNotification table — patient-scoped, distinct from the staff
// Notification table (lib/notificationService.js / routes/notifications.js).
//
// Purely additive: nothing here touches staff notifications, so wiring a
// producer (createPatientNotification) into a wellness flow later cannot affect
// the existing staff notification bell.
const prisma = require("./prisma");

// Hard cap so a malicious/buggy ?limit can't ask for the whole table.
const MAX_LIMIT = 200;

/**
 * Create a notification for a patient. Safe to call from any wellness flow
 * (appointment booked, prescription ready, payment received, etc.).
 *
 * @param {object} args
 * @param {number} args.patientId
 * @param {number} args.tenantId
 * @param {string} args.title
 * @param {string} args.message
 * @param {string} [args.type='info']  info|appointment|prescription|payment|system
 * @param {string|null} [args.link]
 */
async function createPatientNotification({ patientId, tenantId, title, message, type = "info", link = null }) {
  if (!patientId || !tenantId) throw new Error("patientId and tenantId are required");
  if (!title || !message) throw new Error("title and message are required");
  return prisma.patientNotification.create({
    data: { patientId, tenantId, title, message, type, link: link || null },
  });
}

/**
 * List a patient's notifications (newest first) + the live unread count.
 * @returns {Promise<{ items: object[], unreadCount: number }>}
 */
async function listPatientNotifications(patientId, { limit = 50, unreadOnly = false } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_LIMIT);
  const where = { patientId };
  if (unreadOnly) where.isRead = false;
  const [items, unreadCount] = await Promise.all([
    prisma.patientNotification.findMany({ where, orderBy: { createdAt: "desc" }, take }),
    prisma.patientNotification.count({ where: { patientId, isRead: false } }),
  ]);
  return { items, unreadCount };
}

/**
 * Mark ONE notification read — scoped to patientId so a patient can never
 * touch another patient's row. Returns the updated row, or null when the id
 * doesn't belong to this patient (caller maps to 404).
 */
async function markPatientNotificationRead(patientId, id) {
  const existing = await prisma.patientNotification.findFirst({ where: { id, patientId } });
  if (!existing) return null;
  if (existing.isRead) return existing; // idempotent — already read
  return prisma.patientNotification.update({
    where: { id: existing.id },
    data: { isRead: true, readAt: new Date() },
  });
}

/**
 * Mark ALL of a patient's unread notifications read. Returns the count updated.
 */
async function markAllPatientNotificationsRead(patientId) {
  const r = await prisma.patientNotification.updateMany({
    where: { patientId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return r.count;
}

// Public projection — strips tenantId so the portal response keeps the same
// "no internal scoping fields" shape as /portal/me.
function toPublic(n) {
  if (!n) return n;
  const { tenantId: _t, ...rest } = n;
  return rest;
}

module.exports = {
  createPatientNotification,
  listPatientNotifications,
  markPatientNotificationRead,
  markAllPatientNotificationsRead,
  toPublic,
};
