import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DesktopCommand, DesktopCredentialKind, DesktopEvent, DesktopProviderConfigurationInput, DesktopProviderMetadata, GuardedGitActionPreview, ThreadMessage, ThreadRecordV1 } from "../../../src/desktop/types";
import type { HiveDesktopBridge } from "./bridge";
import { installedBridge, type DesktopCommandInput } from "./bridge";
import { CommandPalette, PaletteCommand } from "./components/CommandPalette";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { ProviderDialog } from "./components/ProviderDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { UsageSurface } from "./components/usage/UsageSurface";
import { SplitWorkspace } from "./components/SplitWorkspace";
import { CodexSurface } from "./components/codex/CodexSurface";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Toast, ToastItem } from "./components/Toast";
import { ChatSurface } from "./components/chat/ChatSurface";
import { Shell } from "./shell/Shell";
import type { SidebarSession } from "./shell/Sidebar";
import { notifyRunCompleted } from "./notifications";
import { usePrefs } from "./prefs";
import { initialDesktopState, latestRun, reduceDesktopEvent, type CenterTab, type DesktopMode } from "./state";
import { identifier, terminalStatuses } from "./utils";
import "./styles.css";
import "./styles/motion.css";

export function App({ api: suppliedApi }: { api?: HiveDesktopBridge }) {
  const api = suppliedApi ?? installedBridge();
  const [state, dispatch] = useReducer(reduceDesktopEvent, undefined, initialDesktopState);
  const { prefs, updatePrefs } = usePrefs();

  const [repositoryPath, setRepositoryPath] = useState("");
  const [composer, setComposer] = useState("");
  const [saving, setSaving] = useState(false);
  const [retryMessageId, setRetryMessageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newThreadTitle, setNewThreadTitle] = useState("New HIVE task");
  const [modelChoice, setModelChoice] = useState<{ providerId: string; model: string } | null>(null);

  const [providerDialog, setProviderDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "models" | "catalog">("general");
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [stickyError, setStickyError] = useState<string | null>(null);

  async function fetchModels(providerId: string): Promise<void> {
    setModelsLoading((prev) => ({ ...prev, [providerId]: true }));
    try {
      await send({ type: "models.list", providerId });
    } catch {
      // send() already surfaces request.failed when the bridge returns a typed failure
    } finally {
      setModelsLoading((prev) => ({ ...prev, [providerId]: false }));
    }
  }

  const [credential, setCredential] = useState("");
  const credentialRef = useRef("");
  const mainRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Record<CenterTab, HTMLButtonElement | null>>({ conversation: null, changes: null, report: null });
  const repositoryRef = useRef<string | null>(null);
  const openEpochRef = useRef(0);
  const chatRequestIds = useRef(new Set<string>());
  const modelsRequested = useRef(new Set<string>());
  const startNewChatRef = useRef<() => void>(() => {});

  const splitRatio = prefs.splitRatio ?? 0.4;

  // Sync density, accent and theme attributes to the root element; "system" follows the OS.
  useEffect(() => {
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      root.dataset.density = prefs.density ?? "comfortable";
      root.dataset.accent = prefs.accent ?? "vivid";
      if (prefs.theme && prefs.theme !== "system") root.dataset.theme = prefs.theme;
      else delete root.dataset.theme;
    }
  }, [prefs.density, prefs.accent, prefs.theme]);

  useEffect(() => {
    if (prefs.rails) {
      dispatch({ type: "ui.rails.set", rails: prefs.rails });
    }
    if (prefs.mode && prefs.mode !== "settings") {
      dispatch({ type: "ui.mode", mode: prefs.mode });
    }
  }, []);

  const send = async (command: DesktopCommandInput, scope?: { epoch?: number; repositoryRoot?: string }): Promise<DesktopEvent> => {
    const requestId = command.requestId ?? identifier("request");
    if (command.type === "chat.send" || command.type === "chat.create" || command.type === "chat.cancel") {
      chatRequestIds.current.add(requestId);
    }
    const expectedEpoch = scope?.epoch ?? openEpochRef.current;
    const event = await api.request({ ...command, requestId } as DesktopCommand);
    if (expectedEpoch !== openEpochRef.current) return { type: "request.failed", timestamp: new Date().toISOString(), requestId, message: "Request superseded by a repository switch.", recoverable: true };
    if (scope?.repositoryRoot && event.repositoryRoot && event.repositoryRoot.toLowerCase() !== scope.repositoryRoot.toLowerCase()) return event;
    if (!scope?.epoch && event.repositoryRoot && (!repositoryRef.current || event.repositoryRoot.toLowerCase() !== repositoryRef.current.toLowerCase())) return event;
    dispatch(event);
    if (event.type === "request.failed" && command.type !== "chat.send" && command.type !== "chat.create") {
      setStickyError(event.message);
    } else if (event.type === "worker.failed") {
      setStickyError(event.message);
    } else if (event.type === "desktop.ready" || event.type === "chat.started" || event.type === "chat.completed") {
      setStickyError(null);
    }
    return event;
  };

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "desktop.ready" && !repositoryRef.current) {
        repositoryRef.current = event.repositoryRoot ?? null;
        dispatch(event);
        return;
      }
      if (event.repositoryRoot && (!repositoryRef.current || event.repositoryRoot.toLowerCase() !== repositoryRef.current.toLowerCase())) return;
      dispatch(event);
      if (event.type === "request.failed") {
        if (event.requestId && chatRequestIds.current.has(event.requestId)) {
          chatRequestIds.current.delete(event.requestId);
        } else {
          setStickyError(event.message);
        }
      } else if (event.type === "worker.failed") {
        setStickyError(event.message);
      } else if (event.type === "chat.started" || event.type === "chat.completed") {
        setStickyError(null);
      }

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
    void send({ type: "chat.list" });
    void send({ type: "provider.list" });
    return unsubscribe;
  }, [api]);

  function clearCredential(): void { credentialRef.current = ""; setCredential(""); }
  function closeProviderDialog(): void { clearCredential(); setProviderDialog(false); }

  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId);
  const currentRun = state.run ?? latestRun(activeThread);
  const activeRun = currentRun && !terminalStatuses.has(currentRun.status) ? currentRun : null;
  const repositoryActiveRun = state.threads.flatMap((thread) => thread.runs).find((run) => !terminalStatuses.has(run.status)) ?? null;
  const sessionId = currentRun?.codingSessionId;
  const report = sessionId ? state.reports[sessionId] : null;
  const modalOpen = Boolean(state.preview || providerDialog || settingsOpen || paletteOpen || shortcutHelpOpen);

  // --- Shell-derived navigation/tabs -------------------------------------------------
  const openSettings = (tab: "general" | "models" | "catalog" = "models") => { setSettingsTab(tab); setSettingsOpen(true); };

  const modelOptions = useMemo(() => {
    const options: { providerId: string; providerName: string; model: string }[] = [];
    for (const provider of state.providers) {
      if (!provider.configured) continue;
      const listed = state.modelsByProvider[provider.id] ?? [];
      if (listed.length > 0) {
        for (const model of listed) {
          if (prefs.enabledModels?.[model.id] === false) continue;
          options.push({ providerId: provider.id, providerName: provider.name, model: model.id });
        }
      } else if (provider.defaultModel) {
        options.push({ providerId: provider.id, providerName: provider.name, model: provider.defaultModel });
      }
    }
    return options;
  }, [state.providers, state.modelsByProvider, prefs.enabledModels]);

  const activeModelName = modelChoice
    ? `${state.providers.find((provider) => provider.id === modelChoice.providerId)?.name ?? modelChoice.providerId} / ${modelChoice.model}`
    : "No model";

  useEffect(() => {
    for (const provider of state.providers) {
      if (!provider.configured || modelsRequested.current.has(provider.id)) continue;
      modelsRequested.current.add(provider.id);
      void fetchModels(provider.id);
    }
  }, [state.providers]);

  useEffect(() => {
    setModelChoice((current) => {
      if (current && modelOptions.some((option) => option.providerId === current.providerId && option.model === current.model)) return current;
      const first = modelOptions[0];
      return first ? { providerId: first.providerId, model: first.model } : null;
    });
  }, [modelOptions]);

  const recentSessions: SidebarSession[] = useMemo(() => {
    if (state.mode === "coder") {
      return state.threads
        .filter((thread) => !thread.archived)
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((thread) => {
          const live = [...thread.runs].reverse().find((run) => !terminalStatuses.has(run.status));
          return {
            id: `thread-${thread.id}`,
            title: thread.title,
            kind: "coder" as const,
            active: thread.id === state.activeThreadId,
            ...(live ? { status: live.status } : {}),
          };
        });
    }
    return state.chat.conversations
      .filter((conversation) => !conversation.archived)
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((conversation) => ({
        id: `chat-${conversation.id}`,
        title: conversation.title || "New chat",
        kind: "chat" as const,
        active: conversation.id === state.chat.activeId,
      }));
  }, [state.mode, state.chat.conversations, state.chat.activeId, state.threads, state.activeThreadId]);

  const handleSelectSession = (id: string): void => {
    if (id.startsWith("chat-")) {
      const conversationId = id.slice("chat-".length);
      void send({ type: "chat.load", conversationId });
      dispatch({ type: "ui.mode", mode: "chat" });
    } else if (id.startsWith("thread-")) {
      const thread = state.threads.find((entry) => entry.id === id.slice("thread-".length));
      if (thread) void loadThread(thread);
      dispatch({ type: "ui.mode", mode: "coder" });
    }
  };

  const handleNewTask = async (): Promise<void> => {
    dispatch({ type: "ui.mode", mode: "chat" });
    updatePrefs({ mode: "chat" });
    await send({ type: "chat.create", input: {} });
  };
  startNewChatRef.current = () => { void handleNewTask(); };

  const handleNewCodeTask = (): void => {
    dispatch({ type: "ui.mode", mode: "coder" });
    updatePrefs({ mode: "coder" });
    dispatch({ type: "ui.thread.clear" });
  };

  async function pickRepository(): Promise<void> {
    const picked = await send({ type: "workspace.pick" });
    if (picked.type === "workspace.picked" && picked.path) await openRepository(picked.path);
  }

  const shellTitle = state.mode === "usage"
    ? "Usage"
    : state.mode === "coder"
      ? activeThread?.title ?? "New task"
      : state.mode === "split"
        ? "Side by side"
        : state.chat.conversations.find((conversation) => conversation.id === state.chat.activeId)?.title || "New chat";

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
        await Promise.all([
          send({ type: "thread.list" }, { epoch, repositoryRoot: ready.repositoryRoot }),
          send({ type: "provider.list" }, { epoch }),
          send({ type: "git.inspect", repositoryRoot: ready.repositoryRoot }, { epoch, repositoryRoot: ready.repositoryRoot }),
          send({ type: "chat.list" }, { epoch }),
          send({ type: "workspace.list", input: { repositoryRoot: ready.repositoryRoot } }, { epoch, repositoryRoot: ready.repositoryRoot }),
        ]);
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
    const providerId = state.selectedProviderId;
    const input = { providerId, kind, secret: credentialRef.current };
    try {
      const configured = await send({ type: "provider.configure", input: configuration });
      if (configured.type === "request.failed") return;
      const setCred = await send({ type: "credential.set", input });
      if (setCred.type !== "request.failed") {
        await fetchModels(providerId);
      }
    }
    finally { input.secret = ""; closeProviderDialog(); }
  }

  async function approveProvider(provider: DesktopProviderMetadata): Promise<void> {
    const configured = await send({ type: "provider.configure", input: { id: provider.id, name: provider.name, kind: provider.kind, authType: provider.authType, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}), approved: true } });
    if (configured.type !== "request.failed") {
      closeProviderDialog();
      await fetchModels(provider.id);
    }
  }

  const toggleRail = (side: "left" | "right") => {
    const nextRails = { ...state.rails, [side]: !state.rails[side] };
    dispatch({ type: "ui.rails", side });
    updatePrefs({ rails: nextRails });
  };

  const handleSplitRatioChange = (ratio: number) => {
    updatePrefs({ splitRatio: ratio });
  };

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
      label: "Toggle Workspace sidebar",
      hint: "[/]",
      run: () => toggleRail("left"),
    });

    list.push({
      id: "surface-chat",
      label: "Switch to Chat surface",
      hint: "Surface",
      run: () => {
        dispatch({ type: "ui.mode", mode: "chat" });
        updatePrefs({ mode: "chat" });
      },
    });

    list.push({
      id: "surface-codex",
      label: "Switch to Codex workspace",
      hint: "Surface",
      run: () => {
        dispatch({ type: "ui.mode", mode: "coder" });
        updatePrefs({ mode: "coder" });
      },
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
      id: "help-shortcuts",
      label: "View Keyboard Shortcuts",
      hint: "?",
      run: () => setShortcutHelpOpen(true),
    });
    list.push({
      id: "open-settings",
      label: "Open Settings",
      hint: "[*]",
      run: () => {
        setSettingsTab("models");
        setSettingsOpen(true);
      },
    });
    list.push({
      id: "configure-providers",
      label: "Configure providers",
      hint: "API keys",
      run: () => {
        setSettingsTab("models");
        setSettingsOpen(true);
      },
    });

    return list;
  }, [state.repositories, activeRun, currentRun, state.rails, state.repositoryRoot]);

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

      const meta = event.ctrlKey || event.metaKey;
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
      const inChatComposer = event.target instanceof HTMLElement && event.target.closest(".hive-chat-surface") !== null;
      if (!modalOpen && meta && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        startNewChatRef.current();
        return;
      }
      if (!modalOpen && meta && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n" && (!typing || inChatComposer)) {
        event.preventDefault();
        startNewChatRef.current();
        return;
      }

      const isInput = typing;

      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void submitMessage();
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
  }, [paletteOpen, shortcutHelpOpen, settingsOpen, providerDialog, state.preview, modalOpen, composer, activeThread, state.repositoryRoot, repositoryActiveRun]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-workspace">Skip to workspace</a>
      <Shell
        mode={state.mode}
        onSelectMode={(mode) => {
          dispatch({ type: "ui.mode", mode });
          updatePrefs({ mode });
        }}
        onCreateTask={handleNewTask}
        onNewCodeTask={handleNewCodeTask}
        sessions={recentSessions}
        onSelectSession={handleSelectSession}
        title={shellTitle}
        repositoryPath={state.repositoryRoot ?? repositoryPath}
        setRepositoryPath={setRepositoryPath}
        onOpenRepository={openRepository}
        onPickRepository={() => void pickRepository()}
        busy={busy}
        onOpenSettings={() => openSettings()}
        onOpenUsage={() => dispatch({ type: "ui.mode", mode: "usage" })}
        worker={state.worker}
        sidebarCollapsed={!state.rails.left}
        onToggleSidebar={() => toggleRail("left")}
      >
        {state.mode === "split" ? (
          <SplitWorkspace
            state={state}
            send={send}
            activeModelName={activeModelName}
            modelOptions={modelOptions}
            selectedModel={modelChoice}
            onSelectModel={(choice) => setModelChoice({ providerId: choice.providerId, model: choice.model })}
            onOpenModelPicker={() => openSettings("catalog")}
            onOpenSettings={() => openSettings("models")}
            onOpenRepositoryPicker={() => void pickRepository()}
            onSelectFile={async (filePath) => {
              if (!state.repositoryRoot) return;
              dispatch({ type: "ui.preview-file", path: filePath });
              await send({ type: "workspace.read", input: { repositoryRoot: state.repositoryRoot, path: filePath } });
            }}
            onToggleDir={async (dirPath) => {
              if (!state.repositoryRoot || state.workspaceListings[dirPath]) return;
              await send({ type: "workspace.list", input: { repositoryRoot: state.repositoryRoot, path: dirPath } });
            }}
            onPreviewGit={previewGit}
            onLoadThread={async (threadId) => {
              const t = state.threads.find((entry) => entry.id === threadId);
              if (t) void loadThread(t);
            }}
            onHandoffToCoder={() => dispatch({ type: "ui.mode", mode: "coder" })}
          />
        ) : state.mode === "usage" ? (
          <UsageSurface
            threads={state.threads}
            conversations={state.chat.conversations}
          />
        ) : state.mode === "coder" ? (
          <CodexSurface
            state={state}
            send={send}
            activeModelName={activeModelName}
            onOpenModelPicker={() => openSettings("catalog")}
            onOpenSettings={() => openSettings("models")}
            onOpenRepositoryPicker={() => void pickRepository()}
            onSelectFile={async (filePath) => {
              if (!state.repositoryRoot) return;
              dispatch({ type: "ui.preview-file", path: filePath });
              await send({ type: "workspace.read", input: { repositoryRoot: state.repositoryRoot, path: filePath } });
              if (sessionId && state.diff?.recordedFiles.includes(filePath)) {
                await send({ type: "changes.diff", input: { repositoryRoot: state.repositoryRoot, codingSessionId: sessionId } });
              }
            }}
            onToggleDir={async (dirPath) => {
              if (!state.repositoryRoot || state.workspaceListings[dirPath]) return;
              await send({ type: "workspace.list", input: { repositoryRoot: state.repositoryRoot, path: dirPath } });
            }}
            onPreviewGit={previewGit}
            onLoadThread={async (threadId) => {
              const t = state.threads.find((entry) => entry.id === threadId);
              if (t) void loadThread(t);
            }}
            onRunAction={runAction}
          />
        ) : (
          <ChatSurface
            state={state}
            send={send}
            activeModelName={activeModelName}
            modelOptions={modelOptions}
            selectedModel={modelChoice}
            onSelectModel={(choice) => setModelChoice({ providerId: choice.providerId, model: choice.model })}
            onOpenModelPicker={() => openSettings("catalog")}
            onOpenSettings={() => openSettings("models")}
            onHandoffToCoder={() => dispatch({ type: "ui.mode", mode: "coder" })}
          />
        )}
      </Shell>

      <Toast toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />

      <div className="announcer" aria-live="polite" aria-atomic="true" aria-hidden={modalOpen || undefined}>
        {saving ? "Saving message..." : state.notice}
      </div>

      {stickyError && (
        <div className="error-toast" role="alert">
          <span>{stickyError}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => {
              setStickyError(null);
              dispatch({ type: "ui.dismiss-error" });
            }}
          >
            Dismiss
          </button>
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
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          initialTab={settingsTab}
          providers={state.providers}
          modelsByProvider={state.modelsByProvider}
          modelsLoading={modelsLoading}
          onFetchModels={fetchModels}
          onConfigureProvider={(providerId) => {
            const provider = state.providers.find((entry) => entry.id === providerId);
            if (provider) {
              clearCredential();
              dispatch({ type: "provider.changed", timestamp: new Date().toISOString(), provider });
              setSettingsOpen(false);
              setProviderDialog(true);
            }
          }}
          onAddCompatibleProvider={async (input) => {
            const configured = await send({
              type: "provider.configure",
              input: {
                id: input.id,
                name: input.name,
                kind: "openai-compatible",
                authType: "api-key",
                baseUrl: input.baseUrl,
                defaultModel: input.defaultModel,
                approved: true,
              },
            });
            if (configured.type === "request.failed") return;
            clearCredential();
            setSettingsOpen(false);
            setProviderDialog(true);
          }}
        />
      )}
    </div>
  );
}
