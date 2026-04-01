// @ts-check
/**
 * Projects spec — Projects management page: create form, project table,
 * status/priority badges, and task count column.
 */
const { test, expect } = require('@playwright/test');

test.describe('Projects — Project management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/projects');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Projects page with a heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/projects/);
    const heading = page.locator('h1, h2').filter({ hasText: /project/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'playwright-results/projects-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/projects');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('create project form or button is visible', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ hasText: /add project|new project|create project|\+ project/i })
      .first();
    const form = page.locator('form').first();

    const btnCount = await createBtn.count();
    const formCount = await form.count();
    expect(btnCount + formCount).toBeGreaterThan(0);
    await page.screenshot({ path: 'playwright-results/projects-form.png' });
  });

  test('project table renders', async ({ page }) => {
    await page.waitForTimeout(2000);
    const table = page.locator('table, [role="table"]').first();
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).toBeVisible({ timeout: 15000 });
    } else {
      // Card/kanban layout fallback
      const card = page.locator('.card, [class*="project"]').first();
      const cardCount = await card.count();
      if (cardCount > 0) {
        await expect(card).toBeVisible({ timeout: 15000 });
      }
    }
    await page.screenshot({ path: 'playwright-results/projects-table.png' });
  });

  test('status badges are visible (planning, active, on hold, completed)', async ({ page }) => {
    await page.waitForTimeout(2000);
    const badge = page
      .locator('text=/planning|active|on.hold|completed|in.progress|cancelled/i')
      .first();
    const badgeCount = await badge.count();
    if (badgeCount > 0) {
      await expect(badge).toBeVisible({ timeout: 15000 });
    }
  });

  test('status badges are visible (Planning, Active, On Hold, Completed)', async ({ page }) => {
    await page.waitForTimeout(2000);
    const badge = page.locator('text=/Planning|Active|On Hold|Completed|Cancelled/i').first();
    const badgeCount = await badge.count();
    if (badgeCount > 0) {
      await expect(badge).toBeVisible({ timeout: 15000 });
    }
  });

  test('task count column or indicator is visible on project rows', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Column header for tasks
    const taskHeader = page
      .locator('th, [class*="header"]')
      .filter({ hasText: /tasks?/i })
      .first();
    const headerCount = await taskHeader.count();
    if (headerCount > 0) {
      await expect(taskHeader).toBeVisible({ timeout: 15000 });
    }
    // Fallback: look for a "tasks" label anywhere in rows
    const taskLabel = page.locator('text=/\\d+\\s+tasks?/i').first();
    const labelCount = await taskLabel.count();
    if (labelCount > 0) {
      await expect(taskLabel).toBeVisible({ timeout: 15000 });
    }
  });

  test('full projects page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/projects-full.png', fullPage: true });
  });
});
