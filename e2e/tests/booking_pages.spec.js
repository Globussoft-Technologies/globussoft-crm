// @ts-check
/**
 * Booking pages route smoke (`/api/booking-pages`)
 *  - Authenticated CRUD (list, create, update, delete, GET bookings, cancel)
 *  - Public surfaces (no auth): /public/:slug, /public/:slug/slots,
 *      /public/:slug/book — including a happy-path booking + cancel
 *
 * Self-cleans created booking pages.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('Booking pages — /api/booking-pages', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  async function createPage(request, title) {
    const res = await request.post(`${API}/booking-pages`, {
      headers: auth(),
      data: {
        title: title || `E2E_BOOK_${Date.now()}`,
        description: 'Smoke test booking page',
        durationMins: 30,
        bufferMins: 0,
      },
    });
    expect(res.status(), `create page: ${await res.text()}`).toBe(201);
    return await res.json();
  }

  async function deletePage(request, id) {
    await request.delete(`${API}/booking-pages/${id}`, { headers: auth() });
  }

  test('auth gate — GET / without token returns 401/403', async ({ request }) => {
    const res = await request.get(`${API}/booking-pages`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / returns array shape', async ({ request }) => {
    const res = await request.get(`${API}/booking-pages`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST / rejects missing title with 400', async ({ request }) => {
    const res = await request.post(`${API}/booking-pages`, {
      headers: auth(),
      data: { durationMins: 30 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/title/i);
  });

  test('happy path — create + update + GET bookings + delete', async ({ request }) => {
    const page = await createPage(request);
    expect(page.slug).toMatch(/e2e/);
    expect(page.durationMins).toBe(30);

    const upd = await request.put(`${API}/booking-pages/${page.id}`, {
      headers: auth(),
      data: { durationMins: 45, description: 'Updated by smoke test' },
    });
    expect(upd.status()).toBe(200);
    const updBody = await upd.json();
    expect(updBody.durationMins).toBe(45);

    const bookings = await request.get(`${API}/booking-pages/${page.id}/bookings`, { headers: auth() });
    expect(bookings.status()).toBe(200);
    expect(Array.isArray(await bookings.json())).toBe(true);

    await deletePage(request, page.id);
  });

  test('PUT 404s for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/booking-pages/99999999`, {
      headers: auth(),
      data: { title: 'no-op' },
    });
    expect(res.status()).toBe(404);
  });

  test('public — GET /public/:slug works without auth + returns shape', async ({ request }) => {
    const page = await createPage(request);
    const res = await request.get(`${API}/booking-pages/public/${page.slug}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe(page.slug);
    expect(body.title).toBe(page.title);
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days.length).toBe(14);
    await deletePage(request, page.id);
  });

  test('public — GET /public/:slug 404s for unknown slug', async ({ request }) => {
    const res = await request.get(`${API}/booking-pages/public/this-slug-does-not-exist-xyz`);
    expect(res.status()).toBe(404);
  });

  test('public — GET /public/:slug/slots rejects bad date with 400', async ({ request }) => {
    const page = await createPage(request);
    const res = await request.get(`${API}/booking-pages/public/${page.slug}/slots?date=not-a-date`);
    expect(res.status()).toBe(400);
    await deletePage(request, page.id);
  });

  test('public — GET /public/:slug/slots returns slots array for a valid date', async ({ request }) => {
    const page = await createPage(request);
    // Pick the first weekday in the next 14 days that has at least one slot
    const detail = await request.get(`${API}/booking-pages/public/${page.slug}`);
    const detailBody = await detail.json();
    const dayWithSlot = detailBody.days.find((d) => d.slotCount > 0);
    test.skip(!dayWithSlot, 'no slot windows in the default availability for the next 14 days');

    const res = await request.get(
      `${API}/booking-pages/public/${page.slug}/slots?date=${dayWithSlot.date}`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.date).toBe(dayWithSlot.date);
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);
    await deletePage(request, page.id);
  });

  test('public — POST /public/:slug/book rejects missing fields with 400', async ({ request }) => {
    const page = await createPage(request);
    const res = await request.post(`${API}/booking-pages/public/${page.slug}/book`, {
      data: { contactName: 'Priya Sharma' },
    });
    expect(res.status()).toBe(400);
    await deletePage(request, page.id);
  });

  test('public — POST /public/:slug/book rejects past scheduledAt with 400', async ({ request }) => {
    const page = await createPage(request);
    const res = await request.post(`${API}/booking-pages/public/${page.slug}/book`, {
      data: {
        contactName: 'Priya Sharma',
        contactEmail: 'priya.sharma+e2e@example.com',
        scheduledAt: '2020-01-01T10:00:00.000Z',
      },
    });
    expect(res.status()).toBe(400);
    await deletePage(request, page.id);
  });

  test('public — happy book + admin cancel', async ({ request }) => {
    const page = await createPage(request);
    const detail = await request.get(`${API}/booking-pages/public/${page.slug}`);
    const detailBody = await detail.json();
    const dayWithSlot = detailBody.days.find((d) => d.slotCount > 0);
    test.skip(!dayWithSlot, 'no slot windows for booking');

    const slotsResp = await request.get(
      `${API}/booking-pages/public/${page.slug}/slots?date=${dayWithSlot.date}`,
    );
    const slotsBody = await slotsResp.json();
    const firstSlot = slotsBody.slots[0];

    const book = await request.post(`${API}/booking-pages/public/${page.slug}/book`, {
      data: {
        contactName: 'Arjun Patel',
        contactEmail: `arjun.patel+e2e_${Date.now()}@example.com`,
        scheduledAt: firstSlot.iso,
        notes: 'Smoke test booking',
      },
    });
    expect(book.status(), `book: ${await book.text()}`).toBe(201);
    const bookBody = await book.json();
    expect(bookBody.success).toBe(true);
    expect(bookBody.booking.status).toBe('CONFIRMED');

    const cancel = await request.post(
      `${API}/booking-pages/${page.id}/cancel/${bookBody.booking.id}`,
      { headers: auth() },
    );
    expect(cancel.status()).toBe(200);
    const cancelBody = await cancel.json();
    expect(cancelBody.status).toBe('CANCELED');

    await deletePage(request, page.id);
  });
});
