import { expect, type Page } from "@playwright/test";

export class HiveDesktopPage {
  constructor(readonly page: Page) {}

  async expectCockpit(): Promise<void> {
    await expect(this.page).toHaveTitle("HIVE Desktop");
    await expect(this.page.getByRole("navigation", { name: "Repositories and threads" })).toBeVisible();
    await expect(this.page.getByRole("main")).toBeVisible();
    await expect(this.page.getByRole("complementary", { name: "Run inspector" })).toBeVisible();
  }

  async openRepository(repositoryRoot: string): Promise<void> {
    await this.page.getByLabel("Repository path").fill(repositoryRoot);
    await this.page.getByRole("button", { name: /^Open$/ }).click();
    await expect(this.page.getByLabel("New thread title")).toBeVisible();
  }

  async openRecent(repositoryRoot: string): Promise<void> {
    await this.page.getByRole("button", { name: new RegExp(escapeRegExp(repositoryRoot), "i") }).click();
    await expect(this.page.getByText(repositoryRoot, { exact: true }).first()).toBeVisible();
  }

  async configureOpenAi(secret: string): Promise<void> {
    await this.page.getByLabel("Provider").selectOption("openai");
    await this.page.getByRole("button", { name: "Configure provider" }).click();
    await this.page.getByLabel("API key").fill(secret);
    await this.page.getByRole("button", { name: "Store encrypted credential" }).click();
    await expect(this.page.getByText("Credential encrypted and stored.")).toBeVisible();
  }

  async approveOllama(): Promise<void> {
    await this.page.getByLabel("Provider").selectOption("ollama");
    await this.page.getByRole("button", { name: "Configure provider" }).click();
    await this.page.getByRole("button", { name: "Approve local provider" }).click();
  }

  async createThread(title: string): Promise<void> {
    await this.page.getByLabel("New thread title").fill(title);
    await this.page.getByRole("button", { name: "Create thread" }).click();
    await expect(this.page.getByRole("heading", { name: title })).toBeVisible();
  }

  async selectThread(title: string): Promise<void> {
    await this.page.getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}`) }).click();
    await expect(this.page.getByRole("heading", { name: title })).toBeVisible();
  }

  async send(message: string): Promise<void> {
    await this.page.getByLabel("Message HIVE").fill(message);
    await this.page.getByRole("button", { name: "Send" }).click();
  }

  async expectPhase(phase: string): Promise<void> {
    await expect(this.page.getByRole("complementary", { name: "Run inspector" }).locator(".status-pill").filter({ hasText: phase }).first()).toBeVisible();
    if (["completed", "cancelled", "failed", "paused"].includes(phase)) {
      await expect(this.page.getByRole("banner").locator(".status-pill").filter({ hasText: "stopped" })).toBeVisible();
    }
  }

  async openTab(name: "Conversation" | "Changes" | "Report"): Promise<void> {
    await this.page.getByRole("tab", { name }).click();
    await expect(this.page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  }

  async previewAndConfirm(action: "commit" | "discard" | "push" | "PR"): Promise<void> {
    await this.page.getByRole("button", { name: `Preview ${action}` }).click();
    const dialog = this.page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: `Confirm ${action}` }).click();
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
