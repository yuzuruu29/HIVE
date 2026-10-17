import { expect, type Page } from "@playwright/test";

export class HiveDesktopPage {
  constructor(readonly page: Page) {}

  async expectCockpit(): Promise<void> {
    await expect(this.page).toHaveTitle("HIVE Desktop");
    await expect(this.page.getByRole("navigation", { name: "Global Navigation" })).toBeVisible();
    await expect(this.page.getByRole("main")).toBeVisible();
  }

  async openRepository(repositoryRoot: string): Promise<void> {
    await this.page.getByLabel("Repository path").fill(repositoryRoot);
    await this.page.getByRole("button", { name: /^Open$/ }).click();
    await this.openCode();
  }

  async openCode(): Promise<void> {
    await this.page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(this.page.getByLabel("Hive Code Surface")).toBeVisible();
  }

  async openRecent(repositoryRoot: string): Promise<void> {
    await this.page.keyboard.press("Control+K");
    const palette = this.page.getByRole("dialog", { name: "Command palette" });
    await palette.getByLabel("Search commands").fill(repositoryRoot);
    await palette.getByRole("option", { name: `Open repository: ${repositoryRoot}` }).click();
    await expect(this.page.getByLabel("Repository path")).toHaveValue(repositoryRoot);
    await this.openCode();
  }

  async configureOpenAi(secret: string): Promise<void> {
    await this.configure("OpenAI");
    await this.page.getByLabel("API key").fill(secret);
    await this.page.getByRole("button", { name: "Store encrypted credential" }).click();
    await expect(this.page.getByText("Credential encrypted and stored.")).toBeVisible();
  }

  async approveOllama(): Promise<void> {
    await this.configure("Ollama (local)");
    await this.page.getByRole("button", { name: "Approve local provider" }).click();
    await expect(this.page.getByRole("dialog")).toHaveCount(0);
  }

  async selectThread(title: string): Promise<void> {
    await this.page.getByRole("region", { name: "Code tasks" }).getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}`) }).click();
    await expect(this.page.locator(".user-message-bubble").filter({ hasText: title }).first()).toBeVisible();
  }

  /** Sends a task and waits until its run is the active one, so later phase checks cannot match the previous run. */
  async send(message: string): Promise<void> {
    await this.openTab("Run");
    const previous = await this.runField("Session ID").textContent();
    await this.page.getByLabel("Message HIVE").fill(message);
    await this.page.getByRole("button", { name: "Send task" }).click();
    await expect(this.runField("Session ID")).not.toHaveText(previous ?? "");
  }

  async expectPhase(phase: string): Promise<void> {
    await this.openTab("Run");
    await expect(this.runField("Active Run Status")).toHaveText(phase);
  }

  async openTab(name: "Changes" | "Files" | "Terminal" | "Evidence" | "Run"): Promise<void> {
    const tab = this.page.getByRole("complementary", { name: "Harness Inspector" }).getByRole("tab", { name: new RegExp(`^${name}`) });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }

  async previewAndConfirm(action: "commit" | "discard" | "push" | "PR"): Promise<void> {
    await this.openTab("Changes");
    await this.page.getByRole("button", { name: `Preview ${action}` }).click();
    const dialog = this.page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: `Confirm ${action}` }).click();
  }

  private runField(label: string) {
    return this.page.getByRole("complementary", { name: "Harness Inspector" }).locator(".hive-evidence-row").filter({ has: this.page.getByText(label, { exact: true }) }).locator("span").nth(1);
  }

  private async configure(providerName: string): Promise<void> {
    await this.page.getByRole("button", { name: "Settings" }).click();
    await this.page.getByRole("tab", { name: "Providers" }).click();
    await this.page.locator(".provider-settings-row").filter({ has: this.page.getByText(providerName, { exact: true }) }).getByRole("button", { name: "Configure" }).click();
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
