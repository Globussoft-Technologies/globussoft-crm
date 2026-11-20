// @ts-check
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api/travel/email-automation`;
const RUN_TAG = `E2E_TRAVEL_EMAIL_${Date.now()}`;
let token;
let cleanupTemplateId;

const auth = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test.beforeAll(async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'yasin@travelstall.in', password: 'password123' },
  });
  expect(response.ok()).toBeTruthy();
  token = (await response.json()).token;
});

test.afterAll(async ({ request }) => {
  if (cleanupTemplateId && token) {
    await request.delete(`${API}/templates/${cleanupTemplateId}`, { headers: auth() }).catch(() => {});
  }
});

test('DELETE /templates/:id requires authentication', async ({ request }) => {
  const response = await request.delete(`${API}/templates/99999999`);
  expect([401, 403]).toContain(response.status());
});

test('delivery history is paginated and exposes tenant-scoped message details', async ({ request }) => {
  const response = await request.get(`${API}/delivery-logs?page=1&limit=5`, { headers: auth() });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(Array.isArray(body.logs)).toBeTruthy();
  expect(body.logs.length).toBeLessThanOrEqual(5);
  expect(body.pagination).toEqual(expect.objectContaining({ page: 1, limit: 5 }));
  expect(typeof body.pagination.total).toBe('number');
  expect(typeof body.pagination.totalPages).toBe('number');

  if (body.logs.length) {
    const detail = await request.get(`${API}/delivery-logs/${body.logs[0].id}`, { headers: auth() });
    expect(detail.ok()).toBeTruthy();
    expect(await detail.json()).toEqual(expect.objectContaining({
      id: body.logs[0].id,
      recipientEmail: body.logs[0].recipientEmail,
      subject: body.logs[0].subject,
    }));
  }
});

test('bulk delivery-history deletion validates selected IDs', async ({ request }) => {
  const unauthenticated = await request.post(`${API}/delivery-logs/bulk-delete`, { data: { ids: [1] } });
  expect([401, 403]).toContain(unauthenticated.status());

  const invalid = await request.post(`${API}/delivery-logs/bulk-delete`, {
    headers: auth(),
    data: { ids: [] },
  });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).code).toBe('INVALID_LOG_IDS');
});

test('default templates are protected from deletion', async ({ request }) => {
  const list = await request.get(`${API}/templates`, { headers: auth() });
  expect(list.ok()).toBeTruthy();
  const defaultTemplate = (await list.json()).find((item) => item.isDefault);
  expect(defaultTemplate).toBeTruthy();

  const response = await request.delete(`${API}/templates/${defaultTemplate.id}`, { headers: auth() });
  expect(response.status()).toBe(409);
  expect((await response.json()).code).toBe('DEFAULT_TEMPLATE_PROTECTED');
});

test('user-created template can be deleted', async ({ request }) => {
  const catalogResponse = await request.get(`${API}/catalog`, { headers: auth() });
  expect(catalogResponse.ok()).toBeTruthy();
  const catalog = await catalogResponse.json();
  const eventKeys = catalog.optional.map((item) => item.value);
  const subBrands = [...catalog.subBrands, 'all'];
  let created;

  for (const eventKey of eventKeys) {
    for (const subBrand of subBrands) {
      const response = await request.post(`${API}/templates`, {
        headers: auth(),
        data: {
          eventKey,
          subBrand,
          name: `${RUN_TAG}_${eventKey}_${subBrand}`,
          subject: `${RUN_TAG} subject`,
          body: `${RUN_TAG} body`,
        },
      });
      if (response.status() === 201) {
        created = await response.json();
        break;
      }
      expect(response.status()).toBe(409);
    }
    if (created) break;
  }

  expect(created, 'an unused optional-event/subbrand slot must be available').toBeTruthy();
  expect(created.isDefault).toBe(false);
  cleanupTemplateId = created.id;

  const response = await request.delete(`${API}/templates/${created.id}`, { headers: auth() });
  expect(response.status()).toBe(204);
  cleanupTemplateId = null;

  const list = await request.get(`${API}/templates`, { headers: auth() });
  expect(list.ok()).toBeTruthy();
  expect((await list.json()).some((item) => item.id === created.id)).toBe(false);
});
