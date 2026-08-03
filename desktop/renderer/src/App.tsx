import { FormEvent, ReactNode, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { RuntimeEvent } from "../../../src/coding/types";
import type { DesktopCommand, DesktopCredentialKind, DesktopEvent, DesktopProviderConfigurationInput, DesktopProviderMetadata, GuardedGitActionPreview, ThreadMessage, ThreadRecordV1 } from "../../../src/desktop/types";
import { MAX_THREAD_MESSAGE_CHARS } from "../../../src/desktop/types";
import type { HiveDesktopBridge } from "./bridge";
import { installedBridge } from "./bridge";
import { parseUnifiedDiff } from "./diff";
import { Dialog } from "./Dialog";
import { initialDesktopState, latestRun, reduceDesktopEvent, type CenterTab } from "./state";
import "./styles.css";

let sequence = 0;
function identifier(prefix: string): string { sequence += 1; return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`; }
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
type DesktopCommandInput = DesktopCommand extends infer Command
  ? Command extends { requestId: string } ? Omit<Command, "requestId"> & { requestId?: string } : never
  : never;

export function App({ api: suppliedApi }: { api?: HiveDesktopBridge }) {
  const api = suppliedApi ?? installedBridge();
  const [state, dispatch] = useReducer(reduceDesktopEvent, undefined, initialDesktopState);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [composer, setComposer] = useState("");
  const [saving, setSaving] = useState(false);
  const [retryMessageId, setRetryMessageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newThreadTitle, setNewThreadTitle] = useState("New HIVE task");
  const [providerDialog, setProviderDialog] = useState(false);
  const [credential, setCredential] = useState("");
  const credentialRef = useRef("");
  const mainRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Record<CenterTab, HTMLButtonElement | null>>({ conversation: null, changes: null, report: null });
  const repositoryRef = useRef<string | null>(null);
  const openEpochRef = useRef(0);

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

  useEffect(() => {
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "desktop.ready") return;
      if (event.repositoryRoot && (!repositoryRef.current || event.repositoryRoot.toLowerCase() !== repositoryRef.current.toLowerCase())) return;
      dispatch(event);
    });
    void send({ type: "repository.list" });
    return unsubscribe;
  }, [api]);

  function clearCredential(): void { credentialRef.current = ""; setCredential(""); }
  function closeProviderDialog(): void { clearCredential(); setProviderDialog(false); }

  useEffect(() => {
    if (!providerDialog) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeProviderDialog(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [providerDialog]);
  useEffect(() => () => { credentialRef.current = ""; }, []);

  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId);
  const currentRun = state.run ?? latestRun(activeThread);
  const activeRun = currentRun && !terminalStatuses.has(currentRun.status) ? currentRun : null;
  const repositoryActiveRun = state.threads.flatMap((thread) => thread.runs).find((run) => !terminalStatuses.has(run.status)) ?? null;
  const isPausing = Boolean(currentRun && state.pausingSessionId === currentRun.codingSessionId);
  const sessionId = currentRun?.codingSessionId;
  const report = sessionId ? state.reports[sessionId] : null;
  const modalOpen = Boolean(state.preview || providerDialog);

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
        await Promise.all([send({ type: "thread.list" }, { epoch, repositoryRoot: ready.repositoryRoot }), send({ type: "provider.list" }, { epoch }), send({ type: "git.inspect", repositoryRoot: ready.repositoryRoot }, { epoch, repositoryRoot: ready.repositoryRoot })]);
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

  async function submitMessage(event: FormEvent): Promise<void> {
    event.preventDefault();
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
    const configured = await send({ type: "provider.configure", input: providerConfiguration(provider) });
    if (configured.type !== "request.failed") closeProviderDialog();
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-workspace">Skip to workspace</a>
    <header className="topbar" role="banner" aria-hidden={modalOpen || undefined}>
      <div><span className="wordmark" aria-label="HIVE">HIVE</span><span className="tagline">Hyper Intelligence for Verified Engineering</span></div>
      <StatusPill tone={state.worker === "failed" ? "error" : state.worker === "running" ? "success" : "neutral"}>{state.worker}</StatusPill>
    </header>
    <div className="cockpit-grid" aria-hidden={modalOpen || undefined}>
      <nav className="panel left-rail" aria-label="Repositories and threads">
        <PanelHeader eyebrow="Workspace" title="Repositories" />
        <form className="stack compact" onSubmit={(event) => { event.preventDefault(); void openRepository(repositoryPath); }}>
          <label htmlFor="repository-path">Repository path</label>
          <div className="input-row"><input id="repository-path" value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} placeholder="C:\\source\\project" /><button disabled={!repositoryPath.trim()}>{busy ? "Open another" : "Open"}</button></div>
        </form>
        <section aria-labelledby="recent-heading"><h2 id="recent-heading" className="section-label">Recent</h2>
          {state.repositories.length ? <ul className="plain-list">{state.repositories.map((repository) => <li key={repository.path}><button className="repository-button" aria-current={state.repositoryRoot === repository.path ? "page" : undefined} onClick={() => void openRepository(repository.path)}><span>{repository.path}</span><small>{formatTime(repository.lastOpenedAt)}</small></button></li>)}</ul> : <EmptyState>No recent repositories.</EmptyState>}
        </section>
        {state.repositoryRoot && <>
          <div className="rail-divider" />
          <section aria-labelledby="threads-heading"><div className="section-heading"><h2 id="threads-heading" className="section-label">Threads</h2><span>{state.threads.filter((thread) => !thread.archived).length}</span></div>
            <form className="input-row" onSubmit={(event) => void createThread(event)}><label className="sr-only" htmlFor="thread-title">New thread title</label><input id="thread-title" value={newThreadTitle} onChange={(event) => setNewThreadTitle(event.target.value)} maxLength={200} /><button aria-label="Create thread">+</button></form>
            {state.threads.some((thread) => !thread.archived) ? <ThreadList threads={state.threads.filter((thread) => !thread.archived)} activeId={state.activeThreadId} onLoad={loadThread} /> : <EmptyState>No active threads.</EmptyState>}
            <details className="archived" open><summary>Archived threads ({state.threads.filter((thread) => thread.archived).length})</summary><ThreadList threads={state.threads.filter((thread) => thread.archived)} activeId={state.activeThreadId} onLoad={loadThread} /></details>
          </section>
        </>}
      </nav>

      <main id="main-workspace" ref={mainRef} className="panel center-stage" tabIndex={-1}>
        {!state.repositoryRoot ? <EmptyWorkspace /> : !activeThread ? <EmptyState className="center-empty"><strong>Choose or create a thread.</strong><span>Each message starts a verified coding session.</span></EmptyState> : <>
          <header className="thread-header"><div><span className="eyebrow">Active thread</span><h1>{activeThread.title}</h1><code>{state.repositoryRoot}</code></div><button disabled={Boolean(activeRun)} onClick={() => void send({ type: "thread.archive", threadId: activeThread.id })}>Archive</button></header>
          <div className="tabs" role="tablist" aria-label="Thread views">{(["conversation", "changes", "report"] as CenterTab[]).map((tab, index, tabs) => <button key={tab} ref={(node) => { tabRefs.current[tab] = node; }} role="tab" tabIndex={state.tab === tab ? 0 : -1} aria-selected={state.tab === tab} aria-controls={`panel-${tab}`} id={`tab-${tab}`} onClick={() => void chooseTab(tab)} onKeyDown={(event) => { let target: CenterTab | undefined; const current = tabs.indexOf(tab); if (event.key === "ArrowRight") target = tabs[(current + 1) % tabs.length]; else if (event.key === "ArrowLeft") target = tabs[(current - 1 + tabs.length) % tabs.length]; else if (event.key === "Home") target = tabs[0]; else if (event.key === "End") target = tabs.at(-1); if (target) { event.preventDefault(); void chooseTab(target); queueMicrotask(() => tabRefs.current[target!]?.focus()); } }}>{titleCase(tab)}</button>)}</div>
          <section className="tab-panel" role="tabpanel" id={`panel-${state.tab}`} aria-labelledby={`tab-${state.tab}`}>
            {state.tab === "conversation" && <Conversation thread={activeThread} composer={composer} setComposer={setComposer} saving={saving} disabled={Boolean(repositoryActiveRun)} paused={currentRun?.status === "paused"} retryMessageId={retryMessageId} onRetry={retryRun} onSubmit={submitMessage} />}
            {state.tab === "changes" && <ChangesView patch={state.diff?.patch} truncated={state.diff?.truncated} />}
            {state.tab === "report" && <ReportView report={report} hasRun={Boolean(sessionId)} />}
          </section>
        </>}
      </main>

      <aside className="panel right-rail" aria-label="Run inspector">
        <PanelHeader eyebrow="Live telemetry" title="Run inspector" />
        <InspectorSection label="Phase"><StatusPill tone={phaseTone(isPausing ? "paused" : currentRun?.status)}>{isPausing ? "Pausing…" : currentRun?.status ?? "No active run"}</StatusPill><small>{currentRun ? `Session ${currentRun.codingSessionId}` : "Start a turn from Conversation."}</small></InspectorSection>
        <InspectorSection label="Agents"><AgentActivity events={state.runtimeEvents} /></InspectorSection>
        <InspectorSection label="Provider">
          {state.providers.length ? <><label className="sr-only" htmlFor="provider">Provider</label><select id="provider" value={state.selectedProviderId} onChange={(event) => { clearCredential(); dispatch({ type: "provider.changed", timestamp: new Date().toISOString(), provider: state.providers.find((provider) => provider.id === event.target.value)! }); }}>{state.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} / {provider.defaultModel ?? "default"}</option>)}</select><button className="secondary" onClick={() => { clearCredential(); setProviderDialog(true); }}>Configure provider</button></> : <EmptyState>No providers configured.</EmptyState>}
        </InspectorSection>
        <InspectorSection label="Validation"><ValidationSummary events={state.runtimeEvents} report={report} /></InspectorSection>
        <InspectorSection label="Controls">
          <div className="button-grid"><button disabled={currentRun?.status !== "paused" || isPausing} onClick={() => void runAction("resume")}>Resume</button><button disabled={!activeRun || currentRun?.status === "paused" || state.worker !== "running" || isPausing} aria-busy={isPausing || undefined} title="Pause after active tool work reaches a safe checkpoint." onClick={() => void runAction("pause")}>{isPausing ? "Pausing…" : "Pause"}</button><button className="danger" disabled={!activeRun} onClick={() => void runAction("cancel")}>Cancel</button></div>
          <p className="technical-note">Pause is persisted only at a HIVE safe checkpoint; active tool work is never relabeled as paused.</p>
        </InspectorSection>
        <InspectorSection label="Changes and Git">
          {!sessionId ? <EmptyState>Run a turn to review changes.</EmptyState> : <><div className="button-grid git-actions"><button disabled={state.diff?.codingSessionId !== sessionId || state.diff.commitEligibility !== "eligible" || state.diff.reviewedFiles.length === 0} onClick={() => void previewGit("commit")}>Preview commit</button><button className="danger" onClick={() => void previewGit("discard")}>Preview discard</button><button onClick={() => void previewGit("push")}>Preview push</button><button onClick={() => void previewGit("pull-request")}>Preview PR</button></div>{state.diff?.codingSessionId === sessionId && state.diff.commitEligibility !== "eligible" && <p className="technical-note">{commitBlockedCopy(state.diff.commitEligibility)}</p>}</>}
        </InspectorSection>
        <InspectorSection label="External tools"><div className="button-grid external-actions"><button disabled={!state.repositoryRoot} onClick={() => state.repositoryRoot && void send({ type: "external.open-editor", input: { repositoryRoot: state.repositoryRoot } })}>Open in Editor</button><button disabled={!state.repositoryRoot} onClick={() => state.repositoryRoot && void send({ type: "external.open-terminal", repositoryRoot: state.repositoryRoot })}>Open Terminal</button><button disabled={!state.repositoryRoot} onClick={() => state.repositoryRoot && void send({ type: "external.open-explorer", input: { repositoryRoot: state.repositoryRoot } })}>Open Explorer</button></div></InspectorSection>
        <div className="report-snapshot">{report ? `Report: ${report.result}` : "No run report yet."}</div>
      </aside>
    </div>
    <div className="announcer" aria-live="polite" aria-atomic="true" aria-hidden={modalOpen || undefined}>{saving ? "Saving message..." : state.notice}</div>
    {state.error && <div className="error-toast" role="alert"><span>{state.error}</span><button aria-label="Dismiss error" onClick={() => dispatch({ type: "ui.dismiss-error" })}>x</button></div>}
    {state.preview && <ConfirmationDialog preview={state.preview} onCancel={() => dispatch({ type: "git.action-completed", timestamp: new Date().toISOString(), action: state.preview!.proposal.action, summary: "Preview closed." })} onConfirm={confirmGit} />}
    {providerDialog && <ProviderDialog provider={state.providers.find((item) => item.id === state.selectedProviderId)} credential={credential} onCredential={(value) => { credentialRef.current = value; setCredential(value); }} onClose={closeProviderDialog} onSubmit={storeCredential} onApprove={approveProvider} />}
  </div>;
}

function PanelHeader({ eyebrow, title }: { eyebrow: string; title: string }) { return <div className="panel-header"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></div>; }
function InspectorSection({ label, children }: { label: string; children: ReactNode }) { return <section className="inspector-section"><h2>{label}</h2><div className="stack compact">{children}</div></section>; }
function EmptyState({ children, className = "" }: { children: ReactNode; className?: string }) { return <div className={`empty-state ${className}`}>{children}</div>; }
function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "error" }) { return <span className={`status-pill status-${tone}`}><span aria-hidden="true" className="status-glyph">[{tone === "success" ? "OK" : tone === "error" ? "!!" : tone === "warning" ? ".." : "--"}]</span>{children}</span>; }

function ThreadList({ threads, activeId, onLoad }: { threads: ThreadRecordV1[]; activeId: string | null; onLoad: (thread: ThreadRecordV1) => Promise<void> }) {
  return threads.length ? <ul className="plain-list thread-list">{threads.map((thread) => <li key={thread.id}><button aria-current={thread.id === activeId ? "page" : undefined} onClick={() => void onLoad(thread)}><span>{thread.title}</span><small>{thread.messages.length} messages / {thread.runs.length} runs</small></button></li>)}</ul> : <EmptyState>None.</EmptyState>;
}

function EmptyWorkspace() { return <EmptyState className="center-empty"><pre aria-hidden="true">{"  ___   ___\n /   \\ /   \\\n \\___/ \\___/\n   \\___/"}</pre><strong>Open a repository to begin.</strong><span>HIVE keeps threads and isolated worktrees with the project.</span></EmptyState>; }

function Conversation({ thread, composer, setComposer, saving, disabled, paused, retryMessageId, onRetry, onSubmit }: { thread: ThreadRecordV1; composer: string; setComposer: (value: string) => void; saving: boolean; disabled: boolean; paused: boolean; retryMessageId: string | null; onRetry: (messageId: string) => Promise<void>; onSubmit: (event: FormEvent) => Promise<void> }) {
  return <div className="conversation"><ol className="message-list">{thread.messages.length ? thread.messages.map((message) => <li key={message.id} className={`message message-${message.role}`}><header><strong>{message.role === "user" ? "You" : message.role === "assistant" ? "HIVE" : "System"}</strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></header><p>{message.content}</p>{message.id === retryMessageId && <div className="message-retry"><span>Saved, but the run did not start.</span><button type="button" disabled={disabled || saving} onClick={() => void onRetry(message.id)}>Retry run</button></div>}</li>) : <EmptyState><strong>No messages yet.</strong><span>Describe the outcome you want HIVE to build.</span></EmptyState>}</ol>
    <form className="composer" onSubmit={(event) => void onSubmit(event)}><label htmlFor="composer">Message HIVE</label><textarea id="composer" value={composer} onChange={(event) => setComposer(event.target.value)} maxLength={MAX_THREAD_MESSAGE_CHARS} rows={5} disabled={disabled || saving} aria-describedby="composer-help" /><div className="composer-footer"><small id="composer-help">{paused ? "Resume or cancel the paused turn before sending another." : disabled ? "This repository already has an active run." : `${composer.length.toLocaleString()} / ${MAX_THREAD_MESSAGE_CHARS.toLocaleString()} characters`}</small><button disabled={disabled || saving || !composer.trim()}>{saving ? "Saving..." : "Send"}</button></div></form>
  </div>;
}

function ChangesView({ patch, truncated }: { patch?: string; truncated?: boolean }) {
  if (patch === undefined) return <EmptyState><strong>No diff loaded.</strong><span>Select a completed run or refresh changes.</span></EmptyState>;
  if (!patch) return <EmptyState><strong>No HIVE changes.</strong><span>The selected worktree matches its base.</span></EmptyState>;
  const parsed = parseUnifiedDiff(patch, truncated);
  return <div className="diff-view" aria-label="Read-only unified diff"><header><span>Unified diff / read only</span>{parsed.truncated && <StatusPill tone="warning">Truncated safely</StatusPill>}</header><ol className="diff-lines">{parsed.lines.map((line, index) => { const text = line.text || " "; const metadata = `${line.label}${line.oldLine ? `, old line ${line.oldLine}` : ""}${line.newLine ? `, new line ${line.newLine}` : ""}`; return <li key={`${index}-${line.text}`} className={`diff-line diff-${line.kind}`} aria-label={`${text} — ${metadata}`}><span className="diff-number" aria-hidden="true">{line.newLine ?? line.oldLine ?? ""}</span><code>{text}</code><span className="sr-only"> — {metadata}</span></li>; })}</ol></div>;
}

function ReportView({ report, hasRun }: { report: ReturnType<typeof reportType>; hasRun: boolean }) {
  if (!hasRun) return <EmptyState><strong>No run report yet.</strong><span>Reports appear after a coding turn reaches a terminal state.</span></EmptyState>;
  if (!report) return <EmptyState><strong>Report unavailable.</strong><span>The selected session has not produced a final report.</span></EmptyState>;
  return <article className="report-view"><header><span className="eyebrow">Verified session report</span><h2>{report.result}</h2><time dateTime={report.completedAt}>{formatTime(report.completedAt)}</time></header><div className="report-metrics"><Metric label="Files" value={report.filesChanged.length} /><Metric label="Passed" value={report.validation.filter((item) => item.status === "passed").length} /><Metric label="Agents" value={report.subagents.total} /></div><ReportList title="Validation" items={report.validation.map((item) => `${item.label}: ${item.status}`)} /><ReportList title="Review" items={report.review} /><ReportList title="Outstanding" items={report.outstanding} /></article>;
}
function reportType() { return null as import("../../../src/coding/types").CodingFinalReport | null; }
function Metric({ label, value }: { label: string; value: number }) { return <div><strong>{value}</strong><span>{label}</span></div>; }
function ReportList({ title, items }: { title: string; items: string[] }) { return <section><h3>{title}</h3>{items.length ? <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <EmptyState>None recorded.</EmptyState>}</section>; }

function AgentActivity({ events }: { events: RuntimeEvent[] }) {
  const agents = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of events) { const payload = event.payload as unknown as Record<string, unknown>; if (typeof payload.subagentId === "string") map.set(payload.subagentId, event.type.replace("subagent.", "")); }
    return [...map.entries()];
  }, [events]);
  return agents.length ? <ul className="agent-list">{agents.map(([id, status]) => <li key={id}><code>[{id}]</code><StatusPill tone={status === "failed" ? "error" : status === "completed" ? "success" : "neutral"}>{status}</StatusPill></li>)}</ul> : <EmptyState>No agent activity.</EmptyState>;
}

function ValidationSummary({ events, report }: { events: RuntimeEvent[]; report: ReturnType<typeof reportType> }) {
  const validation = [...events].reverse().find((event) => event.type === "validation.completed");
  if (report) return <span>{report.validation.filter((item) => item.status === "passed").length} passed / {report.validation.length} recorded</span>;
  if (!validation) return <EmptyState>No validation results.</EmptyState>;
  return <span>Validation event received at {formatTime(validation.timestamp)}.</span>;
}

function ConfirmationDialog({ preview, onCancel, onConfirm }: { preview: GuardedGitActionPreview; onCancel: () => void; onConfirm: (preview: GuardedGitActionPreview) => Promise<void> }) {
  const action = preview.proposal.action === "pull-request" ? "PR" : preview.proposal.action;
  return <Dialog title={`Confirm ${action}`} onClose={onCancel}><span className="eyebrow">Guarded Git action</span><p>{preview.summary}</p><dl><dt>Observed HEAD</dt><dd><code>{preview.observedHead ?? "unborn"}</code></dd><dt>Token</dt><dd>One-use / expires {formatTime(preview.expiresAt)}</dd></dl><p className="technical-note">HIVE will reject this confirmation if the repository or proposal changed.</p><div className="dialog-actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className={preview.proposal.action === "discard" ? "danger" : ""} onClick={() => void onConfirm(preview)}>Confirm {action}</button></div></Dialog>;
}

function ProviderDialog({ provider, credential, onCredential, onClose, onSubmit, onApprove }: { provider?: DesktopProviderMetadata; credential: string; onCredential: (value: string) => void; onClose: () => void; onSubmit: (event: FormEvent, kind: DesktopCredentialKind, configuration: DesktopProviderConfigurationInput) => Promise<void>; onApprove: (provider: DesktopProviderMetadata) => Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? "");
  useEffect(() => { setBaseUrl(provider?.baseUrl ?? ""); setDefaultModel(provider?.defaultModel ?? ""); }, [provider?.id, provider?.baseUrl, provider?.defaultModel]);
  if (!provider) return <Dialog title="Configure provider" onClose={onClose}><p>No provider is selected.</p><div className="dialog-actions"><button onClick={onClose}>Close</button></div></Dialog>;
  if (provider.authType === "none") return <Dialog title="Configure provider" onClose={onClose}><p><strong>{provider.name}</strong> uses local or environment configuration and requires no desktop secret.</p><StatusPill tone={provider.configured ? "success" : "warning"}>{provider.configured ? "Configured" : "Approval required"}</StatusPill><div className="dialog-actions"><button className="secondary" onClick={onClose}>Cancel provider setup</button>{!provider.configured && <button onClick={() => void onApprove(provider)}>Approve local provider</button>}</div></Dialog>;
  const kind: DesktopCredentialKind = provider.authType;
  const configurableEndpoint = provider.kind === "openai-compatible";
  const configuredProvider: DesktopProviderMetadata = { ...provider, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim().replace(/\/+$/, "") } : {}), ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}) };
  return <Dialog title="Configure provider" onClose={onClose}><p>Credentials are encrypted by Windows and never returned to this window.</p><form onSubmit={(event) => void onSubmit(event, kind, providerConfiguration(configuredProvider))}>{configurableEndpoint && <><label htmlFor="provider-base-url">HIVE Cloud /v1 base URL</label><input id="provider-base-url" type="url" required value={baseUrl} placeholder="https://your-api.up.railway.app/v1" onChange={(event) => setBaseUrl(event.target.value)} /><label htmlFor="provider-model">Model</label><input id="provider-model" required value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} /></>}<label htmlFor="credential">{provider.id === "hive-cloud" ? "HIVE API key" : kind === "api-key" ? "API key" : kind === "bearer" ? "Bearer token" : "OAuth token"}</label><input id="credential" type="password" autoComplete="off" value={credential} onChange={(event) => onCredential(event.target.value)} /><div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>Cancel provider setup</button><button disabled={!credential || (configurableEndpoint && (!baseUrl.trim() || !defaultModel.trim()))}>Store encrypted credential</button></div></form></Dialog>;
}

function phaseTone(status?: string): "neutral" | "success" | "warning" | "error" { if (!status) return "neutral"; if (status === "completed") return "success"; if (status === "failed" || status === "cancelled") return "error"; if (status === "paused") return "warning"; return "neutral"; }
function commitBlockedCopy(reason: import("../../../src/desktop/types").DesktopChangesDiff["commitEligibility"]): string { switch (reason) { case "no-recorded-files": return "No reviewed session files are available to commit."; case "session-not-completed": return "The session must complete before commit."; case "validation-required": return "Session validation must pass before commit."; case "review-required": return "Session review must pass before commit."; case "eligible": return ""; } }
function titleCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function providerConfiguration(provider: DesktopProviderMetadata): import("../../../src/desktop/types").DesktopProviderConfigurationInput {
  return { id: provider.id, name: provider.name, kind: provider.kind, authType: provider.authType, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}), approved: true };
}
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
