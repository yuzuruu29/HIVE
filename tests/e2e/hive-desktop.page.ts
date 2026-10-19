import { expect, type Page } from "@playwright/test";
import type { DesktopCommand, DesktopEvent } from "../../src/desktop/types";
import type { ProjectSnapshot, SharedSession } from "../../src/projects/types";

export class HiveDesktopPage {
  constructor(readonly page: Page) {}

  async expectCockpit(): Promise<void> {
    await expect(this.page).toHaveTitle("HIVE Desktop");
    await expect(this.page.getByRole("navigation", { name: "Conversations" })).toBeVisible();
    await expect(this.page.getByRole("main", { name: "HIVE conversation" })).toBeVisible();
  }
  async openRepository(repositoryRoot: string): Promise<void> {
    await this.page.getByRole("button", { name: "Attach project", exact: true }).click();
    const dialog = this.page.getByRole("dialog", { name: "Attach a project" });
    await dialog.getByLabel("Project folder").fill(repositoryRoot);
    await dialog.getByRole("button", { name: "Attach project", exact: true }).click();
    await expect(dialog).toBeHidden();
    await this.page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: "New chat", exact: true }).click();
    await expect(this.page.getByLabel("Message HIVE")).toBeVisible();
    await this.page.getByRole("combobox", { name: "Workflow" }).selectOption("code");
  }
  async configureOpenAi(secret: string): Promise<void> {
    await this.configure("OpenAI");
    const dialog = this.page.getByRole("dialog", { name: "Configure provider" });
    await dialog.getByLabel("API key").fill(secret);
    await dialog.getByRole("button", { name: "Store encrypted credential" }).click();
    await expect(dialog).toBeHidden();
    await this.closeSettings();
  }
  async approveOllama(): Promise<void> {
    await this.configure("Ollama (local)");
    const dialog = this.page.getByRole("dialog", { name: "Configure provider" });
    await dialog.getByRole("button", { name: "Approve local provider" }).click();
    await expect(dialog).toBeHidden();
    await this.closeSettings();
    // This suite injects a deterministic utility engine, rather than an installed Ollama daemon.
    const configured = await this.request({ type: "provider.configure", requestId: crypto.randomUUID(), input: { id: "ollama", name: "Ollama (local)", kind: "ollama", authType: "none", approved: true, baseUrl: "http://127.0.0.1:11434", defaultModel: "deterministic-fixture" } });
    expect(configured.type).toBe("provider.changed");
    await this.page.getByRole("button", { name: "Select model", exact: true }).click();
    await this.page.getByRole("listbox", { name: "Configured models" }).getByRole("group", { name: "Ollama (local)" }).getByRole("option").first().click();
  }
  async selectThread(title: string): Promise<void> {
    await this.page.getByRole("button", { name: "Search chats", exact: true }).click();
    const dialog = this.page.getByRole("dialog", { name: "Search chats" });
    await dialog.getByRole("textbox", { name: "Search all projects" }).fill(title);
    await dialog.getByRole("button", { name: new RegExp(escapeRegExp(title)) }).click();
    await expect(this.page.getByRole("heading", { level: 1 })).toHaveText(title);
  }
  async rename(title: string): Promise<void> {
    await this.page.getByRole("button", { name: "Chat actions", exact: true }).click();
    await this.page.getByRole("button", { name: "Rename chat" }).click();
    const dialog = this.page.getByRole("dialog", { name: "Rename chat" });
    await dialog.getByLabel("Name", { exact: true }).fill(title);
    await dialog.getByRole("button", { name: "Save name" }).click();
    await expect(dialog).toBeHidden();
  }
  /** Waits for a newly accepted run, never the previous attempt's completed status. */
  async send(message: string): Promise<void> {
    const previous = (await this.selectedSession())?.runs.at(-1)?.id;
    await this.page.getByLabel("Message HIVE").fill(message);
    await this.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(async () => (await this.selectedSession())?.runs.at(-1)?.id).not.toBe(previous);
  }
  async expectPhase(status: string): Promise<void> {
    await expect(this.page.locator(".project-run-status > span:first-child").last()).toHaveText(status.replace(/_/g, " "));
  }
  async openChanges(): Promise<void> {
    await this.page.getByRole("button", { name: "View changes", exact: true }).click();
    await expect(this.page.getByRole("dialog", { name: "Changes and checks" })).toBeVisible();
  }
  async snapshot(): Promise<ProjectSnapshot> {
    const event = await this.request({ type: "projects.snapshot", requestId: "e2e-state-" + crypto.randomUUID() });
    if (event.type !== "projects.snapshot") throw new Error("Shared snapshot unavailable.");
    return event.snapshot;
  }
  async selectedSession(): Promise<SharedSession | undefined> {
    const id = await this.page.evaluate(() => localStorage.getItem("hive.projects.selection.v1"));
    return (await this.snapshot()).sessions.find((session) => session.id === id);
  }
  async request(command: DesktopCommand): Promise<DesktopEvent> {
    const input = command.type === "projects.action" ? { ...command, requestId: command.action.requestId } : command;
    return this.page.evaluate((payload) => window.hiveDesktop.request(payload), input);
  }
  private async closeSettings(): Promise<void> {
    const settings = this.page.getByRole("dialog", { name: "Preferences & Accessibility" });
    await settings.getByRole("button", { name: "Done", exact: true }).click();
    await expect(settings).toBeHidden();
  }
  private async configure(providerName: string): Promise<void> {
    await this.page.getByRole("button", { name: "Settings", exact: true }).click();
    await this.page.getByRole("tab", { name: "Providers", exact: true }).click();
    await this.page.locator(".provider-settings-row").filter({ has: this.page.getByText(providerName, { exact: true }) }).getByRole("button", { name: "Configure", exact: true }).click();
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"); }
