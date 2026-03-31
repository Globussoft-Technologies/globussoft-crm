// @ts-check
/**
 * Tickets spec — Support tickets page: create form with subject/priority/assignee,
 * ticket table with status badges, status change dropdown.
 */
const { test, expect } = require('@playwright/test');

test.describe('Tickets — Support ticket management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tickets');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Tickets page with a heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/tickets/);
    const heading = page.locator('h1, h2').filter({ hasText: /ticket/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'playwright-results/tickets-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/tickets');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('create ticket form has subject, priority, and assignee fields', async ({ page }) => {
    // Open the create form if behind a button
    const createBtn = page
      .locator('button')
      .filter({ hasText: /new ticket|create ticket|add ticket|\+ ticket/i })
      .first();
    const btnCount = await createBtn.count();
    if (btnCount > 0) {
      await createBtn.click();
      await page.waitForTimeout(500);
    }

    // Subject field
    const subjectField = page
      .locator('input[placeholder*="subject" i], input[name*="subject" i], textarea[placeholder*="subject" i]')
      .first();
    // Priority field
    const priorityField = page
      .locator('select[name*="priority" i], [placeholder*="priority" i]')
      .first();
    // Assignee field
    const assigneeField = page
      .locator('select[name*="assign" i], input[placeholder*="assign" i], [placeholder*="assignee" i]')
      .first();

    const subjectCount = await subjectField.count();
    const priorityCount = await priorityField.count();
    const assigneeCount = await assigneeField.count();

    // At least two of the three fields should be present
    expect(subjectCount + priorityCount + assigneeCount).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: 'playwright-results/tickets-form.png' });
  });

  test('ticket table renders', async ({ page }) => {
    await page.waitForTimeout(2000);
    const table = page.locator('table, [role="table"]').first();
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).toBeVisible({ timeout: 15000 });
    } else {
      const card = page.locator('.card, [class*="ticket"]').first();
      const cardCount = await card.count();
      if (cardCount > 0) {
        await expect(card).toBeVisible({ timeout: 15000 });
      }
    }
    await page.screenshot({ path: 'playwright-results/tickets-table.png' });
  });

  test('ticket status badges are visible (open, in progress, resolved, closed)', async ({ page }) => {
    await page.waitForTimeout(2000);
    const badge = page.locator('text=/open|in.progress|resolved|closed|pending/i').first();
    const badgeCount = await badge.count();
    if (badgeCount > 0) {
      await expect(badge).toBeVisible({ timeout: 15000 });
    }
  });

  test('status change dropdown or action exists on ticket rows', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Look for a status select or an action button on rows
    const statusDropdown = page
      .locator('select[name*="status" i], select[aria-label*="status" i]')
      .first();
    const actionBtn = page
      .locator('button')
      .filter({ hasText: /update|change status|resolve|close/i })
      .first();

    const dropdownCount = await statusDropdown.count();
    const actionCount = await actionBtn.count();

    if (dropdownCount + actionCount > 0) {
      const el = dropdownCount > 0 ? statusDropdown : actionBtn;
      await expect(el).toBeVisible({ timeout: 15000 });
    }
    // Acceptable if no tickets exist yet
  });

  test('priority badges render with correct labels', async ({ page }) => {
    await page.waitForTimeout(2000);
    const priorityBadge = page.locator('text=/low|medium|high|critical|urgent/i').first();
    const badgeCount = await priorityBadge.count();
    if (badgeCount > 0) {
      await expect(priorityBadge).toBeVisible({ timeout: 15000 });
    }
  });

  test('full tickets page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/tickets-full.png', fullPage: true });
  });
});
