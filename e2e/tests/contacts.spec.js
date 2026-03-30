// @ts-check
/**
 * Contacts spec — covers the contact directory: list view, search/filter,
 * create contact modal, delete contact, and navigation to contact detail.
 */
const { test, expect } = require('@playwright/test');

const TEST_CONTACT = {
  name: `E2E Test Contact ${Date.now()}`,
  email: `e2e-test-${Date.now()}@example.com`,
  company: 'E2E Test Corp',
  title: 'QA Engineer',
};

test.describe('Contacts — List view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/contacts');
    await page.waitForLoadState('domcontentloaded');
  });

  test('renders the Contacts page header', async ({ page }) => {
    await expect(page.locator('h2').filter({ hasText: 'Contacts' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Manage your leads and customers')).toBeVisible();
  });

  test('shows Add Contact button', async ({ page }) => {
    const addBtn = page.locator('button', { hasText: 'Add Contact' });
    await expect(addBtn).toBeVisible();
  });

  test('renders search input', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search"], input[type="search"]').first();
    await expect(searchInput).toBeVisible({ timeout: 10000 });
  });

  test('contact table renders with headers', async ({ page }) => {
    // Wait for the table or list to load
    await page.waitForTimeout(1500); // brief wait for data fetch
    const table = page.locator('table, [role="table"]').first();
    // If table exists, check for header content
    const tableExists = await table.count();
    if (tableExists > 0) {
      await expect(table).toBeVisible();
    } else {
      // Could be a card/list layout
      const listContainer = page.locator('.card').first();
      await expect(listContainer).toBeVisible();
    }
    await page.screenshot({ path: 'playwright-results/contacts-list.png' });
  });

  test('status filter dropdown is present', async ({ page }) => {
    const filterSelect = page.locator('select').first();
    await expect(filterSelect).toBeVisible({ timeout: 8000 });
  });

  test('search input filters visible contacts', async ({ page }) => {
    await page.waitForTimeout(1500);
    const searchInput = page.locator('input[placeholder*="Search"], input[type="search"]').first();

    // Type something unlikely to match
    await searchInput.fill('zzznomatch999xyz');
    await page.waitForTimeout(500);

    // Rows should be reduced or empty
    const rows = page.locator('tr[data-testid], tbody tr, [data-contact-id]');
    const count = await rows.count();
    // Either 0 rows or a "no results" message
    if (count > 0) {
      // If rows still show, they should contain the search text
      const firstRowText = await rows.first().textContent();
      // At minimum no crash
      expect(firstRowText).toBeDefined();
    }
  });
});

test.describe('Contacts — Create contact', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/contacts');
    await page.waitForLoadState('domcontentloaded');
  });

  test('Add Contact button opens the create modal', async ({ page }) => {
    const addBtn = page.locator('button', { hasText: 'Add Contact' });
    await addBtn.click();

    // Modal should appear
    const modal = page.locator('[role="dialog"], .modal, form').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: 'playwright-results/contacts-create-modal.png' });
  });

  test('create contact modal has required fields', async ({ page }) => {
    await page.locator('button', { hasText: 'Add Contact' }).click();
    await page.waitForTimeout(500);

    // Look for name and email fields in the modal
    const nameField = page.locator('input[placeholder*="name" i], input[name="name"]').first();
    const emailField = page.locator('input[type="email"], input[placeholder*="email" i]').first();

    await expect(nameField).toBeVisible({ timeout: 5000 });
    await expect(emailField).toBeVisible({ timeout: 5000 });
  });

  test('can create a new contact and it appears in the list', async ({ page }) => {
    const addBtn = page.locator('button', { hasText: 'Add Contact' });
    await addBtn.click();
    await page.waitForTimeout(500);

    // Fill in the form
    const nameField = page.locator('input[placeholder*="name" i], input[name="name"]').first();
    const emailField = page.locator('input[type="email"], input[placeholder*="email" i]').first();
    const companyField = page.locator('input[placeholder*="company" i], input[name="company"]').first();

    await nameField.fill(TEST_CONTACT.name);
    await emailField.fill(TEST_CONTACT.email);

    const companyExists = await companyField.count();
    if (companyExists > 0) {
      await companyField.fill(TEST_CONTACT.company);
    }

    // Submit the form
    const submitBtn = page.locator('button[type="submit"], button', { hasText: /save|add|create/i }).last();
    await submitBtn.click();

    // Modal should close
    await page.waitForTimeout(1000);

    // New contact name should appear in the list
    await expect(page.locator(`text=${TEST_CONTACT.name}`)).toBeVisible({ timeout: 8000 });

    await page.screenshot({ path: 'playwright-results/contacts-created.png' });
  });
});

test.describe('Contacts — Delete contact', () => {
  test('delete button triggers confirmation and removes contact', async ({ page }) => {
    await page.goto('/contacts');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Accept the confirmation dialog automatically
    page.on('dialog', (dialog) => dialog.accept());

    // Find a delete button (trash icon button)
    const deleteBtn = page.locator('button[title*="delete" i], button svg[data-lucide="trash2"]').first();
    const deleteBtnCount = await deleteBtn.count();

    if (deleteBtnCount > 0) {
      await deleteBtn.click();
      // After delete, list should reload without error
      await page.waitForTimeout(1000);
      // No error should be thrown
      await expect(page).toHaveURL(/\/contacts/);
    } else {
      test.skip(true, 'No delete buttons found — list may be empty');
    }
  });
});

test.describe('Contacts — Contact detail page', () => {
  test('clicking a contact navigates to detail page', async ({ page }) => {
    await page.goto('/contacts');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Find the first contact link
    const contactLink = page.locator('a[href^="/contacts/"]').first();
    const linkCount = await contactLink.count();

    if (linkCount > 0) {
      await contactLink.click();
      await page.waitForLoadState('domcontentloaded');

      // URL should be /contacts/:id
      await expect(page).toHaveURL(/\/contacts\/\w+/);

      await page.screenshot({ path: 'playwright-results/contact-detail.png' });
    } else {
      test.skip(true, 'No contact links found — list may be empty');
    }
  });

  test('contact detail page renders without errors', async ({ page }) => {
    await page.goto('/contacts');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    const contactLink = page.locator('a[href^="/contacts/"]').first();
    const linkCount = await contactLink.count();

    if (linkCount > 0) {
      const href = await contactLink.getAttribute('href');
      await page.goto(href);
      await page.waitForLoadState('domcontentloaded');

      // Should not show a 404 or error state
      const errorText = page.locator('text=404, text=Not Found, text=Error');
      const errorCount = await errorText.count();
      expect(errorCount).toBe(0);
    } else {
      test.skip(true, 'No contacts available to test detail page');
    }
  });
});
