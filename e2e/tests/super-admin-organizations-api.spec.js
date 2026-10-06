// @ts-check
/**
 * Super Admin organization provisioning contract.
 *
 * This spec is intentionally local-stack-only: it creates a real tenant and
 * owner, verifies their RBAC-backed login, and removes the tenant directly
 * from the ephemeral CI database in afterAll. It must never create test
 * organizations on the live demo.
 */
const { test, expect } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const IS_LOCAL_STACK = ['127.0.0.1', 'localhost'].includes(new URL(BASE_URL).hostname);
const RUN_TAG = `E2E_SUPER_ORG_${Date.now()}_${process.pid}`;
const ownerEmail = `${RUN_TAG.toLowerCase()}@example.com`;
const ownerPassword = 'OwnerPass1523';
const organizationName = `${RUN_TAG} Travel`;
const BACKEND_DIR = path.resolve(__dirname, '../../backend');

let superAdminToken = null;
let createdTenantId = null;

const superHeaders = () => ({
  Authorization: `Bearer ${superAdminToken}`,
  'Content-Type': 'application/json',
});

test.beforeAll(async ({ request }) => {
  test.skip(!IS_LOCAL_STACK, 'organization provisioning mutates data and is CI-local only');
  const response = await request.post(`${API}/super-admin/auth/login`, {
    data: {
      username: process.env.E2E_SUPER_ADMIN_USERNAME,
      password: process.env.E2E_SUPER_ADMIN_PASSWORD,
    },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(200);
  superAdminToken = (await response.json()).token;
  expect(superAdminToken).toBeTruthy();
});

test.afterAll(() => {
  if (!IS_LOCAL_STACK || !createdTenantId || !process.env.DATABASE_URL) return;
  const cleanup = spawnSync(process.execPath, ['-e', [
    "const { PrismaClient } = require('@prisma/client');",
    'const prisma = new PrismaClient();',
    `prisma.tenant.delete({ where: { id: ${createdTenantId} } })`,
    ".catch((error) => { if (error.code !== 'P2025') throw error; })",
    '.finally(() => prisma.$disconnect());',
  ].join(' ')], {
    cwd: BACKEND_DIR,
    env: process.env,
    encoding: 'utf8',
  });
  expect(cleanup.status, cleanup.stderr).toBe(0);
});

test.describe('POST /api/super-admin/tenant-management/organizations', () => {
  test('rejects anonymous and regular CRM tokens', async ({ request }) => {
    const anonymous = await request.post(`${API}/super-admin/tenant-management/organizations`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(anonymous.status()).toBe(401);

    const login = await request.post(`${API}/auth/login`, {
      data: { email: 'admin@globussoft.com', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(login.status()).toBe(200);
    const regularToken = (await login.json()).token;
    const regular = await request.post(`${API}/super-admin/tenant-management/organizations`, {
      data: {},
      headers: { Authorization: `Bearer ${regularToken}`, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(regular.status()).toBe(401);
  });

  test('validates input before creating an organization', async ({ request }) => {
    const response = await request.post(`${API}/super-admin/tenant-management/organizations`, {
      data: { organizationName, name: 'E2E Owner', email: 'invalid', password: ownerPassword },
      headers: superHeaders(),
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'EMAIL_REQUIRED' });
  });

  test('creates a travel tenant with a usable RBAC-enabled owner', async ({ request }) => {
    const response = await request.post(`${API}/super-admin/tenant-management/organizations`, {
      data: {
        organizationName,
        name: 'E2E Owner',
        email: ownerEmail,
        password: ownerPassword,
        vertical: 'travel',
        themePreference: 'light',
      },
      headers: superHeaders(),
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.organization).toMatchObject({ name: organizationName, vertical: 'travel' });
    expect(body.owner).toMatchObject({ email: ownerEmail, role: 'ADMIN' });
    createdTenantId = body.organization.id;

    const ownerLogin = await request.post(`${API}/auth/login`, {
      data: { email: ownerEmail, password: ownerPassword },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(ownerLogin.status()).toBe(200);
    const ownerToken = (await ownerLogin.json()).token;
    const pages = await request.get(`${API}/pages/me`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(pages.status()).toBe(200);
    const pagesBody = await pages.json();
    const pageList = Array.isArray(pagesBody) ? pagesBody : pagesBody.pages;
    expect(Array.isArray(pageList)).toBe(true);
    expect(pageList.length).toBeGreaterThan(0);
  });

  test('rejects duplicate owner email within the same vertical', async ({ request }) => {
    const response = await request.post(`${API}/super-admin/tenant-management/organizations`, {
      data: { organizationName: `${organizationName} Two`, name: 'Other', email: ownerEmail, password: ownerPassword, vertical: 'travel' },
      headers: superHeaders(),
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'EMAIL_ALREADY_EXISTS' });
  });

  test('rejects a duplicate organization name', async ({ request }) => {
    const response = await request.post(`${API}/super-admin/tenant-management/organizations`, {
      data: { organizationName: organizationName.toUpperCase(), name: 'Other', email: `other-${ownerEmail}`, password: ownerPassword, vertical: 'generic' },
      headers: superHeaders(),
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'ORGANIZATION_NAME_ALREADY_EXISTS' });
  });
});
