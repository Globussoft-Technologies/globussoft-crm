---
name: writing-vitest-unit-test
description: Authors a vitest unit test for a backend lib/, middleware/, services/, or cron/ module. Use when adding unit-level coverage for a JS module (R-2/R-3 lib pair, R-5 cron-engine pair, G-16 service-module pattern, #410/#411-style engine fixes). Encodes the vi.mock prisma setup, the CJS-require quirk + createRequire workaround for modules like @sentry/node that don't intercept under this repo's setup, the mocking pattern by SUT type (https.request mock for sms/whatsapp/telephony, fetch mock for plain HTTP, prisma fan-out for routes/cron), and the ≥80% line coverage target. vitest auto-discovers backend/test/**/*.test.js so no wire-in is needed.
---

# Writing a vitest unit test

## When to use

You're adding a `backend/test/<area>/<module>.test.js` that exercises a single JS module with all externals mocked (prisma, fetch, https, etc.). Runs in <50ms per file; runs as part of the `unit_tests` gate on every push.

NOT this skill:
- API-level contract tests (those are Playwright `request`-fixture specs — see `writing-api-gate-spec`)
- Route handlers — those are tested at the API level, not unit. Don't unit-test routes.
- UI components — frontend vitest+RTL is a separate setup (G-21, not yet built).

## Standing rules

- **No wire-in.** `npm run test:unit` invokes `vitest run` which auto-discovers `backend/test/**/*.test.js`. Just put the file in the right directory.
- **Header rule** (per `feedback_descriptive_headers.md` memory): JSDoc covering what's tested + which module + WHY (the regression class) + EXACT functions/branches covered + non-obvious mocking notes.
- **No `Co-Authored-By: Claude`** in commits.
- **Coverage target:** ≥80% lines on the SUT. Verify with `npm test -- --coverage backend/test/<your-file>.test.js`.

## Pattern selection — clone an existing test

Match the SUT's external-call shape:

| SUT shape | Reference test | Mock approach |
|---|---|---|
| Uses `https.request` (sms/whatsapp/telephony providers) | `backend/test/services/whatsappProvider.test.js` (commit `6871d8d`) — 100% coverage, 23 tests | Monkey-patch `https.request` via createRequire on the real `https` module |
| Uses global `fetch` | `backend/test/services/telephonyProvider.test.js` | `vi.mock` of `node-fetch` OR mock `global.fetch` |
| Uses prisma + has business logic (cron engines) | `backend/test/cron/wellnessOpsEngine.test.js` (`8303272`) — 30 tests, 76.92% lines / `backend/test/cron/appointmentRemindersEngine.test.js` (`d86fbdb`) — 23 tests, 93.5% | `vi.mock('../../lib/prisma')` returns a per-method-mocked client |
| Uses prisma + a `$extends` hook (lib/prisma encryption layer) | `backend/test/lib/prisma.test.js` (`90eddac`) — 21 tests, 88.33% | Stub `prisma.$parent._engine.request` to return `{ data: { _op: <payload> } }` |
| Pure function (validators, formatters) | `backend/test/lib/validators.test.js` (existing) | No mocks; just assert input → output |
| External SDK module that the test must monkey-patch through CJS-require chain | `backend/test/lib/sentry.test.js` (`90eddac`) — uses `createRequire` workaround | See "CJS-require quirk" below |

## CJS-require quirk

`vi.mock('@sentry/node')` does NOT intercept CJS requires under this repo's vitest config. Confirmed across `notificationService.test.js` / `eventBus.test.js` / `audit.test.js` / `sentry.test.js`.

**Workaround** — monkey-patch the real CJS `module.exports` of the dependency. The SUT's top-level `require(...)` and runtime `require(...).method` both resolve to the same cached instance, so writing on the cached exports propagates.

```js
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const Sentry = requireCJS('@sentry/node');

// Save and restore between tests
let originalInit;
let originalCaptureException;

beforeEach(() => {
  originalInit = Sentry.init;
  originalCaptureException = Sentry.captureException;
  Sentry.init = vi.fn();
  Sentry.captureException = vi.fn();
});

afterEach(() => {
  Sentry.init = originalInit;
  Sentry.captureException = originalCaptureException;
  vi.resetModules(); // so require('../../lib/sentry') re-runs init logic next test
});
```

When in doubt, reach for `vi.mock` first (cleaner). Only fall back to the createRequire pattern if vi.mock provably doesn't intercept (verify by adding `console.log` inside the mocked function and seeing it never fire).

## prisma mocking pattern (cron engines + lib helpers)

```js
import { vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  default: {
    visit: { findMany: vi.fn(), findFirst: vi.fn() },
    smsMessage: { create: vi.fn(), findFirst: vi.fn() },
    survey: { findFirst: vi.fn(), create: vi.fn() },
    contact: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
    // ... only the prisma surfaces the SUT calls. Don't bloat with everything.
  },
}));

import prisma from '../../lib/prisma';
import { runForTenant } from '../../cron/wellnessOpsEngine';

beforeEach(() => {
  vi.clearAllMocks();
});

test('NPS happy path', async () => {
  prisma.visit.findMany.mockResolvedValueOnce([{ id: 1, contactId: 99, /* ... */ }]);
  prisma.survey.findFirst.mockResolvedValueOnce(null); // no existing nps row
  prisma.smsMessage.create.mockResolvedValueOnce({ id: 1 });
  prisma.survey.create.mockResolvedValueOnce({ id: 1 });

  await runForTenant({ id: 2, vertical: 'wellness' });

  expect(prisma.smsMessage.create).toHaveBeenCalledOnce();
  expect(prisma.survey.create).toHaveBeenCalledOnce();
});
```

See `backend/test/cron/wellnessOpsEngine.test.js` for the canonical example.

## https.request mock pattern (sms/whatsapp/telephony providers)

```js
import { vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mockHttpsRequest = vi.fn();
vi.mock('node:https', () => ({
  default: { request: mockHttpsRequest },
  request: mockHttpsRequest,
}));

import { sendTemplate } from '../../services/whatsappProvider';

beforeEach(() => {
  mockHttpsRequest.mockReset();
});

function mockHttpsResponse({ statusCode, body }) {
  mockHttpsRequest.mockImplementationOnce((opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    setTimeout(() => {
      cb(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    }, 0);
    return Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(),
    });
  });
}

test('sendTemplate happy path', async () => {
  mockHttpsResponse({ statusCode: 200, body: '{"messages":[{"id":"abc"}]}' });
  const result = await sendTemplate({ to: '+919999999999', templateName: 'foo', phoneNumberId: 'p1', accessToken: 't1' });
  expect(result.success).toBe(true);
  expect(result.providerMsgId).toBe('abc');
});
```

See `backend/test/services/whatsappProvider.test.js:6871d8d` for the canonical pattern with all branches (template/free-form, error responses, network errors, byte-length headers).

## Acceptance criteria — the standard set

Per SUT type, cover these branches:

**Service modules (sms/whatsapp/telephony/email):**
- Happy path → returns success envelope with provider id
- Error response (4xx/5xx from provider) → returns `{ success: false, error: ... }` (NOT throws — the contract is graceful-degrade)
- Network error (req emits `error` event) → same graceful return
- Missing config / null phoneNumberId → `{ skipped: true }` or similar (per the SUT's documented contract)
- Variable substitution if applicable (e.g. `{{name}}` template params)
- Phone number normalization if applicable
- Byte-length `Content-Length` header (catches multi-byte input bugs)

**Cron engines:**
- Happy path → expected DB writes occur once each, with correct args
- Dedup branch → repeat invocation does NOT duplicate the side effect (engine queries for existing rows + skips)
- Window math edges (too-early / too-old / cancelled) → SUT skips
- Per-tenant scope → engine filters `where: { tenantId }`
- Per-row error containment → one failed record doesn't stop sibling records
- Tenant-iteration top-level → wraps each tenant in try/catch (so one bad tenant doesn't kill the cron)

**Lib helpers (prisma, sentry, etc.):**
- Module-shape (singleton contract for prisma; module loads cleanly without DSN for sentry)
- Configured-mode and unconfigured-mode for env-var-gated helpers
- Each export's happy + error branches

## Coverage check

```bash
cd backend && npm test -- --coverage backend/test/<your-test-file>.test.js
```

Target: ≥80% lines on the SUT. If below:
- Read the report's "Uncovered Lines" output
- Add tests for missed branches
- If the gap is a cron-shell init function or orchestration shell that can't be invoked from a unit test (because not exported), document that in the test header. See wellnessOpsEngine.test.js header for the canonical "NOT covered" note.

## Commit message format

```
test(unit): <module> vitest (<gap-id>)

[Brief: which module, what branches covered, the regression class]

Pattern: backend/test/<reference-test-path>.test.js.

Closes <gap-id> from docs/E2E_GAPS.md.
```

For engine fixes that pair with a unit test (the #410/#411 pattern), use `fix(cron): ...` instead, and document the test as evidence:

```
fix(cron): <one-line summary> (closes #XXX)

[Description of the engine bug + fix]

Adds backend/test/cron/<engine>.test.js with N tests including an
anti-regression assertion against the old broken form.
```

## Templates

See `TEMPLATE.md` for a vitest skeleton; `MOCK_PATTERNS.md` for concrete prisma + fetch + https.request mock setups.
