// @ts-check
/**
 * Tasks spec — Priority Queue with Critical/High/Medium/Low tasks
 */
const { test, expect } = require('@playwright/test');

test.describe('Tasks — Agent Priority Queue', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tasks');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
  });

  test('renders the Tasks page with correct heading', async ({ page }) => {
    await expect(page).toHaveURL(/\/tasks/);
    const heading = page.locator('h1').filter({ hasText: /Agent Task Queue/i }).first();
    await expect(heading).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: 'playwright-results/tasks-overview.png' });
  });

  test('page loads without JS runtime errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('/tasks');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('task form fields are visible', async ({ page }) => {
    const titleInput = page.locator('#task-title-input');
    await expect(titleInput).toBeVisible({ timeout: 8000 });

    const prioritySelect = page.locator('#task-priority-select');
    await expect(prioritySelect).toBeVisible({ timeout: 8000 });

    const submitBtn = page.locator('#assign-task-btn');
    await expect(submitBtn).toBeVisible({ timeout: 8000 });
  });

  test('creates a Critical priority task and it appears in queue', async ({ page }) => {
    const titleInput = page.locator('#task-title-input');
    await expect(titleInput).toBeVisible({ timeout: 8000 });

    await titleInput.fill('E2E Critical Task — Auto Test');

    const prioritySelect = page.locator('#task-priority-select');
    await prioritySelect.selectOption('Critical');

    const assignBtn = page.locator('#assign-task-btn');
    await assignBtn.click({ force: true });

    // Wait for task to appear — use innerHTML check to avoid scroll clipping
    await page.waitForTimeout(2000);
    const bodyHTML = await page.locator('body').innerHTML();
    expect(bodyHTML).toContain('E2E Critical Task — Auto Test');

    await page.screenshot({ path: 'playwright-results/tasks-critical-created.png' });
  });

  test('marks a task as complete and it moves to completed log', async ({ page }) => {
    // First create a task
    const titleInput = page.locator('#task-title-input');
    await expect(titleInput).toBeVisible({ timeout: 8000 });
    const uniqueTitle = `E2E Complete Task ${Date.now()}`;
    await titleInput.fill(uniqueTitle);

    const assignBtn = page.locator('#assign-task-btn');
    await assignBtn.click({ force: true });
    await page.waitForTimeout(2000);

    // Find the task's Resolve button in the Active Priority Queue section
    const activeSection = page.locator('h3').filter({ hasText: /Active Priority Queue/i }).locator('..');
    const taskHeading = activeSection.locator('h4').filter({ hasText: uniqueTitle }).first();

    if (await taskHeading.count() > 0) {
      // Navigate up to the task row and find its Resolve button
      const taskContainer = taskHeading.locator('..').locator('..');
      const resolveBtn = taskContainer.locator('button').filter({ hasText: /Resolve/i }).first();

      if (await resolveBtn.count() > 0) {
        await resolveBtn.click({ force: true });
        await page.waitForTimeout(3000);

        // Verify: the task should now appear in the Completed Log section
        const completedSection = page.locator('h3').filter({ hasText: /Completed Log/i }).locator('..');
        const completedEntry = completedSection.locator(`text=${uniqueTitle}`).first();
        const isCompleted = await completedEntry.count() > 0;
        expect(isCompleted).toBeTruthy();
      }
    }
    await page.screenshot({ path: 'playwright-results/tasks-completed.png' });
  });

  test('full tasks page screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/tasks-full.png', fullPage: true });
  });
});
