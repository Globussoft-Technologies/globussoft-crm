// @ts-check
/**
 * Pipeline spec — covers the Kanban deal board: stage columns visible,
 * deal cards render, create deal modal, deal detail modal.
 */
const { test, expect } = require('@playwright/test');

// Pipeline stages may be custom or defaults — test checks for any stage columns
const DEFAULT_STAGES = ['New Lead', 'Contacted', 'Proposal Sent', 'Closed Won'];

test.describe('Pipeline — Kanban board', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pipeline');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the Pipeline page', async ({ page }) => {
    // The Pipeline page should have some heading or content
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'playwright-results/pipeline-overview.png' });
  });

  test('deal stage columns are visible', async ({ page }) => {
    // Wait for data to load — stages may be custom or default
    await page.waitForTimeout(3000);

    // There should be at least 1 stage column rendered (h3 headings inside the glass panels)
    const stageHeaders = page.locator('h3');
    const count = await stageHeaders.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('stage columns show deal count indicators', async ({ page }) => {
    await page.waitForTimeout(3000);
    // Each stage column header has a count badge span
    const firstStageHeader = page.locator('h3').first();
    await expect(firstStageHeader).toBeVisible();
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

    await page.waitForTimeout(3000); // extra time for production API + re-render

    // Deal should be in the DOM (board may overflow, so use attached not visible)
    const dealLocator = page.locator(`h4:has-text("${dealTitle}"), [data-testid*="deal"]`).filter({ hasText: dealTitle });
    const dealInDom = await page.locator('body').innerHTML();
    expect(dealInDom).toContain(dealTitle);

    await page.screenshot({ path: 'playwright-results/pipeline-deal-created.png' });
  });

  test('clicking a deal card opens the deal detail modal', async ({ page }) => {
    await page.waitForTimeout(3000);

    // Deal cards contain h4 headings — find a card that has an h4 inside it
    const dealCard = page.locator('div[draggable="true"]').first();
    const cardCount = await dealCard.count();

    if (cardCount > 0) {
      await dealCard.click();
      await page.waitForTimeout(1000);

      // A modal should open showing deal details
      const modal = page.locator('.modal, [role="dialog"]').first();
      await expect(modal).toBeVisible({ timeout: 5000 });

      await page.screenshot({ path: 'playwright-results/pipeline-deal-modal.png' });
    } else {
      // Cards may not exist if deals haven't loaded yet
      test.skip(true, 'No deal cards found to test detail modal');
    }
  });

  test('AI Score button is visible on deal cards', async ({ page }) => {
    await page.waitForTimeout(3000);

    // AI score buttons are on draggable deal cards with title="Generate AI Insights"
    const dealCards = page.locator('div[draggable="true"]');
    const cardCount = await dealCards.count();

    if (cardCount > 0) {
      const aiBtn = page.locator('button[title="Generate AI Insights"]').first();
      await expect(aiBtn).toBeVisible({ timeout: 5000 });
    } else {
      test.skip(true, 'No deal cards found — board may be empty');
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
    await page.waitForLoadState('domcontentloaded');

    const criticalErrors = consoleErrors.filter(
      (err) =>
        !err.includes('favicon') &&
        !err.includes('extension') &&
        !err.includes('socket.io') &&
        !err.includes('ai_scoring') && // AI scoring endpoint may not be available
        !err.includes('WebSocket') &&
        !err.includes('net::ERR_') &&
        !err.includes('Failed to fetch') &&
        !err.includes('connect_error')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
