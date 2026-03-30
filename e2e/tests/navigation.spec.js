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
  { label: 'Billing', path: '/billing', heading: /Billing|Invoice/i },
  { label: 'App Builder', path: '/objects', heading: /App Builder|Object|Entity/i },
  { label: 'Developers', path: '/developer', heading: /Developer|API|Key/i },
  { label: 'Settings', path: '/settings', heading: /Settings|Organization/i },
];

const PLACEHOLDER_ROUTES = [
  { path: '/expenses', moduleName: 'Expenses' },
  { path: '/contracts', moduleName: 'Contracts' },
  { path: '/estimates', moduleName: 'Estimates' },
  { path: '/invoices', moduleName: 'Invoices' },
  { path: '/tickets', moduleName: 'Tickets' },
  { path: '/tasks', moduleName: 'Tasks' },
  { path: '/projects', moduleName: 'Projects' },
  { path: '/clients', moduleName: 'Clients' },
  { path: '/leads', moduleName: 'Leads' },
  { path: '/staff', moduleName: 'Staff' },
];

const ALL_SIDEBAR_LINKS = [
  'Dashboard',
  'Inbox',
  'Contacts',
  'Pipeline',
  'Marketing',
  'Sequences',
  'Reports',
  'Billing',
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

test.describe('Navigation — Placeholder pages', () => {
  for (const placeholder of PLACEHOLDER_ROUTES) {
    test(`${placeholder.path} shows "In Development" placeholder state`, async ({ page }) => {
      await page.goto(placeholder.path);
      await page.waitForLoadState('domcontentloaded');

      // Placeholder component shows module name + "under active development"
      await expect(
        page.locator(`text=${placeholder.moduleName} Module`).first()
      ).toBeVisible({ timeout: 10000 });

      await expect(
        page.locator('text=under active development, text=upcoming release').first()
      ).toBeVisible({ timeout: 8000 });
    });
  }

  test('placeholder page renders construction icon', async ({ page }) => {
    await page.goto('/expenses');
    await page.waitForLoadState('domcontentloaded');

    // Lucide Construction icon renders as SVG
    const constructionIcon = page.locator('svg').first();
    await expect(constructionIcon).toBeVisible();

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
