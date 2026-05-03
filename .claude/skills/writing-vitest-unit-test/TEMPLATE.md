# vitest unit-test template

Copy into `backend/test/<area>/<module>.test.js`.

```js
// @ts-check
/**
 * <Module> — vitest unit test for backend/<path>/<module>.js.
 *
 * Why this exists: <regression class — e.g. "the engine had API-level
 * coverage via tests/<x>-api.spec.js but no unit-level coverage; the
 * dedup query and window math couldn't be exercised deterministically
 * without booting a real backend">.
 *
 * Branches covered:
 *   ✅ Happy path → expected DB writes / return value
 *   ✅ <branch 2 — e.g. "dedup short-circuit when X exists">
 *   ✅ <branch 3 — e.g. "tenant scope mandatory in where clause">
 *   ✅ <error branch — e.g. "per-row error containment">
 *
 * NOT covered (intentional — explain why):
 *   - <e.g. "initWellnessOpsCron — schedule shell, not exported, can't
 *     be invoked from unit test without changing module surface">
 *
 * Pattern: backend/test/<reference-test>.test.js (commit <hash>).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── Mocks (all externals) ────────────────────────────────────────────

vi.mock('../../lib/prisma', () => ({
  default: {
    // Only the prisma surfaces the SUT calls
    visit: { findMany: vi.fn() },
    smsMessage: { create: vi.fn(), findFirst: vi.fn() },
    contact: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import prisma from '../../lib/prisma';
import { runForTenant } from '../../<path>/<module>';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('<module> — happy path', () => {
  test('writes expected DB rows', async () => {
    prisma.visit.findMany.mockResolvedValueOnce([
      { id: 1, contactId: 99, visitDate: new Date(Date.now() - 73 * 60 * 60 * 1000) },
    ]);
    prisma.smsMessage.findFirst.mockResolvedValueOnce(null); // no existing
    prisma.smsMessage.create.mockResolvedValueOnce({ id: 1 });

    await runForTenant({ id: 2, vertical: 'wellness' });

    expect(prisma.smsMessage.create).toHaveBeenCalledOnce();
  });
});

describe('<module> — dedup', () => {
  test('skips when prior row exists', async () => {
    prisma.visit.findMany.mockResolvedValueOnce([
      { id: 1, contactId: 99, visitDate: new Date(Date.now() - 73 * 60 * 60 * 1000) },
    ]);
    prisma.smsMessage.findFirst.mockResolvedValueOnce({ id: 99 }); // already sent

    await runForTenant({ id: 2, vertical: 'wellness' });

    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });
});

describe('<module> — tenant scope mandatory', () => {
  test('queries include where.tenantId', async () => {
    prisma.visit.findMany.mockResolvedValueOnce([]);

    await runForTenant({ id: 7, vertical: 'wellness' });

    expect(prisma.visit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 7 }),
      })
    );
  });
});

describe('<module> — per-row error containment', () => {
  test('one failed visit does not stop siblings', async () => {
    prisma.visit.findMany.mockResolvedValueOnce([
      { id: 1, contactId: 99 },
      { id: 2, contactId: 100 },
    ]);
    prisma.smsMessage.findFirst.mockResolvedValue(null);
    prisma.smsMessage.create
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ id: 1 });

    // Should NOT throw — engine catches per-row
    await expect(runForTenant({ id: 2 })).resolves.not.toThrow();

    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(2);
  });
});
```
