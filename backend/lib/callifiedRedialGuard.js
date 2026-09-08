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

/** "45 seconds" / "2 minutes" — how long is left, in words a person reads. */
function describeWait(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Build the canonical 429 body for a cooldown rejection.
 *
 * The message says how long is LEFT rather than printing an ISO timestamp of
 * the previous call — an operator staring at a dialog wants to know whether to
 * wait or move on, not to do date arithmetic. `redialAfter` keeps the precise
 * machine-readable instant for any caller that wants to schedule against it.
 *
 * @param {Date} recentDial
 * @param {number} [cooldownMs]
 */
function redialCooldownError(recentDial, cooldownMs = REDIAL_COOLDOWN_MS) {
  const readyAt = new Date(recentDial.getTime() + cooldownMs);
  const remainingMs = readyAt.getTime() - Date.now();

  return {
    error:
      remainingMs > 0
        ? `This customer was called moments ago. You can call again in ${describeWait(remainingMs)}.`
        : 'This customer was called moments ago. Please try again.',
    code: 'CALLIFIED_REDIAL_COOLDOWN',
    redialAfter: readyAt.toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
  };
}

module.exports = {
  REDIAL_COOLDOWN_MS,
  wasRecentlyDialed,
  redialCooldownError,
  describeWait,
};
