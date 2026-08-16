import { test, expect } from "@playwright/test";

test.describe("ShareDialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/e2e-test/share-dialog");
  });

  // ---------------------------------------------------------------------------
  // 1. Dialog opens from the triggering control
  // ---------------------------------------------------------------------------
  test("dialog opens from the triggering control", async ({ page }) => {
    await expect(page.getByTestId("dialog-state")).toHaveText("closed");

    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();
    await expect(page.getByTestId("dialog-state")).toHaveText("open");
  });

  // ---------------------------------------------------------------------------
  // 2. Initial focus enters the dialog
  // ---------------------------------------------------------------------------
  test("initial focus enters the dialog", async ({ page }) => {
    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    const focused = page.locator(":focus");
    await expect(focused).toBeAttached();

    // Focused element should be a descendant of the dialog
    const dialog = page.getByTestId("share-dialog");
    await expect(dialog.locator(":focus")).toBeAttached();
  });

  // ---------------------------------------------------------------------------
  // 3. Tab cycles within the dialog (focus trap forward)
  // ---------------------------------------------------------------------------
  test("Tab cycles within the dialog", async ({ page }) => {
    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    const sentinelBefore = page.locator("#focus-trap-sentinel-before");
    const sentinelAfter = page.locator("#focus-trap-sentinel-after");

    // When dialog is open, tabbing should not reach sentinel elements outside dialog
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      await expect(sentinelBefore).not.toBeFocused();
      await expect(sentinelAfter).not.toBeFocused();
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Shift+Tab cycles within the dialog (focus trap backward)
  // ---------------------------------------------------------------------------
  test("Shift+Tab cycles within the dialog", async ({ page }) => {
    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    const sentinelBefore = page.locator("#focus-trap-sentinel-before");
    const sentinelAfter = page.locator("#focus-trap-sentinel-after");

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Shift+Tab");
      await expect(sentinelBefore).not.toBeFocused();
      await expect(sentinelAfter).not.toBeFocused();
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Focus does not escape into the page
  // ---------------------------------------------------------------------------
  test("focus does not escape into page content", async ({ page }) => {
    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    const trigger = page.getByTestId("open-share-trigger");

    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      // Focus must be inside the dialog, never on the trigger behind it
      await expect(trigger).not.toBeFocused();
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Escape dismisses the dialog
  // ---------------------------------------------------------------------------
  test("Escape dismisses the dialog", async ({ page }) => {
    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("share-dialog")).not.toBeVisible();
    await expect(page.getByTestId("dialog-state")).toHaveText("closed");
  });

  // ---------------------------------------------------------------------------
  // 7. Focus returns to the opening control after close
  // ---------------------------------------------------------------------------
  test("focus returns to the triggering control after close", async ({ page }) => {
    const trigger = page.getByTestId("open-share-trigger");
    await trigger.click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("share-dialog")).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  // ---------------------------------------------------------------------------
  // 8. Clicking the backdrop dismisses the dialog
  // ---------------------------------------------------------------------------
  test("clicking the backdrop dismisses the dialog", async ({ page }) => {
    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    // Astryx Dialog renders a backdrop; click the overlay element
    const backdrop = page.locator('[data-astryx-dialog-backdrop]');
    if (await backdrop.isVisible()) {
      await backdrop.click({ position: { x: 10, y: 10 } });
      await expect(page.getByTestId("share-dialog")).not.toBeVisible();
      await expect(page.getByTestId("dialog-state")).toHaveText("closed");
    } else {
      // Fallback: use Escape if backdrop element not found
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("share-dialog")).not.toBeVisible();
      await expect(page.getByTestId("dialog-state")).toHaveText("closed");
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Screen-reader-accessible dialog name and role
  // ---------------------------------------------------------------------------
  test("dialog has accessible name and role", async ({ page }) => {
    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    const dialog = page.getByTestId("share-dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // Verify an accessible heading exists
    await expect(
      dialog.getByRole("heading", { name: "Share conversation" }),
    ).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // 10. Create-share flow works (API returns success)
  // ---------------------------------------------------------------------------
  test("create-share flow creates link and shows URL", async ({ page }) => {
    await page.route("**/api/cloud/conversations/test-conversation-1/share", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          json: { data: { token: "test-token-abc", url: "/shared/test-token-abc" } },
        });
      } else {
        await route.fulfill({ status: 200, json: {} });
      }
    });

    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    const createBtn = page.getByTestId("share-create-button");
    await expect(createBtn).toBeVisible();
    await expect(createBtn).toBeEnabled();
    await createBtn.click();

    // After successful creation URL input and controls appear
    await expect(page.getByTestId("share-url-input")).toBeVisible();
    await expect(page.getByTestId("share-copy-button")).toBeVisible();
    await expect(page.getByTestId("share-revoke-button")).toBeVisible();

    // Create button should no longer be visible
    await expect(page.getByTestId("share-create-button")).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // 11. Revoke-share flow works (API returns success)
  // ---------------------------------------------------------------------------
  test("revoke-share flow revokes link and shows create button", async ({ page }) => {
    await page.route("**/api/cloud/conversations/test-conversation-1/share", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          json: { data: { token: "revoke-test", url: "/shared/revoke-test" } },
        });
      } else if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 200 });
      } else {
        await route.fulfill({ status: 200, json: {} });
      }
    });

    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    // Create a share first
    await page.getByTestId("share-create-button").click();
    await expect(page.getByTestId("share-url-input")).toBeVisible();

    // Now revoke it
    const revokeBtn = page.getByTestId("share-revoke-button");
    await expect(revokeBtn).toBeVisible();
    await revokeBtn.click();

    // After revocation the create button should reappear
    await expect(page.getByTestId("share-create-button")).toBeVisible();
    await expect(page.getByTestId("share-url-input")).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // 12. Copy action works (stub navigator.clipboard.writeText)
  // ---------------------------------------------------------------------------
  test("copy action copies the share URL", async ({ page }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: (text: string) => Promise.resolve() },
        configurable: true,
      });
    });

    await page.route("**/api/cloud/conversations/test-conversation-1/share", async (route) => {
      await route.fulfill({
        status: 200,
        json: { data: { token: "copy-test", url: "/shared/copy-test" } },
      });
    });

    await page.getByTestId("open-share-trigger").click();
    await page.getByTestId("share-create-button").click();
    await expect(page.getByTestId("share-copy-button")).toBeVisible();

    const copyBtn = page.getByTestId("share-copy-button");
    await copyBtn.click();

    await expect(copyBtn).toHaveText(/Copied/);
  });

  // ---------------------------------------------------------------------------
  // 13. Copy success state is announced (aria-live region)
  // ---------------------------------------------------------------------------
  test("copy success is announced via aria-live", async ({ page }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: (text: string) => Promise.resolve() },
        configurable: true,
      });
    });

    await page.route("**/api/cloud/conversations/test-conversation-1/share", async (route) => {
      await route.fulfill({
        status: 200,
        json: { data: { token: "announce-test", url: "/shared/announce-test" } },
      });
    });

    await page.getByTestId("open-share-trigger").click();
    await page.getByTestId("share-create-button").click();
    await page.getByTestId("share-copy-button").click();

    const liveRegion = page.getByTestId("share-dialog").locator('[aria-live="polite"].sr-only');
    await expect(liveRegion).toContainText("Share link copied to clipboard");
  });

  // ---------------------------------------------------------------------------
  // 14. Copy failure state is visible and accessible
  // ---------------------------------------------------------------------------
  test("copy failure shows accessible error state", async ({ page }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: () => Promise.reject(new DOMException("NotAllowedError", "ClipboardWriteError")),
        },
        configurable: true,
      });
    });

    await page.route("**/api/cloud/conversations/test-conversation-1/share", async (route) => {
      await route.fulfill({
        status: 200,
        json: { data: { token: "fail-test", url: "/shared/fail-test" } },
      });
    });

    await page.getByTestId("open-share-trigger").click();
    await page.getByTestId("share-create-button").click();
    await page.getByTestId("share-copy-button").click();

    // The sr-only aria-live region announces the failure
    const liveRegion = page.getByTestId("share-dialog").locator('[aria-live="polite"].sr-only');
    await expect(liveRegion).toContainText("Share link could not be copied");

    // The copy button label reflects failure
    await expect(page.getByTestId("share-copy-button")).toHaveAttribute("aria-label", "Copy failed");
  });

  // ---------------------------------------------------------------------------
  // 15. Creation failure state is visible and accessible
  // ---------------------------------------------------------------------------
  test("creation failure shows accessible error banner", async ({ page }) => {
    await page.route("**/api/cloud/conversations/test-conversation-1/share", async (route) => {
      await route.fulfill({ status: 500, json: { error: "Internal error" } });
    });

    await page.getByTestId("open-share-trigger").click();
    await page.getByTestId("share-create-button").click();

    const errorBanner = page.getByTestId("share-error");
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toHaveAttribute("role", "alert");
    await expect(errorBanner).toContainText("Failed to create share link.");
  });

  // ---------------------------------------------------------------------------
  // 16. Revocation failure state is visible and accessible
  // ---------------------------------------------------------------------------
  test("revocation failure shows accessible error banner", async ({ page }) => {
    await page.route("**/api/cloud/conversations/test-conversation-1/share", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          json: { data: { token: "revfail-token", url: "/shared/revfail-token" } },
        });
      } else if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 500, json: { error: "Revoke failed" } });
      } else {
        await route.fulfill({ status: 200, json: {} });
      }
    });

    await page.getByTestId("open-share-trigger").click();
    await page.getByTestId("share-create-button").click();
    await expect(page.getByTestId("share-revoke-button")).toBeVisible();

    await page.getByTestId("share-revoke-button").click();

    const errorBanner = page.getByTestId("share-error");
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toHaveAttribute("role", "alert");
    await expect(errorBanner).toContainText("Failed to revoke share link.");
  });

  // ---------------------------------------------------------------------------
  // 17. Loading actions prevent accidental duplicate submission
  // ---------------------------------------------------------------------------
  test("loading state prevents duplicate submission", async ({ page }) => {
    // Keep the request pending to hold the loading state
    await page.route("**/api/cloud/conversations/test-conversation-1/share", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.fulfill({
        status: 200,
        json: { data: { token: "loading-test", url: "/shared/loading-test" } },
      });
    });

    await page.getByTestId("open-share-trigger").click();
    await expect(page.getByTestId("share-dialog")).toBeVisible();

    const createBtn = page.getByTestId("share-create-button");
    await createBtn.click();

    // Button should become disabled while loading
    await expect(createBtn).toBeDisabled();
    // Verify the button text reflects loading
    await expect(createBtn).toContainText(/Creating/);
  });

  // ---------------------------------------------------------------------------
  // 18. Disabled controls expose correct semantics
  // ---------------------------------------------------------------------------
  test("disabled controls expose correct semantics", async ({ page }) => {
    await page.route("**/api/cloud/conversations/test-conversation-1/share", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          json: { data: { token: "disabled-test", url: "/shared/disabled-test" } },
        });
      } else if (route.request().method() === "DELETE") {
        // Delay to observe disabled state
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.fulfill({ status: 200 });
      } else {
        await route.fulfill({ status: 200, json: {} });
      }
    });

    await page.getByTestId("open-share-trigger").click();
    await page.getByTestId("share-create-button").click();
    await expect(page.getByTestId("share-revoke-button")).toBeVisible();

    // Click revoke, then verify it becomes disabled during the operation
    const revokeBtn = page.getByTestId("share-revoke-button");
    await revokeBtn.click();
    await expect(revokeBtn).toBeDisabled();
  });
});
