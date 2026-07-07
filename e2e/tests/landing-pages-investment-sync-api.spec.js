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
    // Create a TMC trip with a payment plan
    const tripRes = await request.post(`${API_BASE}/travel/trips`, {
      headers: adminHeaders,
      data: {
        tripCode: 'tmc-test-sync-001',
        schoolName: "Test School",
        destination: 'Jaipur',
        departDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        returnDate: new Date(Date.now() + 40 * 86400000).toISOString(),
        pricePerStudent: 95000,
      },
    });
    expect(tripRes.ok()).toBeTruthy();
    const trip = await tripRes.json();
    const tripId = trip.id;

    // Create a payment plan for the trip
    const planRes = await request.post(`${API_BASE}/travel/trips/${tripId}/payment-plan`, {
      headers: adminHeaders,
      data: {
        graceDays: 0,
        installments: [
          { dueDate: '2026-04-20', amount: 25000, reminderDays: 7 },
          { dueDate: '2026-05-15', amount: 35000, reminderDays: 7 },
          { dueDate: '2026-06-15', amount: 35000, reminderDays: 7 },
        ],
      },
    });
    expect(planRes.ok()).toBeTruthy();

    // Create a wanderlux-v1 landing page WITHOUT investment installments
    const pageRes = await request.post(`${API_BASE}/landing-pages`, {
      headers: adminHeaders,
      data: {
        title: 'Test Jaipur Page',
        slug: 'test-jaipur-sync-auto',
        templateType: 'wanderlux-v1',
        content: JSON.stringify({
          brand: { name: 'Test Brand' },
          hero: { headline: 'Test' },
          investment: {
            eyebrow: 'Investment',
            title: 'Transparent Pricing',
            installments: [],  // Empty — should auto-fill on link
          },
        }),
      },
    });
    expect(pageRes.ok()).toBeTruthy();
    const page = await pageRes.json();
    const pageId = page.id;

    // Link the page to the trip via PUT
    const linkRes = await request.put(`${API_BASE}/landing-pages/${pageId}`, {
      headers: adminHeaders,
      data: { tripId },
    });
    expect(linkRes.ok()).toBeTruthy();
    const updated = await linkRes.json();

    // Verify investment.installments were auto-filled
    const cfg = JSON.parse(updated.content);
    expect(cfg.investment).toBeDefined();
    expect(Array.isArray(cfg.investment.installments)).toBe(true);
    expect(cfg.investment.installments.length).toBe(3);

    // Verify structure and formatting
    const inst0 = cfg.investment.installments[0];
    expect(inst0.tag).toMatch(/^A\. Instalment/);
    expect(inst0.amount).toMatch(/^₹25,000$/);
    expect(inst0.date).toMatch(/20th April 2026/);
    expect(inst0.title).toBe(''); // Operator must fill
    expect(inst0.sub).toBe('');
    expect(inst0.entity).toBe('');

    const inst1 = cfg.investment.installments[1];
    expect(inst1.tag).toMatch(/^B\. Instalment/);
    expect(inst1.amount).toMatch(/^₹35,000$/);
    expect(inst1.date).toMatch(/15th May 2026/);

    const inst2 = cfg.investment.installments[2];
    expect(inst2.tag).toMatch(/^C\. Instalment/);
    expect(inst2.amount).toMatch(/^₹35,000$/);
    expect(inst2.date).toMatch(/15th June 2026/);
  });

  test('POST /landing-pages/:id/sync-investment — regenerate installments from trip', async ({ request }) => {
    // Create trip with payment plan (reuse the one from above or create new)
    const tripRes = await request.post(`${API_BASE}/travel/trips`, {
      headers: adminHeaders,
      data: {
        tripCode: 'tmc-test-sync-002',
        schoolName: "Test School",
        destination: 'Andaman',
        departDate: new Date(Date.now() + 50 * 86400000).toISOString(),
        returnDate: new Date(Date.now() + 60 * 86400000).toISOString(),
        pricePerStudent: 120000,
      },
    });
    expect(tripRes.ok()).toBeTruthy();
    const trip = await tripRes.json();
    const tripId = trip.id;

    // Create payment plan
    const planRes = await request.post(`${API_BASE}/travel/trips/${tripId}/payment-plan`, {
      headers: adminHeaders,
      data: {
        graceDays: 0,
        installments: [
          { dueDate: '2026-05-01', amount: 40000, reminderDays: 7 },
          { dueDate: '2026-06-01', amount: 40000, reminderDays: 7 },
          { dueDate: '2026-07-01', amount: 40000, reminderDays: 7 },
        ],
      },
    });
    expect(planRes.ok()).toBeTruthy();

    // Create linked wanderlux page (with some existing but different installments)
    const pageRes = await request.post(`${API_BASE}/landing-pages`, {
      headers: adminHeaders,
      data: {
        title: 'Test Andaman Page',
        slug: 'test-andaman-sync-manual',
        templateType: 'wanderlux-v1',
        tripId,
        content: JSON.stringify({
          brand: { name: 'Test Brand' },
          hero: { headline: 'Test' },
          investment: {
            eyebrow: 'Investment',
            title: 'Transparent Pricing',
            installments: [
              { tag: 'Old 1', title: 'Old Title', amount: '₹0', date: '2026-01-01', entity: '' },
            ],
          },
        }),
      },
    });
    expect(pageRes.ok()).toBeTruthy();
    const page = await pageRes.json();
    const pageId = page.id;

    // Call /sync-investment to regenerate from trip
    const syncRes = await request.post(`${API_BASE}/landing-pages/${pageId}/sync-investment`, {
      headers: adminHeaders,
    });
    expect(syncRes.ok()).toBeTruthy();
    const syncData = await syncRes.json();
    expect(syncData.success).toBe(true);
    expect(syncData.message).toMatch(/synced/i);
    expect(Array.isArray(syncData.installments)).toBe(true);
    expect(syncData.installments.length).toBe(3);

    // Verify updated amounts (should match trip payment plan)
    expect(syncData.installments[0].amount).toMatch(/^₹40,000$/);
    expect(syncData.installments[0].tag).toMatch(/^A\. Instalment/);
    expect(syncData.installments[0].date).toMatch(/1st May 2026/);
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
    // Create a wanderlux page without tripId
    const pageRes = await request.post(`${API_BASE}/landing-pages`, {
      headers: adminHeaders,
      data: {
        title: 'Unlinked Page',
        slug: 'test-unlinked-sync',
        templateType: 'wanderlux-v1',
        content: JSON.stringify({
          brand: { name: 'Test' },
          hero: { headline: 'Test' },
          investment: { installments: [] },
        }),
      },
    });
    expect(pageRes.ok()).toBeTruthy();
    const page = await pageRes.json();

    const syncRes = await request.post(`${API_BASE}/landing-pages/${page.id}/sync-investment`, {
      headers: adminHeaders,
    });
    expect(syncRes.status()).toBe(400);
    const err = await syncRes.json();
    expect(err.code).toBe('NO_TRIP_LINKED');
  });

  test('POST /landing-pages/:id/sync-investment — 400 when trip has no payment plan', async ({ request }) => {
    // Create trip without payment plan
    const tripRes = await request.post(`${API_BASE}/travel/trips`, {
      headers: adminHeaders,
      data: {
        tripCode: 'tmc-test-no-plan',
        schoolName: "Test School",
        destination: 'Kerala',
        departDate: new Date(Date.now() + 70 * 86400000).toISOString(),
        returnDate: new Date(Date.now() + 80 * 86400000).toISOString(),
        pricePerStudent: 85000,
      },
    });
    expect(tripRes.ok()).toBeTruthy();
    const trip = await tripRes.json();

    // Create page linked to this trip
    const pageRes = await request.post(`${API_BASE}/landing-pages`, {
      headers: adminHeaders,
      data: {
        title: 'Kerala Page',
        slug: 'test-kerala-sync',
        templateType: 'wanderlux-v1',
        tripId: trip.id,
        content: JSON.stringify({
          brand: { name: 'Test' },
          hero: { headline: 'Test' },
          investment: { installments: [] },
        }),
      },
    });
    expect(pageRes.ok()).toBeTruthy();
    const page = await pageRes.json();

    const syncRes = await request.post(`${API_BASE}/landing-pages/${page.id}/sync-investment`, {
      headers: adminHeaders,
    });
    expect(syncRes.status()).toBe(400);
    const err = await syncRes.json();
    expect(err.code).toBe('NO_PAYMENT_PLAN');
  });

  test('Linking page to trip with existing installments does NOT overwrite', async ({ request }) => {
    // Create trip with payment plan
    const tripRes = await request.post(`${API_BASE}/travel/trips`, {
      headers: adminHeaders,
      data: {
        tripCode: 'tmc-test-preserve',
        schoolName: "Test School",
        destination: 'Goa',
        departDate: new Date(Date.now() + 90 * 86400000).toISOString(),
        returnDate: new Date(Date.now() + 100 * 86400000).toISOString(),
        pricePerStudent: 75000,
      },
    });
    expect(tripRes.ok()).toBeTruthy();
    const trip = await tripRes.json();

    const planRes = await request.post(`${API_BASE}/travel/trips/${trip.id}/payment-plan`, {
      headers: adminHeaders,
      data: {
        graceDays: 0,
        installments: [
          { dueDate: '2026-08-01', amount: 25000, reminderDays: 7 },
          { dueDate: '2026-09-01', amount: 25000, reminderDays: 7 },
          { dueDate: '2026-10-01', amount: 25000, reminderDays: 7 },
        ],
      },
    });
    expect(planRes.ok()).toBeTruthy();

    // Create page with EXISTING installments
    const pageRes = await request.post(`${API_BASE}/landing-pages`, {
      headers: adminHeaders,
      data: {
        title: 'Goa Page',
        slug: 'test-goa-preserve',
        templateType: 'wanderlux-v1',
        content: JSON.stringify({
          brand: { name: 'Test' },
          hero: { headline: 'Test' },
          investment: {
            installments: [
              { tag: 'Custom 1', title: 'Custom Title', amount: '₹50,000', date: '2026-12-01', entity: 'Custom Vendor' },
            ],
          },
        }),
      },
    });
    expect(pageRes.ok()).toBeTruthy();
    const page = await pageRes.json();

    // Link to trip
    const linkRes = await request.put(`${API_BASE}/landing-pages/${page.id}`, {
      headers: adminHeaders,
      data: { tripId: trip.id },
    });
    expect(linkRes.ok()).toBeTruthy();
    const updated = await linkRes.json();

    // Verify existing installments were PRESERVED (not overwritten)
    const cfg = JSON.parse(updated.content);
    expect(cfg.investment.installments.length).toBe(1);
    expect(cfg.investment.installments[0].tag).toBe('Custom 1');
    expect(cfg.investment.installments[0].amount).toBe('₹50,000');
  });
});
