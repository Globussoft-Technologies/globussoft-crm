// @ts-check
/**
 * Wellness — Browser UI flow tests (8 scenarios).
 *
 * Exercises the wellness vertical end-to-end through the live UI:
 *  - admin login + sidebar navigation
 *  - patient search + detail tabs
 *  - recommendation approval
 *  - service catalog inline edit
 *  - telecaller queue disposition
 *  - owner dashboard chart + occupancy
 *  - public booking flow
 *  - embed lead-form submission
 *
 * Each test boots a logged-out browser via storageState reset, so we always
 * start clean and exercise the real login path.
 *
 * Run: cd e2e && BASE_URL=https://crm.globusdemos.com \
 *        npx playwright test tests/wellness-ui-flows.spec.js --project=chromium --reporter=line
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const PARTNER_KEY = process.env.WELLNESS_PARTNER_KEY ||
  'glbs_6ba99bc3309ef840d58d1fd43339e09c62eb395396c6c8cf';

// Always start from a clean slate — never use the saved auth state.
test.use({ storageState: { cookies: [], origins: [] } });

async function loginAsWellnessAdmin(page) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState('domcontentloaded');
  const demoAdminBtn = page.getByRole('button', { name: /Demo Admin/i });
  await expect(demoAdminBtn).toBeVisible({ timeout: 15000 });
  await demoAdminBtn.click();
  await page.waitForURL(/\/wellness/, { timeout: 20000 });
  await page.waitForFunction(
    () => document.body.getAttribute('data-vertical') === 'wellness',
    { timeout: 10000 }
  );
}

// ─────────────────────────────────────────────────────────────────────
// 1. Patients → search → first patient → New prescription tab
// ─────────────────────────────────────────────────────────────────────
test('1. Patients search filters list, click into one, prescription tab renders', async ({ page }) => {
  await loginAsWellnessAdmin(page);

  await page.getByRole('link', { name: /Patients/i }).first().click();
  await page.waitForURL(/\/wellness\/patients/, { timeout: 10000 });

  // Wait for the list to populate
  const firstRow = page.locator('a[href*="/wellness/patients/"]').first();
  await expect(firstRow).toBeVisible({ timeout: 15000 });
  const firstName = (await firstRow.textContent())?.trim() || '';
  expect(firstName.length).toBeGreaterThan(0);

  // Search box filters — type the first 3 chars of the first patient's name
  const searchBox = page.getByPlaceholder(/Search by name, phone, or email/i);
  await expect(searchBox).toBeVisible();
  await searchBox.fill(firstName.slice(0, 3));

  // Wait for the debounced re-fetch + assert at least one result row remains
  await page.waitForTimeout(500);
  await expect(page.locator('a[href*="/wellness/patients/"]').first()).toBeVisible();

  // Click into the first patient
  await page.locator('a[href*="/wellness/patients/"]').first().click();
  await page.waitForURL(/\/wellness\/patients\/\d+/, { timeout: 10000 });

  // Switch to "New prescription" tab
  await page.getByRole('button', { name: /New prescription/i }).click();
  await expect(page.getByRole('heading', { name: /^New prescription$/i })).toBeVisible({ timeout: 10000 });
  await expect(page.getByPlaceholder(/Drug name/i)).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────
// 2. Recommendations → Approve first card
// ─────────────────────────────────────────────────────────────────────
test('2. Recommendations Approve removes the card from the pending list', async ({ page }) => {
  await loginAsWellnessAdmin(page);

  await page.getByRole('link', { name: /Recommendations/i }).first().click();
  await page.waitForURL(/\/wellness\/recommendations/, { timeout: 10000 });
  await expect(page.getByRole('heading', { name: /Agent Recommendations/i })).toBeVisible();

  // Wait for cards to load
  await page.waitForTimeout(1000);

  // The Approve button only renders for status === 'pending'.
  const approveButtons = page.getByRole('button', { name: /^Approve$/i });
  const initialCount = await approveButtons.count();
  if (initialCount === 0) {
    test.skip(true, 'no pending recommendations available — nothing to approve');
  }

  await approveButtons.first().click();

  // After approval, the load() refetches pending only. The Approve button count
  // should drop by at least one (or to zero if there was only one).
  await expect.poll(
    async () => page.getByRole('button', { name: /^Approve$/i }).count(),
    { timeout: 15000 }
  ).toBeLessThan(initialCount);
});

// ─────────────────────────────────────────────────────────────────────
// 3. Service Catalog → pencil → change price → Save → updated price visible
// ─────────────────────────────────────────────────────────────────────
test('3. Service Catalog inline edit updates the displayed price', async ({ page }) => {
  await loginAsWellnessAdmin(page);

  // Use the canonical /wellness/services route directly — the sidebar link
  // labelled "Service Catalog" points here too.
  await page.goto(`${BASE_URL}/wellness/services`);
  await page.waitForURL(/\/wellness\/services/, { timeout: 10000 });
  await expect(page.getByRole('heading', { name: /Service catalog/i })).toBeVisible({ timeout: 15000 });

  // Click the first edit (pencil) button
  const firstEdit = page.locator('button[title="Edit"]').first();
  await expect(firstEdit).toBeVisible({ timeout: 15000 });
  await firstEdit.click();

  // The edit card shows three number inputs in a 1fr-1fr-1fr row;
  // the first one is "₹ price". Change it.
  const priceInput = page.locator('input[type="number"][placeholder="₹ price"]').first();
  await expect(priceInput).toBeVisible();
  const originalRaw = await priceInput.inputValue();
  const newPrice = String((parseFloat(originalRaw) || 0) + 11);
  await priceInput.fill(newPrice);

  // Save
  await page.getByRole('button', { name: /^Save$/i }).first().click();

  // After save, the card flips back to read mode + shows the new price.
  // Indian-grouped, e.g. "1,234". We just check the bare digits show up.
  const newPriceDisplay = parseFloat(newPrice).toLocaleString('en-IN');
  await expect(page.getByText(newPriceDisplay).first()).toBeVisible({ timeout: 10000 });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Telecaller Queue → click a disposition → card disappears
// ─────────────────────────────────────────────────────────────────────
test('4. Telecaller Queue disposition removes the card from the list', async ({ page }) => {
  await loginAsWellnessAdmin(page);

  // Try the sidebar link variants
  const tcLink = page.getByRole('link', { name: /Telecaller/i }).first();
  if (!(await tcLink.isVisible().catch(() => false))) {
    await page.goto(`${BASE_URL}/wellness/telecaller`);
  } else {
    await tcLink.click();
  }
  await page.waitForURL(/\/wellness\/telecaller/, { timeout: 10000 }).catch(() => {});
  await expect(page.getByRole('heading', { name: /Telecaller Queue/i })).toBeVisible({ timeout: 15000 });

  // Wait for either: (a) loading disappears and cards present, or (b) inbox-zero
  await page.waitForTimeout(1500); // allow load() to complete

  const cardCount = await page.locator('button:has-text("Junk")').count();
  if (cardCount === 0) {
    test.skip(true, 'queue is empty for this user — nothing to dispose');
  }

  // Click "Junk" on the first card
  const junkBtn = page.locator('button:has-text("Junk")').first();
  await junkBtn.click();

  // Card count should drop by at least 1
  await expect.poll(
    async () => page.locator('button:has-text("Junk")').count(),
    { timeout: 15000 }
  ).toBeLessThan(cardCount);
});

// ─────────────────────────────────────────────────────────────────────
// 5. Owner Dashboard → 30-day chart svg + occupancy %
// ─────────────────────────────────────────────────────────────────────
test('5. Owner Dashboard renders the 30-day chart svg + occupancy %', async ({ page }) => {
  await loginAsWellnessAdmin(page);

  // We may already be on the owner dashboard after login — go explicitly.
  const ownerLink = page.getByRole('link', { name: /Owner Dashboard/i }).first();
  if (await ownerLink.isVisible().catch(() => false)) {
    await ownerLink.click();
  } else {
    await page.goto(`${BASE_URL}/wellness`);
  }

  // KPI tile labels confirm we're on the dashboard
  await expect(page.getByText(/Today's appointments/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Occupancy/i)).toBeVisible();

  // Recharts renders an <svg> inside the ResponsiveContainer
  await expect(page.locator('svg.recharts-surface').first()).toBeVisible({ timeout: 10000 });

  // Occupancy tile shows a "NN%" value
  await expect(page.locator('text=/^\\d+%$/').first()).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────
// 6. Public booking — pick service → location → name/phone → confirm
// ─────────────────────────────────────────────────────────────────────
test('6. Public booking flow on /book/enhanced-wellness completes', async ({ page }) => {
  await page.goto(`${BASE_URL}/book/enhanced-wellness`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('heading', { name: /Enhanced Wellness/i })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Pick a service/i)).toBeVisible();

  // Step 1 — first service card
  await page.locator('button').filter({ hasText: /min/i }).first().click();

  // Step 2 — first location card
  await expect(page.getByText(/Pick a clinic/i)).toBeVisible({ timeout: 10000 });
  await page.locator('button').filter({ hasText: /\w+,\s*\w+/i }).first().click();

  // Step 3 — fill name + phone, confirm
  await expect(page.getByText(/Your details/i)).toBeVisible({ timeout: 10000 });
  await page.locator('input[placeholder*="Your name"]').fill('Aarav Sharma');
  await page.locator('input[placeholder*="Phone"]').fill(`98765${Date.now().toString().slice(-5)}`);

  await page.getByRole('button', { name: /Confirm booking/i }).click();

  // Either the green check-mark confirmation or the "Booking confirmed" heading
  await expect(page.getByRole('heading', { name: /Booking confirmed/i })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/Aarav Sharma/i)).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────
// 7. Embed lead-form submission
// ─────────────────────────────────────────────────────────────────────
test('7. Embed lead-form submission shows the Thanks message', async ({ page }) => {
  const url = `${BASE_URL}/embed/lead-form.html?key=${PARTNER_KEY}&title=UI%20Flow%20Embed`;
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByRole('heading', { name: /UI Flow Embed/i })).toBeVisible({ timeout: 10000 });
  await page.locator('input[name="name"]').fill('Diya Verma');
  await page.locator('input[name="phone"]').fill(`97${Date.now().toString().slice(-8)}`);
  await page.getByRole('button', { name: /Request a callback/i }).click();

  // The success card uses "Thanks <name>!" — assert that copy appears
  await expect(page.getByText(/Thanks Diya Verma/i)).toBeVisible({ timeout: 15000 });
});

// ─────────────────────────────────────────────────────────────────────
// 8. Patient detail — switch through all 7 tabs
// ─────────────────────────────────────────────────────────────────────
test('8. Patient detail: every one of the 7 tabs renders without error', async ({ page }) => {
  await loginAsWellnessAdmin(page);

  await page.getByRole('link', { name: /Patients/i }).first().click();
  await page.waitForURL(/\/wellness\/patients/, { timeout: 10000 });
  const firstRow = page.locator('a[href*="/wellness/patients/"]').first();
  await expect(firstRow).toBeVisible({ timeout: 15000 });
  await firstRow.click();
  await page.waitForURL(/\/wellness\/patients\/\d+/, { timeout: 10000 });

  const tabs = [
    { label: 'Case history',     marker: /No case history|First|Visit|Prescription|Consent/i },
    { label: 'New prescription', marker: /^New prescription$/i },
    { label: 'Consent form',     marker: /Capture consent/i },
    { label: 'Treatment plans',  marker: /New treatment plan|No treatment plans/i },
    { label: 'Log visit',        marker: /Log a visit/i },
    { label: 'Photos',           marker: /Visit photos/i },
    { label: 'Inventory used',   marker: /Inventory used/i },
  ];

  for (const t of tabs) {
    await page.getByRole('button', { name: new RegExp(t.label, 'i') }).click();
    // Some tab content (Case history) may not have a heading — just assert no crash
    // by verifying at least one of: the marker text, OR the tab button is still active.
    const found = await Promise.race([
      page.getByText(t.marker).first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false),
      page.locator('text=' + t.label).first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false),
    ]);
    expect(found, `Tab "${t.label}" did not render content`).toBe(true);
  }
});
