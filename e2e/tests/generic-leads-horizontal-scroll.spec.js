const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5174';
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(!['localhost', '127.0.0.1'].includes(new URL(BASE_URL).hostname), 'Local Generic 2.0 browser regression');

test('horizontal wheel gestures over rows and frozen names move the lead columns', async ({ page, request }) => {
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
  // Isolate scrolling from delayed auto-start tours (including on Contacts).
  await page.route('**/api/tours/state', route => route.fulfill({
    json: { preferences: { enabled: false, autoStart: false, updatedAt: new Date().toISOString() }, progress: {} },
  }));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${BASE_URL}/leads`);
  const table = page.locator('.leads-page-root--generic .leads-split-table');
  const bar = table.locator('.top-scroll-sync__sticky-bottom');
  await expect(bar).toBeVisible();
  await page.keyboard.press('Escape');
  const scrollLeft = () => bar.evaluate(element => element.scrollLeft);
  const rows = table.locator('.leads-table--scrollable tbody');
  await rows.hover();
  await page.mouse.wheel(220, 0);
  await expect.poll(scrollLeft).toBeGreaterThan(0);
  const firstPosition = await scrollLeft();
  await table.locator('.leads-table--frozen tbody').hover();
  await page.mouse.wheel(180, 0);
  await expect.poll(scrollLeft).toBeGreaterThan(firstPosition);
  const frozenPosition = await scrollLeft();
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Shift');
  await expect.poll(scrollLeft).toBeGreaterThan(frozenPosition);
  const rightPosition = await scrollLeft();
  await rows.hover();
  await page.mouse.wheel(-150, 0);
  await expect.poll(scrollLeft).toBeLessThan(rightPosition);
  const beforeDiagonal = await scrollLeft();
  await page.mouse.wheel(-40, 80);
  await expect.poll(scrollLeft).toBeLessThan(beforeDiagonal);
  await page.mouse.wheel(100000, 0);
  await expect.poll(scrollLeft).toBeGreaterThan(rightPosition);
  await page.mouse.wheel(200, 0);
  await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBe(0);
  const farRight = await scrollLeft();
  await page.mouse.wheel(-200, 0);
  await expect.poll(scrollLeft).toBeLessThan(farRight);
  const beforeShiftLeft = await scrollLeft();
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Shift');
  await expect.poll(scrollLeft).toBeLessThan(beforeShiftLeft);
  await page.mouse.wheel(-100000, 0);
  await expect.poll(scrollLeft).toBe(0);
  // Regular vertical wheel input must not be converted into sideways movement.
  const beforeVertical = await scrollLeft();
  await page.mouse.wheel(0, 120);
  await expect.poll(scrollLeft).toBe(beforeVertical);
  await page.screenshot({ path: test.info().outputPath('leads-horizontal-scroll.png'), fullPage: true });
  await page.goto(`${BASE_URL}/contacts`);
  const contacts = page.locator('.contacts-split-table');
  const nativeScroller = contacts.locator('.top-scroll-sync__bottom');
  await expect(contacts.locator('.contacts-table-frozen-pane tbody')).toBeVisible();
  await page.keyboard.press('Escape');
  await contacts.locator('.contacts-table-frozen-pane tbody').hover();
  await page.mouse.wheel(180, 0);
  await expect.poll(() => nativeScroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const contactPosition = await nativeScroller.evaluate(element => element.scrollLeft);
  await page.mouse.wheel(-100, 0);
  await expect.poll(() => nativeScroller.evaluate(element => element.scrollLeft)).toBeLessThan(contactPosition);
});
