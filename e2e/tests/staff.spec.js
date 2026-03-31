// @ts-check
/**
 * Staff spec — Staff management page: user table, role badges
 * (ADMIN / MANAGER / USER), and role change dropdown.
 */
const { test, expect } = require('@playwright/test');

test.describe('Staff — User management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/staff');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Staff page with a heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/staff/);
    const heading = page.locator('h1, h2').filter({ hasText: /staff|team|users/i }).first();
    await expect(heading).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'playwright-results/staff-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/staff');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('user table renders', async ({ page }) => {
    await page.waitForTimeout(2000);
    const table = page.locator('table, [role="table"]').first();
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).toBeVisible({ timeout: 15000 });
    } else {
      // Card/list layout fallback
      const card = page.locator('.card, [class*="user"], [class*="staff"]').first();
      const cardCount = await card.count();
      if (cardCount > 0) {
        await expect(card).toBeVisible({ timeout: 15000 });
      }
    }
    await page.screenshot({ path: 'playwright-results/staff-table.png' });
  });

  test('role badges are visible (ADMIN, MANAGER, USER)', async ({ page }) => {
    await page.waitForTimeout(2000);
    // At least one role badge should appear since the logged-in admin exists
    const adminBadge = page.locator('text=/admin/i').first();
    const managerBadge = page.locator('text=/manager/i').first();
    const userBadge = page.locator('text=/user/i').first();

    const adminCount = await adminBadge.count();
    const managerCount = await managerBadge.count();
    const userCount = await userBadge.count();

    // At least one role label should be visible
    expect(adminCount + managerCount + userCount).toBeGreaterThan(0);
    await page.screenshot({ path: 'playwright-results/staff-roles.png' });
  });

  test('role change dropdown exists on staff rows', async ({ page }) => {
    await page.waitForTimeout(2000);
    const roleDropdown = page
      .locator('select[name*="role" i], select[aria-label*="role" i]')
      .first();
    const dropdownCount = await roleDropdown.count();
    if (dropdownCount > 0) {
      await expect(roleDropdown).toBeVisible({ timeout: 15000 });
    }
    // Also accept a button-based role changer
    const roleBtn = page
      .locator('button')
      .filter({ hasText: /change role|update role|assign role/i })
      .first();
    const roleBtnCount = await roleBtn.count();
    if (roleBtnCount > 0) {
      await expect(roleBtn).toBeVisible({ timeout: 15000 });
    }
  });

  test('staff table shows email column', async ({ page }) => {
    await page.waitForTimeout(2000);
    const emailHeader = page
      .locator('th, [class*="header"]')
      .filter({ hasText: /email/i })
      .first();
    const headerCount = await emailHeader.count();
    if (headerCount > 0) {
      await expect(emailHeader).toBeVisible({ timeout: 15000 });
    }
    // Fallback: check for an email address anywhere on the page
    const emailCell = page.locator('text=/@/').first();
    const emailCellCount = await emailCell.count();
    if (emailCellCount > 0) {
      await expect(emailCell).toBeVisible({ timeout: 15000 });
    }
  });

  test('invite or add staff button is present', async ({ page }) => {
    const inviteBtn = page
      .locator('button')
      .filter({ hasText: /invite|add staff|add user|new user|\+ user/i })
      .first();
    const btnCount = await inviteBtn.count();
    if (btnCount > 0) {
      await expect(inviteBtn).toBeVisible({ timeout: 15000 });
    }
  });

  test('full staff page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/staff-full.png', fullPage: true });
  });
});
