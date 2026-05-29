// Unit tests for backend/middleware/sendLimiter.js
// Covers exported limiter middleware shape and behavior — verifies that:
//   1. each limiter is a function
//   2. first request is allowed and forwarded
//   3. requests beyond the configured cap return 429
//   4. distinct authenticated users have separate buckets (per-user keying)
//   5. unauthenticated requests fall back to the IP key generator
import { describe, test, expect, vi } from 'vitest';
import {
  emailSendLimiter,
  smsSendLimiter,
  whatsappSendLimiter,
  pushSendLimiter,
} from '../../middleware/sendLimiter.js';

function makeReqRes({ user = null, ip = '203.0.113.1' } = {}) {
  const req = {
    user,
    ip,
    ips: [],
    method: 'POST',
    url: '/test',
    headers: {},
    socket: { remoteAddress: ip },
    connection: { remoteAddress: ip },
    app: { get: () => undefined },
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
  const headers = {};
  let _statusCode = 200;
  const res = {
    headers,
    locals: {},
    statusCode: 200,
    setHeader: vi.fn(function (n, v) {
      headers[n] = v;
    }),
    getHeader: vi.fn(function (n) {
      return headers[n];
    }),
    removeHeader: vi.fn(function (n) {
      delete headers[n];
    }),
    set: vi.fn(function (n, v) {
      headers[n] = v;
      return this;
    }),
    status: vi.fn(function (c) {
      this.statusCode = c;
      _statusCode = c;
      return this;
    }),
    json: vi.fn(function (data) {
      this.body = data;
      return this;
    }),
    send: vi.fn(function (data) {
      this.body = data;
      return this;
    }),
    end: vi.fn(),
  };
  const next = vi.fn();
  return { req, res, next };
}

// Run a limiter once, returning a promise that resolves once the middleware
// has decided (either by calling next() or by writing the 429 response).
function runLimiter(mw, req, res) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const next = vi.fn(() => settle('allowed'));
    // express-rate-limit calls res.status(429).send(...) on rejection, so
    // patch res.send to settle the promise.
    const origSend = res.send;
    res.send = vi.fn(function (data) {
      origSend.call(this, data);
      settle('rejected');
      return this;
    });
    const origJson = res.json;
    res.json = vi.fn(function (data) {
      origJson.call(this, data);
      settle('rejected');
      return this;
    });
    const origEnd = res.end;
    res.end = vi.fn(function (...a) {
      origEnd.apply(this, a);
      settle('rejected');
      return this;
    });
    Promise.resolve(mw(req, res, next)).catch(() => settle('rejected'));
  });
}

describe('module shape', () => {
  test('exports the four limiters as functions', () => {
    expect(typeof emailSendLimiter).toBe('function');
    expect(typeof smsSendLimiter).toBe('function');
    expect(typeof whatsappSendLimiter).toBe('function');
    expect(typeof pushSendLimiter).toBe('function');
  });
});

describe('first-request behavior', () => {
  test('emailSendLimiter allows the first authenticated request', async () => {
    const { req, res } = makeReqRes({ user: { userId: 'first-email-1' } });
    const outcome = await runLimiter(emailSendLimiter, req, res);
    expect(outcome).toBe('allowed');
    expect(res.statusCode).toBe(200);
  });

  test('smsSendLimiter allows the first request', async () => {
    const { req, res } = makeReqRes({ user: { userId: 'first-sms-1' } });
    expect(await runLimiter(smsSendLimiter, req, res)).toBe('allowed');
  });

  test('whatsappSendLimiter allows the first request', async () => {
    const { req, res } = makeReqRes({ user: { userId: 'first-wa-1' } });
    expect(await runLimiter(whatsappSendLimiter, req, res)).toBe('allowed');
  });

  test('pushSendLimiter allows the first request', async () => {
    const { req, res } = makeReqRes({ user: { userId: 'first-push-1' } });
    expect(await runLimiter(pushSendLimiter, req, res)).toBe('allowed');
  });

  test('falls back to IP key for unauthenticated requests', async () => {
    const { req, res } = makeReqRes({ user: null, ip: '198.51.100.42' });
    expect(await runLimiter(emailSendLimiter, req, res)).toBe('allowed');
  });
});

describe('rate limiting kicks in past cap', () => {
  test('pushSendLimiter rejects after 20 requests for same user', async () => {
    const userId = 'push-burst-' + Math.random().toString(36).slice(2);
    // 20 allowed
    for (let i = 0; i < 20; i++) {
      const { req, res } = makeReqRes({ user: { userId } });
      const outcome = await runLimiter(pushSendLimiter, req, res);
      expect(outcome).toBe('allowed');
    }
    // 21st should be rejected with 429
    const { req, res } = makeReqRes({ user: { userId } });
    const outcome = await runLimiter(pushSendLimiter, req, res);
    expect(outcome).toBe('rejected');
    expect(res.statusCode).toBe(429);
  });

  test('separate users have independent buckets', async () => {
    const userA = 'push-userA-' + Math.random().toString(36).slice(2);
    const userB = 'push-userB-' + Math.random().toString(36).slice(2);
    // Burn user A to the limit
    for (let i = 0; i < 20; i++) {
      const { req, res } = makeReqRes({ user: { userId: userA } });
      await runLimiter(pushSendLimiter, req, res);
    }
    const aReject = await runLimiter(
      pushSendLimiter,
      ...Object.values(makeReqRes({ user: { userId: userA } }))
        .slice(0, 2)
    ).catch(() => null);
    // Try the call directly: user A's 21st is rejected.
    const aTry = makeReqRes({ user: { userId: userA } });
    expect(await runLimiter(pushSendLimiter, aTry.req, aTry.res)).toBe(
      'rejected'
    );
    // But user B's first request is allowed.
    const bTry = makeReqRes({ user: { userId: userB } });
    expect(await runLimiter(pushSendLimiter, bTry.req, bTry.res)).toBe(
      'allowed'
    );
    // Quiet unused-binding lint.
    void aReject;
  });
});

describe('per-limiter cap values', () => {
  test('smsSendLimiter rejects after 50 requests for same user (cap=50)', async () => {
    const userId = 'sms-burst-' + Math.random().toString(36).slice(2);
    for (let i = 0; i < 50; i++) {
      const { req, res } = makeReqRes({ user: { userId } });
      const outcome = await runLimiter(smsSendLimiter, req, res);
      expect(outcome).toBe('allowed');
    }
    // 51st rejected
    const { req, res } = makeReqRes({ user: { userId } });
    const outcome = await runLimiter(smsSendLimiter, req, res);
    expect(outcome).toBe('rejected');
    expect(res.statusCode).toBe(429);
  });

  test('whatsappSendLimiter rejects after 50 and surfaces the WhatsApp-specific error message', async () => {
    const userId = 'wa-burst-' + Math.random().toString(36).slice(2);
    for (let i = 0; i < 50; i++) {
      const { req, res } = makeReqRes({ user: { userId } });
      expect(await runLimiter(whatsappSendLimiter, req, res)).toBe('allowed');
    }
    const { req, res } = makeReqRes({ user: { userId } });
    const outcome = await runLimiter(whatsappSendLimiter, req, res);
    expect(outcome).toBe('rejected');
    expect(res.statusCode).toBe(429);
    // The configured message body should surface in the JSON response.
    expect(res.body).toBeDefined();
    expect(res.body.error).toBe('WhatsApp rate limit exceeded.');
  });
});

describe('429 response shape and rate-limit headers', () => {
  test('standardHeaders: true → RateLimit-* headers set on allowed responses', async () => {
    const userId = 'headers-user-' + Math.random().toString(36).slice(2);
    const { req, res } = makeReqRes({ user: { userId } });
    const outcome = await runLimiter(emailSendLimiter, req, res);
    expect(outcome).toBe('allowed');
    // express-rate-limit v7 with standardHeaders:true writes the IETF draft
    // headers (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset / Policy).
    // Different versions use slightly different casing; assert that at least
    // one RateLimit-* header was emitted via setHeader/set.
    const allCalls = [
      ...res.setHeader.mock.calls,
      ...res.set.mock.calls,
    ];
    const rateLimitHeaderSeen = allCalls.some(([name]) =>
      typeof name === 'string' && /^ratelimit/i.test(name)
    );
    expect(rateLimitHeaderSeen).toBe(true);
  });

  test('email 429 body uses the configured error string (not a generic message)', async () => {
    const userId = 'email-msg-' + Math.random().toString(36).slice(2);
    // Burn the email bucket (cap=100).
    for (let i = 0; i < 100; i++) {
      const { req, res } = makeReqRes({ user: { userId } });
      expect(await runLimiter(emailSendLimiter, req, res)).toBe('allowed');
    }
    const { req, res } = makeReqRes({ user: { userId } });
    const outcome = await runLimiter(emailSendLimiter, req, res);
    expect(outcome).toBe('rejected');
    expect(res.statusCode).toBe(429);
    expect(res.body).toBeDefined();
    expect(res.body.error).toBe('Too many emails sent, please slow down.');
  });
});

describe('key-generator contract', () => {
  test('numeric userId is coerced via toString() — buckets the same as the string form', async () => {
    // Pick a numeric id; the string-form and number-form must hash to the
    // same bucket because userKey does `.toString()`. Burn the bucket via
    // the numeric form, then assert the string form is also rejected.
    const numericId = Math.floor(Math.random() * 1e9) + 1;
    const stringId = numericId.toString();
    for (let i = 0; i < 20; i++) {
      const { req, res } = makeReqRes({ user: { userId: numericId } });
      expect(await runLimiter(pushSendLimiter, req, res)).toBe('allowed');
    }
    // 21st via the *string* form must also reject (shared bucket).
    const { req, res } = makeReqRes({ user: { userId: stringId } });
    const outcome = await runLimiter(pushSendLimiter, req, res);
    expect(outcome).toBe('rejected');
    expect(res.statusCode).toBe(429);
  });

  test('cross-limiter independence: exhausting pushSendLimiter does not affect smsSendLimiter for the same user', async () => {
    const userId = 'cross-' + Math.random().toString(36).slice(2);
    // Burn push (cap=20) to the limit.
    for (let i = 0; i < 20; i++) {
      const { req, res } = makeReqRes({ user: { userId } });
      await runLimiter(pushSendLimiter, req, res);
    }
    // Push 21st is rejected.
    const pushTry = makeReqRes({ user: { userId } });
    expect(await runLimiter(pushSendLimiter, pushTry.req, pushTry.res)).toBe(
      'rejected'
    );
    // But sms first request for the same user is allowed (separate bucket).
    const smsTry = makeReqRes({ user: { userId } });
    expect(await runLimiter(smsSendLimiter, smsTry.req, smsTry.res)).toBe(
      'allowed'
    );
  });
});
