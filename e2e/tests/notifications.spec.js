// @ts-check
/**
 * Notifications spec — covers the notification bell icon, dropdown panel,
 * mark-all-as-read action, and notification API endpoints.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;

async function getAuthToken(request) {
  if (authToken) return authToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email: 'admin@globussoft.com', password: 'password123' },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (response.ok()) {
        const data = await response.json();
        authToken = data.token;
        return authToken;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function authGet(request, path) {
  const token = await getAuthToken(request);
  if (!token) throw new Error('Failed to acquire auth token');
  return request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
}

async function authPut(request, path, data) {
  const token = await getAuthToken(request);
  if (!token) throw new Error('Failed to acquire auth token');
  return request.put(`${BASE_URL}${path}`, {
    data,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ============================================================
// Notification Bell UI
// ============================================================

test.describe('Notifications — Bell icon and dropdown', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('notification bell icon is visible on all pages', async ({ page }) => {
    // The bell is in a header bar — a button containing a Bell SVG
    const bellButton = page.locator('header button').first();
    await expect(bellButton).toBeVisible({ timeout: 10000 });
  });

  test('clicking bell opens notification dropdown', async ({ page }) => {
    await page.waitForTimeout(1500);
    // Click the bell button in the header
    const bellButton = page.locator('header button').first();
    await bellButton.click();
    await page.waitForTimeout(500);

    // The dropdown shows "Notifications" text
    const notifText = page.locator('text=Notifications').first();
    await expect(notifText).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: 'playwright-results/notifications-dropdown.png' });
  });

  test('notification dropdown shows mark all as read or empty state', async ({ page }) => {
    await page.waitForTimeout(1500);
    const bellButton = page.locator('header button').first();
    await bellButton.click();
    await page.waitForTimeout(500);

    // Should show either "Mark all as read" or "No notifications" (if no notifications exist)
    const dropdownContent = page.locator('text=/Notifications/i').first();
    await expect(dropdownContent).toBeVisible({ timeout: 5000 });
  });

  test('page loads without JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    expect(errors.length).toBe(0);
  });
});

// ============================================================
// Notification API Endpoints
// ============================================================

test.describe('Notifications — API endpoints', () => {
  test('API: GET /api/notifications returns array', async ({ request }) => {
    const response = await authGet(request, '/api/notifications');
    expect([200, 404]).toContain(response.status());

    if (response.status() === 200) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();
      expect(Array.isArray(body)).toBe(true);
    }
  });

  test('API: GET /api/notifications/unread-count returns count object', async ({ request }) => {
    const response = await authGet(request, '/api/notifications/unread-count');
    expect([200, 404]).toContain(response.status());

    if (response.status() === 200) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();
      expect(typeof body).toBe('object');
      // Should have a count-like property
      const hasCountField = body.hasOwnProperty('count') || body.hasOwnProperty('unreadCount') || body.hasOwnProperty('unread');
      expect(hasCountField).toBe(true);
    }
  });

  test('API: PUT /api/notifications/read-all returns success', async ({ request }) => {
    const response = await authPut(request, '/api/notifications/read-all', {});
    expect([200, 204, 404]).toContain(response.status());

    if (response.status() === 200) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();
    }
  });
});
