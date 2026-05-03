# Mock patterns by SUT type

Concrete mock-setup snippets for the 4 most common SUT shapes in this codebase.

## 1. Prisma fan-out (cron engines, lib helpers, route-internal helpers)

```js
import { vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  default: {
    // List ONLY the prisma surfaces the SUT actually calls.
    // Resist bloating with "everything just in case" — keeps the test
    // a precise contract on what the SUT touches.
    visit: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    smsMessage: { create: vi.fn(), findFirst: vi.fn() },
    survey: { findFirst: vi.fn(), create: vi.fn() },
    contact: { deleteMany: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import prisma from '../../lib/prisma';
import { runForTenant } from '../../cron/<engine>';

beforeEach(() => {
  vi.clearAllMocks();
});

// Per-test setup: chain mockResolvedValueOnce calls in invocation order
test('happy path', async () => {
  prisma.visit.findMany.mockResolvedValueOnce([{ id: 1, contactId: 99 }]);
  prisma.survey.findFirst.mockResolvedValueOnce(null);
  prisma.smsMessage.create.mockResolvedValueOnce({ id: 1 });
  prisma.survey.create.mockResolvedValueOnce({ id: 1 });

  await runForTenant({ id: 2 });

  expect(prisma.smsMessage.create).toHaveBeenCalledOnce();
  expect(prisma.survey.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ tenantId: 2 }),
    })
  );
});
```

Reference: `backend/test/cron/wellnessOpsEngine.test.js` (commit `8303272`).

## 2. https.request mock (sms/whatsapp/telephony providers)

The provider modules use the Node built-in `https.request`, not `fetch`. Mock the request function directly.

```js
import { vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const mockHttpsRequest = vi.fn();
vi.mock('node:https', () => ({
  default: { request: mockHttpsRequest },
  request: mockHttpsRequest,
}));

import { sendTemplate, sendText } from '../../services/<provider>';

beforeEach(() => {
  mockHttpsRequest.mockReset();
});

// Helper to script a one-shot https response
function mockHttpsResponse({ statusCode, body }) {
  mockHttpsRequest.mockImplementationOnce((opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    // Schedule the callback on next tick so the SUT's `req.write/req.end`
    // calls happen before the response stream emits.
    setTimeout(() => {
      cb(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    }, 0);
    // The "request" object the SUT writes to.
    return Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(),
    });
  });
}

// And a network-error variant:
function mockHttpsNetworkError(err = new Error('ECONNRESET')) {
  mockHttpsRequest.mockImplementationOnce(() => {
    const req = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(),
    });
    setTimeout(() => req.emit('error', err), 0);
    return req;
  });
}

test('sendTemplate happy path', async () => {
  mockHttpsResponse({ statusCode: 200, body: '{"messages":[{"id":"abc"}]}' });
  const result = await sendTemplate({
    to: '+919999999999', templateName: 'foo',
    phoneNumberId: 'p1', accessToken: 't1',
  });
  expect(result.success).toBe(true);
  expect(result.providerMsgId).toBe('abc');
});

test('sendTemplate provider 5xx', async () => {
  mockHttpsResponse({ statusCode: 500, body: '{"error":{"message":"down"}}' });
  const result = await sendTemplate({ to: '+919999999999', templateName: 'foo', phoneNumberId: 'p1', accessToken: 't1' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('down');
});

test('sendTemplate network error', async () => {
  mockHttpsNetworkError(new Error('ECONNRESET'));
  const result = await sendTemplate({ to: '+919999999999', templateName: 'foo', phoneNumberId: 'p1', accessToken: 't1' });
  expect(result.success).toBe(false);
});
```

Reference: `backend/test/services/whatsappProvider.test.js` (commit `6871d8d`, 100% coverage).

## 3. global fetch mock (HTTP clients that use fetch)

Some services use `global.fetch` (Node 18+) or a `node-fetch` import. For modules that use the global:

```js
import { vi, beforeEach } from 'vitest';

beforeEach(() => {
  // Replace per-test, restore from saved reference
  global.fetch = vi.fn();
});

import { sendCall } from '../../services/<provider>';

test('sendCall happy path', async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ id: 'call-123', status: 'queued' }),
  });
  const r = await sendCall({ to: '+919999999999', script: 'hello' });
  expect(r.success).toBe(true);
});
```

For modules that `require('node-fetch')`:
```js
vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));
import fetch from 'node-fetch';
// Use fetch.mockResolvedValueOnce(...) per test
```

Reference: `backend/test/services/telephonyProvider.test.js`.

## 4. CJS-require quirk workaround (for modules vi.mock can't intercept)

Used when `vi.mock('@sentry/node')` (or similar SDK module) doesn't intercept a CJS `require()` chain. Confirmed-working modules: `@sentry/node`, possibly older versions of certain libs.

```js
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const Sentry = requireCJS('@sentry/node');

// Save the originals once at module load — refer to the same cached
// instance the SUT's require() will resolve to.
const ORIGINAL_INIT = Sentry.init;
const ORIGINAL_CAPTURE = Sentry.captureException;

let mockInit;
let mockCapture;

beforeEach(() => {
  mockInit = vi.fn();
  mockCapture = vi.fn();
  Sentry.init = mockInit;
  Sentry.captureException = mockCapture;

  // Reset module cache so `require('../../lib/sentry')` re-executes
  // the top-level Sentry.init() call against our mocked init.
  vi.resetModules();
});

afterEach(() => {
  Sentry.init = ORIGINAL_INIT;
  Sentry.captureException = ORIGINAL_CAPTURE;
});

test('init called once when SENTRY_DSN is set', async () => {
  process.env.SENTRY_DSN = 'https://example.com/123';
  const { initSentry } = await import('../../lib/sentry');
  initSentry();
  expect(mockInit).toHaveBeenCalledOnce();
  expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({
    dsn: 'https://example.com/123',
  }));
});

test('captureException no-ops when DSN missing', async () => {
  delete process.env.SENTRY_DSN;
  const { captureException } = await import('../../lib/sentry');
  captureException(new Error('test'));
  expect(mockCapture).not.toHaveBeenCalled();
});
```

Reference: `backend/test/lib/sentry.test.js` (commit `90eddac`, 100% coverage). Use this pattern only when vi.mock provably doesn't intercept — verify by adding `console.log` inside the mocked function and seeing it never fire.

## Coverage check

```bash
cd backend && npm test -- --coverage backend/test/<your-test-file>.test.js
```

Look for "Uncovered Lines" in the report. Target ≥80% on the SUT.
