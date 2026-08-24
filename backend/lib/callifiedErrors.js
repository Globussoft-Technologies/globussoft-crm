/**
 * Shared HTTP error mapping for Callified route handlers.
 *
 * The Callified service layer throws errors carrying stable `code` values
 * (AI_CALLING_DISABLED, CALLIFIED_NOT_CONFIGURED, MISSING_PHONE, …). Every
 * route that fronts the integration has to turn those into the canonical
 * `{error, code}` envelope with the right status. This module holds that
 * mapping once so the generic-CRM routes and the wellness routes cannot
 * drift apart in what they report for the same failure.
 */

/**
 * Translate a callifiedClient error into an HTTP status + response body.
 *
 * @param {Error & {code?: string, status?: number, spentCents?: number, capCents?: number}} e
 * @param {string} [fallbackMessage]
 * @returns {{status: number, body: object}}
 */
function mapCallifiedError(e, fallbackMessage = 'Callified request failed') {
  if (!e) return { status: 500, body: { error: fallbackMessage, code: 'INTERNAL_ERROR' } };

  if (e.code === 'AI_CALLING_BUDGET_EXCEEDED') {
    return {
      status: 402,
      body: {
        error: e.message,
        code: 'AI_CALLING_BUDGET_EXCEEDED',
        spentCents: e.spentCents,
        capCents: e.capCents,
      },
    };
  }
  if (e.code === 'AI_CALLING_DISABLED') {
    return { status: 403, body: { error: e.message, code: 'AI_CALLING_DISABLED' } };
  }
  if (e.code === 'CALLIFIED_NOT_CONFIGURED' || e.code === 'CALLIFIED_AUTH_FAILED') {
    return { status: 503, body: { error: e.message, code: e.code } };
  }
  if (
    e.code === 'MISSING_PHONE' ||
    e.code === 'INVALID_PHONE' ||
    e.code === 'CONTACT_NOT_FOUND'
  ) {
    return { status: e.status || 400, body: { error: e.message, code: e.code } };
  }
  if (e.code === 'CALLIFIED_MISSING_LEAD_ID' || e.code === 'CALLIFIED_MISSING_CALL_SID') {
    return { status: 502, body: { error: e.message, code: e.code } };
  }
  if (e.status) {
    return { status: e.status, body: { error: e.message, code: e.code || `HTTP_${e.status}` } };
  }
  return { status: 500, body: { error: fallbackMessage, code: 'CALLIFIED_ERROR' } };
}

/**
 * Express convenience wrapper around mapCallifiedError.
 *
 * @param {import('express').Response} res
 * @param {Error} e
 * @param {string} logPrefix  e.g. "[callified] leads/:id/browser-call"
 * @param {string} fallbackMessage
 */
function sendCallifiedError(res, e, logPrefix, fallbackMessage) {
  const { status, body } = mapCallifiedError(e, fallbackMessage);
  if (status >= 500) {
    console.error(`${logPrefix} error:`, e && e.message);
  }
  return res.status(status).json(body);
}

module.exports = { mapCallifiedError, sendCallifiedError };
