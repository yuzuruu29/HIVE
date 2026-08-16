import { test, expect } from "@playwright/test";

test.describe("Theme synchronization", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/e2e-test/theme");
  });

  test("persisted light survives hydration and Astryx mount", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("hive-theme", "light");
      document.documentElement.dataset.theme = "light";
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    // HIVE attribute persists after hydration
    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("light");

    // Astryx does not remove html[data-theme]
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("persisted dark survives hydration and Astryx mount", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("hive-theme", "dark");
      document.documentElement.dataset.theme = "dark";
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("toggle light to dark updates HIVE, Astryx, and localStorage", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("hive-theme", "light");
      document.documentElement.dataset.theme = "light";
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("light");

    // Toggle to dark
    await page.getByTestId("theme-toggle-btn").click();

    await expect(page.getByTestId("theme-hive-value")).toHaveText("dark");
    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByTestId("theme-localstorage-value")).toHaveText("dark");
  });

  test("toggle dark to light updates HIVE, Astryx, and localStorage", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("hive-theme", "dark");
      document.documentElement.dataset.theme = "dark";
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("dark");

    // Toggle to light
    await page.getByTestId("theme-toggle-btn").click();

    await expect(page.getByTestId("theme-hive-value")).toHaveText("light");
    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByTestId("theme-localstorage-value")).toHaveText("light");
  });

  test("dark persists after toggle and reload", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("hive-theme", "light");
      document.documentElement.dataset.theme = "light";
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Toggle to dark
    await page.getByTestId("theme-toggle-btn").click();
    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("dark");

    // Reload and verify dark persists
    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("light persists after toggle and reload", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("hive-theme", "dark");
      document.documentElement.dataset.theme = "dark";
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Toggle to light
    await page.getByTestId("theme-toggle-btn").click();
    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("light");

    // Reload and verify light persists
    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("html[data-theme] is not removed after Astryx mounts", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("hive-theme", "dark");
      document.documentElement.dataset.theme = "dark";
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Verify data-theme exists on html after hydration
    await expect(page.locator("html")).toHaveAttribute("data-theme");

    // Toggle a few times and verify it's never removed
    await page.getByTestId("theme-toggle-btn").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.getByTestId("theme-toggle-btn").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("no hydration flash — theme stays consistent", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("hive-theme", "light");
      document.documentElement.dataset.theme = "light";
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("theme-hive-value")).toHaveText("light");
    await expect(page.getByTestId("theme-data-attr-value")).toHaveText("light");

    // Both should agree (no flash would have reset one)
    const hiveValue = await page.getByTestId("theme-hive-value").textContent();
    const attrValue = await page.getByTestId("theme-data-attr-value").textContent();
    expect(hiveValue).toBe(attrValue);
  });
});
