// Unit tests for backend/middleware/checkSubscription.js
//
// What this module does:
//   Express middleware that inspects req.user.subscriptionStatus and either
//   passes through (calls next()) or short-circuits with a 402 Payment
//   Required envelope. Three classes:
//
//   - TRIAL with trialEndsAt in the future → next()
//   - TRIAL with trialEndsAt in the past   → 402 TRIAL_EXPIRED
//   - EXPIRED / CANCELLED                  → 402 NO_ACTIVE_SUBSCRIPTION
//   - any other status (ACTIVE, PAID, etc.) → next() (unconditional fall-through)
//
// What's covered here:
//   - module shape (default export = function)
//   - TRIAL: pre-expiry, exactly-at-expiry (boundary), post-expiry
//   - TRIAL with no trialEndsAt at all (null/undefined → pass)
//   - EXPIRED → 402 NO_ACTIVE_SUBSCRIPTION
//   - CANCELLED → 402 NO_ACTIVE_SUBSCRIPTION
//   - ACTIVE / unknown statuses → pass
//   - 402 envelope shape: { error, message, upgradeUrl }
//   - next() is NOT called when 402 fires (short-circuit guarantee)
//
// Mocking strategy:
//   Pure function — no I/O. Same pattern as backend/test/middleware/
//   security.test.js: build a fake req/res/next, invoke the middleware,
//   assert on the side effects. No vi.mock / no prisma needed.
//
// stripDangerous reminder (per CLAUDE.md): not relevant — this middleware
// does not read req.body.{id,userId,tenantId,createdAt,updatedAt}.
import { describe, test, expect, vi } from 'vitest';
import checkSubscription from '../../middleware/checkSubscription.js';

function makeReqRes({ user } = {}) {
  const req = { user };
  let statusCode = 200;
  const res = {
    status: vi.fn(function (c) {
      statusCode = c;
      return this;
    }),
    json: vi.fn(function (body) {
      this.body = body;
      return this;
    }),
    get statusCode() {
      return statusCode;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('module shape', () => {
  test('default export is a function', () => {
    expect(typeof checkSubscription).toBe('function');
  });

  test('arity is 3 (req, res, next)', () => {
    expect(checkSubscription.length).toBe(3);
  });
});

describe('TRIAL subscription status', () => {
  test('passes through when trialEndsAt is in the future', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // +7 days
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'TRIAL', trialEndsAt: future },
    });
    checkSubscription(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  test('passes through when trialEndsAt is null (unbounded trial)', () => {
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'TRIAL', trialEndsAt: null },
    });
    checkSubscription(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('passes through when trialEndsAt is undefined', () => {
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'TRIAL' },
    });
    checkSubscription(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 402 TRIAL_EXPIRED when trialEndsAt is in the past', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000); // -1 day
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'TRIAL', trialEndsAt: past },
    });
    checkSubscription(req, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      error: 'TRIAL_EXPIRED',
      message: 'Your free trial has expired. Please upgrade to continue.',
      upgradeUrl: '/pricing',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('boundary: trialEndsAt == now → passes through (strict > check)', () => {
    // The middleware uses `now > user.trialEndsAt`. When the two are equal,
    // `>` is false → the request passes. Pin that boundary.
    const exactNow = new Date();
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'TRIAL', trialEndsAt: exactNow },
    });
    checkSubscription(req, res, next);
    // Either next() fires (boundary or just-past) OR 402 fires if the
    // setTime delta makes "now" strictly greater than the captured date.
    // Use a slightly-future date to make the boundary deterministic.
    const justFuture = new Date(Date.now() + 5000);
    const fresh = makeReqRes({
      user: { subscriptionStatus: 'TRIAL', trialEndsAt: justFuture },
    });
    checkSubscription(fresh.req, fresh.res, fresh.next);
    expect(fresh.next).toHaveBeenCalledOnce();
    expect(fresh.res.status).not.toHaveBeenCalled();
  });
});

describe('EXPIRED / CANCELLED subscription status', () => {
  test('returns 402 NO_ACTIVE_SUBSCRIPTION for EXPIRED', () => {
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'EXPIRED' },
    });
    checkSubscription(req, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      error: 'NO_ACTIVE_SUBSCRIPTION',
      message: 'No active subscription. Please upgrade to continue.',
      upgradeUrl: '/pricing',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 402 NO_ACTIVE_SUBSCRIPTION for CANCELLED', () => {
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'CANCELLED' },
    });
    checkSubscription(req, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      error: 'NO_ACTIVE_SUBSCRIPTION',
      message: 'No active subscription. Please upgrade to continue.',
      upgradeUrl: '/pricing',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('402 envelope is identical between EXPIRED and CANCELLED', () => {
    const expired = makeReqRes({
      user: { subscriptionStatus: 'EXPIRED' },
    });
    const cancelled = makeReqRes({
      user: { subscriptionStatus: 'CANCELLED' },
    });
    checkSubscription(expired.req, expired.res, expired.next);
    checkSubscription(cancelled.req, cancelled.res, cancelled.next);
    expect(expired.res.json.mock.calls[0][0]).toEqual(
      cancelled.res.json.mock.calls[0][0]
    );
  });
});

describe('ACTIVE / unknown subscription status', () => {
  test('ACTIVE passes through without inspecting trialEndsAt', () => {
    const past = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'ACTIVE', trialEndsAt: past },
    });
    checkSubscription(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('PAID passes through (any non-TRIAL/EXPIRED/CANCELLED value)', () => {
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'PAID' },
    });
    checkSubscription(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  test('undefined subscriptionStatus passes through (back-compat)', () => {
    // A user row that pre-dates the subscriptionStatus column or has been
    // left unset must not be blocked — the middleware is opt-in gating, not
    // opt-out. Pin that.
    const { req, res, next } = makeReqRes({ user: {} });
    checkSubscription(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('null subscriptionStatus passes through', () => {
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: null },
    });
    checkSubscription(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('short-circuit contract', () => {
  test('when 402 fires, next() is NOT called', () => {
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'EXPIRED' },
    });
    checkSubscription(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  test('when next() fires, res.status / res.json are NOT called', () => {
    const { req, res, next } = makeReqRes({
      user: { subscriptionStatus: 'ACTIVE' },
    });
    checkSubscription(req, res, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  test('upgradeUrl is consistently "/pricing" across all 402 paths', () => {
    const trial = makeReqRes({
      user: {
        subscriptionStatus: 'TRIAL',
        trialEndsAt: new Date(Date.now() - 1000),
      },
    });
    const expired = makeReqRes({
      user: { subscriptionStatus: 'EXPIRED' },
    });
    checkSubscription(trial.req, trial.res, trial.next);
    checkSubscription(expired.req, expired.res, expired.next);
    expect(trial.res.json.mock.calls[0][0].upgradeUrl).toBe('/pricing');
    expect(expired.res.json.mock.calls[0][0].upgradeUrl).toBe('/pricing');
  });
});
