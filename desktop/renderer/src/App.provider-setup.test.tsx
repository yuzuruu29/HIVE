import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DesktopCommand, DesktopEvent, DesktopProviderMetadata } from "../../../src/desktop/types";
import { App } from "./App";

const now = "2026-10-18T00:00:00.000Z";
const fixtureCredential = "fixture-only-desktop-credential";

function setupBridge(options: {
  existing?: boolean;
  failWriteOnce?: boolean;
  failMetadata?: boolean;
  writeBarrier?: () => Promise<void>;
  keyless?: boolean;
  pickedPath?: string | null;
} = {}) {
  let stored = options.existing ?? false;
  let approved = false;
  const writes: DesktopCommand[] = [];
  const listeners = new Set<(event: DesktopEvent) => void>();
  const provider = (): DesktopProviderMetadata => ({
    id: "desktop-only", name: "Desktop provider", kind: options.keyless ? "ollama" : "openai-compatible",
    authType: options.keyless ? "none" : "api-key", baseUrl: "http://127.0.0.1:1234/v1",
    defaultModel: "fixture-model", approved, configured: approved && (options.keyless || stored),
  });
  const request = vi.fn(async (command: DesktopCommand): Promise<DesktopEvent> => {
    let event: DesktopEvent;
    switch (command.type) {
      case "repository.list": event = { type: "repository.listed", timestamp: now, repositories: [] }; break;
      case "repository.open": event = { type: "desktop.ready", timestamp: now, repositoryRoot: command.repositoryRoot }; break;
      case "workspace.pick": event = { type: "workspace.picked", timestamp: now, path: options.pickedPath === undefined ? "C:\\fixture-project" : options.pickedPath }; break;
      case "provider.list": event = { type: "provider.listed", timestamp: now, providers: [provider()] }; break;
      case "provider.configure":
        approved = command.input.approved;
        event = { type: "provider.changed", timestamp: now, provider: provider() };
        break;
      case "credential.list": event = options.failMetadata
        ? { type: "request.failed", timestamp: now, requestId: command.requestId, recoverable: true, message: "Metadata unavailable." }
        : { type: "credential.listed", timestamp: now, credentials: stored ? [{ providerId: "desktop-only", kind: "api-key", configured: true, updatedAt: now }] : [] };
        break;
      case "credential.set": case "credential.replace":
        writes.push(structuredClone(command));
        await options.writeBarrier?.();
        if (options.failWriteOnce && writes.length === 1) {
          event = { type: "request.failed", timestamp: now, requestId: command.requestId, recoverable: true, message: "Encrypted store is temporarily unavailable." };
        } else {
          stored = true;
          event = { type: "credential.changed", timestamp: now, credential: { providerId: command.input.providerId, kind: command.input.kind, configured: true, updatedAt: now } };
        }
        break;
      case "models.list": event = { type: "models.listed", timestamp: now, providerId: command.providerId, models: [{ id: "fixture-model" }] }; break;
      case "thread.list": event = { type: "thread.listed", timestamp: now, threads: [] }; break;
      case "chat.list": event = { type: "chat.listed", timestamp: now, conversations: [] }; break;
      case "chat.create": event = { type: "chat.changed", timestamp: now, conversation: { id: "fixture-conversation", cwd: "C:\\fixture-project", role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [] } }; break;
      default: event = { type: "request.completed", timestamp: now, requestId: command.requestId };
    }
    listeners.forEach((listener) => listener(event));
    return event;
  });
  return { request, writes, subscribe(listener: (event: DesktopEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

async function configure(api: ReturnType<typeof setupBridge>) {
  render(<App api={api} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^settings$/i }));
  const settings = await screen.findByRole("dialog", { name: /preferences & accessibility/i });
  const row = (await within(settings).findByText("Desktop provider")).closest("li")!;
  await user.click(within(row).getByRole("button", { name: "Configure" }));
  await screen.findByRole("dialog", { name: "Configure provider" });
  return user;
}

describe("desktop provider setup", () => {
  for (const existing of [false, true]) {
    it(`${existing ? "replaces an existing unapproved key" : "stores a new key"} and refreshes provider/model metadata`, async () => {
      const api = setupBridge({ existing });
      const user = await configure(api);
      await user.type(screen.getByLabelText("API key"), fixtureCredential);
      await user.click(screen.getByRole("button", { name: "Store encrypted credential" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configure provider" })).not.toBeInTheDocument());
      expect(api.writes).toHaveLength(1);
      expect(api.writes[0]).toMatchObject({ type: existing ? "credential.replace" : "credential.set", input: { providerId: "desktop-only", kind: "api-key", secret: fixtureCredential } });
      await waitFor(() => expect(api.request.mock.calls.filter(([command]) => command.type === "models.list")).toHaveLength(1));
      expect(api.request.mock.calls.filter(([command]) => command.type === "provider.list").length).toBeGreaterThan(1);
      expect(document.body.textContent).not.toContain(fixtureCredential);
      expect(JSON.stringify(localStorage)).not.toContain(fixtureCredential);
      const write = api.request.mock.calls.map(([command]) => command).find((command) => command.type === "credential.set" || command.type === "credential.replace");
      expect(write && "input" in write && write.input).toMatchObject({ secret: "" });
    });
  }

  it("keeps a failed save in the dialog with its masked entry and allows retry", async () => {
    const api = setupBridge({ failWriteOnce: true });
    const user = await configure(api);
    await user.type(screen.getByLabelText("API key"), fixtureCredential);
    await user.click(screen.getByRole("button", { name: "Store encrypted credential" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/setup could not be saved/i);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByLabelText("API key")).toHaveValue(fixtureCredential);
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Store encrypted credential" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configure provider" })).not.toBeInTheDocument());
    expect(api.writes).toHaveLength(2);
  });

  it("does not overwrite a key when credential metadata cannot be inspected", async () => {
    const api = setupBridge({ existing: true, failMetadata: true });
    const user = await configure(api);
    await user.type(screen.getByLabelText("API key"), fixtureCredential);
    await user.click(screen.getByRole("button", { name: "Store encrypted credential" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/setup could not be saved/i);
    expect(api.writes).toHaveLength(0);
    expect(api.request.mock.calls.some(([command]) => command.type === "provider.configure")).toBe(false);
    expect(screen.getByLabelText("API key")).toHaveValue(fixtureCredential);
  });

  it("blocks duplicate submissions and Escape until an encrypted write settles", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const api = setupBridge({ existing: true, writeBarrier: () => barrier });
    const user = await configure(api);
    await user.type(screen.getByLabelText("API key"), fixtureCredential);
    await user.click(screen.getByRole("button", { name: "Store encrypted credential" }));
    try {
      expect(await screen.findByRole("button", { name: /saving encrypted credential/i })).toBeDisabled();
      await user.keyboard("{Escape}");
      expect(screen.getByRole("dialog", { name: "Configure provider" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel provider setup" })).toBeDisabled();
      fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
      expect(api.writes).toHaveLength(1);
      expect(api.request.mock.calls.some(([command]) => command.type === "models.list")).toBe(false);
    } finally {
      release();
    }
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configure provider" })).not.toBeInTheDocument());
  });

  it("approves a keyless local provider without attempting credential storage", async () => {
    const api = setupBridge({ keyless: true });
    const user = await configure(api);
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve local provider" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configure provider" })).not.toBeInTheDocument());
    await waitFor(() => expect(api.request.mock.calls.some(([command]) => command.type === "models.list")).toBe(true));
    expect(api.request.mock.calls.some(([command]) => command.type.startsWith("credential."))).toBe(false);
  });

  it("keeps a first-message draft through setup and sends the selected desktop model after opening a folder", async () => {
    const api = setupBridge();
    render(<App api={api} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Message HIVE" }), "Explain this project");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    await user.click(await screen.findByRole("button", { name: "Open Settings" }));
    const row = (await screen.findByText("Desktop provider")).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Configure" }));
    await user.type(screen.getByLabelText("API key"), fixtureCredential);
    await user.click(screen.getByRole("button", { name: "Store encrypted credential" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Message HIVE" })).toHaveValue("Explain this project");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(api.request.mock.calls.some(([command]) => command.type === "chat.send")).toBe(true));
    expect(api.request.mock.calls.map(([command]) => command).find((command) => command.type === "chat.send")).toMatchObject({ input: { providerId: "desktop-only", model: "fixture-model", content: "Explain this project" } });
  });

  it("treats cancelling the folder picker as a no-op and keeps the draft", async () => {
    const api = setupBridge({ pickedPath: null });
    render(<App api={api} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Message HIVE" }), "Keep my draft");
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    expect(screen.getByRole("textbox", { name: "Message HIVE" })).toHaveValue("Keep my draft");
    expect(api.request.mock.calls.some(([command]) => ["repository.open", "chat.list", "chat.create", "chat.send"].includes(command.type))).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
