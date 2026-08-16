import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DesktopCommand, DesktopCredentialKind, DesktopEvent, DesktopProviderConfigurationInput, DesktopProviderMetadata, GuardedGitActionPreview, ThreadMessage, ThreadRecordV1 } from "../../../src/desktop/types";
import type { HiveDesktopBridge } from "./bridge";
import { installedBridge, type DesktopCommandInput } from "./bridge";import { CenterStage } from "./components/CenterStage";
import { ChatView } from "./components/chat/ChatView";
import { CommandPalette, PaletteCommand } from "./components/CommandPalette";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { Inspector } from "./components/Inspector";
import { LeftRail } from "./components/LeftRail";
import { ProviderDialog } from "./components/ProviderDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Toast, ToastItem } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { notifyRunCompleted } from "./notifications";
import { usePrefs } from "./prefs";
import { initialDesktopState, latestRun, reduceDesktopEvent, type CenterTab, type DesktopMode } from "./state";
import { identifier, terminalStatuses } from "./utils";
import "./styles.css";

export function App({ api: suppliedApi }: { api?: HiveDesktopBridge }) {
  const api = suppliedApi ?? installedBridge();
  const [state, dispatch] = useReducer(reduceDesktopEvent, undefined, initialDesktopState);
  const { prefs, updatePrefs } = usePrefs();

  // A `?view=` seed (pop-out windows) overrides the saved mode for this window
  // only; the prefs write is suppressed so the saved preference survives.
  const seededView = useMemo<DesktopMode | null>(() => {
    try {
      const view = new URLSearchParams(window.location.search).get("view");
      return view === "chat" || view === "coder" ? view : null;
    } catch {
      return null;
    }
  }, []);

  const [repositoryPath, setRepositoryPath] = useState("");
  const [composer, setComposer] = useState("");
  const [saving, setSaving] = useState(false);
  const [retryMessageId, setRetryMessageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newThreadTitle, setNewThreadTitle] = useState("New HIVE task");

  const [providerDialog, setProviderDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const [credential, setCredential] = useState("");
  const credentialRef = useRef("");
  const mainRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Record<CenterTab, HTMLButtonElement | null>>({ conversation: null, changes: null, report: null });
  const repositoryRef = useRef<string | null>(null);
  const openEpochRef = useRef(0);

  // Sync density and accent attributes to root HTML element
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.density = prefs.density ?? "comfortable";
      document.documentElement.dataset.accent = prefs.accent ?? "vivid";
    }
  }, [prefs.density, prefs.accent]);

  // Sync initial rails preference
  useEffect(() => {
    if (prefs.rails) {
      dispatch({ type: "ui.rails.set", rails: prefs.rails });
    }
    if (seededView) dispatch({ type: "ui.mode", mode: seededView });
    else if (prefs.mode) dispatch({ type: "ui.mode", mode: prefs.mode });
  }, []);

  const send = async (command: DesktopCommandInput, scope?: { epoch?: number; repositoryRoot?: string }): Promise<DesktopEvent> => {
    const requestId = command.requestId ?? identifier("request");
    const expectedEpoch = scope?.epoch ?? openEpochRef.current;
    const event = await api.request({ ...command, requestId } as DesktopCommand);
    if (expectedEpoch !== openEpochRef.current) return { type: "request.failed", timestamp: new Date().toISOString(), requestId, message: "Request superseded by a repository switch.", recoverable: true };
    if (scope?.repositoryRoot && event.repositoryRoot && event.repositoryRoot.toLowerCase() !== scope.repositoryRoot.toLowerCase()) return event;
    if (!scope?.epoch && event.repositoryRoot && (!repositoryRef.current || event.repositoryRoot.toLowerCase() !== repositoryRef.current.toLowerCase())) return event;
    dispatch(event);
    return event;
  };

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "desktop.ready") return;
      if (event.repositoryRoot && (!repositoryRef.current || event.repositoryRoot.toLowerCase() !== repositoryRef.current.toLowerCase())) return;
      dispatch(event);

      // Presence & Toast on run completion
      if (event.type === "run.changed" && terminalStatuses.has(event.run.status)) {
        const ownerThread = stateRef.current.threads.find((t) => t.runs.some((r) => r.codingSessionId === event.run.codingSessionId));
        const threadTitle = ownerThread?.title ?? "HIVE Run";
        const tone = event.run.status === "completed" ? "success" : "error";
        const toastId = identifier("toast");
        const messageText = `Run ${event.run.status}: ${threadTitle}`;

        setToasts((prev) => [...prev, { id: toastId, tone, text: messageText }]);
        notifyRunCompleted("HIVE Cockpit", { threadTitle, status: event.run.status });

        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toastId));
        }, 6000);
      }
    });
    void send({ type: "repository.list" });
    return unsubscribe;
  }, [api]);

  function clearCredential(): void { credentialRef.current = ""; setCredential(""); }
  function closeProviderDialog(): void { clearCredential(); setProviderDialog(false); }

  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId);
  const currentRun = state.run ?? latestRun(activeThread);
  const activeRun = currentRun && !terminalStatuses.has(currentRun.status) ? currentRun : null;
  const repositoryActiveRun = state.threads.flatMap((thread) => thread.runs).find((run) => !terminalStatuses.has(run.status)) ?? null;
  const isPausing = Boolean(currentRun && state.pausingSessionId === currentRun.codingSessionId);
  const sessionId = currentRun?.codingSessionId;
  const report = sessionId ? state.reports[sessionId] : null;
  const modalOpen = Boolean(state.preview || providerDialog || settingsOpen || paletteOpen || shortcutHelpOpen);

  async function openRepository(root: string): Promise<void> {
    const value = root.trim(); if (!value) return;
    const epoch = ++openEpochRef.current;
    repositoryRef.current = null;
    dispatch({ type: "ui.repository-opening" });
    setSaving(false); setComposer(""); closeProviderDialog();
    setBusy(true);
    try {
      const ready = await send({ type: "repository.open", repositoryRoot: value }, { epoch });
      if (epoch === openEpochRef.current && ready.type === "desktop.ready") {
        repositoryRef.current = ready.repositoryRoot;
        setRepositoryPath(ready.repositoryRoot);
        await Promise.all([send({ type: "thread.list" }, { epoch, repositoryRoot: ready.repositoryRoot }), send({ type: "provider.list" }, { epoch }), send({ type: "git.inspect", repositoryRoot: ready.repositoryRoot }, { epoch, repositoryRoot: ready.repositoryRoot }), send({ type: "chat.list" }, { epoch })]);
      }
    } finally { if (epoch === openEpochRef.current) setBusy(false); }
  }

  async function loadThread(thread: ThreadRecordV1): Promise<void> {
    const event = await send({ type: "thread.load", threadId: thread.id });
    if (event.type === "thread.changed") {
      const run = latestRun(event.thread);
      if (run && state.repositoryRoot) {
        await send({ type: "run.report", input: { repositoryRoot: state.repositoryRoot, threadId: thread.id, codingSessionId: run.codingSessionId } });
        await send({ type: "changes.diff", input: { repositoryRoot: state.repositoryRoot, codingSessionId: run.codingSessionId } });
      }
    }
  }

  async function createThread(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!newThreadTitle.trim()) return;
    await send({ type: "thread.create", input: { title: newThreadTitle.trim() } });
    setNewThreadTitle("New HIVE task");
  }

  async function submitMessage(event?: FormEvent): Promise<void> {
    if (event) event.preventDefault();
    if (!activeThread || !state.repositoryRoot || !composer.trim() || repositoryActiveRun) return;
    const content = composer.trim();
    setSaving(true);
    try {
      const loaded = await send({ type: "thread.load", threadId: activeThread.id });
      if (loaded.type !== "thread.changed") return;
      const authoritativeRun = latestRun(loaded.thread);
      if (authoritativeRun && !terminalStatuses.has(authoritativeRun.status)) return;
      const message: ThreadMessage = { id: identifier("message"), role: "user", content, createdAt: new Date().toISOString() };
      const persisted = await send({ type: "thread.message.append", input: { threadId: activeThread.id, message } });
      if (persisted.type !== "thread.changed") return;
      setComposer("");
      const started = await send({ type: "run.start", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, currentUserMessageId: message.id, options: { mode: "auto", approvalPolicy: "changes", providerId: state.selectedProviderId || undefined } } });
      setRetryMessageId(started.type === "request.failed" ? message.id : null);
    } catch { setComposer(content); }
    finally { setSaving(false); }
  }

  async function retryRun(messageId: string): Promise<void> {
    if (!activeThread || !state.repositoryRoot || repositoryActiveRun) return;
    setSaving(true);
    try {
      const started = await send({ type: "run.start", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, currentUserMessageId: messageId, options: { mode: "auto", approvalPolicy: "changes", providerId: state.selectedProviderId || undefined } } });
      if (started.type !== "request.failed") setRetryMessageId(null);
    } finally { setSaving(false); }
  }

  async function chooseTab(tab: CenterTab): Promise<void> {
    dispatch({ type: "ui.tab", tab });
    if (!state.repositoryRoot || !activeThread || !sessionId) return;
    if (tab === "changes") await send({ type: "changes.diff", input: { repositoryRoot: state.repositoryRoot, codingSessionId: sessionId } });
    if (tab === "report") await send({ type: "run.report", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, codingSessionId: sessionId } });
  }

  async function runAction(type: "pause" | "resume" | "cancel"): Promise<void> {
    if (!state.repositoryRoot || !activeThread || !currentRun) return;
    if (type === "pause") await send({ type: "run.pause", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, codingSessionId: currentRun.codingSessionId } });
    else if (type === "resume") await send({ type: "run.resume", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, codingSessionId: currentRun.codingSessionId, options: { mode: "auto", approvalPolicy: "changes", providerId: state.selectedProviderId || undefined } } });
    else await send({ type: "run.cancel", input: { repositoryRoot: state.repositoryRoot, threadId: activeThread.id, codingSessionId: currentRun.codingSessionId } });
  }

  async function previewGit(action: "commit" | "discard" | "push" | "pull-request"): Promise<void> {
    if (!state.repositoryRoot || !sessionId) return;
    const base = { repositoryRoot: state.repositoryRoot, codingSessionId: sessionId };
    if (action === "commit") await send({ type: "git.commit.preview", input: { ...base, action, message: "HIVE: approve reviewed changes", paths: state.diff?.codingSessionId === sessionId ? state.diff.reviewedFiles : [] } });
    else if (action === "discard") await send({ type: "git.discard.preview", input: { ...base, action } });
    else if (action === "push") await send({ type: "git.push.preview", input: { ...base, action, remote: "origin" } });
    else await send({ type: "git.pull-request.preview", input: { ...base, action, remote: "origin", base: "main", title: activeThread?.title ?? "HIVE changes", body: "Changes reviewed in HIVE Desktop.", draft: true } });
  }

  async function confirmGit(preview: GuardedGitActionPreview): Promise<void> {
    const input = { confirmationToken: preview.confirmationToken, proposal: preview.proposal };
    const type = preview.proposal.action === "pull-request" ? "git.pull-request.confirm" : `git.${preview.proposal.action}.confirm`;
    const result = await send({ type, input } as DesktopCommandInput);
    if (result.type === "request.failed") dispatch({ type: "ui.close-preview" });
  }

  async function storeCredential(event: FormEvent, kind: DesktopCredentialKind, configuration: DesktopProviderConfigurationInput): Promise<void> {
    event.preventDefault(); if (!state.selectedProviderId || !credential) return;
    const input = { providerId: state.selectedProviderId, kind, secret: credentialRef.current };
    try {
      const configured = await send({ type: "provider.configure", input: configuration });
      if (configured.type === "request.failed") return;
      await send({ type: "credential.set", input });
    }
    finally { input.secret = ""; closeProviderDialog(); }
  }

  async function approveProvider(provider: DesktopProviderMetadata): Promise<void> {
    const configured = await send({ type: "provider.configure", input: { id: provider.id, name: provider.name, kind: provider.kind, authType: provider.authType, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}), approved: true } });
    if (configured.type !== "request.failed") closeProviderDialog();
  }

  const toggleRail = (side: "left" | "right") => {
    const nextRails = { ...state.rails, [side]: !state.rails[side] };
    dispatch({ type: "ui.rails", side });
    updatePrefs({ rails: nextRails });
  };

  const switchMode = (mode: DesktopMode) => {
    if (state.mode === mode) return;
    dispatch({ type: "ui.mode", mode });
    updatePrefs({ mode });
    if (mode === "chat" && state.repositoryRoot) void send({ type: "chat.list" });
  };

  const popOutCoder = () => { void send({ type: "shell.open-view", view: "coder" }); };
  const recombineWindows = () => { void send({ type: "shell.close-view", view: "coder" }); };

  // Palette Commands
  const paletteCommands: PaletteCommand[] = useMemo(() => {
    const list: PaletteCommand[] = [];

    state.repositories.slice(0, 6).forEach((repo) => {
      list.push({
        id: `repo-${repo.path}`,
        label: `Open repository: ${repo.path}`,
        hint: "Recent",
        run: () => void openRepository(repo.path),
      });
    });

    list.push({
      id: "tab-conv",
      label: "Switch to Conversation tab",
      hint: "Ctrl+1",
      run: () => void chooseTab("conversation"),
    });
    list.push({
      id: "tab-changes",
      label: "Switch to Changes diff tab",
      hint: "Ctrl+2",
      run: () => void chooseTab("changes"),
    });
    list.push({
      id: "tab-report",
      label: "Switch to Verified Report tab",
      hint: "Ctrl+3",
      run: () => void chooseTab("report"),
    });

    list.push({
      id: "toggle-left",
      label: "Toggle Repositories rail",
      hint: "[/]",
      run: () => toggleRail("left"),
    });
    list.push({
      id: "toggle-right",
      label: "Toggle Inspector rail",
      hint: "[\\]",
      run: () => toggleRail("right"),
    });

    if (activeRun) {
      list.push({
        id: "run-pause",
        label: "Pause active turn",
        hint: "Checkpoint",
        run: () => void runAction("pause"),
      });
    } else if (currentRun?.status === "paused") {
      list.push({
        id: "run-resume",
        label: "Resume paused turn",
        hint: "Resume",
        run: () => void runAction("resume"),
      });
    }

    list.push({
      id: "mode-chat",
      label: "Switch to Chat",
      hint: "Ctrl+Shift+1",
      run: () => switchMode("chat"),
    });
    list.push({
      id: "mode-coder",
      label: "Switch to Coder",
      hint: "Ctrl+Shift+2",
      run: () => switchMode("coder"),
    });

    list.push({
      id: "help-shortcuts",
      label: "View Keyboard Shortcuts",
      hint: "?",
      run: () => setShortcutHelpOpen(true),
    });
    list.push({
      id: "open-settings",
      label: "Open Preferences & Accessibility",
      hint: "[*]",
      run: () => setSettingsOpen(true),
    });

    return list;
  }, [state.repositories, activeRun, currentRun, state.rails, state.mode, state.repositoryRoot]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (paletteOpen) { setPaletteOpen(false); return; }
        if (shortcutHelpOpen) { setShortcutHelpOpen(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (providerDialog) { closeProviderDialog(); return; }
        if (state.preview) {
          dispatch({
            type: "git.action-completed",
            timestamp: new Date().toISOString(),
            action: state.preview.proposal.action,
            summary: "Preview closed.",
          });
          return;
        }
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.code === "Digit1" || event.code === "Digit2")) {
        event.preventDefault();
        switchMode(event.code === "Digit1" ? "chat" : "coder");
        return;
      }

      const isInput = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;

      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (state.mode === "coder") void submitMessage();
        return;
      }

      if (isInput || modalOpen) return;

      if ((event.ctrlKey || event.metaKey) && event.key === "1") {
        event.preventDefault();
        void chooseTab("conversation");
      } else if ((event.ctrlKey || event.metaKey) && event.key === "2") {
        event.preventDefault();
        void chooseTab("changes");
      } else if ((event.ctrlKey || event.metaKey) && event.key === "3") {
        event.preventDefault();
        void chooseTab("report");
      } else if (event.key === "?") {
        event.preventDefault();
        setShortcutHelpOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [paletteOpen, shortcutHelpOpen, settingsOpen, providerDialog, state.preview, modalOpen, composer, activeThread, state.repositoryRoot, repositoryActiveRun, state.mode]);

  const cockpitClasses = `cockpit-grid ${!state.rails.left ? "hide-left" : ""} ${!state.rails.right ? "hide-right" : ""}`;

  return (
    <div className="app-shell" data-density={prefs.density ?? "comfortable"} data-accent={prefs.accent ?? "vivid"}>
      <a className="skip-link" href="#main-workspace">Skip to workspace</a>
      <TopBar
        worker={state.worker}
        modalOpen={modalOpen}
        activeRun={Boolean(repositoryActiveRun)}
        mode={state.mode}
        onModeChange={switchMode}
        onPopOut={popOutCoder}
        onRecombine={recombineWindows}
        canRecombine={state.shellViews.length > 1}
        onToggleLeftRail={() => toggleRail("left")}
        onToggleRightRail={() => toggleRail("right")}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {state.mode === "chat" ? (
        <ChatView state={state} send={send} />
      ) : (
      <div className={cockpitClasses} aria-hidden={modalOpen || undefined}>
        <LeftRail
          repositoryPath={repositoryPath}
          setRepositoryPath={setRepositoryPath}
          busy={busy}
          repositories={state.repositories}
          repositoryRoot={state.repositoryRoot}
          threads={state.threads}
          activeThreadId={state.activeThreadId}
          newThreadTitle={newThreadTitle}
          setNewThreadTitle={setNewThreadTitle}
          onOpenRepository={openRepository}
          onCreateThread={createThread}
          onLoadThread={loadThread}
        />

        <CenterStage
          state={state}
          activeThread={activeThread}
          activeRun={activeRun}
          currentRun={currentRun}
          repositoryActiveRun={repositoryActiveRun}
          report={report}
          sessionId={sessionId}
          composer={composer}
          setComposer={setComposer}
          saving={saving}
          retryMessageId={retryMessageId}
          mainRef={mainRef}
          tabRefs={tabRefs}
          onArchiveThread={(threadId) => send({ type: "thread.archive", threadId }).then(() => {})}
          onChooseTab={chooseTab}
          onRetryRun={retryRun}
          onSubmitMessage={submitMessage}
        />

        <Inspector
          state={state}
          currentRun={currentRun}
          activeRun={activeRun}
          isPausing={isPausing}
          sessionId={sessionId}
          report={report}
          onClearCredential={clearCredential}
          onProviderChange={(event) => {
            clearCredential();
            dispatch({
              type: "provider.changed",
              timestamp: new Date().toISOString(),
              provider: state.providers.find((provider) => provider.id === event.target.value)!,
            });
          }}
          onOpenProviderDialog={() => {
            clearCredential();
            setProviderDialog(true);
          }}
          onRunAction={runAction}
          onPreviewGit={previewGit}
          onSendExternal={(command) => send(command)}
        />
      </div>
      )}

      <Toast toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />

      <div className="announcer" aria-live="polite" aria-atomic="true" aria-hidden={modalOpen || undefined}>
        {saving ? "Saving message..." : state.notice}
      </div>

      {state.error && (
        <div className="error-toast" role="alert">
          <span>{state.error}</span>
          <button aria-label="Dismiss error" onClick={() => dispatch({ type: "ui.dismiss-error" })}>x</button>
        </div>
      )}

      {state.preview && (
        <ConfirmationDialog
          preview={state.preview}
          onCancel={() => dispatch({ type: "git.action-completed", timestamp: new Date().toISOString(), action: state.preview!.proposal.action, summary: "Preview closed." })}
          onConfirm={confirmGit}
        />
      )}

      {providerDialog && (
        <ProviderDialog
          provider={state.providers.find((item) => item.id === state.selectedProviderId)}
          credential={credential}
          onCredential={(value) => { credentialRef.current = value; setCredential(value); }}
          onClose={closeProviderDialog}
          onSubmit={storeCredential}
          onApprove={approveProvider}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
      />

      {shortcutHelpOpen && (
        <ShortcutHelp onClose={() => setShortcutHelpOpen(false)} />
      )}

      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
