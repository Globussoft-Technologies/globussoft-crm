/**
 * Landing Pages — Investment Installments Auto-Fill (Trip Payment Plan Sync)
 *
 * Tests auto-filling investment installments from TMC trip payment plans
 * when a landing page is linked to a trip, and the /sync-investment endpoint
 * for manual regeneration.
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API_BASE = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

let adminHeaders;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API_BASE}/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) { if (attempt === 0) continue; }
  }
  return null;
}

async function assertOk(response, label) {
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`${label} failed (${response.status()}): ${body.slice(0, 1000)}`);
  }
}

async function createTrip(request, tripCode, destination, pricePerStudent, dayOffsets = [30, 40]) {
  const tripRes = await request.post(`${API_BASE}/travel/trips`, {
    headers: adminHeaders,
    data: {
      tripCode,
      schoolName: 'Test School',
      destination,
      departDate: new Date(Date.now() + dayOffsets[0] * 86400000).toISOString(),
      returnDate: new Date(Date.now() + dayOffsets[1] * 86400000).toISOString(),
      pricePerStudent,
    },
  });
  await assertOk(tripRes, `Create trip ${tripCode}`);
  return await tripRes.json();
}

async function createPaymentPlan(request, tripId, installments, graceDays = 0) {
  // Route contract: PUT /travel/trips/:tripId/payment-plan with instalmentsJson string.
  const planRes = await request.put(`${API_BASE}/travel/trips/${tripId}/payment-plan`, {
    headers: adminHeaders,
    data: {
      graceDays,
      instalmentsJson: JSON.stringify(installments),
    },
  });
  await assertOk(planRes, `Create payment plan for trip ${tripId}`);
  return await planRes.json();
}

async function createLandingPage(request, title, slug, content) {
  const pageRes = await request.post(`${API_BASE}/landing-pages`, {
    headers: adminHeaders,
    data: {
      title,
      slug,
      templateType: 'wanderlux-v1',
      content: JSON.stringify(content),
    },
  });
  await assertOk(pageRes, `Create landing page ${slug}`);
  return await pageRes.json();
}

async function linkPageToTrip(request, pageId, tripId) {
  const linkRes = await request.put(`${API_BASE}/landing-pages/${pageId}`, {
    headers: adminHeaders,
    data: { tripId },
  });
  await assertOk(linkRes, `Link page ${pageId} to trip ${tripId}`);
  return await linkRes.json();
}

test.describe('landing-pages-investment-sync-api', () => {
  test.beforeAll(async ({ request }) => {
    const token = await loginAs(request, 'yasin@travelstall.in', 'password123');
    expect(token, 'travel admin login must succeed').toBeTruthy();
    adminHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  });

  test('POST /landing-pages/:id — auto-fill investment when linking to trip with payment plan', async ({ request }) => {
    const trip = await createTrip(request, 'tmc-test-sync-001', 'Jaipur', 95000);
    await createPaymentPlan(request, trip.id, [
      { dueDate: '2026-04-20', amount: 25000, reminderDays: 7 },
      { dueDate: '2026-05-15', amount: 35000, reminderDays: 7 },
      { dueDate: '2026-06-15', amount: 35000, reminderDays: 7 },
    ]);

    const page = await createLandingPage(request, 'Test Jaipur Page', 'test-jaipur-sync-auto', {
      brand: { name: 'Test Brand' },
      hero: { headline: 'Test' },
      investment: {
        eyebrow: 'Investment',
        title: 'Transparent Pricing',
        installments: [],  // Empty — should auto-fill on link
      },
    });

    const updated = await linkPageToTrip(request, page.id, trip.id);

    const cfg = JSON.parse(updated.content);
    expect(cfg.investment).toBeDefined();
    expect(Array.isArray(cfg.investment.installments)).toBe(true);
    expect(cfg.investment.installments.length).toBe(3);

    const inst0 = cfg.investment.installments[0];
    expect(inst0.tag).toMatch(/^A\. Instalment/);
    expect(inst0.amount).toMatch(/^₹25,000$/);
    expect(inst0.date).toMatch(/20 April 2026/);
    expect(inst0.title).toBe('');
    expect(inst0.sub).toBe('');
    expect(inst0.entity).toBe('');

    const inst1 = cfg.investment.installments[1];
    expect(inst1.tag).toMatch(/^B\. Instalment/);
    expect(inst1.amount).toMatch(/^₹35,000$/);
    expect(inst1.date).toMatch(/15 May 2026/);

    const inst2 = cfg.investment.installments[2];
    expect(inst2.tag).toMatch(/^C\. Instalment/);
    expect(inst2.amount).toMatch(/^₹35,000$/);
    expect(inst2.date).toMatch(/15 June 2026/);
  });

  test('POST /landing-pages/:id/sync-investment — regenerate installments from trip', async ({ request }) => {
    const trip = await createTrip(request, 'tmc-test-sync-002', 'Andaman', 120000, [50, 60]);
    await createPaymentPlan(request, trip.id, [
      { dueDate: '2026-05-01', amount: 40000, reminderDays: 7 },
      { dueDate: '2026-06-01', amount: 40000, reminderDays: 7 },
      { dueDate: '2026-07-01', amount: 40000, reminderDays: 7 },
    ]);

    const page = await createLandingPage(request, 'Test Andaman Page', 'test-andaman-sync-manual', {
      brand: { name: 'Test Brand' },
      hero: { headline: 'Test' },
      investment: {
        eyebrow: 'Investment',
        title: 'Transparent Pricing',
        installments: [
          { tag: 'Old 1', title: 'Old Title', amount: '₹0', date: '2026-01-01', entity: '' },
        ],
      },
    });
    await linkPageToTrip(request, page.id, trip.id);

    const syncRes = await request.post(`${API_BASE}/landing-pages/${page.id}/sync-investment`, {
      headers: adminHeaders,
    });
    await assertOk(syncRes, 'Sync investment');
    const syncData = await syncRes.json();
    expect(syncData.success).toBe(true);
    expect(syncData.message).toMatch(/synced/i);
    expect(Array.isArray(syncData.installments)).toBe(true);
    expect(syncData.installments.length).toBe(3);

    expect(syncData.installments[0].amount).toMatch(/^₹40,000$/);
    expect(syncData.installments[0].tag).toMatch(/^A\. Instalment/);
    expect(syncData.installments[0].date).toMatch(/1 May 2026/);
  });

  test('POST /landing-pages/:id/sync-investment — 404 when page not found', async ({ request }) => {
    const syncRes = await request.post(`${API_BASE}/landing-pages/99999/sync-investment`, {
      headers: adminHeaders,
    });
    expect(syncRes.status()).toBe(404);
    const err = await syncRes.json();
    expect(err.code).toBe('PAGE_NOT_FOUND');
  });

  test('POST /landing-pages/:id/sync-investment — 400 when page has no trip linked', async ({ request }) => {
    const page = await createLandingPage(request, 'Unlinked Page', 'test-unlinked-sync', {
      brand: { name: 'Test' },
      hero: { headline: 'Test' },
      investment: { installments: [] },
    });

    const syncRes = await request.post(`${API_BASE}/landing-pages/${page.id}/sync-investment`, {
      headers: adminHeaders,
    });
    expect(syncRes.status()).toBe(400);
    const err = await syncRes.json();
    expect(err.code).toBe('NO_TRIP_LINKED');
  });

  test('POST /landing-pages/:id/sync-investment — 400 when trip has no payment plan', async ({ request }) => {
    const trip = await createTrip(request, 'tmc-test-no-plan', 'Kerala', 85000, [70, 80]);

    const page = await createLandingPage(request, 'Kerala Page', 'test-kerala-sync', {
      brand: { name: 'Test' },
      hero: { headline: 'Test' },
      investment: { installments: [] },
    });
    await linkPageToTrip(request, page.id, trip.id);

    const syncRes = await request.post(`${API_BASE}/landing-pages/${page.id}/sync-investment`, {
      headers: adminHeaders,
    });
    expect(syncRes.status()).toBe(400);
    const err = await syncRes.json();
    expect(err.code).toBe('NO_PAYMENT_PLAN');
  });

  test('Linking page to trip with existing installments does NOT overwrite', async ({ request }) => {
    const trip = await createTrip(request, 'tmc-test-preserve', 'Goa', 75000, [90, 100]);
    await createPaymentPlan(request, trip.id, [
      { dueDate: '2026-08-01', amount: 25000, reminderDays: 7 },
      { dueDate: '2026-09-01', amount: 25000, reminderDays: 7 },
      { dueDate: '2026-10-01', amount: 25000, reminderDays: 7 },
    ]);

    const page = await createLandingPage(request, 'Goa Page', 'test-goa-preserve', {
      brand: { name: 'Test' },
      hero: { headline: 'Test' },
      investment: {
        installments: [
          { tag: 'Custom 1', title: 'Custom Title', amount: '₹50,000', date: '2026-12-01', entity: 'Custom Vendor' },
        ],
      },
    });

    const updated = await linkPageToTrip(request, page.id, trip.id);

    const cfg = JSON.parse(updated.content);
    expect(cfg.investment.installments.length).toBe(1);
    expect(cfg.investment.installments[0].tag).toBe('Custom 1');
    expect(cfg.investment.installments[0].amount).toBe('₹50,000');
  });
});
