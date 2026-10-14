const { test, expect } = require('@playwright/test');
const { createRequire } = require('node:module');
const path = require('node:path');
const backendRequire = createRequire(path.resolve(__dirname, '../../backend/package.json'));
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const local = ['localhost', '127.0.0.1'].includes(new URL(BASE_URL).hostname);
test.describe.configure({ mode: 'serial' });
test.skip(!local, 'Isolated database fixtures are CI/local only');
let prisma;
const tenants = [];
const identities = {};
const tag = `assignees-${Date.now()}-${process.pid}`;

test.beforeAll(async () => {
  expect(process.env.DATABASE_URL).toBeTruthy();
  expect(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)).toBe(true);
  expect(process.env.JWT_SECRET).toBeTruthy();
  const { PrismaClient } = backendRequire('@prisma/client');
  const jwt = backendRequire('jsonwebtoken');
  prisma = new PrismaClient();
  for (const [key, vertical] of [['a', 'travel'], ['b', 'travel'], ['generic', 'generic'], ['wellness', 'wellness']]) {
    const tenant = await prisma.tenant.create({ data: { name: `${tag}-${key}`, slug: `${tag}-${key}`, vertical } });
    tenants.push(tenant.id);
    const admin = await prisma.user.create({ data: {
      tenantId: tenant.id, name: `${tag}-${key}`, email: `${tag}-${key}@example.test`,
      password: 'not-used-for-signed-test-token', role: 'ADMIN', userType: 'STAFF',
      subscriptionStatus: 'TRIAL', trialEndsAt: new Date(Date.now() + 86400000),
    } });
    const sign = (user) => jwt.sign({
      userId: user.id, tenantId: tenant.id, role: user.role, vertical,
      userType: 'STAFF', isOwner: false, sessionVersion: user.sessionVersion,
    }, process.env.JWT_SECRET, { expiresIn: '10m' });
    identities[key] = { id: admin.id, token: sign(admin) };
    if (key === 'a') {
      const reader = await prisma.user.create({ data: {
        tenantId: tenant.id, name: `${tag}-reader`, email: `${tag}-reader@example.test`,
        password: 'not-used-for-signed-test-token', role: 'USER', userType: 'STAFF',
      } });
      const role = await prisma.role.create({ data: {
        tenantId: tenant.id, key: `${tag}-reader`, name: 'Assignee read-only fixture',
        permissions: { create: [{ module: 'contacts', action: 'read' }, { module: 'leads', action: 'read' }] },
      } });
      await prisma.userRole.create({ data: { userId: reader.id, roleId: role.id } });
      identities.reader = { id: reader.id, token: sign(reader) };
    }
  }
});

test.afterAll(async () => {
  if (!prisma) return;
  try {
    if (!tenants.length) return;
    // Contact updates create AuditLog rows. Its Tenant FK intentionally uses
    // Restrict, so drain only our CI-local fixture tenants before deleting them.
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.role.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  } finally { await prisma.$disconnect(); }
});

const get = (request, key) => request.get(`${BASE_URL}/api/contacts/assignees`, {
  headers: { Authorization: `Bearer ${identities[key].token}` },
});
test('requires authentication', async ({ request }) => {
  expect((await request.get(`${BASE_URL}/api/contacts/assignees`)).status()).toBe(401);
});
test('travel assignee lists contain only the authenticated tenant staff', async ({ request }) => {
  for (const key of ['a', 'b']) {
    const response = await get(request, key);
    expect(response.status(), await response.text()).toBe(200);
    const rows = await response.json();
    expect(rows.some((row) => row.id === identities[key].id)).toBe(true);
    expect(rows.some((row) => row.id === identities[key === 'a' ? 'b' : 'a'].id)).toBe(false);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'name', 'role', 'subBrandAccess']);
  }
});
test('read-only travel staff cannot enumerate assignees', async ({ request }) => {
  expect((await get(request, 'reader')).status()).toBe(403);
});
for (const vertical of ['generic', 'wellness']) {
  test(`${vertical} administrators cannot use the travel assignee endpoint`, async ({ request }) => {
    expect((await get(request, vertical)).status()).toBe(404);
  });
}

test('authorized contact updates still enforce field-level write restrictions', async ({ request }) => {
  // Do not change the shared seeded USER role or any shared-tenant field rules.
  const admin = await prisma.user.findUnique({ where: { id: identities.generic.id } });
  const contact = await prisma.contact.create({ data: {
    tenantId: admin.tenantId, name: `${tag}-field-write`, email: `${tag}-contact@example.test`,
    status: 'Lead', assignedToId: admin.id,
  } });
  let rule;
  try {
    rule = await prisma.fieldPermission.create({ data: {
      tenantId: admin.tenantId, role: 'ADMIN', entity: 'Contact', field: 'email',
      action: 'WRITE', canRead: true, canWrite: false,
    } });
    const response = await request.put(`${BASE_URL}/api/contacts/${contact.id}`, {
      headers: { Authorization: `Bearer ${identities.generic.token}` },
      data: { email: `${tag}-changed@example.test`, name: `${tag}-edited` },
    });
    expect(response.status(), await response.text()).toBe(200);
    const stored = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(stored.email).toBe(contact.email);
    expect(stored.name).toBe(`${tag}-edited`);
  } finally {
    if (rule) await prisma.fieldPermission.delete({ where: { id: rule.id } });
    await prisma.contact.delete({ where: { id: contact.id } });
  }
});
