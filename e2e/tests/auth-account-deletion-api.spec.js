const { test, expect } = require('@playwright/test');
const { createRequire } = require('node:module');
const path = require('node:path');
const backendRequire = createRequire(path.resolve(__dirname, '../../backend/package.json'));
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
test.describe.configure({ mode: 'serial' });
test.skip(!['localhost', '127.0.0.1'].includes(new URL(BASE_URL).hostname), 'Local disposable fixtures only');
let prisma;
const tenants = [];
const tag = `account-delete-${Date.now()}-${process.pid}`;
const password = 'Deletion-fixture-Only123!';

test.beforeAll(async () => {
  expect(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)).toBe(true);
  expect(process.env.JWT_SECRET).toBeTruthy();
  const { PrismaClient } = backendRequire('@prisma/client');
  prisma = new PrismaClient();
});
test.afterAll(async () => {
  if (!prisma) return;
  try {
    if (tenants.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    }
  } finally { await prisma.$disconnect(); }
});
async function fixture(label, vertical = 'generic') {
  const tenant = await prisma.tenant.create({ data: { name: `${tag}-${label}`, slug: `${tag}-${label}`, vertical } });
  tenants.push(tenant.id);
  const hash = await backendRequire('bcryptjs').hash(password, 4);
  const users = [];
  for (const suffix of ['a', 'b']) {
    const user = await prisma.user.create({ data: {
      tenantId: tenant.id, name: suffix, email: `${tag}-${label}-${suffix}@example.test`,
      password: hash, role: 'ADMIN', userType: 'STAFF', subscriptionStatus: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 86400000),
    } });
    const token = backendRequire('jsonwebtoken').sign({
      userId: user.id, tenantId: tenant.id, role: 'ADMIN', userType: 'STAFF',
      isOwner: false, vertical, sessionVersion: user.sessionVersion,
    }, process.env.JWT_SECRET, { expiresIn: '10m' });
    users.push({ ...user, token });
  }
  return { tenant, users };
}
function remove(request, user, successor) {
  return request.delete(`${BASE_URL}/api/auth/me/account`, {
    headers: { Authorization: `Bearer ${user.token}` },
    data: { password, confirmDestructive: true, successorAdminId: successor.id },
  });
}
test('concurrent reciprocal deletions leave one active admin', async ({ request }) => {
  const { tenant, users: [a, b] } = await fixture('race');
  const results = await Promise.all([remove(request, a, b), remove(request, b, a)]);
  expect(results.filter(result => result.status() === 200)).toHaveLength(1);
  // The losing request may reach authentication after its account was deleted.
  expect(results.every(result => [200, 401, 404, 409].includes(result.status()))).toBe(true);
  expect(await prisma.user.count({ where: { tenantId: tenant.id, role: 'ADMIN', deactivatedAt: null } })).toBe(1);
  expect(await prisma.tenant.findUnique({ where: { id: tenant.id } })).not.toBeNull();
});
test('preserves organization signing credentials, shifts and petty-cash entries', async ({ request }) => {
  const { tenant, users: [a, b] } = await fixture('history', 'wellness');
  const location = await prisma.location.create({ data: {
    tenantId: tenant.id, name: 'Fixture location', addressLine: 'Fixture', city: 'Fixture',
  } });
  const register = await prisma.register.create({ data: { tenantId: tenant.id, locationId: location.id, name: 'Fixture register' } });
  const shift = await prisma.shift.create({ data: { tenantId: tenant.id, registerId: register.id, userId: a.id } });
  const ledger = await prisma.pettyCashLedger.create({ data: {
    tenantId: tenant.id, shiftId: shift.id, userId: a.id, type: 'DEPOSIT', amount: 25, reason: 'Fixture',
  } });
  const credential = await prisma.webhookCredential.create({ data: {
    tenantId: tenant.id, createdById: a.id, secret: 'fixture-only-secret', signingId: `${tag}-signing`,
  } });
  const response = await remove(request, a, b);
  expect(response.status()).toBe(200);
  expect((await prisma.shift.findUnique({ where: { id: shift.id } })).userId).toBe(b.id);
  expect((await prisma.pettyCashLedger.findUnique({ where: { id: ledger.id } })).amount).toBe(25);
  const saved = await prisma.webhookCredential.findUnique({ where: { id: credential.id } });
  expect(saved.createdById).toBe(b.id);
  expect(saved.secret).toBe('fixture-only-secret');
  expect(await prisma.user.findUnique({ where: { id: a.id } })).toBeNull();
});
