// @ts-check
/**
 * Navigation spec — verifies all sidebar links work, all routes render
 * without crashing, and placeholder pages show the correct "In Development" state.
 */
const { test, expect } = require('@playwright/test');

const SIDEBAR_ROUTES = [
  { label: 'Dashboard', path: '/', heading: /Enterprise Overview/i },
  { label: 'Inbox', path: '/inbox', heading: /Inbox/i },
  { label: 'Contacts', path: '/contacts', heading: /Contacts/i },
  { label: 'Pipeline', path: '/pipeline', heading: /Pipeline|Lead|Deal/i },
  { label: 'Marketing', path: '/marketing', heading: /Marketing|Campaign/i },
  { label: 'Sequences', path: '/sequences', heading: /Sequence|Automation|Workflow/i },
  { label: 'Reports', path: '/reports', heading: /Report|Analytics/i },
  { label: 'Invoices', path: '/invoices', heading: /Invoices|Invoice/i },
  { label: 'App Builder', path: '/objects', heading: /App Builder|Object|Entity/i },
  { label: 'Developers', path: '/developer', heading: /Developer|API|Key/i },
  { label: 'Settings', path: '/settings', heading: /Settings|Organization/i },
];

// These modules are now fully built — no longer placeholders
const FULLY_BUILT_ROUTES = [
  { path: '/expenses', heading: /Expense/i },
  { path: '/contracts', heading: /Contracts/i },
  { path: '/estimates', heading: /Estimates/i },
  { path: '/invoices', heading: /Invoices/i },
  { path: '/tickets', heading: /Tickets/i },
  { path: '/tasks', heading: /Task/i },
  { path: '/projects', heading: /Projects/i },
  { path: '/clients', heading: /Clients/i },
  { path: '/leads', heading: /Leads/i },
  { path: '/staff', heading: /Staff/i },
];

const ALL_SIDEBAR_LINKS = [
  'Dashboard',
  'Inbox',
  'Contacts',
  'Pipeline',
  'Marketing',
  'Sequences',
  'Reports',
  'Invoices',
  'Support',
  'App Builder',
  'Developers',
  'Settings',
];

test.describe('Navigation — Sidebar presence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('sidebar is visible on all authenticated pages', async ({ page }) => {
    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });
  });

  test('Globussoft logo/brand text is in sidebar', async ({ page }) => {
    await expect(page.locator('text=Globussoft').first()).toBeVisible();
  });

  test('all expected sidebar links are present', async ({ page }) => {
    for (const linkLabel of ALL_SIDEBAR_LINKS) {
      await expect(
        page.locator(`nav a, aside a, nav [href]`).filter({ hasText: new RegExp(linkLabel, 'i') }).first()
      ).toBeVisible({ timeout: 8000 });
    }
  });
});

test.describe('Navigation — Sidebar link routing', () => {
  for (const route of SIDEBAR_ROUTES) {
    test(`sidebar link "${route.label}" navigates to ${route.path}`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');

      // Click the sidebar link
      const link = page
        .locator(`nav a, aside a`)
        .filter({ hasText: new RegExp(route.label, 'i') })
        .first();
      await expect(link).toBeVisible({ timeout: 8000 });
      await link.click();

      await page.waitForLoadState('domcontentloaded');

      // URL should match the expected path
      if (route.path === '/') {
        await expect(page).toHaveURL('/');
      } else {
        await expect(page).toHaveURL(new RegExp(route.path));
      }

      // Page should show some expected content
      await expect(page.locator('h1, h2').filter({ hasText: route.heading }).first()).toBeVisible({
        timeout: 10000,
      });
    });
  }
});

test.describe('Navigation — Direct route access', () => {
  for (const route of SIDEBAR_ROUTES) {
    test(`direct navigation to ${route.path} renders without errors`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(route.path);
      await page.waitForLoadState('domcontentloaded');

      // Should not have navigated away (no 404 redirect to login)
      if (route.path !== '/') {
        await expect(page).toHaveURL(new RegExp(route.path));
      }

      // No JS runtime errors
      expect(errors).toHaveLength(0);
    });
  }
});

test.describe('Navigation — Fully built module pages', () => {
  for (const route of FULLY_BUILT_ROUTES) {
    test(`${route.path} renders with correct heading`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState('domcontentloaded');

      await expect(
        page.locator('h1, h2').filter({ hasText: route.heading }).first()
      ).toBeVisible({ timeout: 10000 });
    });
  }

  test('module page renders SVG icons', async ({ page }) => {
    await page.goto('/expenses');
    await page.waitForLoadState('domcontentloaded');

    const icon = page.locator('svg').first();
    await expect(icon).toBeVisible();

    await page.screenshot({ path: 'playwright-results/navigation-placeholder.png' });
  });
});

test.describe('Navigation — Browser back/forward', () => {
  test('browser back button works after navigating between pages', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await page.goto('/contacts');
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL(/\/contacts/);

    await page.goBack();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL('/');
  });

  test('browser forward button works after going back', async ({ page }) => {
    await page.goto('/contacts');
    await page.waitForLoadState('domcontentloaded');

    await page.goto('/pipeline');
    await page.waitForLoadState('domcontentloaded');

    await page.goBack();
    await expect(page).toHaveURL(/\/contacts/);

    await page.goForward();
    await expect(page).toHaveURL(/\/pipeline/);
  });
});
