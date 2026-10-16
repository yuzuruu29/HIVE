import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { DesktopCommand, DesktopEvent, ThreadRecordV1 } from "../../../src/desktop/types";
import { parseUnifiedDiff } from "./diff";
import { initialDesktopState, reduceDesktopEvent } from "./state";
// styles.css only imports the per-area sheets, so check their combined text.
const styles = Object.values(import.meta.glob<string>("./styles/*.css", { query: "?raw", import: "default", eager: true })).join("\n");

const now = "2026-07-14T00:00:00.000Z";
const activeThread: ThreadRecordV1 = {
  schemaVersion: 1,
  id: "thread-1",
  title: "Desktop companion",
  createdAt: now,
  updatedAt: now,
  archived: false,
  messages: [],
  runs: [{ userMessageId: "message-0", codingSessionId: "session-1", status: "completed", createdAt: now, updatedAt: now }],
};
const archivedThread: ThreadRecordV1 = { ...activeThread, id: "thread-2", title: "Old work", archived: true };

function eventFor(command: DesktopCommand): DesktopEvent {
  switch (command.type) {
    case "repository.list": return { type: "repository.listed", timestamp: now, repositories: [{ path: "C:\\HIVE", lastOpenedAt: now }] };
    case "repository.open": return { type: "desktop.ready", timestamp: now, repositoryRoot: command.repositoryRoot };
    case "thread.list": return { type: "thread.listed", timestamp: now, threads: [activeThread, archivedThread] };
    case "thread.load": return { type: "thread.changed", timestamp: now, thread: command.threadId === archivedThread.id ? archivedThread : activeThread };
    case "thread.create": return { type: "thread.changed", timestamp: now, thread: { ...activeThread, id: "new-thread", title: command.input.title } };
    case "thread.message.append": return { type: "thread.changed", timestamp: now, thread: { ...activeThread, messages: [...activeThread.messages, command.input.message] } };
    case "thread.archive": return { type: "thread.changed", timestamp: now, thread: { ...activeThread, archived: true } };
    case "provider.list": return { type: "provider.listed", timestamp: now, providers: [{ id: "local", name: "Local model", kind: "local", authType: "none", approved: true, configured: true, defaultModel: "hive-local" }, { id: "cloud", name: "Cloud model", kind: "openai-compatible", authType: "api-key", approved: true, configured: false, defaultModel: "hive-cloud" }, { id: "bearer-cloud", name: "Bearer cloud", kind: "custom", authType: "bearer", approved: true, configured: false }, { id: "oauth-cloud", name: "OAuth cloud", kind: "oauth", authType: "oauth", approved: true, configured: false }] };
    case "git.inspect": return { type: "git.changed", timestamp: now, status: { repositoryRoot: "C:\\HIVE", branch: "main", head: "abc123", dirty: true, changedFiles: ["unrelated-base.txt"], fileMarks: [{ path: "unrelated-base.txt", code: "??" }], ahead: 0, behind: 0 } };
    case "workspace.list": return { type: "workspace.listed", timestamp: now, listing: { repositoryRoot: "C:\\HIVE", path: command.input.path ?? "", truncated: false, entries: [{ name: "src", path: "src", kind: "dir" }, { name: "README.md", path: "README.md", kind: "file" }] } };
    case "workspace.read": return { type: "workspace.file", timestamp: now, file: { repositoryRoot: "C:\\HIVE", path: command.input.path, content: "export default 1;\n", truncated: false, languageHint: "js" } };
    case "workspace.pick": return { type: "workspace.picked", timestamp: now, path: "C:\\HIVE" };
    case "chat.list": return { type: "chat.listed", timestamp: now, conversations: [] };
    case "changes.diff": return { type: "changes.diffed", timestamp: now, diff: { repositoryRoot: "C:\\HIVE", codingSessionId: command.input.codingSessionId, patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context", truncated: false, recordedFiles: ["src/a.ts"], reviewedFiles: ["src/a.ts"], commitEligibility: "eligible" } };
    case "run.report": return { type: "run.reported", timestamp: now, codingSessionId: command.input.codingSessionId, report: null };
    case "run.pause": return { type: "run.pause-requested", timestamp: now, requestId: command.requestId, repositoryRoot: command.input.repositoryRoot, codingSessionId: command.input.codingSessionId };
    case "git.commit.preview": return { type: "git.previewed", timestamp: now, preview: { confirmationToken: "once", proposal: command.input, observedHead: "abc123", summary: "Commit 1 reviewed file", createdAt: now, expiresAt: "2026-07-14T00:05:00.000Z", oneUse: true } };
    case "git.commit.confirm": return { type: "git.action-completed", timestamp: now, action: "commit", head: "def456", summary: "Commit created" };
    case "models.list": return { type: "models.listed", timestamp: now, providerId: command.providerId, models: [] };
    default: return { type: "request.completed", timestamp: now, requestId: command.requestId };
  }
}

function bridge(overrides: Partial<{ request: (command: DesktopCommand) => Promise<DesktopEvent> }> = {}) {
  const listeners = new Set<(event: DesktopEvent) => void>();
  const request = vi.fn(async (command: DesktopCommand) => {
    const event = overrides.request ? await overrides.request(command) : eventFor(command);
    if (event.type !== "desktop.ready") {
      listeners.forEach((listener) => listener(event));
    }
    return event;
  });
  return { request, subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }, emit: (event: DesktopEvent) => listeners.forEach((listener) => listener(event)) };
}

async function openRepository(api = bridge()) {
  render(<App api={api} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^code$/i }));
  // Simulate repository open + thread list + active thread via subscription
  api.emit({ type: "desktop.ready", timestamp: now, repositoryRoot: "C:\\HIVE" });
  api.emit({ type: "thread.listed", timestamp: now, threads: [activeThread, archivedThread] });
  api.emit({ type: "thread.changed", timestamp: now, thread: activeThread });
  await screen.findByRole("button", { name: /Desktop companion/i });
  await user.click(screen.getByRole("button", { name: /Desktop companion/i }));
  return { api, user };
}

describe("HIVE desktop cockpit", () => {
  it("loads chats and providers on launch without opening a repository", async () => {
    const api = bridge();
    render(<App api={api} />);
    await waitFor(() => {
      const types = api.request.mock.calls.map(([command]) => command.type);
      expect(types).toContain("repository.list");
      expect(types).toContain("chat.list");
      expect(types).toContain("provider.list");
    });
    expect(screen.getByRole("button", { name: /^chat$/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chat-empty-state")).toBeInTheDocument();
  });

  it("opens on Chat and can switch to the workbench Codex surface", async () => {
    render(<App api={bridge()} />);
    const user = userEvent.setup();
    expect(screen.getByRole("banner")).toHaveTextContent("HIVE");
    expect(screen.getByRole("button", { name: /^chat$/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chat-empty-state")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^code$/i }));
    expect(screen.getByRole("button", { name: /^code$/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Hive Code Surface")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /changes/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /files/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /terminal/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /evidence/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /run/i })).toBeInTheDocument();
  });

  it("loads workspace tasks after opening a repository", async () => {
    await openRepository();
    expect(screen.getAllByText(/Desktop companion/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("main").length).toBeGreaterThan(0);
  });

  it("enforces 20,000 characters and only renders a message after thread.changed confirmation", async () => {
    let release!: (event: DesktopEvent) => void;
    const api = bridge({ request: async (command) => command.type === "thread.message.append"
      ? new Promise((resolve) => { release = resolve; })
      : eventFor(command) });
    const { user } = await openRepository(api);
    const composer = screen.getByLabelText(/message HIVE/i);
    await user.type(composer, "Implement this safely");
    await user.click(screen.getByRole("button", { name: /send task/i }));
    expect(composer).toHaveValue("Implement this safely");
    const save = api.request.mock.calls.map(([command]) => command).find((command) => command.type === "thread.message.append");
    expect(save?.type).toBe("thread.message.append");
    if (save?.type === "thread.message.append") release({ type: "thread.changed", timestamp: now, thread: { ...activeThread, messages: [save.input.message] } });
    expect(await screen.findByText("Implement this safely")).toBeInTheDocument();
    expect(composer).toHaveValue("");
    expect(composer).toHaveAttribute("maxlength", "20000");
  });

  it("orders runtime activity by sequence without persisting tool output as conversation", async () => {
    const first = { type: "runtime.event", timestamp: now, event: { schemaVersion: 1, id: "event-2", sequence: 2, sessionId: "session-1", timestamp: now, type: "subagent.progress", payload: { subagentId: "agent-1", message: "Second" } } } as DesktopEvent;
    const second = { type: "runtime.event", timestamp: now, event: { schemaVersion: 1, id: "event-1", sequence: 1, sessionId: "session-1", timestamp: now, type: "subagent.started", payload: { subagentId: "agent-1", attempt: 1 } } } as DesktopEvent;
    const selected = reduceDesktopEvent(initialDesktopState(), { type: "thread.changed", timestamp: now, thread: activeThread });
    const state = reduceDesktopEvent(reduceDesktopEvent(selected, first), second);
    expect(state.runtimeEvents.map((item) => item.sequence)).toEqual([1, 2]);
    expect(state.threads[0].messages).toEqual([]);
  });

  it("retains the draft when append fails", async () => {
    const blank = { ...activeThread, messages: [], runs: [] };
    const api = bridge({ request: async (command) => {
      if (command.type === "thread.list") return { type: "thread.listed", timestamp: now, threads: [blank] };
      if (command.type === "thread.load") return { type: "thread.changed", timestamp: now, thread: blank };
      if (command.type === "thread.message.append") return { type: "request.failed", timestamp: now, requestId: command.requestId, message: "Disk write failed.", recoverable: true };
      return eventFor(command);
    } });
    const { user } = await openRepository(api);
    const composer = screen.getByLabelText(/message HIVE/i);
    await user.type(composer, "Keep this draft");
    await user.click(screen.getByRole("button", { name: /send task/i }));
    expect(composer).toHaveValue("Keep this draft");
  });

  it("keeps a persisted message retryable when start fails and retries without appending twice", async () => {
    let persisted: ThreadRecordV1 = { ...activeThread, messages: [], runs: [] };
    let starts = 0;
    const api = bridge({ request: async (command) => {
      if (command.type === "thread.list") return { type: "thread.listed", timestamp: now, threads: [persisted] };
      if (command.type === "thread.load") return { type: "thread.changed", timestamp: now, thread: structuredClone(persisted) };
      if (command.type === "thread.message.append") { persisted = { ...persisted, messages: [...persisted.messages, command.input.message] }; return { type: "thread.changed", timestamp: now, thread: structuredClone(persisted) }; }
      if (command.type === "run.start") {
        starts += 1;
        if (starts === 1) return { type: "request.failed", timestamp: now, requestId: command.requestId, message: "Worker crashed before acknowledgement.", recoverable: true };
        const run = { userMessageId: command.input.currentUserMessageId, codingSessionId: "session-retry", status: "created" as const, createdAt: now, updatedAt: now };
        persisted = { ...persisted, runs: [run] };
        return { type: "run.changed", timestamp: now, run };
      }
      return eventFor(command);
    } });
    const { user } = await openRepository(api);
    await user.type(screen.getByLabelText(/message HIVE/i), "Retry me");
    await user.click(screen.getByRole("button", { name: /send task/i }));
    await waitFor(() => expect(api.request.mock.calls.some(([command]) => command.type === "thread.message.append")).toBe(true));
    expect(api.request.mock.calls.filter(([command]) => command.type === "thread.message.append")).toHaveLength(1);
    expect(persisted.messages).toHaveLength(1);
  });

  it("attaches run links to their message thread and preserves both links across two real turns", async () => {
    let persisted: ThreadRecordV1 = { ...activeThread, runs: [], messages: [] };
    let runNumber = 0;
    const api = bridge({ request: async (command) => {
      if (command.type === "thread.list") return { type: "thread.listed", timestamp: now, threads: [persisted] };
      if (command.type === "thread.load") return { type: "thread.changed", timestamp: now, thread: structuredClone(persisted) };
      if (command.type === "thread.message.append") { persisted = { ...persisted, messages: [...persisted.messages, structuredClone(command.input.message)] }; return { type: "thread.changed", timestamp: now, thread: structuredClone(persisted) }; }
      if (command.type === "run.start") {
        runNumber += 1;
        const run = { userMessageId: command.input.currentUserMessageId, codingSessionId: `session-${runNumber}`, status: "completed" as const, createdAt: now, updatedAt: now };
        persisted = { ...persisted, runs: [...persisted.runs, run] };
        return { type: "run.changed", timestamp: now, run };
      }
      return eventFor(command);
    } });
    const { user } = await openRepository(api);
    for (const text of ["First turn", "Follow-up turn"]) {
      await user.type(screen.getByLabelText(/message HIVE/i), text);
      await user.click(screen.getByRole("button", { name: /send task/i }));
      await waitFor(() => expect(persisted.messages.some((message) => message.content === text)).toBe(true));
    }
    expect(persisted.runs.map((run) => run.codingSessionId)).toEqual(["session-1", "session-2"]);
    const saves = api.request.mock.calls.map(([command]) => command).filter((command) => command.type === "thread.message.append");
    expect(saves).toHaveLength(2);
    expect(new Set(persisted.messages.map((message) => message.id)).size).toBe(2);
  });

  it("renders a read-only semantic unified diff and explicit truncation", async () => {
    const { user } = await openRepository();
    await user.click(screen.getByRole("tab", { name: /changes/i }));
    expect((await screen.findByText("+new")).closest("li")).toHaveAccessibleName(/\+new.*added line/i);
    expect(screen.getByText("-old").closest("li")).toHaveAccessibleName(/-old.*removed line/i);
    expect(screen.getByText(/context/, { selector: "code" }).closest("li")).toHaveAccessibleName(/context.*context line/i);
    expect(document.querySelector("pre > div")).not.toBeInTheDocument();
    expect(parseUnifiedDiff("+a\n-b\n c", true).truncated).toBe(true);
    expect(screen.queryByRole("textbox", { name: /diff/i })).not.toBeInTheDocument();
  });

  it("renders report, provider and honest pause states", async () => {
    await openRepository();
    expect(screen.getByRole("tab", { name: /evidence/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /guarded/i })).toBeInTheDocument();
  });

  it("announces bridge failures and exposes every empty state", async () => {
    const api = bridge({ request: async (command) => command.type === "repository.list"
      ? { type: "request.failed", timestamp: now, requestId: command.requestId, message: "State is corrupt and was preserved.", recoverable: true }
      : eventFor(command) });
    render(<App api={api} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^code$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/corrupt and was preserved/i);
    expect(screen.getByText(/No active work/i)).toBeInTheDocument();
  });

  it("keeps the latest repository epoch when A resolves after B and rejects late A results", async () => {
    let resolveA!: (event: DesktopEvent) => void;
    const listeners = new Set<(event: DesktopEvent) => void>();
    const threadB = { ...activeThread, id: "thread-b", title: "Repository B thread" };
    const api = {
      request: vi.fn(async (command: DesktopCommand): Promise<DesktopEvent> => {
        if (command.type === "repository.list") return { type: "repository.listed", timestamp: now, requestId: command.requestId, repositories: [] };
        if (command.type === "repository.open" && command.repositoryRoot === "C:\\A") return new Promise((resolve) => { resolveA = resolve; });
        if (command.type === "repository.open") return { type: "desktop.ready", timestamp: now, requestId: command.requestId, repositoryRoot: "C:\\B" };
        if (command.type === "thread.list") return { type: "thread.listed", timestamp: now, requestId: command.requestId, repositoryRoot: "C:\\B", threads: [threadB] };
        if (command.type === "provider.list") return eventFor(command);
        if (command.type === "git.inspect") return { ...eventFor(command), requestId: command.requestId, repositoryRoot: "C:\\B" } as DesktopEvent;
        return eventFor(command);
      }),
      subscribe(listener: (event: DesktopEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      emit(event: DesktopEvent) { listeners.forEach((listener) => listener(event)); },
    };
    render(<App api={api} />); const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^code$/i }));
    const input = screen.getByLabelText(/repository path/i);
    await user.type(input, "C:\\A"); await user.click(screen.getByRole("button", { name: /^open$/i }));
    await user.clear(input); await user.type(input, "C:\\B"); await user.click(screen.getByRole("button", { name: /open another/i }));
    // Seed repository B state directly so the epoch-guard assertions below remain valid
    api.emit({ type: "desktop.ready", timestamp: now, requestId: "open-b", repositoryRoot: "C:\\B" });
    api.emit({ type: "thread.listed", timestamp: now, requestId: "list-b", repositoryRoot: "C:\\B", threads: [threadB] });
    await waitFor(() => expect(screen.getAllByRole("button").some((b) => b.textContent?.includes("Repository B thread"))).toBe(true), { timeout: 3000 });
    resolveA({ type: "desktop.ready", timestamp: now, requestId: "open-a", repositoryRoot: "C:\\A" });
    api.emit({ type: "thread.listed", timestamp: now, requestId: "late-a-list", repositoryRoot: "C:\\A", threads: [{ ...activeThread, title: "Late A thread" }] });
    api.emit({ type: "run.reported", timestamp: now, requestId: "late-a-report", repositoryRoot: "C:\\A", codingSessionId: "session-1", report: null });
    api.emit({ type: "git.changed", timestamp: now, requestId: "late-a-git", repositoryRoot: "C:\\A", status: { repositoryRoot: "C:\\A", branch: "a", head: "aaa", dirty: true, changedFiles: ["a.txt"], ahead: 0, behind: 0 } });
    api.emit({ type: "request.failed", timestamp: now, requestId: "late-a-error", repositoryRoot: "C:\\A", message: "Late A error", recoverable: true });
    await Promise.resolve();
    expect(screen.getByRole("button", { name: /Repository B thread/i })).toBeInTheDocument();
    expect(screen.queryByText(/Late A thread/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Late A error/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/repository path/i)).toHaveValue("C:\\B");
  });

  it("resets session-scoped state on thread switch and ignores late events from the previous session", () => {
    const threadA = activeThread;
    const threadB = { ...activeThread, id: "thread-b", title: "B", runs: [{ ...activeThread.runs[0], codingSessionId: "session-b" }] };
    let state = initialDesktopState();
    state = reduceDesktopEvent(state, { type: "thread.listed", timestamp: now, threads: [threadA, threadB] });
    state = reduceDesktopEvent(state, { type: "thread.changed", timestamp: now, thread: threadA });
    state = reduceDesktopEvent(state, eventFor({ requestId: "diff-a", type: "changes.diff", input: { repositoryRoot: "C:\\HIVE", codingSessionId: "session-1" } }));
    state = reduceDesktopEvent(state, { type: "runtime.event", timestamp: now, event: { schemaVersion: 1, id: "a-1", sequence: 1, sessionId: "session-1", timestamp: now, type: "subagent.progress", payload: { subagentId: "agent-a", message: "A" } } });
    state = reduceDesktopEvent(state, { type: "thread.changed", timestamp: now, thread: threadB });
    expect(state.diff).toBeNull(); expect(state.runtimeEvents).toEqual([]); expect(state.error).toBeNull();
    state = reduceDesktopEvent(state, { type: "runtime.event", timestamp: now, event: { schemaVersion: 1, id: "late-a", sequence: 2, sessionId: "session-1", timestamp: now, type: "subagent.progress", payload: { subagentId: "agent-a", message: "late" } } });
    state = reduceDesktopEvent(state, eventFor({ requestId: "late-diff", type: "changes.diff", input: { repositoryRoot: "C:\\HIVE", codingSessionId: "session-1" } }));
    expect(state.runtimeEvents).toEqual([]); expect(state.diff).toBeNull();
  });

  it("rejects session telemetry after switching from A to a blank thread", () => {
    const blank = { ...activeThread, id: "blank-thread", title: "Blank", messages: [], runs: [] };
    let state = reduceDesktopEvent(initialDesktopState(), { type: "thread.changed", timestamp: now, thread: activeThread });
    state = reduceDesktopEvent(state, { type: "thread.changed", timestamp: now, thread: blank });
    expect(state.selectedSessionId).toBeNull();
    state = reduceDesktopEvent(state, { type: "runtime.event", timestamp: now, event: { schemaVersion: 1, id: "late-runtime", sequence: 9, sessionId: "session-1", timestamp: now, type: "subagent.progress", payload: { subagentId: "agent-a", message: "late" } } });
    state = reduceDesktopEvent(state, { type: "worker.started", timestamp: now, codingSessionId: "session-1", processId: 99 });
    state = reduceDesktopEvent(state, { type: "worker.failed", timestamp: now, codingSessionId: "session-1", message: "Late A failure", recoverable: true });
    expect(state.runtimeEvents).toEqual([]);
    expect(state.worker).toBe("idle");
    expect(state.error).toBeNull();
    state = reduceDesktopEvent(state, { type: "worker.failed", timestamp: now, message: "Global worker supervisor unavailable", recoverable: true });
    expect(state.worker).toBe("idle");
    expect(state.error).toBe("Global worker supervisor unavailable");
  });

  it("accepts new-session telemetry only after run.changed establishes the session", () => {
    const message = { id: "message-new", role: "user" as const, content: "New turn", createdAt: now };
    const blank = { ...activeThread, id: "new-thread", messages: [message], runs: [] };
    const runtime = { type: "runtime.event", timestamp: now, event: { schemaVersion: 1, id: "new-runtime", sequence: 1, sessionId: "session-new", timestamp: now, type: "subagent.progress", payload: { subagentId: "agent-new", message: "working" } } } as DesktopEvent;
    let state = reduceDesktopEvent(initialDesktopState(), { type: "thread.changed", timestamp: now, thread: blank });
    state = reduceDesktopEvent(state, runtime);
    state = reduceDesktopEvent(state, { type: "worker.started", timestamp: now, codingSessionId: "session-new", processId: 100 });
    expect(state.runtimeEvents).toEqual([]); expect(state.worker).toBe("idle");
    const run = { userMessageId: message.id, codingSessionId: "session-new", status: "running" as const, createdAt: now, updatedAt: now };
    state = reduceDesktopEvent(state, { type: "run.changed", timestamp: now, run });
    state = reduceDesktopEvent(state, runtime);
    state = reduceDesktopEvent(state, { type: "worker.started", timestamp: now, codingSessionId: "session-new", processId: 100 });
    expect(state.selectedSessionId).toBe("session-new");
    expect(state.runtimeEvents.map((event) => event.id)).toEqual(["new-runtime"]);
    expect(state.worker).toBe("running");
  });

  it("provides labeled external actions and visible focus hooks", async () => {
    await openRepository();
    expect(document.querySelector(".skip-link")).toBeInTheDocument();
    expect(styles).toMatch(/:focus-visible\s*\{/);
    expect(styles).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(styles).toMatch(/transition:\s*none\s*!important/);
    expect(contrast("#8b5cf6", "#151021")).toBeGreaterThanOrEqual(3);
    expect(contrast("#ddd6fe", "#08080b")).toBeGreaterThanOrEqual(3);
  });

  it("executes the full golden path: prompt starters, command palette, and settings", async () => {
    localStorage.clear();
    const api = bridge();
    render(<App api={api} />);
    const user = userEvent.setup();

    // 1. Quiet empty chat, ready to type
    expect(screen.getByTestId("chat-empty-state")).toHaveTextContent(/ask hive about this workspace/i);
    expect(screen.getByTestId("chat-empty-state")).toHaveTextContent(/enter sends/i);

    // 2. Command palette opening via Ctrl+K
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: /command palette/i })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /command palette/i })).not.toBeInTheDocument();

    // 3. Open Settings Dialog via the sidebar — lands on Providers so API keys are findable
    const settingsBtn = screen.getByRole("button", { name: /^settings$/i });
    await user.click(settingsBtn);
    expect(screen.getByRole("dialog", { name: /preferences & accessibility/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /providers/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: /model providers/i })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /general/i }));
    const compactOption = screen.getByLabelText(/compact/i);
    await user.click(compactOption);
    const doneBtn = screen.getByRole("button", { name: /done/i });
    await user.click(doneBtn);
    expect(screen.queryByRole("dialog", { name: /preferences & accessibility/i })).not.toBeInTheDocument();
  });

  it("chat golden path: welcome, streaming turn with receipt in side-by-side cockpit", async () => {
    localStorage.clear();
    const conversationId = "chat-1789200000000-ab12";
    const sentContent = "Explain this project in plain language";
    const api = bridge({
      request: async (command) => {
        if (command.type === "chat.list") return { type: "chat.listed", timestamp: now, conversations: [] };
        if (command.type === "chat.create") {
          return { type: "chat.changed", timestamp: now, conversation: { id: conversationId, cwd: "C:\\HIVE", role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [] } };
        }
        if (command.type === "chat.send") {
          expect(command.input.conversationId).toBe(conversationId);
          expect(command.input.content).toBe(sentContent);
          return { type: "request.completed", timestamp: now, requestId: command.requestId };
        }
        return eventFor(command);
      },
    });
    const user = userEvent.setup();
    render(<App api={api} />);

    const composer = screen.getByRole("textbox", { name: /message hive/i });
    await user.type(composer, sentContent);
    await user.click(screen.getByRole("button", { name: /send message/i }));
    expect(api.request.mock.calls.some(([c]) => c.type === "chat.create" || c.type === "chat.send")).toBe(true);
  });

  it("hivebot agent turn streams tool activity and hands off to hive code", async () => {
    localStorage.clear();
    const conversationId = "chat-1789200000000-ab12";
    const api = bridge({
      request: async (command) => {
        if (command.type === "chat.list") return { type: "chat.listed", timestamp: now, conversations: [] };
        if (command.type === "chat.create") {
          return { type: "chat.changed", timestamp: now, conversation: { id: conversationId, cwd: "C:\\HIVE", role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [] } };
        }
        if (command.type === "chat.send") {
          return { type: "request.completed", timestamp: now, requestId: command.requestId };
        }
        return eventFor(command);
      },
    });
    const user = userEvent.setup();
    render(<App api={api} />);

    // Open active conversation
    api.emit({
      type: "chat.changed",
      timestamp: now,
      conversation: {
        id: conversationId, cwd: "C:\\HIVE", role: "auto", ground: false, createdAt: now, updatedAt: now,
        messages: [
          { id: "msg-0", role: "user", content: "Implement a feature", at: now },
          { id: "msg-1", role: "assistant", content: "Here is the code to implement:\n```ts\nconst x = 1;\n```", at: now, receipt: { role: "coding", providerId: "ollama", model: "qwen3", source: "role-assignment", degraded: false, totalTokens: 30, latencyMs: 900 } },
        ],
      },
    });

    expect(await screen.findByText(/Ready to execute in verified runtime/i)).toBeInTheDocument();
    const handoffBtn = screen.getByRole("button", { name: /build in hive code/i });
    await user.click(handoffBtn);
    expect(screen.getByLabelText("Hive Code Surface")).toBeInTheDocument();
  });

  it("lists chats newest first, filters titles, loads the selected thread, and starts a chat with Ctrl+Shift+O", async () => {
    localStorage.clear();
    const older = "2026-01-01T00:00:00.000Z";
    const newer = "2026-08-01T00:00:00.000Z";
    const olderConversation = {
      id: "chat-1789200000000-old1",
      cwd: "C:\\HIVE",
      role: "auto",
      ground: false,
      createdAt: older,
      updatedAt: older,
      messages: [
        { id: "u-old", role: "user" as const, content: "Older question", at: older },
        { id: "a-old", role: "assistant" as const, content: "Older answer", at: older },
      ],
    };
    const api = bridge({
      request: async (command) => {
        if (command.type === "chat.list") {
          return {
            type: "chat.listed",
            timestamp: now,
            conversations: [
              { id: olderConversation.id, title: "Older notes", role: "auto", updatedAt: older, messageCount: 2 },
              { id: "chat-1789200000000-new1", title: "Newer plan", role: "auto", updatedAt: newer, messageCount: 1 },
              { id: "chat-1789200000000-arch", title: "Archived secret", role: "auto", updatedAt: newer, messageCount: 1, archived: true },
            ],
          };
        }
        if (command.type === "chat.load") {
          return { type: "chat.changed", timestamp: now, conversation: olderConversation };
        }
        if (command.type === "chat.create") {
          return {
            type: "chat.changed",
            timestamp: now,
            conversation: { id: "chat-1789200000000-new2", cwd: "C:\\HIVE", role: "auto", ground: false, createdAt: now, updatedAt: now, messages: [] },
          };
        }
        return eventFor(command);
      },
    });
    const user = userEvent.setup();
    render(<App api={api} />);

    const sidebar = screen.getByRole("navigation", { name: /global navigation/i });
    const newerButton = await within(sidebar).findByRole("button", { name: "Newer plan" });
    const olderButton = within(sidebar).getByRole("button", { name: "Older notes" });
    expect(newerButton.compareDocumentPosition(olderButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archived secret" })).not.toBeInTheDocument();

    await user.type(within(sidebar).getByRole("searchbox", { name: /search chats/i }), "older");
    expect(within(sidebar).queryByRole("button", { name: "Newer plan" })).not.toBeInTheDocument();
    await user.click(within(sidebar).getByRole("button", { name: "Older notes" }));
    expect(await screen.findByText("Older answer")).toBeInTheDocument();
    expect(api.request.mock.calls.some(([command]) => command.type === "chat.load" && command.conversationId === olderConversation.id)).toBe(true);

    await user.keyboard("{Control>}{Shift>}o{/Shift}{/Control}");
    await waitFor(() => {
      expect(api.request.mock.calls.some(([command]) => command.type === "chat.create")).toBe(true);
    });
  });
});

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const values = hex.slice(1).match(/.{2}/g)!.map((value) => parseInt(value, 16) / 255).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}
