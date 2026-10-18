import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopCommand, DesktopEvent } from "../../../../src/desktop/types";
import type { ProjectSnapshot, SharedRun, SharedSession } from "../../../../src/projects/types";
import { ProjectWorkspaceApp } from "./ProjectWorkspaceApp";

const now = "2026-10-18T12:00:00.000Z";
const baseSession: SharedSession = { id: "one", projectId: "alpha", workspaceId: "alpha-workspace", title: "First conversation", archived: false, createdAt: now, updatedAt: now, settings: { mode: "code", permissions: "guarded", providerId: "local", model: "local-model" }, messages: [], runs: [], sources: [] };
const baseRun: SharedRun = { id: "run-one", sessionId: "one", requestId: "accepted", workspaceId: "alpha-workspace", workspace: "C:\\Alpha", status: "completed", settings: baseSession.settings, effectivePolicy: "guarded: concrete tool approval", startedAt: now, endedAt: now, summary: "Recorded task result", engine: "live", events: [{ id: "event-one", sequence: 1, role: "Validator", kind: "check", text: "Executed check command", createdAt: now }], patches: [{ path: "src/app.ts", additions: 1, deletions: 1, state: "applied", workspace: "C:\\Alpha", diff: "-old\n+new" }], checks: [{ id: "check-one", name: "Unit tests", command: "node --test", workspace: "C:\\Alpha", status: "passed", exitCode: 0 }], approvals: [] };

function snapshot(): ProjectSnapshot { return { schemaVersion: 1, revision: 1, warnings: [], projects: ["alpha", "beta"].map((id) => ({ id, name: id === "alpha" ? "Alpha" : "Beta", repositoryId: id, repositoryPath: `C:\\${id}`, workspaces: [{ id: `${id}-workspace`, path: `C:\\${id}`, repositoryId: id, branch: "main" }], lastSessionId: id === "alpha" ? "one" : "three", createdAt: now, updatedAt: now })), sessions: [baseSession, { ...baseSession, id: "two", title: "Second conversation" }, { ...baseSession, id: "three", projectId: "beta", workspaceId: "beta-workspace", title: "Other project chat" }] }; }

function bridge(initial = snapshot(), override?: (command: DesktopCommand) => Promise<DesktopEvent | undefined>) {
  let current = structuredClone(initial);
  const listeners = new Set<(event: DesktopEvent) => void>();
  const request = vi.fn(async (command: DesktopCommand): Promise<DesktopEvent> => {
    const custom = await override?.(command); if (custom) return custom;
    if (command.type === "projects.snapshot") return { type: "projects.snapshot", timestamp: now, snapshot: current };
    if (command.type === "provider.list") return { type: "provider.listed", timestamp: now, providers: [{ id: "local", name: "Local", kind: "local", authType: "none", configured: true, approved: true, defaultModel: "local-model" }] };
    if (command.type === "models.list") return { type: "models.listed", timestamp: now, providerId: command.providerId, models: [] };
    if (command.type === "projects.action") {
      const action = command.action;
      expect(command.requestId).toBe(action.requestId);
      current = { ...current, revision: current.revision + 1 };
      if ("sessionId" in action) {
        current.sessions = current.sessions.map((session) => {
          if (session.id !== action.sessionId) return session;
          if (action.type === "session.rename") return { ...session, title: action.title };
          if (action.type === "session.settings") return { ...session, settings: { ...session.settings, ...action.settings } };
          if (action.type === "session.archive" || action.type === "session.restore") return { ...session, archived: action.type === "session.archive" };
          return session;
        });
      }
      return { type: "projects.snapshot", timestamp: now, requestId: command.requestId, snapshot: current, result: "sessionId" in action ? { sessionId: action.sessionId } : {} };
    }
    return { type: "request.completed", timestamp: now, requestId: command.requestId };
  });
  return { request, subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, emit: (next: ProjectSnapshot) => { current = next; listeners.forEach((listener) => listener({ type: "projects.snapshot", timestamp: now, snapshot: next })); } };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("shared project conversation", () => {
  it("mounts grouped projects and one composer; external entry hints never steal focus or drafts", async () => {
    const api = bridge(); const user = userEvent.setup();
    render(<ProjectWorkspaceApp api={api} />);
    const composer = await screen.findByRole("textbox", { name: "Message HIVE" });
    expect(screen.getAllByRole("textbox", { name: "Message HIVE" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Other project chat" })).not.toBeInTheDocument();
    await user.type(composer, "A client-local draft");
    const external = snapshot(); external.revision = 2; external.projects[0].lastSessionId = "two";
    await act(async () => api.emit(external));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("First conversation");
    expect(composer).toHaveValue("A client-local draft"); expect(composer).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Second conversation" }));
    expect(composer).toHaveValue("");
    await user.type(composer, "Second draft");
    await user.click(screen.getByRole("button", { name: "First conversation" }));
    expect(composer).toHaveValue("A client-local draft");
  });

  it("keeps the same request ID after a lost send acknowledgment and preserves later edits", async () => {
    let calls = 0; let resolveSend: ((event: DesktopEvent) => void) | undefined;
    const api = bridge(snapshot(), async (command) => {
      if (command.type === "projects.action" && command.action.type === "session.send") {
        calls++;
        if (calls === 1) throw new Error("Acknowledgment unavailable");
        return await new Promise<DesktopEvent>((resolve) => { resolveSend = resolve; });
      }
      return undefined;
    });
    const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    const composer = await screen.findByRole("textbox", { name: "Message HIVE" });
    await user.type(composer, "Run this"); await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Acknowledgment unavailable"); expect(composer).toHaveValue("Run this");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.type(composer, " with a follow-up draft");
    const attempts = api.request.mock.calls.map(([command]) => command).filter((command) => command.type === "projects.action" && command.action.type === "session.send");
    expect(attempts).toHaveLength(2);
    if (attempts[0].type !== "projects.action" || attempts[1].type !== "projects.action") throw new Error("Missing send actions");
    expect(attempts[0].action.requestId).toBe(attempts[1].action.requestId);
    expect(attempts.every((command) => command.type === "projects.action" && command.requestId === command.action.requestId)).toBe(true);
    await act(async () => resolveSend?.({ type: "projects.snapshot", timestamp: now, snapshot: { ...snapshot(), revision: 3 }, result: { sessionId: "one", runId: "run-one" } }));
    expect(composer).toHaveValue("Run this with a follow-up draft");
  });

  it("searches across projects, opens the owning chat, and restores archived chats", async () => {
    const initial = snapshot(); initial.sessions[2].archived = true;
    const api = bridge(initial); const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    await screen.findByRole("textbox", { name: "Message HIVE" });
    await user.click(screen.getByRole("button", { name: "Search chats" }));
    const dialog = screen.getByRole("dialog", { name: "Search chats" });
    await user.type(within(dialog).getByRole("textbox", { name: "Search all projects" }), "Other");
    expect(within(dialog).getByText("No matching chats.")).toBeVisible();
    await user.click(within(dialog).getByLabelText("Include archived chats"));
    await user.click(within(dialog).getByRole("button", { name: /Other project chat Beta/ }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Other project chat");
    expect(screen.queryByRole("textbox", { name: "Message HIVE" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore chat" }));
    expect(await screen.findByRole("textbox", { name: "Message HIVE" })).toBeVisible();
  });

  it("shows actual evidence on demand and separates review from permission approval", async () => {
    const initial = snapshot(); initial.sessions[0] = { ...baseSession, messages: [{ id: "answer", role: "assistant", text: "Completed response <script>alert(1)</script>", createdAt: now, runId: baseRun.id }], runs: [baseRun] };
    const api = bridge(initial); const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    await screen.findByText(/Completed response/);
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Changes and checks" })).not.toBeInTheDocument();
    expect(screen.getByText(/Activity · 1 agent role/).closest("details")).not.toHaveAttribute("open");
    await user.click(screen.getByRole("button", { name: "View changes" }));
    const changes = screen.getByRole("dialog", { name: "Changes and checks" });
    expect(within(changes).getByText("Unit tests · passed · exit 0")).toBeInTheDocument();
    await user.click(within(changes).getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(api.request.mock.calls.map(([command]) => command)).toContainEqual(expect.objectContaining({ type: "projects.action", action: expect.objectContaining({ type: "run.review", sessionId: "one", runId: "run-one" }) })));
    expect(api.request.mock.calls.some(([command]) => command.type === "projects.action" && command.action.type === "run.approve")).toBe(false);
  });

  it("disables archive/settings during execution and sends concrete approval and stop commands", async () => {
    const initial = snapshot(); initial.sessions[0] = { ...baseSession, runs: [{ ...baseRun, status: "awaiting_approval", endedAt: null, approvals: [{ id: "approval-one", runId: "run-one", tool: "write_file", description: "Write src/app.ts", input: { path: "src/app.ts" }, workspace: "C:\\Alpha", external: false, createdAt: now, expiresAt: "2026-10-18T12:30:00.000Z", status: "pending" }] }] };
    const api = bridge(initial); const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    await screen.findByRole("button", { name: "Stop run" });
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Workflow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Select model" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Approve this action" }));
    await waitFor(() => expect(api.request.mock.calls.map(([command]) => command)).toContainEqual(expect.objectContaining({ type: "projects.action", action: expect.objectContaining({ type: "run.approve", approvalId: "approval-one", runId: "run-one", approved: true }) })));
    await user.click(screen.getByRole("button", { name: "Stop run" }));
    await waitFor(() => expect(api.request.mock.calls.map(([command]) => command)).toContainEqual(expect.objectContaining({ type: "projects.action", action: expect.objectContaining({ type: "run.cancel", runId: "run-one" }) })));
  });

  it("updates workflow through shared settings and ignores older snapshots", async () => {
    const api = bridge(); const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    const workflow = await screen.findByRole("combobox", { name: "Workflow" });
    await user.selectOptions(workflow, "plan");
    await waitFor(() => expect(workflow).toHaveValue("plan"));
    await act(async () => api.emit(snapshot()));
    expect(workflow).toHaveValue("plan");
  });

  it("keeps drawer focus inside and returns it to the navigation trigger", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const api = bridge(); const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    const trigger = await screen.findByRole("button", { name: "Open navigation" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("allows the existing configured route without a desktop model catalog and preserves rejected input", async () => {
    const api = bridge(snapshot(), async (command) => {
      if (command.type === "provider.list") return { type: "provider.listed", timestamp: now, providers: [] };
      if (command.type === "projects.action" && command.action.type === "session.send") return { type: "request.failed", timestamp: now, requestId: command.requestId, recoverable: true, message: "The configured provider is unavailable. Configure a provider and retry." };
      return undefined;
    });
    const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    const composer = await screen.findByRole("textbox", { name: "Message HIVE" });
    await user.type(composer, "Use my configured HIVE route");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("configured provider is unavailable");
    expect(composer).toHaveValue("Use my configured HIVE route");
  });

  it("keeps image attachments local to each draft and sends them through the validated engine context", async () => {
    const api = bridge(); const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    const composer = await screen.findByRole("textbox", { name: "Message HIVE" });
    await user.click(screen.getByRole("button", { name: "Attach images" }));
    const dialog = screen.getByRole("dialog", { name: "Attach images" });
    await user.type(within(dialog).getByLabelText("Local image paths"), "C:\\Images\\screenshot.png");
    await user.click(within(dialog).getByRole("button", { name: "Save attachments" }));
    expect(screen.getByRole("button", { name: "Remove image screenshot.png" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Second conversation" }));
    expect(screen.queryByRole("button", { name: "Remove image screenshot.png" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "First conversation" }));
    expect(screen.getByRole("button", { name: "Remove image screenshot.png" })).toBeVisible();
    await user.type(composer, "Explain the image");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(api.request.mock.calls.map(([command]) => command)).toContainEqual(expect.objectContaining({ type: "projects.action", action: expect.objectContaining({ type: "session.send", sessionId: "one", executionContext: { imagePaths: ["C:\\Images\\screenshot.png"] } }) })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove image screenshot.png" })).not.toBeInTheDocument());
  });

  it("previews legacy history before explicit backup/import and keeps the current selection and draft", async () => {
    const imported = snapshot(); imported.revision = 10; imported.projects[0].lastSessionId = "legacy-one"; imported.sessions.push({ ...baseSession, id: "legacy-one", title: "Imported CLI history" });
    const api = bridge(snapshot(), async (command) => {
      if (command.type === "projects.import.preview") return { type: "projects.import.previewed", timestamp: now, preview: { projectId: "alpha", workspaceId: "alpha-workspace", digest: "verified-preview", counts: { cli: 1, thread: 0, chat: 0, messages: 2 }, warnings: [], sessions: [{ id: "legacy-one", title: "Imported CLI history", messages: 2 }], alreadyImported: false } };
      if (command.type === "projects.import.confirm") return { type: "projects.imported", timestamp: now, result: { snapshot: imported, imported: 1, duplicate: false, backupDirectory: "C:\\Alpha\\history-backup" } };
      return undefined;
    });
    const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    const composer = await screen.findByRole("textbox", { name: "Message HIVE" });
    await user.type(composer, "Keep this local draft");
    await user.click(screen.getByRole("button", { name: "Import legacy history" }));
    const dialog = await screen.findByRole("dialog", { name: "Import legacy history" });
    expect(within(dialog).getByText("Imported CLI history · 2 messages")).toBeVisible();
    expect(api.request.mock.calls.some(([command]) => command.type === "projects.import.confirm")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Back up and import" }));
    expect(await within(dialog).findByText("C:\\Alpha\\history-backup")).toBeVisible();
    const confirmed = api.request.mock.calls.map(([command]) => command).find((command) => command.type === "projects.import.confirm");
    expect(confirmed).toEqual(expect.objectContaining({ digest: "verified-preview", projectId: "alpha", workspaceId: "alpha-workspace" }));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("First conversation");
    expect(composer).toHaveValue("Keep this local draft");
  });

  it("does not select or focus a delayed new chat after the user chooses another conversation", async () => {
    let resolveCreate: ((event: DesktopEvent) => void) | undefined;
    const api = bridge(snapshot(), async (command) => command.type === "projects.action" && command.action.type === "session.create" ? await new Promise<DesktopEvent>((resolve) => { resolveCreate = resolve; }) : undefined);
    const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    const composer = await screen.findByRole("textbox", { name: "Message HIVE" });
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "New chat" }));
    await user.click(screen.getByRole("button", { name: "Second conversation" }));
    await user.type(composer, "Keep the newer selection");
    const next = snapshot(); next.revision = 5; next.sessions.push({ ...baseSession, id: "delayed-new", title: "New chat" });
    await act(async () => resolveCreate?.({ type: "projects.snapshot", timestamp: now, snapshot: next, result: { sessionId: "delayed-new", projectId: "alpha" } }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Second conversation");
    expect(composer).toHaveValue("Keep the newer selection"); expect(composer).toHaveFocus();
  });

  it("restores a scrolled transcript and draft when returning from legacy history", async () => {
    const api = bridge(); const user = userEvent.setup(); const { container } = render(<ProjectWorkspaceApp api={api} />);
    const composer = await screen.findByRole("textbox", { name: "Message HIVE" });
    await user.type(composer, "Draft survives the legacy view");
    const transcript = container.querySelector<HTMLDivElement>(".project-transcript")!;
    Object.defineProperty(transcript, "scrollHeight", { value: 2000 });
    Object.defineProperty(transcript, "clientHeight", { value: 400 });
    transcript.scrollTop = 270; fireEvent.scroll(transcript);
    await user.click(screen.getByRole("button", { name: "Legacy history & tools" }));
    await user.click(screen.getByRole("button", { name: /Projects and conversations/ }));
    expect(container.querySelector<HTMLDivElement>(".project-transcript")?.scrollTop).toBe(270);
    expect(screen.getByRole("textbox", { name: "Message HIVE" })).toHaveValue("Draft survives the legacy view");
  });

  it("retries transient provider metadata failure when Settings is opened", async () => {
    let providerRequests = 0;
    const api = bridge(snapshot(), async (command) => { if (command.type === "provider.list" && ++providerRequests === 1) throw new Error("Transient provider metadata failure"); return undefined; });
    const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider settings could not be loaded");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = screen.getByRole("dialog", { name: "Preferences & Accessibility" });
    await user.click(within(settings).getByRole("tab", { name: "Providers" }));
    expect(await within(settings).findByText("Local", { exact: true })).toBeVisible();
    expect(providerRequests).toBe(2);
    expect(screen.queryByText("Provider settings could not be loaded. Reconnect or open Settings to try again.")).not.toBeInTheDocument();
  });

  it("uses the run's owning workspace for guarded Git in another attached worktree", async () => {
    const initial = snapshot();
    const workspace = "C:\\Alpha-linked";
    initial.sessions[0].runs = [{ ...baseRun, workspace, engineSessionId: "coding-linked" }];
    const seen: string[] = [];
    const api = bridge(initial, async (command) => {
      if (command.type === "repository.open") { seen.push(command.repositoryRoot); return { type: "desktop.ready", timestamp: now, repositoryRoot: command.repositoryRoot }; }
      if (command.type === "changes.diff") { seen.push(command.input.repositoryRoot); return { type: "changes.diffed", timestamp: now, diff: { repositoryRoot: workspace, codingSessionId: "coding-linked", patch: "", truncated: false, recordedFiles: [], reviewedFiles: [], commitEligibility: "no-recorded-files" } }; }
      return undefined;
    });
    const user = userEvent.setup(); render(<ProjectWorkspaceApp api={api} />);
    await user.click(await screen.findByRole("button", { name: "View changes" }));
    await user.click(screen.getByRole("button", { name: "Preview commit" }));
    await waitFor(() => expect(seen).toEqual([workspace, workspace]));
  });
});
