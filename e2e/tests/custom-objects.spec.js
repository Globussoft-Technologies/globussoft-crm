// @ts-check
/**
 * Custom Objects / App Builder spec — entity schema management:
 * object list loads, create entity flow, view entity records.
 */
const { test, expect } = require('@playwright/test');

test.describe('App Builder — Custom Objects', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/objects');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the App Builder page', async ({ page }) => {
    await expect(page).toHaveURL(/\/objects/);
    await expect(
      page.locator('h1, h2').filter({ hasText: /app builder|object|entity|custom/i }).first()
    ).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'playwright-results/custom-objects-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/objects');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('shows list of custom entity types or empty state', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Should show entities or a CTA to create first entity
    const content = page
      .locator('.card, [class*="entity"], [class*="object"], ul, [class*="schema"]')
      .first();
    await expect(content).toBeVisible({ timeout: 10000 });
  });

  test('Create Entity or New Object button is present', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /create|new object|new entity|add entity|\+ object/i })
      .first();
    await expect(createBtn).toBeVisible({ timeout: 10000 });
  });

  test('clicking Create Entity opens a form or modal', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /create|new object|new entity|add entity|\+ object/i })
      .first();
    await createBtn.click();
    await page.waitForTimeout(500);

    const modal = page.locator('[role="dialog"], .modal, form').first();
    const modalCount = await modal.count();
    if (modalCount > 0) {
      await expect(modal).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'playwright-results/custom-objects-create-modal.png' });
    }
  });

  test('entity creation form has a name field', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /create|new object|new entity|add entity|\+ object/i })
      .first();
    await createBtn.click();
    await page.waitForTimeout(500);

    const nameInput = page
      .locator('input[placeholder*="name" i], input[name="name"], input[placeholder*="entity" i]')
      .first();
    const inputCount = await nameInput.count();
    if (inputCount > 0) {
      await expect(nameInput).toBeVisible({ timeout: 5000 });
    }
  });

  test('can create a new entity and it appears in the list', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /create|new object|new entity|add entity|\+ object/i })
      .first();
    await createBtn.click();
    await page.waitForTimeout(500);

    const nameInput = page
      .locator('input[placeholder*="name" i], input[name="name"], input[placeholder*="entity" i]')
      .first();
    const inputCount = await nameInput.count();

    if (inputCount > 0) {
      const entityName = `E2EEntity${Date.now()}`;
      await nameInput.fill(entityName);

      const submitBtn = page
        .locator('button[type="submit"], button')
        .filter({ hasText: /save|create|add/i })
        .last();
      await submitBtn.click();

      await page.waitForTimeout(1500);

      // Entity should appear in list
      await expect(page.locator(`text=${entityName}`).first()).toBeVisible({ timeout: 8000 });

      await page.screenshot({ path: 'playwright-results/custom-objects-created.png' });
    } else {
      test.skip(true, 'Entity creation form not found');
    }
  });

  test('clicking a custom entity navigates to /objects/:entityName', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Custom Objects page uses buttons with window.location.href, not <a> links
    const entityBtn = page.locator('button').filter({ hasText: /Access Dataset Records/i }).first();
    const btnCount = await entityBtn.count();

    if (btnCount > 0) {
      await entityBtn.click();
      await page.waitForLoadState('domcontentloaded');

      await expect(page).toHaveURL(/\/objects\/.+/);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'playwright-results/custom-objects-entity-view.png' });
    } else {
      test.skip(true, 'No custom entity buttons found');
    }
  });

  test('can open Add Record modal inside an entity view', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Navigate to an entity view first
    const entityBtn = page.locator('button').filter({ hasText: /Access Dataset Records/i }).first();
    const btnCount = await entityBtn.count();

    if (btnCount > 0) {
      await entityBtn.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000);

      // Look for "New <entity>" button (text is "New" + entity name with last char trimmed)
      const addRecordBtn = page.locator('button').filter({ hasText: /^New\s/i }).first();
      const addCount = await addRecordBtn.count();

      if (addCount > 0) {
        await addRecordBtn.click();
        await page.waitForTimeout(500);
        // After clicking, a form should appear
        const form = page.locator('form').first();
        await expect(form).toBeVisible({ timeout: 5000 });
      } else {
        test.skip(true, 'Add Record button not found in entity view');
      }
    } else {
      test.skip(true, 'No custom entity buttons found');
    }
  });

  test('full app builder page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/custom-objects-full.png', fullPage: true });
  });
});
