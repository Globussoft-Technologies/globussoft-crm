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
 * Turn a raw Callified failure into something an operator can act on.
 *
 * Callified answers a dial it cannot place with a plain-text reason wrapped in
 * an HTTP error, which reaches us as
 * `Callified API error 502: {"error":"no Exotel credentials configured …"}`.
 * Shown as-is that is noise: it names an internal vendor concept, buries the
 * reason in a status line, and never says who fixes it.
 *
 * The strings matched here are the literal errors raised in Callified's
 * `internal/dial/initiator.go` — the calling-provider setup failures (Exotel /
 * Tata Tele credentials, inbound-only numbers, non-voicebot accounts) plus the
 * three operational refusals that have their own status codes (credits, DND,
 * TRAI calling hours).
 *
 * Returns null when nothing matches, so an unrecognised failure falls through
 * to the caller's generic fallback rather than being mislabelled.
 *
 * @param {string} raw
 * @returns {{error: string, code: string} | null}
 */
function friendlyProviderMessage(raw) {
  const text = String(raw || '').toLowerCase();
  if (!text) return null;

  // ── Calling provider not set up ──────────────────────────────────────
  if (
    text.includes('no exotel credentials configured') ||
    text.includes('provider account not found') ||
    text.includes('no provider account')
  ) {
    return {
      error:
        'Calling is not set up yet. Ask your administrator to connect a calling provider (Exotel or Tata Tele) to this campaign in Callified before placing calls.',
      code: 'CALLING_PROVIDER_NOT_CONFIGURED',
    };
  }
  if (text.includes('inbound-only')) {
    return {
      error:
        'The calling number on this campaign can only receive calls, not make them. Ask your administrator to switch it to an outbound account in Callified.',
      code: 'CALLING_PROVIDER_INBOUND_ONLY',
    };
  }
  if (text.includes('voicebot')) {
    return {
      error:
        "This campaign's calling account does not support browser calls. Ask your administrator to use a voicebot-enabled account in Callified.",
      code: 'CALLING_PROVIDER_NOT_VOICEBOT',
    };
  }
  if (text.includes('twilio provider is disabled')) {
    return {
      error:
        'Twilio calling is disabled. Ask your administrator to select Exotel or Tata Tele for this campaign in Callified.',
      code: 'CALLING_PROVIDER_DISABLED',
    };
  }

  // ── Operational refusals — nothing to configure, just can't call now ──
  if (text.includes('insufficient credits')) {
    return {
      error: 'Calling credits have run out. Top up in Callified to continue making calls.',
      code: 'CALLING_NO_CREDITS',
    };
  }
  if (text.includes('dnd')) {
    return {
      error:
        'This customer is on the Do Not Disturb registry and cannot be called.',
      code: 'CALLING_LEAD_ON_DND',
    };
  }
  if (text.includes('calling hours')) {
    return {
      error:
        'Calls can only be placed between 9 AM and 9 PM under TRAI rules. Please try again during calling hours.',
      code: 'CALLING_OUTSIDE_HOURS',
    };
  }

  return null;
}

/**
 * Plain-language copy for an upstream HTTP status, with no vendor detail.
 *
 * Callified sits behind Cloudflare. When its origin is unreachable the body is
 * a Cloudflare error document — `{"type":"https://developers.cloudflare.com/…",
 * "detail":"The origin web server returned an invalid…","zone":
 * "testgo1.callified.ai","cloudflare_error":true,…}` — which is meaningless to
 * a receptionist and leaks the vendor's infrastructure into our UI. The status
 * code carries everything a user needs to decide what to do.
 *
 * @param {number} status
 * @returns {{error: string, code: string}}
 */
function friendlyUpstreamMessage(status) {
  if (status === 502 || status === 503 || status === 504) {
    return {
      error:
        'The calling service is temporarily unreachable. Please try again in a minute — if it keeps happening, contact support.',
      code: 'CALLING_SERVICE_UNAVAILABLE',
    };
  }
  if (status === 429) {
    return {
      error: 'The calling service is busy right now. Please wait a moment and try again.',
      code: 'CALLING_SERVICE_BUSY',
    };
  }
  if (status === 401 || status === 403) {
    return {
      error:
        'Calling could not authenticate with Callified. Ask your administrator to check the API key in Settings → Integrations.',
      code: 'CALLIFIED_AUTH_FAILED',
    };
  }
  if (status === 404) {
    return {
      error: 'Callified no longer has a record for this call or customer.',
      code: 'CALLIFIED_RECORD_NOT_FOUND',
    };
  }
  if (status >= 500) {
    return {
      error: 'The calling service ran into a problem. Please try again shortly.',
      code: 'CALLING_SERVICE_ERROR',
    };
  }
  return {
    error: 'The calling service rejected this request. Please try again, or contact support.',
    code: 'CALLING_REQUEST_REJECTED',
  };
}

/**
 * A gateway failure at Callified is not OUR client's fault, so it surfaces as
 * 503 (try again) rather than echoing their 502.
 */
function mappedStatusFor(status) {
  if (status === 502 || status === 504) return 503;
  return status;
}

/**
 * Translate a callifiedClient error into an HTTP status + response body.
 *
 * @param {Error & {code?: string, status?: number, spentCents?: number, capCents?: number}} e
 * @param {string} [fallbackMessage]
 * @returns {{status: number, body: object}}
 */
function mapCallifiedError(e, fallbackMessage = 'Callified request failed') {
  if (!e) return { status: 500, body: { error: fallbackMessage, code: 'INTERNAL_ERROR' } };

  // Checked FIRST: a provider-setup failure is the single most common reason a
  // call will not place, and Callified reports it as a generic 502 whose only
  // signal is the message text. Left unmatched it would surface as
  // "Callified API error 502: {...}" and nobody would know to go configure
  // Exotel / Tata Tele.
  const friendly = friendlyProviderMessage(e.message);
  if (friendly) {
    // 503 for "not set up" — the request is fine and will work once someone
    // configures it. 409 for the operational refusals, which no amount of
    // configuration changes right now.
    const operational = ['CALLING_LEAD_ON_DND', 'CALLING_OUTSIDE_HOURS'].includes(friendly.code);
    const noCredits = friendly.code === 'CALLING_NO_CREDITS';
    return {
      status: noCredits ? 402 : operational ? 409 : 503,
      body: friendly,
    };
  }

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
  // Our own side of the setup: no API key stored, or the stored one is dead.
  // The service-layer text names API keys and Settings, which is right for a
  // developer but not for the receptionist who clicked Call.
  if (e.code === 'CALLIFIED_NOT_CONFIGURED') {
    return {
      status: 503,
      body: {
        error:
          'Calling is not connected for this clinic yet. Ask your administrator to add the Callified API key in Settings → Integrations.',
        code: e.code,
      },
    };
  }
  if (e.code === 'CALLIFIED_AUTH_FAILED') {
    return {
      status: 503,
      body: {
        error:
          'Calling could not sign in to Callified — the saved API key looks invalid or expired. Ask your administrator to update it in Settings → Integrations.',
        code: e.code,
      },
    };
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
    // NEVER pass the upstream body through. `callifiedJson` throws
    // `Callified API error <status>: <raw body>`, and when Callified's origin
    // is down Cloudflare answers with a wall of JSON — type/status/detail/
    // instance/zone/cloudflare_error — which was being rendered verbatim in
    // the call dialog. The status alone is enough to say something useful.
    return { status: mappedStatusFor(e.status), body: friendlyUpstreamMessage(e.status) };
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

module.exports = {
  mapCallifiedError,
  sendCallifiedError,
  friendlyProviderMessage,
  friendlyUpstreamMessage,
};
