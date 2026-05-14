// @ts-check
/**
 * Navigation spec — verifies all sidebar links work, all routes render
 * without crashing, and placeholder pages show the correct "In Development" state.
 */
const { test, expect } = require('@playwright/test');

// Mirrors the actual labels + paths that renderGenericNav() in
// frontend/src/components/Sidebar.jsx renders for an ADMIN on the generic
// tenant (admin@globussoft.com). Headings come from the corresponding page
// component's <h1>/<h2>. Keep this in sync with Sidebar.jsx whenever labels
// or paths change — v3.2.1 RBAC + label refactor required this update.
const SIDEBAR_ROUTES = [
  // The Dashboard sidebar link points to /dashboard. When token is present, "/"
  // redirects to /dashboard, so testing the URL pattern as /dashboard works for both.
  { label: 'Dashboard', path: '/dashboard', heading: /Enterprise Overview/i },
  { label: 'Inbox', path: '/inbox', heading: /Unified Inbox|Inbox/i },
  { label: 'Contacts', path: '/contacts', heading: /Contacts/i },
  { label: 'Pipeline', path: '/pipeline', heading: /Sales Pipeline|Pipeline/i },
  { label: 'Marketing', path: '/marketing', heading: /Marketing/i },
  { label: 'Sequences', path: '/sequences', heading: /Sequence|Automation/i },
  { label: 'Reports', path: '/reports', heading: /Reports? & Analytics|Reports?/i },
  { label: 'Invoices', path: '/invoices', heading: /Invoices?/i },
  { label: 'App Builder', path: '/objects', heading: /Custom Objects? Builder|App Builder|Object/i },
  { label: 'Developers', path: '/developer', heading: /Developer Ecosystem|Developer/i },
  { label: 'Settings', path: '/settings', heading: /Organization Settings|Settings/i },
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

  test('brand text is in sidebar', async ({ page }) => {
    // Sidebar renders `tenant?.name || 'Globussoft'` in an <h1>. Pre-2026-05-02
    // this test asserted literal "Globussoft" — that worked accidentally
    // because auth.setup.js wasn't populating localStorage.tenant, so the
    // fallback was always shown. Now that auth.setup writes tenant correctly,
    // the seeded NovaCrest tenant's name renders. Just assert the h1 is
    // visible with non-empty text — that's what the test really cares about.
    const brandHeading = page.locator('aside h1').first();
    await expect(brandHeading).toBeVisible({ timeout: 10000 });
    const brandText = (await brandHeading.textContent())?.trim();
    expect(brandText && brandText.length > 0).toBe(true);
  });

  test('all expected sidebar links are present', async ({ page }) => {
    // The sidebar <nav> is overflow:auto and contains 50+ items for ADMINs,
    // so links low in the list may be scrolled out of view. We assert each
    // expected label exists in the DOM (count > 0) rather than requiring
    // them to be in the viewport — `toBeVisible` only checks computed-style
    // visibility, but the explicit count assertion is clearer about intent.
    //
    // v3.7.13 e2e-full retry fix: items with a count badge ("Inbox 5",
    // "Tickets 9") have inner text "Inbox5" / "Tickets9" — a `^\s*Inbox\s*$`
    // regex won't match. Match against the inner label span/div which
    // carries ONLY the label text, then ascend to the enclosing <a>/<button>.
    for (const linkLabel of ALL_SIDEBAR_LINKS) {
      // Exact-text regex with word boundaries to avoid "Reports" matching
      // "Agent Reports" / "Custom Reports" before .first() resolves.
      const exact = new RegExp(`^\\s*${linkLabel}\\s*$`, 'i');
      const link = page
        .locator('nav a, aside a, nav button, aside button')
        .filter({
          has: page.locator('span, div').filter({ hasText: exact }),
        });
      await expect(link.first()).toBeAttached({ timeout: 8000 });
    }
  });
});

test.describe('Navigation — Sidebar link routing', () => {
  for (const route of SIDEBAR_ROUTES) {
    test(`sidebar link "${route.label}" navigates to ${route.path}`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');

      // Click the sidebar link. Use exact-text match with word boundaries so
      // "Reports" doesn't accidentally pick up "Agent Reports"/"Custom Reports"
      // and "Pipeline" doesn't pick up "Pipelines".
      //
      // v3.7.13 e2e-full retry fix — two coordinated changes:
      // (1) hasText alone is wrong for items with a count badge ("Inbox" has
      //     a "5" sibling so the link's text content is "Inbox5", which a
      //     `^\s*Inbox\s*$` regex won't match). Match against the inner
      //     label `<span>` (which carries ONLY the label text) and ascend
      //     to its enclosing <a> via `..`.
      // (2) Stale-element guard: the sidebar can re-render between locator
      //     resolution and scrollIntoView/click when AuthContext settles
      //     tenant data slightly after domcontentloaded. Wrap find+scroll+
      //     click in a 3-attempt loop so a fresh handle is acquired if the
      //     DOM re-renders mid-action; networkidle gives AuthContext a
      //     chance to settle on the first attempt.
      const exact = new RegExp(`^\\s*${route.label}\\s*$`, 'i');
      const findLink = () =>
        page
          .locator('nav a, aside a')
          .filter({
            has: page.locator('span, div').filter({ hasText: exact }),
          })
          .first();

      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
        // networkidle is best-effort — Socket.io keeps a long-poll open in
        // some envs and never goes idle. Fall through to the locator wait.
      });

      let lastErr = null;
      let clicked = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const link = findLink();
          await link.waitFor({ state: 'attached', timeout: 8000 });
          await link.scrollIntoViewIfNeeded({ timeout: 5000 });
          await link.click({ timeout: 5000 });
          clicked = true;
          break;
        } catch (err) {
          lastErr = err;
          // 250ms breath lets a mid-flight re-render settle before retry.
          await page.waitForTimeout(250);
        }
      }
      if (!clicked) throw lastErr;

      await page.waitForLoadState('domcontentloaded');

      // URL should match the expected path
      await expect(page).toHaveURL(new RegExp(route.path));

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
    // When authenticated, "/" redirects to /dashboard, so going back lands on
    // /dashboard rather than the bare "/" the test originally asserted.
    await expect(page).toHaveURL(/\/(dashboard)?$/);
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
