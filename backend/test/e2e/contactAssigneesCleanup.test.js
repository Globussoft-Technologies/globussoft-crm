import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual Playwright cleanup hook without a DB or HTTP server.
const source = readFileSync(resolve(process.cwd(), '../e2e/tests/contact-assignees-api.spec.js'), 'utf8');
const start = source.indexOf('test.afterAll(');
const hook = source.slice(start, source.indexOf('\n});', start) + '\n});'.length);

describe('assignee API fixture cleanup', () => {
  function fixture(tenants) {
    let cleanup;
    let auditExists = true;
    const prisma = {
      auditLog: { deleteMany: vi.fn(async () => { auditExists = false; }) },
      role: { deleteMany: vi.fn(async () => {}) },
      user: { deleteMany: vi.fn(async () => {}) },
      tenant: { deleteMany: vi.fn(async () => {
        if (auditExists) throw new Error('AuditLog tenant FK restrict');
      }) },
      $disconnect: vi.fn(async () => {}),
    };
    runInNewContext(hook, { prisma, tenants, test: { afterAll: (fn) => { cleanup = fn; } } });
    return { prisma, cleanup };
  }

  it('drains only owned tenant audit rows before tenant deletion', async () => {
    const { prisma, cleanup } = fixture([501, 502]);
    await cleanup();
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({ where: { tenantId: { in: [501, 502] } } });
    expect(prisma.tenant.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [501, 502] } } });
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not issue deletes when setup created no tenants', async () => {
    const { prisma, cleanup } = fixture([]);
    await cleanup();
    for (const model of ['auditLog', 'role', 'user', 'tenant']) {
      expect(prisma[model].deleteMany).not.toHaveBeenCalled();
    }
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });
});
