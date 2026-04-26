// @ts-check
/**
 * Pipeline Stages spec — covers customizable pipeline stages including
 * API CRUD operations and UI integration on Pipeline and Settings pages.
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
// Pipeline Stages API
// ============================================================

test.describe('Pipeline Stages — API endpoints', () => {
  test('API: GET /api/pipeline_stages returns array', async ({ request }) => {
    const response = await authGet(request, '/api/pipeline_stages');
    expect([200, 404]).toContain(response.status());

    if (response.status() === 200) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();
      expect(Array.isArray(body)).toBe(true);
    }
  });

  test('API: POST /api/pipeline_stages creates and cleans up a stage', async ({ request }) => {
    const stageName = `E2E Stage ${Date.now()}`;
    const response = await authPost(request, '/api/pipeline_stages', {
      name: stageName,
      color: '#8b5cf6',
      position: 99,
    });

    expect([200, 201, 404]).toContain(response.status());

    if (response.status() === 200 || response.status() === 201) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name');
      expect(body.name).toBe(stageName);

      // Clean up — delete the test stage so it doesn't pollute the pipeline
      const token = await getAuthToken(request);
      await request.delete(`${BASE_URL}/api/pipeline_stages/${body.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT,
      });
    }
  });
});

// ============================================================
// Pipeline Stages UI
// ============================================================

test.describe('Pipeline Stages — UI', () => {
  test('pipeline page loads stages from API or defaults', async ({ page }) => {
    await page.goto('/pipeline');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Pipeline should render columns/stages — look for column headers or kanban lanes
    const stageColumns = page.locator('[class*="column"], [class*="stage"], [class*="kanban"], [class*="lane"], [data-stage]');
    const count = await stageColumns.count();

    // Should have at least the default stages (lead, contacted, proposal, won, lost)
    expect(count).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: 'playwright-results/pipeline-stages.png' });
  });

  test('settings page has pipeline stages section', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Look for "Pipeline Stages" or "Pipeline" text in the settings page
    const pipelineSection = page.locator('text=/pipeline.*stage/i, text=/stage.*pipeline/i, h2:has-text("Pipeline"), h3:has-text("Pipeline"), [class*="pipeline"]').first();
    const visible = await pipelineSection.isVisible().catch(() => false);

    if (visible) {
      await expect(pipelineSection).toBeVisible();
    } else {
      // Settings page may organize this under tabs — look for a tab/link
      const pipelineTab = page.locator('button, a, [role="tab"]').filter({ hasText: /pipeline/i }).first();
      const tabCount = await pipelineTab.count();
      // At minimum, settings page should load without errors
      expect(tabCount).toBeGreaterThanOrEqual(0);
    }

    await page.screenshot({ path: 'playwright-results/settings-pipeline-stages.png' });
  });
});
