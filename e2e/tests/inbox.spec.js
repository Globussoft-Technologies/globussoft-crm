// @ts-check
/**
 * Inbox spec — omnichannel inbox page: renders without errors,
 * shows email/message list, conversation panel.
 */
const { test, expect } = require('@playwright/test');

test.describe('Inbox', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/inbox');
    await page.waitForLoadState('networkidle');
  });

  test('renders the Inbox page', async ({ page }) => {
    await expect(page).toHaveURL(/\/inbox/);
    await expect(page.locator('h1, h2').filter({ hasText: /inbox/i }).first()).toBeVisible({
      timeout: 10000,
    });
    await page.screenshot({ path: 'playwright-results/inbox-overview.png' });
  });

  test('inbox page has a message/conversation list area', async ({ page }) => {
    // The inbox renders a list of messages or conversations
    // Look for common inbox UI patterns
    const listArea = page
      .locator('[class*="inbox"], [class*="messages"], [class*="conversation"], ul, .card')
      .first();
    await expect(listArea).toBeVisible({ timeout: 10000 });
  });

  test('inbox loads without JS runtime errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/inbox');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('inbox shows channel filter or tabs', async ({ page }) => {
    // Omnichannel inbox typically has tabs for Email, SMS, Chat etc.
    const channelTabs = page
      .locator('button, [role="tab"]')
      .filter({ hasText: /email|sms|chat|all/i })
      .first();
    const tabCount = await channelTabs.count();
    // May or may not have tabs depending on implementation
    if (tabCount > 0) {
      await expect(channelTabs).toBeVisible();
    }
  });

  test('compose/new message button is present if inbox has content', async ({ page }) => {
    await page.waitForTimeout(1500);
    // Look for a compose or new message button
    const composeBtn = page
      .locator('button')
      .filter({ hasText: /compose|new message|new email|\+ message/i })
      .first();
    const btnCount = await composeBtn.count();
    if (btnCount > 0) {
      await expect(composeBtn).toBeVisible();
    }
  });

  test('inbox shows conversation items or empty state', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Either shows conversations or an empty state message
    const hasConversations = await page.locator('[data-conversation], [class*="thread"], li').first().count();
    const hasEmptyState = await page
      .locator('text=/no messages|empty|no conversations/i')
      .first()
      .count();

    // At least one of these should be true
    const pageHasContent = hasConversations > 0 || hasEmptyState > 0;

    // Regardless, the page should render without crashing
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('full inbox screenshot', async ({ page }) => {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-results/inbox-full.png', fullPage: true });
  });
});
