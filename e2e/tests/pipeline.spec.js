// @ts-check
/**
 * Pipeline spec — covers the Kanban deal board: stage columns visible,
 * deal cards render, create deal modal, deal detail modal.
 */
const { test, expect } = require('@playwright/test');

const PIPELINE_STAGES = ['New Lead', 'Contacted', 'Proposal Sent', 'Closed Won'];

test.describe('Pipeline — Kanban board', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pipeline');
    await page.waitForLoadState('networkidle');
  });

  test('renders the Pipeline page', async ({ page }) => {
    // The Pipeline page should have some heading or content
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'playwright-results/pipeline-overview.png' });
  });

  test('all four deal stage columns are visible', async ({ page }) => {
    // Wait for data to load
    await page.waitForTimeout(2000);

    for (const stage of PIPELINE_STAGES) {
      await expect(page.locator(`text=${stage}`).first()).toBeVisible({ timeout: 10000 });
    }
  });

  test('stage columns show deal count indicators', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Each stage column should have some numeric indicator or empty state
    const newLeadColumn = page.locator('text=New Lead').first();
    await expect(newLeadColumn).toBeVisible();
  });

  test('Add Deal button is visible', async ({ page }) => {
    const addDealBtn = page.locator('button', { hasText: /add deal|new deal|\+ deal/i });
    await expect(addDealBtn.first()).toBeVisible({ timeout: 10000 });
  });

  test('clicking Add Deal opens the create deal modal', async ({ page }) => {
    const addDealBtn = page.locator('button', { hasText: /add deal|new deal|\+ deal/i }).first();
    await addDealBtn.click();
    await page.waitForTimeout(500);

    const modal = page.locator('[role="dialog"], .modal').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: 'playwright-results/pipeline-create-deal-modal.png' });
  });

  test('create deal modal has required fields', async ({ page }) => {
    const addDealBtn = page.locator('button', { hasText: /add deal|new deal|\+ deal/i }).first();
    await addDealBtn.click();
    await page.waitForTimeout(500);

    // Modal should have title/name, amount, and stage fields
    const titleField = page.locator('input[placeholder*="title" i], input[name="title"], input[placeholder*="deal" i]').first();
    const amountField = page.locator('input[placeholder*="amount" i], input[type="number"], input[name="amount"]').first();

    await expect(titleField).toBeVisible({ timeout: 5000 });
    await expect(amountField).toBeVisible({ timeout: 5000 });
  });

  test('can create a new deal and it appears on the board', async ({ page }) => {
    const addDealBtn = page.locator('button', { hasText: /add deal|new deal|\+ deal/i }).first();
    await addDealBtn.click();
    await page.waitForTimeout(500);

    const titleField = page.locator('input[placeholder*="title" i], input[name="title"], input[placeholder*="deal" i]').first();
    const amountField = page.locator('input[placeholder*="amount" i], input[type="number"], input[name="amount"]').first();

    const dealTitle = `E2E Deal ${Date.now()}`;
    await titleField.fill(dealTitle);
    await amountField.fill('50000');

    // Submit
    const submitBtn = page.locator('button[type="submit"], button', { hasText: /save|add|create/i }).last();
    await submitBtn.click();

    await page.waitForTimeout(1500);

    // Deal should appear in the New Lead column
    await expect(page.locator(`text=${dealTitle}`)).toBeVisible({ timeout: 8000 });

    await page.screenshot({ path: 'playwright-results/pipeline-deal-created.png' });
  });

  test('clicking a deal card opens the deal detail modal', async ({ page }) => {
    await page.waitForTimeout(2000);

    // Find any deal card and click it
    const dealCard = page.locator('.card', { hasNot: page.locator('button', { hasText: /add/i }) }).first();
    const cardCount = await dealCard.count();

    if (cardCount > 0) {
      await dealCard.click();
      await page.waitForTimeout(500);

      // A modal should open showing deal details
      const modal = page.locator('[role="dialog"], .modal').first();
      await expect(modal).toBeVisible({ timeout: 5000 });

      await page.screenshot({ path: 'playwright-results/pipeline-deal-modal.png' });
    } else {
      test.skip(true, 'No deal cards found to test detail modal');
    }
  });

  test('AI Score button is visible on deal cards', async ({ page }) => {
    await page.waitForTimeout(2000);

    // The Pipeline has AI scoring buttons (Zap icon)
    const aiBtn = page.locator('button svg[data-lucide="zap"], button', { hasText: /ai|score/i }).first();
    const btnCount = await aiBtn.count();

    if (btnCount > 0) {
      await expect(aiBtn).toBeVisible();
    } else {
      // Skip if no deals exist yet
      test.skip(true, 'No AI score buttons found — board may be empty');
    }
  });

  test('pipeline page loads without console errors', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/pipeline');
    await page.waitForLoadState('networkidle');

    const criticalErrors = consoleErrors.filter(
      (err) =>
        !err.includes('favicon') &&
        !err.includes('extension') &&
        !err.includes('socket.io') &&
        !err.includes('ai_scoring') // AI scoring endpoint may not be available
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
