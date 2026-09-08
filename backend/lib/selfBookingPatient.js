/**
 * Self-booking Patient identity sync.
 *
 * A wellness customer who books their own appointment gets a `Patient` row
 * linked back to their `User` via `Patient.userId`. The customer never edits
 * that row directly — they edit their account on `/profile` — so the Patient
 * has to track the User, or the clinic sees stale details.
 *
 * WHY THIS MODULE EXISTS
 *   routes/wellness.js carried THREE byte-similar copies of this resolve-and-
 *   sync block (`resolveBookingPatient`, the book-and-pay path, and
 *   confirm-payment). All three synced `name` and `email` — and none synced
 *   `phone`. The result: a self-booked patient could never have a phone
 *   number, so the Patients list showed a blank, appointment reminders had
 *   nowhere to go, and the Callified Call action on Appointments was
 *   permanently disabled for exactly the customers who signed themselves up.
 *
 *   Rule-of-3 promotion: one implementation, phone included, so a future
 *   field can't be added to two of three copies again.
 *
 * PHONE IS NOT A UNIQUE KEY
 *   `(tenantId, normalizedPhone)` on Patient is a plain index, not a unique
 *   constraint (migration 202608211700). Several patients in one clinic may
 *   legitimately share a number — a couple, a parent booking for a child, one
 *   household landline — so this module writes both `phone` and
 *   `normalizedPhone` without any collision handling. There is nothing to
 *   collide with.
 */

const prisma = require('./prisma');
const { normalizePhone } = require('../utils/deduplication');

const activePatientWhere = (extra = {}) => ({
  ...extra,
  deletedAt: null,
});

async function loadSelfBookingUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true, phone: true, deactivatedAt: true },
  });

  if (!user || user.deactivatedAt) {
    return null;
  }

  return user;
}

/**
 * The identity fields a linked Patient mirrors from its User account.
 *
 * @param {{name?: string|null, email?: string|null, phone?: string|null}} user
 * @returns {{name: string, email: string|null, phone: string|null}}
 */
function desiredIdentityFromUser(user) {
  return {
    name: user?.name || user?.email || 'Patient',
    email: user?.email || null,
    phone: user?.phone || null,
  };
}

/**
 * Which of the mirrored fields actually differ, so an unchanged booking does
 * not write to the database on every request.
 */
function identityDrift(patient, desired) {
  const data = {};
  if (patient.name !== desired.name) data.name = desired.name;
  if (patient.email !== desired.email) data.email = desired.email;
  if ((patient.phone || null) !== desired.phone) {
    data.phone = desired.phone;
    // Kept in step with `phone` so the best-effort dedup lookups, the
    // reminder engines, and the Callified dialer all see the same number.
    data.normalizedPhone = desired.phone ? normalizePhone(desired.phone) : null;
  }
  return data;
}

/**
 * Find or create the Patient row belonging to a user, and keep its identity
 * fields in step with the account.
 *
 * @param {{userId: number, tenantId: number}} params
 * @returns {Promise<object>} the patient row
 */
async function resolveSelfBookingPatient({ userId, tenantId }) {
  const user = await loadSelfBookingUser(userId);
  if (!user) {
    const err = new Error('User not found');
    err.status = 401;
    throw err;
  }
  const desired = desiredIdentityFromUser(user);

  const existing = await prisma.patient.findFirst({
    where: activePatientWhere({ tenantId, userId }),
  });

  if (!existing) {
    return await prisma.patient.create({
      data: {
        name: desired.name,
        email: desired.email,
        phone: desired.phone,
        normalizedPhone: desired.phone ? normalizePhone(desired.phone) : null,
        source: 'self-booking',
        tenant: { connect: { id: tenantId } },
        user: { connect: { id: userId } },
      },
    });
  }

  const drift = identityDrift(existing, desired);
  if (Object.keys(drift).length === 0) return existing;
  return await prisma.patient.update({ where: { id: existing.id }, data: drift });
}

/**
 * Push a just-saved account change onto the caller's linked Patient row.
 *
 * Used by `PUT /api/auth/me` so a phone number typed on `/profile` reaches
 * the clinic immediately instead of waiting for the customer's next booking.
 * Returns null when the user has no linked Patient (staff, or a customer who
 * has never booked).
 *
 * @param {{userId: number, tenantId: number}} params
 * @returns {Promise<object|null>}
 */
async function syncPatientFromUser({ userId, tenantId }) {
  const user = await loadSelfBookingUser(userId);
  if (!user) return null;

  const existing = await prisma.patient.findFirst({
    where: activePatientWhere({ tenantId, userId }),
    select: { id: true, name: true, email: true, phone: true },
  });
  if (!existing) return null;

  const drift = identityDrift(existing, desiredIdentityFromUser(user));
  if (Object.keys(drift).length === 0) return existing;
  return await prisma.patient.update({ where: { id: existing.id }, data: drift });
}

module.exports = {
  resolveSelfBookingPatient,
  syncPatientFromUser,
  loadSelfBookingUser,
  desiredIdentityFromUser,
  identityDrift,
};
