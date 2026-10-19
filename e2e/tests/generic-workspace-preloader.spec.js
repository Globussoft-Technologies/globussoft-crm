const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5174';
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(!['localhost', '127.0.0.1'].includes(new URL(BASE_URL).hostname), 'Local Generic 2.0 browser regression');

test('login keeps one continuous loader through subscription, permissions and page access', async ({ page }) => {
  const gates = {};
  for (const [name, path] of Object.entries({
    subscription: '**/api/subscriptions/access',
    permissions: '**/api/auth/me/permissions',
    pages: '**/api/pages/me',
  })) {
    let release;
    let requested;
    const pending = new Promise(resolve => { release = resolve; });
    const seen = new Promise(resolve => { requested = resolve; });
    gates[name] = { release, seen };
    await page.route(path, async route => {
      requested();
      await pending;
      await route.continue();
    });
  }
  await page.route('**/api/tours/state', route => route.fulfill({
    json: { preferences: { enabled: false, autoStart: false, updatedAt: new Date().toISOString() }, progress: {} },
  }));
  await page.goto(`${BASE_URL}/login`);
  await page.getByPlaceholder('Enter your email', { exact: true }).fill('admin@globussoft.com');
  await page.getByPlaceholder('Enter your password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  const overlay = page.locator('.workspace-loading-overlay');
  await expect(overlay).toBeVisible();
  const original = await overlay.elementHandle();
  const animation = await overlay.locator('.workspace-preloader__logo').elementHandle();
  for (const name of ['subscription', 'permissions', 'pages']) {
    await gates[name].seen;
    await expect(overlay).toHaveCount(1);
    expect(await original.evaluate(element => element.isConnected)).toBe(true);
    expect(await animation.evaluate(element => element.isConnected)).toBe(true);
    await expect(overlay).not.toHaveClass(/--closing/);
    gates[name].release();
  }
  await expect(overlay).toHaveCount(0);
  await expect(page.locator('[data-tour="page-content"]')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Bringing your workspace together' })).toHaveCount(0);
});

test('branded GIF is responsive, respects reduced motion and disappears when session validation finishes', async ({ page, request }) => {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
  });
  expect(response.ok()).toBe(true);
  const { token, user, tenant } = await response.json();
  expect(tenant.vertical).toBe('generic');
  await page.addInitScript(({ token, user, tenant }) => {
    sessionStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('tenant', JSON.stringify(tenant));
  }, { token, user, tenant });
  await page.route('**/api/tours/state', route => route.fulfill({
    json: { preferences: { enabled: false, autoStart: false, updatedAt: new Date().toISOString() }, progress: {} },
  }));
  let finishValidation;
  const sessionPending = new Promise(resolve => { finishValidation = resolve; });
  await page.route('**/api/auth/me', async route => {
    await sessionPending;
    await route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/leads`);
  const loader = page.getByRole('status', { name: 'Bringing your workspace together' });
  await expect(loader).toBeVisible();
  await expect(loader.getByRole('img', { name: 'GlobusCRM' })).toBeVisible();
  expect(await loader.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  const animation = () => loader.locator('img').evaluate(element => element.currentSrc);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(animation).toContain('/preloaders/globuscrm-loader.gif');
  await expect(loader.locator('.workspace-preloader__rail')).toHaveCount(0);
  await expect(loader.locator('.workspace-preloader__card')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(loader.locator('.workspace-preloader__card')).toHaveCSS('border-top-width', '0px');
  await expect(loader.locator('.workspace-preloader__card')).toHaveCSS('box-shadow', 'none');
  await page.screenshot({ path: '/tmp/globuscrm-gradient-rail-local.png' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  expect(await loader.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(11, 12, 16)');
  await page.screenshot({ path: '/tmp/globuscrm-gradient-rail-dark.png' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 720 });
    const card = await loader.locator('.workspace-preloader__card').boundingBox();
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(animation).toContain('/preloaders/globuscrm-loader-static.png');
  await expect(page.locator('.workspace-loading-overlay')).toHaveCSS('transition-duration', '0s');
  await page.screenshot({ path: '/tmp/globuscrm-gradient-rail-mobile.png' });
  finishValidation();
  await expect(page.locator('.leads-page-root--generic')).toBeVisible();
  await expect(page.locator('.workspace-preloader')).toHaveCount(0);
});
