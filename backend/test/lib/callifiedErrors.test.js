// @ts-check
/**
 * Tests for backend/lib/callifiedErrors.js.
 *
 * The generic-CRM routes and the wellness routes both front the same
 * Callified service layer. This module is what stops them drifting on what
 * status/code they report for the same failure, so the mapping is pinned
 * here rather than re-asserted in every route spec.
 */

import { describe, test, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  mapCallifiedError,
  sendCallifiedError,
  friendlyProviderMessage,
} = requireCJS('../../lib/callifiedErrors');

function err(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

describe('mapCallifiedError', () => {
  test('budget exhaustion is 402 and carries the spend figures', () => {
    const { status, body } = mapCallifiedError(
      err('cap reached', { code: 'AI_CALLING_BUDGET_EXCEEDED', spentCents: 12000, capCents: 10000 }),
    );
    expect(status).toBe(402);
    expect(body).toMatchObject({
      code: 'AI_CALLING_BUDGET_EXCEEDED',
      spentCents: 12000,
      capCents: 10000,
    });
  });

  test('a disabled tenant is 403, not 500', () => {
    const { status, body } = mapCallifiedError(err('off', { code: 'AI_CALLING_DISABLED' }));
    expect(status).toBe(403);
    expect(body.code).toBe('AI_CALLING_DISABLED');
  });

  test('missing credentials are 503 — the caller can retry after setup', () => {
    for (const code of ['CALLIFIED_NOT_CONFIGURED', 'CALLIFIED_AUTH_FAILED']) {
      expect(mapCallifiedError(err('nope', { code })).status).toBe(503);
    }
  });

  test('bad customer data is a 4xx the operator can act on', () => {
    for (const code of ['MISSING_PHONE', 'INVALID_PHONE', 'CONTACT_NOT_FOUND']) {
      const { status, body } = mapCallifiedError(err('bad', { code }));
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(body.code).toBe(code);
    }
  });

  test('an upstream status is translated, never echoed raw', () => {
    const { status, body } = mapCallifiedError(err('gone', { status: 404, code: 'CALLIFIED_API_404' }));
    expect(status).toBe(404);
    // The user gets prose, not the vendor's status-code vocabulary.
    expect(body.code).toBe('CALLIFIED_RECORD_NOT_FOUND');
    expect(body.error).not.toMatch(/404/);
  });

  test('a malformed Callified response is 502 — upstream is at fault, not us', () => {
    expect(mapCallifiedError(err('no sid', { code: 'CALLIFIED_MISSING_CALL_SID' })).status).toBe(502);
    expect(mapCallifiedError(err('no lead', { code: 'CALLIFIED_MISSING_LEAD_ID' })).status).toBe(502);
  });

  test('an unrecognised error surfaces the caller fallback, never the raw message', () => {
    const { status, body } = mapCallifiedError(
      err('Prisma: column `secret_token` does not exist'),
      'Failed to start the call',
    );
    expect(status).toBe(500);
    expect(body.error).toBe('Failed to start the call');
    expect(body.error).not.toContain('secret_token');
  });
});

describe('sendCallifiedError', () => {
  function makeRes() {
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
    return res;
  }

  test('writes the mapped status + body onto the response', () => {
    const res = makeRes();
    sendCallifiedError(res, err('off', { code: 'AI_CALLING_DISABLED' }), '[t]', 'fallback');
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('AI_CALLING_DISABLED');
  });

  test('logs only for 5xx — a 403 is expected traffic, not an incident', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendCallifiedError(makeRes(), err('off', { code: 'AI_CALLING_DISABLED' }), '[t]', 'fallback');
    expect(spy).not.toHaveBeenCalled();
    sendCallifiedError(makeRes(), err('boom'), '[t]', 'fallback');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

/**
 * Calling-provider setup failures.
 *
 * Callified reports "this call cannot be placed because nobody configured a
 * calling provider" as a generic HTTP 502 whose only signal is the message
 * text — it reaches us as
 * `Callified API error 502: {"error":"no Exotel credentials configured …"}`.
 *
 * Shown raw that tells the receptionist who clicked Call nothing useful. The
 * strings asserted below are the LITERAL errors raised in Callified's
 * internal/dial/initiator.go, so these tests pin our translation against
 * their real vocabulary rather than an invented one.
 */
describe('friendlyProviderMessage', () => {
  const CASES = [
    ['no Exotel credentials configured for this campaign', 'CALLING_PROVIDER_NOT_CONFIGURED'],
    ['provider account not found or inaccessible', 'CALLING_PROVIDER_NOT_CONFIGURED'],
    ['selected provider account is inbound-only; choose an outbound account', 'CALLING_PROVIDER_INBOUND_ONLY'],
    ['campaign provider account is inbound-only; choose an outbound account', 'CALLING_PROVIDER_INBOUND_ONLY'],
    ['selected provider account is not a voicebot account; browser calls require app_type=voicebot', 'CALLING_PROVIDER_NOT_VOICEBOT'],
    ['Twilio provider is disabled; choose Exotel or Tata Tele', 'CALLING_PROVIDER_DISABLED'],
    ['insufficient credits — please recharge to continue making calls', 'CALLING_NO_CREDITS'],
    ['lead is on DND list', 'CALLING_LEAD_ON_DND'],
    ['outside TRAI calling hours (9 AM – 9 PM)', 'CALLING_OUTSIDE_HOURS'],
  ];

  for (const [raw, code] of CASES) {
    test(`"${raw.slice(0, 46)}…" -> ${code}`, () => {
      const result = friendlyProviderMessage(raw);
      expect(result).not.toBeNull();
      expect(result.code).toBe(code);
      expect(result.error.length).toBeGreaterThan(20);
    });
  }

  test('matches even when wrapped in our HTTP error envelope', () => {
    // This is the shape callifiedJson actually throws.
    const wrapped =
      'Callified API error 502: {"error":"no Exotel credentials configured for this campaign"}';
    expect(friendlyProviderMessage(wrapped)?.code).toBe('CALLING_PROVIDER_NOT_CONFIGURED');
  });

  test('the setup messages say WHO fixes it and WHERE', () => {
    const setup = friendlyProviderMessage('no Exotel credentials configured for this campaign');
    expect(setup.error).toMatch(/administrator/i);
    expect(setup.error).toMatch(/Exotel|Tata/i);
    // Never leak the vendor's internal phrasing to an end user.
    expect(setup.error).not.toMatch(/502|credentials configured for this campaign/i);
  });

  test('returns null for anything unrecognised so it is not mislabelled', () => {
    expect(friendlyProviderMessage('some brand new upstream failure')).toBeNull();
    expect(friendlyProviderMessage('')).toBeNull();
    expect(friendlyProviderMessage(null)).toBeNull();
  });
});

describe('mapCallifiedError — provider failures', () => {
  test('an unconfigured provider is 503, not a bare 502 upstream error', () => {
    const { status, body } = mapCallifiedError(
      err('Callified API error 502: {"error":"no Exotel credentials configured for this campaign"}', {
        status: 502,
        code: 'CALLIFIED_API_502',
      }),
    );
    // 503: the request is fine and will work once someone sets it up.
    expect(status).toBe(503);
    expect(body.code).toBe('CALLING_PROVIDER_NOT_CONFIGURED');
    expect(body.error).toMatch(/administrator/i);
  });

  test('DND and calling hours are 409 — configuration cannot fix them', () => {
    expect(mapCallifiedError(err('lead is on DND list', { status: 409 })).status).toBe(409);
    expect(mapCallifiedError(err('outside TRAI calling hours (9 AM – 9 PM)', { status: 409 })).status).toBe(409);
  });

  test('no credits stays 402 so the top-up flow can hook it', () => {
    const { status, body } = mapCallifiedError(
      err('insufficient credits — please recharge to continue making calls', { status: 402 }),
    );
    expect(status).toBe(402);
    expect(body.code).toBe('CALLING_NO_CREDITS');
  });

  test('our own missing API key reads as setup, not as a vendor error', () => {
    const { status, body } = mapCallifiedError(
      err('Callified integration not configured for this tenant.', { code: 'CALLIFIED_NOT_CONFIGURED' }),
    );
    expect(status).toBe(503);
    expect(body.error).toMatch(/Settings/i);
    expect(body.error).toMatch(/administrator/i);
  });

  test('an unrecognised upstream 502 reads as a temporary outage, not a setup problem', () => {
    const { status, body } = mapCallifiedError(
      err('Callified API error 502: {"error":"something entirely new"}', { status: 502 }),
    );
    // Their gateway failing is not our caller's fault — 503 try-again.
    expect(status).toBe(503);
    expect(body.code).toBe('CALLING_SERVICE_UNAVAILABLE');
    expect(body.error).not.toContain('something entirely new');
  });
});

/**
 * Upstream outages must never leak the vendor's error document.
 *
 * Callified sits behind Cloudflare. When its origin is unreachable the body is
 * a Cloudflare problem+json document, and `callifiedJson` wraps it as
 * `Callified API error 502: {…}`. That whole wall of JSON — type URLs, zone
 * names, cloudflare_error flags — was being rendered verbatim in the Call
 * Customer dialog, which tells a receptionist nothing and puts the vendor's
 * infrastructure on screen.
 */
describe('mapCallifiedError — upstream outages', () => {
  const CLOUDFLARE_502 =
    'Callified API error 502: {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/",' +
    '"status":502,"detail":"The origin web server returned an invalid response or is misconfigured.",' +
    '"instance":"a30ab943ab947eb8","error_code":502,"error_time":"2026-08-25T12:50:39Z",' +
    '"zone":"testgo1.callified.ai","cloudflare_error":true}';

  test('a Cloudflare 502 becomes one plain sentence', () => {
    const { status, body } = mapCallifiedError(err(CLOUDFLARE_502, { status: 502 }));

    expect(status).toBe(503);
    expect(body.code).toBe('CALLING_SERVICE_UNAVAILABLE');
    expect(body.error).toMatch(/temporarily unreachable/i);
  });

  test('none of the Cloudflare payload survives into the message', () => {
    const { body } = mapCallifiedError(err(CLOUDFLARE_502, { status: 502 }));

    for (const leak of [
      'cloudflare',
      'developers.cloudflare.com',
      'testgo1.callified.ai',
      'origin web server',
      'error_code',
      'instance',
      '{',
    ]) {
      expect(body.error.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  test('504 and 503 read the same way as 502', () => {
    for (const upstream of [503, 504]) {
      const { body } = mapCallifiedError(err('gateway boom', { status: upstream }));
      expect(body.code).toBe('CALLING_SERVICE_UNAVAILABLE');
    }
  });

  test('429 tells the user to wait rather than to call support', () => {
    const { status, body } = mapCallifiedError(err('Too Many Requests', { status: 429 }));
    expect(status).toBe(429);
    expect(body.code).toBe('CALLING_SERVICE_BUSY');
    expect(body.error).toMatch(/wait a moment/i);
  });

  test('an upstream 401 points at the API key, and names where to fix it', () => {
    const { body } = mapCallifiedError(err('Unauthorized', { status: 401 }));
    expect(body.code).toBe('CALLIFIED_AUTH_FAILED');
    expect(body.error).toMatch(/Settings/i);
  });

  test('every translated message is short enough to read in a dialog', () => {
    for (const status of [400, 401, 404, 429, 500, 502, 503, 504]) {
      const { body } = mapCallifiedError(err('x'.repeat(4000), { status }));
      expect(body.error.length).toBeLessThan(200);
    }
  });
});
