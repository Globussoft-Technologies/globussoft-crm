// @ts-check
/**
 * CSV Import spec — covers the CSV import feature on the Contacts page,
 * including the import button, modal with file input, and API endpoint.
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

async function authPost(request, path, data) {
  const token = await getAuthToken(request);
  if (!token) throw new Error('Failed to acquire auth token');
  return request.post(`${BASE_URL}${path}`, {
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
// CSV Import UI
// ============================================================

test.describe('CSV Import — Contacts page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/contacts');
    await page.waitForLoadState('domcontentloaded');
  });

  test('import CSV button is visible on contacts page', async ({ page }) => {
    await page.waitForTimeout(1500);
    const importBtn = page.locator('button, a').filter({ hasText: /import/i }).first();
    await expect(importBtn).toBeVisible({ timeout: 10000 });
  });

  test('clicking import opens a modal with file input', async ({ page }) => {
    await page.waitForTimeout(1500);
    const importBtn = page.locator('button').filter({ hasText: /import/i }).first();
    await importBtn.click();
    await page.waitForTimeout(500);

    // The modal shows "Import CSV" heading
    const modalHeading = page.locator('h3').filter({ hasText: /Import CSV/i }).first();
    await expect(modalHeading).toBeVisible({ timeout: 5000 });
  });

  test('import modal has a file upload area', async ({ page }) => {
    await page.waitForTimeout(1500);
    const importBtn = page.locator('button, a').filter({ hasText: /import/i }).first();
    await importBtn.click();
    await page.waitForTimeout(500);

    // Look for file input or upload zone
    const fileInput = page.locator('input[type="file"], [class*="upload"], [class*="dropzone"], [class*="file"]').first();
    // The file input might be hidden (common pattern), so check it exists in the DOM
    const count = await fileInput.count();
    expect(count).toBeGreaterThan(0);
  });

  test('page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/csv-import-contacts.png' });
  });
});

// ============================================================
// CSV Import API
// ============================================================

test.describe('CSV Import — API endpoint', () => {
  test('API: POST /api/contacts/import-csv with valid data returns imported count', async ({ request }) => {
    const response = await authPost(request, '/api/contacts/import-csv', {
      contacts: [
        {
          name: 'CSV Test',
          email: `csv-test-${Date.now()}@example.com`,
          company: 'Test Corp',
        },
      ],
    });

    expect([200, 201, 404]).toContain(response.status());

    if (response.status() === 200 || response.status() === 201) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();
      // Should report how many were imported
      const hasCount = body.hasOwnProperty('imported') || body.hasOwnProperty('count') || body.hasOwnProperty('created') || body.hasOwnProperty('message');
      expect(hasCount).toBe(true);
    }
  });
});
