import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { DesktopCommand, DesktopEvent, ThreadRecordV1 } from "../../../src/desktop/types";
import { parseUnifiedDiff } from "./diff";
import { initialDesktopState, reduceDesktopEvent } from "./state";
import styles from "./styles.css?raw";

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
    case "git.inspect": return { type: "git.changed", timestamp: now, status: { repositoryRoot: "C:\\HIVE", branch: "main", head: "abc123", dirty: true, changedFiles: ["unrelated-base.txt"], ahead: 0, behind: 0 } };
    case "changes.diff": return { type: "changes.diffed", timestamp: now, diff: { repositoryRoot: "C:\\HIVE", codingSessionId: command.input.codingSessionId, patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context", truncated: false, recordedFiles: ["src/a.ts"], reviewedFiles: ["src/a.ts"], commitEligibility: "eligible" } };
    case "run.report": return { type: "run.reported", timestamp: now, codingSessionId: command.input.codingSessionId, report: null };
    case "run.pause": return { type: "run.pause-requested", timestamp: now, requestId: command.requestId, repositoryRoot: command.input.repositoryRoot, codingSessionId: command.input.codingSessionId };
    case "git.commit.preview": return { type: "git.previewed", timestamp: now, preview: { confirmationToken: "once", proposal: command.input, observedHead: "abc123", summary: "Commit 1 reviewed file", createdAt: now, expiresAt: "2026-07-14T00:05:00.000Z", oneUse: true } };
    case "git.commit.confirm": return { type: "git.action-completed", timestamp: now, action: "commit", head: "def456", summary: "Commit created" };
    default: return { type: "request.completed", timestamp: now, requestId: command.requestId };
  }
}

function bridge(overrides: Partial<{ request: (command: DesktopCommand) => Promise<DesktopEvent> }> = {}) {
  const listeners = new Set<(event: DesktopEvent) => void>();
  const request = vi.fn(async (command: DesktopCommand) => {
    const event = overrides.request ? await overrides.request(command) : eventFor(command);
    listeners.forEach((listener) => listener(event));
    return event;
  });
  return { request, subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }, emit: (event: DesktopEvent) => listeners.forEach((listener) => listener(event)) };
}

async function openRepository(api = bridge()) {
  render(<App api={api} />);
  const user = userEvent.setup();
  await screen.findByRole("button", { name: /C:\\HIVE/i });
  await user.click(screen.getByRole("button", { name: /C:\\HIVE/i }));
  await screen.findByRole("button", { name: /Desktop companion/i });
  await user.click(screen.getByRole("button", { name: /Desktop companion/i }));
  return { api, user };
}

describe("HIVE desktop cockpit", () => {
  it("renders semantic three-pane layout and onboarding/recent repository state", async () => {
    render(<App api={bridge()} />);
    expect(screen.getByRole("banner")).toHaveTextContent("HIVE");
    expect(screen.getByRole("navigation", { name: /repositories and threads/i })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /run inspector/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /C:\\HIVE/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/repository path/i)).toBeInTheDocument();
  });

  it("loads active and archived threads and supports tab keyboard semantics", async () => {
    const { user } = await openRepository();
    expect(screen.getByRole("button", { name: /Desktop companion/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Old work/i })).toBeInTheDocument();
    const changes = screen.getByRole("tab", { name: /changes/i });
    changes.focus();
    await user.keyboard("{Enter}");
    expect(changes).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName(/changes/i);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /report/i })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /report/i })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: /conversation/i })).toHaveFocus();
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
  });

  it("enforces 20,000 characters and only renders a message after thread.changed confirmation", async () => {
    let release!: (event: DesktopEvent) => void;
    const api = bridge({ request: async (command) => command.type === "thread.message.append"
      ? new Promise((resolve) => { release = resolve; })
      : eventFor(command) });
    const { user } = await openRepository(api);
    const composer = screen.getByLabelText(/message HIVE/i);
    await user.type(composer, "Implement this safely");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(screen.getByText(/saving message/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/disk write failed/i);
    expect(composer).toHaveValue("Keep this draft");
    expect(api.request.mock.calls.some(([command]) => command.type === "run.start")).toBe(false);
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
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText(/saved, but the run did not start/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry run/i }));
    await waitFor(() => expect(starts).toBe(2));
    expect(api.request.mock.calls.filter(([command]) => command.type === "thread.message.append")).toHaveLength(1);
    expect(persisted.messages).toHaveLength(1);
    expect(persisted.runs).toHaveLength(1);
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
      await user.click(screen.getByRole("button", { name: /send/i }));
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
    expect(screen.getByText(/Local model/i)).toBeInTheDocument();
    expect(screen.getByText(/No run report yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeDisabled();
    expect(screen.getByText(/safe checkpoint/i)).toBeInTheDocument();
  });

  it("requests pause from the keyboard, blocks duplicates while pausing, and enables Resume only after authoritative pause", async () => {
    const runningThread: ThreadRecordV1 = { ...activeThread, messages: [{ id: "message-0", role: "user", content: "Run", createdAt: now }], runs: [{ ...activeThread.runs[0], status: "running" }] };
    const api = bridge({ request: async (command) => {
      if (command.type === "thread.list") return { type: "thread.listed", timestamp: now, threads: [runningThread] };
      if (command.type === "thread.load") return { type: "thread.changed", timestamp: now, thread: runningThread };
      return eventFor(command);
    } });
    const { user } = await openRepository(api);
    api.emit({ type: "worker.started", timestamp: now, repositoryRoot: "C:\\HIVE", codingSessionId: "session-1", processId: 42 });
    const pause = await screen.findByRole("button", { name: "Pause" });
    expect(pause).toBeEnabled();
    pause.focus();
    await user.keyboard("{Enter}");
    expect(api.request.mock.calls.filter(([command]) => command.type === "run.pause")).toHaveLength(1);
    expect(await screen.findByText("Pausing…", { selector: "button" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(api.request.mock.calls.filter(([command]) => command.type === "run.pause")).toHaveLength(1);
    api.emit({ type: "run.changed", timestamp: now, repositoryRoot: "C:\\HIVE", run: { ...runningThread.runs[0], status: "paused" } });
    expect(await screen.findByRole("button", { name: "Resume" })).toBeEnabled();
    expect(screen.queryByText("Pausing…", { selector: "button" })).not.toBeInTheDocument();
  });

  it("clears Pausing state when the matching pause request fails without altering the active run", async () => {
    const runningThread: ThreadRecordV1 = { ...activeThread, messages: [{ id: "message-0", role: "user", content: "Run", createdAt: now }], runs: [{ ...activeThread.runs[0], status: "running" }] };
    const api = bridge({ request: async (command) => {
      if (command.type === "thread.list") return { type: "thread.listed", timestamp: now, threads: [runningThread] };
      if (command.type === "thread.load") return { type: "thread.changed", timestamp: now, thread: runningThread };
      if (command.type === "run.pause") return eventFor(command);
      return eventFor(command);
    } });
    const { user } = await openRepository(api);
    api.emit({ type: "worker.started", timestamp: now, repositoryRoot: "C:\\HIVE", codingSessionId: "session-1", processId: 42 });
    await user.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByText("Pausing…", { selector: "button" })).toBeDisabled();
    const pauseCommand = api.request.mock.calls.map(([command]) => command).find((command) => command.type === "run.pause");
    api.emit({ type: "request.failed", timestamp: now, requestId: pauseCommand!.requestId, repositoryRoot: "C:\\HIVE", message: "Pause does not match the active coding session.", recoverable: true });
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not match/i);
    expect(screen.queryByText("Pausing…", { selector: "button" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getAllByText("running", { selector: ".status-pill" })).toHaveLength(2);
  });

  it("announces bridge failures and exposes every empty state", async () => {
    const api = bridge({ request: async (command) => command.type === "repository.list"
      ? { type: "request.failed", timestamp: now, requestId: command.requestId, message: "State is corrupt and was preserved.", recoverable: true }
      : eventFor(command) });
    render(<App api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/corrupt and was preserved/i);
    expect(screen.getByText(/No recent repositories/i)).toBeInTheDocument();
    expect(screen.getByText(/Open a repository to begin/i)).toBeInTheDocument();
    expect(screen.getByText(/No active run/i)).toBeInTheDocument();
  });

  it("requires an explicit one-use confirmation dialog for guarded Git", async () => {
    const { api, user } = await openRepository();
    await user.click(screen.getByRole("button", { name: /preview commit/i }));
    const dialog = await screen.findByRole("dialog", { name: /confirm commit/i });
    expect(within(dialog).getByText(/one.use/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /confirm commit/i }));
    expect(api.request.mock.calls.some(([command]) => command.type === "git.commit.confirm")).toBe(true);
    const preview = api.request.mock.calls.map(([command]) => command).find((command) => command.type === "git.commit.preview");
    expect(preview?.type === "git.commit.preview" && preview.input.paths).toEqual(["src/a.ts"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("enables commit from session changes even when the base is clean, and disables sessions with no reviewed files", async () => {
    let diffCalls = 0;
    const api = bridge({ request: async (command) => {
      if (command.type === "git.inspect") return { type: "git.changed", timestamp: now, status: { repositoryRoot: "C:\\HIVE", branch: "main", head: "abc", dirty: false, changedFiles: [], ahead: 0, behind: 0 } };
      if (command.type === "changes.diff") {
        diffCalls += 1;
        const result = eventFor(command);
        if (result.type === "changes.diffed" && diffCalls > 1) return { ...result, diff: { ...result.diff, patch: "", recordedFiles: [], reviewedFiles: [], commitEligibility: "no-recorded-files" as const } };
        return result;
      }
      return eventFor(command);
    } });
    const { user } = await openRepository(api);
    expect(screen.getByRole("button", { name: /preview commit/i })).toBeEnabled();
    await user.click(screen.getByRole("tab", { name: /changes/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /preview commit/i })).toBeDisabled());
    expect(screen.getByText(/no reviewed session files/i)).toBeInTheDocument();
  });

  it("clears provider secrets on cancel, Escape, provider switch, failure, and reopen", async () => {
    const api = bridge({ request: async (command) => command.type === "credential.set" ? { type: "request.failed", timestamp: now, requestId: command.requestId, message: "Credential test failed.", recoverable: true } : eventFor(command) });
    const { user } = await openRepository(api);
    await user.selectOptions(screen.getByLabelText(/^provider$/i), "cloud");
    await user.click(screen.getByRole("button", { name: /configure provider/i }));
    const secret = screen.getByLabelText(/^API key$/i);
    await user.type(secret, "secret-one");
    await user.click(screen.getByRole("button", { name: /cancel provider setup/i }));
    await user.click(screen.getByRole("button", { name: /configure provider/i }));
    expect(screen.getByLabelText(/^API key$/i)).toHaveValue("");
    await user.type(screen.getByLabelText(/^API key$/i), "secret-two");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /configure provider/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /configure provider/i }));
    expect(screen.getByLabelText(/^API key$/i)).toHaveValue("");
    await user.type(screen.getByLabelText(/^API key$/i), "secret-switch");
    await user.selectOptions(screen.getByLabelText(/^provider$/i), "bearer-cloud");
    expect(screen.getByLabelText(/bearer token/i)).toHaveValue("");
    await user.selectOptions(screen.getByLabelText(/^provider$/i), "cloud");
    await user.type(screen.getByLabelText(/^API key$/i), "secret-failure");
    await user.click(screen.getByRole("button", { name: /store encrypted credential/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/credential test failed/i);
    const write = api.request.mock.calls.map(([command]) => command).find((command) => command.type === "credential.set");
    expect(write?.type === "credential.set" && write.input.secret).toBe("");
    await user.click(screen.getByRole("button", { name: /configure provider/i }));
    await user.type(screen.getByLabelText(/^API key$/i), "secret-unmount");
    cleanup();
    const reopened = await openRepository(api);
    await reopened.user.selectOptions(screen.getByLabelText(/^provider$/i), "cloud");
    await reopened.user.click(screen.getByRole("button", { name: /configure provider/i }));
    expect(screen.getByLabelText(/^API key$/i)).toHaveValue("");
  });

  it("derives credential kind exactly and never asks no-auth providers for a secret", async () => {
    const api = bridge(); const { user } = await openRepository(api);
    await user.click(screen.getByRole("button", { name: /configure provider/i }));
    expect(screen.getByText(/requires no desktop secret/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /store encrypted credential/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /cancel provider setup/i }));
    for (const [provider, label, kind] of [["cloud", /^API key$/i, "api-key"], ["bearer-cloud", /bearer token/i, "bearer"], ["oauth-cloud", /oauth token/i, "oauth"]] as const) {
      await user.selectOptions(screen.getByLabelText(/^provider$/i), provider);
      await user.click(screen.getByRole("button", { name: /configure provider/i }));
      await user.type(screen.getByLabelText(label), `value-${kind}`);
      await user.click(screen.getByRole("button", { name: /store encrypted credential/i }));
      const writes = api.request.mock.calls.map(([command]) => command).filter((command) => command.type === "credential.set");
      expect(writes.at(-1)?.type === "credential.set" && writes.at(-1)?.input.kind).toBe(kind);
    }
  });

  it("traps focus in reusable dialogs, closes with Escape, hides background, and restores focus", async () => {
    const { user } = await openRepository();
    const trigger = screen.getByRole("button", { name: /preview commit/i });
    trigger.focus(); await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: /confirm commit/i });
    const cancel = within(dialog).getByRole("button", { name: /^cancel$/i });
    const confirm = within(dialog).getByRole("button", { name: /confirm commit/i });
    expect(cancel).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}"); expect(confirm).toHaveFocus();
    await user.keyboard("{Tab}"); expect(cancel).toHaveFocus();
    expect(document.querySelector(".cockpit-grid")).toHaveAttribute("aria-hidden", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes a consumed Git confirmation after failure and restores focus for an accessible error", async () => {
    const api = bridge({ request: async (command) => command.type === "git.commit.confirm"
      ? { type: "request.failed", timestamp: now, requestId: command.requestId, message: "Repository drift rejected the one-use token.", recoverable: true }
      : eventFor(command) });
    const { user } = await openRepository(api);
    const trigger = screen.getByRole("button", { name: /preview commit/i });
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: /confirm commit/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/repository drift/i);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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
    const input = screen.getByLabelText(/repository path/i);
    await user.type(input, "C:\\A"); await user.click(screen.getByRole("button", { name: /^open$/i }));
    await user.clear(input); await user.type(input, "C:\\B"); await user.click(screen.getByRole("button", { name: /open another/i }));
    expect(await screen.findByRole("button", { name: /Repository B thread/i })).toBeInTheDocument();
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
    const { user } = await openRepository();
    const editor = screen.getByRole("button", { name: /open in editor/i });
    editor.focus();
    expect(editor).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /open terminal/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open explorer/i })).toBeInTheDocument();
    expect(document.querySelector(".skip-link")).toBeInTheDocument();
    expect(styles).toMatch(/:focus-visible\s*\{/);
    expect(styles).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(styles).toMatch(/transition-duration:\s*\.001ms/);
    expect(contrast("#8b5cf6", "#151021")).toBeGreaterThanOrEqual(3);
    expect(contrast("#ddd6fe", "#08080b")).toBeGreaterThanOrEqual(3);
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
