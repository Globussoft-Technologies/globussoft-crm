// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("generic CRM product tour", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "One desktop browser covers this shared-user persistence flow.");
  });

  test("runs accessibly, restores focus, and persists completion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/contacts");
    await expect(page).not.toHaveURL(/\/login/);

    const token = await page.evaluate(() => sessionStorage.getItem("token"));
    test.skip(!token, "Authenticated test state did not provide a session token.");
    const headers = { Authorization: `Bearer ${token}` };
    const originalStateResponse = await page.request.get("/api/tours/state", { headers });
    expect(originalStateResponse.ok()).toBeTruthy();
    const originalState = await originalStateResponse.json();
    const originalOrganizationResponse = await page.request.get("/api/tours/organization-preferences", { headers });
    expect(originalOrganizationResponse.ok()).toBeTruthy();
    const originalOrganization = await originalOrganizationResponse.json();

    try {
      if (!originalOrganization.organizationEnabled) {
        const enabled = await page.request.put("/api/tours/organization-preferences", {
          headers,
          data: { organizationEnabled: true },
        });
        expect(enabled.ok()).toBeTruthy();
      }
      const updatedAt = new Date().toISOString();
      const prepared = await page.request.put("/api/tours/state", {
        headers,
        data: {
          preferences: { enabled: true, autoStart: false, updatedAt },
          progress: originalState.progress || {},
          progressResetAt: originalState.progressResetAt || null,
        },
      });
      expect(prepared.ok()).toBeTruthy();
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("gcrm.productTours.")) localStorage.removeItem(key);
        }
      });
      await page.reload();

      const launcher = page.locator('[data-tour="tour-launcher"]');
      await expect(launcher).toBeVisible();
      await launcher.click();
      const dialog = page.getByRole("dialog", { name: "Add a contact" });
      await expect(dialog).toBeVisible();
      await expect(page.locator("#root")).toHaveAttribute("inert", "");
      expect(await dialog.evaluate((element) => element.style.transition)).toBe("none");
      await expect(page.getByRole("status")).toContainText("Step 1 of 3: Add a contact");

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(launcher).toBeFocused();
      await expect(page.locator("#root")).not.toHaveAttribute("inert", "");

      await launcher.click();
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByRole("status")).toContainText("Step 2 of 3");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Finish" }).click();
      await expect(page.getByTestId("product-tour-overlay")).toHaveCount(0);

      await expect.poll(async () => {
        const response = await page.request.get("/api/tours/state", { headers });
        if (!response.ok()) return null;
        return (await response.json()).progress?.["contacts:1"]?.status;
      }).toBe("COMPLETED");
    } finally {
      const restoredAt = new Date(Date.now() + 1000).toISOString();
      await page.request.put("/api/tours/state", {
        headers,
        data: {
          preferences: { ...originalState.preferences, updatedAt: restoredAt },
          progress: Object.fromEntries(Object.entries(originalState.progress || {}).map(([key, value]) => [
            key,
            { ...value, updatedAt: restoredAt },
          ])),
          progressResetAt: originalState.progressResetAt || null,
        },
      }).catch(() => {});
      if (originalOrganization.organizationEnabled === false) {
        await page.request.put("/api/tours/organization-preferences", {
          headers,
          data: { organizationEnabled: false },
        }).catch(() => {});
      }
    }
  });
});
