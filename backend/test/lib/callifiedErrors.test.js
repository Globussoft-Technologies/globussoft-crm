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
const { mapCallifiedError, sendCallifiedError } = requireCJS('../../lib/callifiedErrors');

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

  test('an explicit status on the error wins over the generic fallback', () => {
    const { status, body } = mapCallifiedError(err('gone', { status: 404, code: 'CALLIFIED_API_404' }));
    expect(status).toBe(404);
    expect(body.code).toBe('CALLIFIED_API_404');
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
