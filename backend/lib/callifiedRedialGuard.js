/**
 * Redial cooldown for Callified outbound calls.
 *
 * Outbound calls cost real money and reach real customers, so a double-click
 * (or two operators working the same list) must not fire two calls at the
 * same person. The frontend disables its buttons while a call is in flight;
 * this is the server-side backstop that makes the guarantee real.
 *
 * The window is measured against CRM CallLog rows rather than any Callified
 * state, so it holds for both call modes — AI dial and browser/agent bridge.
 *
 * Promoted out of routes/callified.js when the wellness Appointments calling
 * surface became the second consumer.
 */

const prisma = require('./prisma');

const REDIAL_COOLDOWN_MS =
  Number(process.env.CALLIFIED_REDIAL_COOLDOWN_MS) || 60 * 1000;

/**
 * @param {number} tenantId
 * @param {number|string} contactId
 * @param {number} [sinceMs]
 * @returns {Promise<Date|null>} the timestamp of the recent call, or null
 */
async function wasRecentlyDialed(tenantId, contactId, sinceMs = REDIAL_COOLDOWN_MS) {
  const since = new Date(Date.now() - sinceMs);
  const recent = await prisma.callLog.findFirst({
    where: {
      tenantId,
      contactId: Number(contactId),
      provider: 'callified',
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  });
  return recent ? recent.createdAt : null;
}

/**
 * Build the canonical 429 body for a cooldown rejection.
 *
 * @param {Date} recentDial
 * @param {number} [cooldownMs]
 */
function redialCooldownError(recentDial, cooldownMs = REDIAL_COOLDOWN_MS) {
  return {
    error: `This customer was called recently at ${recentDial.toISOString()}. Please wait before calling again.`,
    code: 'CALLIFIED_REDIAL_COOLDOWN',
    redialAfter: new Date(recentDial.getTime() + cooldownMs).toISOString(),
  };
}

module.exports = { REDIAL_COOLDOWN_MS, wasRecentlyDialed, redialCooldownError };
