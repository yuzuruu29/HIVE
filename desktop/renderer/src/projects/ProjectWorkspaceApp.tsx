import { FormEvent, Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopCredentialKind, DesktopEvent, DesktopProviderConfigurationInput, DesktopProviderMetadata } from "../../../../src/desktop/types";
import type { SessionMode, SessionPermissions, SharedSession } from "../../../../src/projects/types";
import { installedBridge, type HiveDesktopBridge } from "../bridge";
import { App as AdvancedWorkspace } from "../App";
import { Dialog } from "../Dialog";
import { CommandPalette } from "../components/CommandPalette";
import { ConfiguredModelPicker } from "../components/ConfiguredModelPicker";
import { ProviderDialog } from "../components/ProviderDialog";
import { SettingsDialog, type SettingsTab } from "../components/SettingsDialog";
import { renderMarkdown } from "../markdown";
import { usePrefs } from "../prefs";
import { ArchiveIcon, ArrowUpIcon, ChatIcon, ChevronDownIcon, CloseIcon, DiffIcon, FolderIcon, GearIcon, HiveMark, MoreIcon, PenIcon, PulseIcon, SearchIcon, ShieldIcon, SidebarIcon, StopIcon } from "../shell/icons";
import { ChangesDialog, RunSummary } from "./RunEvidence";
import { activeRunStates, useProjectWorkspace, type ActionInput } from "./useProjectWorkspace";
import "../styles.css";
import "../styles/projects.css";

type EditState = { kind: "attach" | "project.rename" | "session.rename"; id?: string; value: string; path?: string };
type Panel = "search" | "archive" | "usage" | null;
type ImportPreview = Extract<DesktopEvent, { type: "projects.import.previewed" }>["preview"];

/** Running wins over review; imported history and change-free runs never ask for review. */
function sessionMarker(session: SharedSession): { state: "running" | "review"; label: string } | null {
  if (session.runs.some((run) => activeRunStates.has(run.status))) return { state: "running", label: "Run active" };
  const last = session.runs.at(-1);
  return last && last.status === "completed" && !last.reviewedAt && last.engine !== "imported" && last.patches.length > 0 ? { state: "review", label: "Needs review" } : null;
}

export function ProjectWorkspaceApp({ api: suppliedApi }: { api?: HiveDesktopBridge }) {
  const api = suppliedApi ?? installedBridge();
  const store = useProjectWorkspace(api);
  const { prefs } = usePrefs();
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string> | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [changesId, setChangesId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [chatActionsOpen, setChatActionsOpen] = useState(false);
  const chatActionsRef = useRef<HTMLDivElement>(null);
  const [provider, setProvider] = useState<DesktopProviderMetadata | null>(null);
  const [credential, setCredential] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const providerLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [imageDrafts, setImageDrafts] = useState<Record<string, string[]>>({});
  const [attachment, setAttachment] = useState<{ sessionId: string; paths: string } | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importResult, setImportResult] = useState<{ imported: number; backupDirectory: string } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollPositions = useRef(new Map<string, { top: number; follow: boolean }>());
  const navigationEpoch = useRef(0);
  const selected = store.snapshot?.sessions.find((session) => session.id === store.selectedId);
  const project = store.snapshot?.projects.find((entry) => entry.id === (selected?.projectId ?? projectChoice)) ?? store.snapshot?.projects[0];
  const latest = selected?.runs.at(-1);
  const running = selected?.runs.find((run) => activeRunStates.has(run.status));
  const changedRun = selected?.runs.find((run) => run.id === changesId);
  const draft = selected ? store.drafts[selected.id] ?? "" : "";
  const imagePaths = selected ? imageDrafts[selected.id] ?? [] : [];
  const sending = selected ? store.sendingIds.has(selected.id) : false;
  const modelOptions = store.providers.filter((entry) => entry.configured).flatMap((entry) => {
    const choices = store.models[entry.id]?.map((model) => model.id) ?? [];
    if (!choices.length && entry.defaultModel) choices.push(entry.defaultModel);
    return choices.filter((model) => prefs.enabledModels?.[model] !== false).map((model) => ({ providerId: entry.id, providerName: entry.name, model }));
  });

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = prefs.density ?? "comfortable";
    root.dataset.accent = prefs.accent ?? "vivid";
    if (prefs.theme && prefs.theme !== "system") root.dataset.theme = prefs.theme;
    else delete root.dataset.theme;
  }, [prefs.density, prefs.accent, prefs.theme]);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 760px)");
    if (!media) return;
    const sync = () => { setCompact(media.matches); if (!media.matches) setDrawerOpen(false); };
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useLayoutEffect(() => {
    if (advanced || !selected || !transcriptRef.current) return;
    const saved = scrollPositions.current.get(selected.id);
    transcriptRef.current.scrollTop = saved?.follow === false ? saved.top : transcriptRef.current.scrollHeight;
  }, [selected?.id, advanced]);
  useEffect(() => { setResumeId(null); setChatActionsOpen(false); }, [selected?.id]);
  useEffect(() => {
    if (!chatActionsOpen) return;
    const dismiss = (event: PointerEvent) => { if (!chatActionsRef.current?.contains(event.target as Node)) setChatActionsOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [chatActionsOpen]);
  useLayoutEffect(() => {
    if (advanced || !selected || !transcriptRef.current) return;
    if (scrollPositions.current.get(selected.id)?.follow !== false) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [selected?.messages, selected?.runs, advanced]);

  async function perform(input: ActionInput) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true);
    try { return await store.action(input); }
    catch (failure) { store.setError(failure instanceof Error ? failure.message : "The action could not be completed. Try again."); }
    finally { actionLock.current = false; setBusy(false); }
  }

  function choose(session: SharedSession) {
    navigationEpoch.current++;
    store.select(session.id); setProjectChoice(session.projectId); setChangesId(null); setDrawerOpen(false);
    setExpandedProjects((current) => new Set([...(current ?? []), session.projectId]));
    // lastSessionId is only an entry hint. The response never changes this client's selection.
    void perform({ type: "session.select", sessionId: session.id });
  }
  async function newSession(projectId = project?.id) {
    if (!projectId) { setEdit({ kind: "attach", value: "", path: "" }); return; }
    const epoch = ++navigationEpoch.current;
    const result = await perform({ type: "session.create", projectId });
    if (result?.sessionId && navigationEpoch.current === epoch) {
      store.select(result.sessionId); setProjectChoice(projectId); setDrawerOpen(false); setChangesId(null);
      setExpandedProjects((current) => new Set([...(current ?? []), projectId]));
      requestAnimationFrame(() => { if (navigationEpoch.current === epoch) composerRef.current?.focus(); });
    }
  }
  function openSettings(tab: SettingsTab = "general") { void store.refreshProviders(); setSettingsTab(tab); setSettingsOpen(true); }
  async function sendMessage() {
    if (!selected || running || sending || busy || !store.online) return;
    const continuation = resumeId;
    const sentImages = imagePaths;
    if (await store.sendSession(selected, continuation ?? undefined, sentImages.length ? { imagePaths: sentImages } : undefined)) {
      setResumeId((current) => current === continuation ? null : current);
      setImageDrafts((current) => JSON.stringify(current[selected.id] ?? []) === JSON.stringify(sentImages) ? { ...current, [selected.id]: [] } : current);
    }
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen((open) => !open); }
      if (event.key.toLowerCase() === "n" && !document.querySelector('[role="dialog"]')) { event.preventDefault(); void newSession(); }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [project?.id]);

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!edit) return;
    const result = await perform(edit.kind === "attach" ? { type: "project.attach", path: edit.path?.trim() ?? "", ...(edit.value.trim() ? { name: edit.value.trim() } : {}) } : edit.kind === "project.rename" ? { type: "project.rename", projectId: edit.id!, name: edit.value.trim() } : { type: "session.rename", sessionId: edit.id!, title: edit.value.trim() });
    if (!result) return;
    if (edit.kind === "attach" && result.projectId) {
      setProjectChoice(result.projectId); store.select(result.sessionId ?? null);
      setExpandedProjects((current) => new Set([...(current ?? []), result.projectId!]));
    }
    setEdit(null);
  }

  async function previewHistory() {
    if (!project || actionLock.current) return;
    actionLock.current = true; setBusy(true); store.setError(null);
    try {
      const event = await store.request({ type: "projects.import.preview", projectId: project.id, ...(selected?.projectId === project.id ? { workspaceId: selected.workspaceId } : {}) });
      if (event.type !== "projects.import.previewed") throw new Error("History preview was not returned. Original stores are unchanged.");
      setImportPreview(event.preview); setImportResult(null);
    } catch (failure) { store.setError(failure instanceof Error ? failure.message : "History could not be previewed. Original stores are unchanged."); }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function confirmHistoryImport() {
    if (!importPreview || actionLock.current) return;
    actionLock.current = true; setBusy(true); store.setError(null);
    try {
      const event = await store.request({ type: "projects.import.confirm", projectId: importPreview.projectId, workspaceId: importPreview.workspaceId, digest: importPreview.digest });
      if (event.type !== "projects.imported") throw new Error("History import was not acknowledged. Keep the original stores and inspect recovery state.");
      setImportResult({ imported: event.result.imported, backupDirectory: event.result.backupDirectory });
    } catch (failure) { store.setError(failure instanceof Error ? failure.message : "History import failed. Original stores are preserved."); }
    finally { actionLock.current = false; setBusy(false); }
  }

  function closeProvider() { if (providerLock.current) return; setProvider(null); setCredential(""); setProviderError(null); }
  function configureProvider(entry: DesktopProviderMetadata) { setProvider(entry); setCredential(""); setProviderError(null); }
  async function saveProvider(kind: DesktopCredentialKind | null, configuration: DesktopProviderConfigurationInput) {
    if (providerLock.current) return;
    providerLock.current = true; setProviderBusy(true); setProviderError(null);
    const input = kind ? { providerId: configuration.id, kind, secret: credential } : null;
    try {
      const metadata = input ? await store.request({ type: "credential.list" }) : null;
      const configured = await store.request({ type: "provider.configure", input: configuration });
      if (configured.type !== "provider.changed") throw new Error("Provider configuration not acknowledged.");
      if (input) {
        if (metadata?.type !== "credential.listed") throw new Error("Credential metadata unavailable.");
        const replacing = metadata.credentials.some((entry) => entry.providerId === input.providerId && entry.configured);
        const stored = await store.request({ type: replacing ? "credential.replace" : "credential.set", input });
        if (stored.type !== "credential.changed" || stored.credential.providerId !== configuration.id || !stored.credential.configured) throw new Error("Credential not saved.");
      }
      setProvider(null); setCredential("");
      await store.request({ type: "provider.list" });
      await store.fetchModels(configuration.id);
    } catch { setProviderError("Provider setup could not be saved. Your entries are preserved."); }
    finally { if (input) input.secret = ""; providerLock.current = false; setProviderBusy(false); }
  }

  const sidebar = <aside className="project-sidebar" aria-label="Projects and sessions">
    <div className="project-brand"><HiveMark size={34} /><span>HIVE</span>{compact && <button className="project-icon" aria-label="Close navigation" onClick={() => setDrawerOpen(false)}><CloseIcon /></button>}</div>
    <nav className="project-primary" aria-label="Conversations">
      <button disabled={busy} onClick={() => void newSession()}><PenIcon size={19} />New chat</button>
      <button onClick={() => { setPanel("search"); setQuery(""); }}><SearchIcon size={19} />Search chats</button>
    </nav>
    <div className="project-nav-heading"><h2>Projects</h2><button className="project-icon" aria-label="Attach project" onClick={() => setEdit({ kind: "attach", value: "", path: "" })}>+</button></div>
    <nav className="project-tree" aria-label="Project sessions">
      {!store.snapshot && <p className="project-nav-empty">{store.online ? "Loading projects…" : "Connecting to HIVE…"}</p>}
      {store.snapshot && !store.snapshot.projects.length && <p className="project-nav-empty">Attach a project folder to start your first conversation.</p>}
      {store.snapshot?.projects.map((entry) => {
        const expanded = expandedProjects ? expandedProjects.has(entry.id) : project?.id === entry.id;
        const sessions = store.snapshot!.sessions.filter((session) => session.projectId === entry.id && !session.archived);
        return <section key={entry.id} className="project-group">
          <div className="project-row"><button aria-expanded={expanded} onClick={() => { setProjectChoice(entry.id); setExpandedProjects((current) => { const next = new Set(current ?? (project ? [project.id] : [])); if (expanded) next.delete(entry.id); else next.add(entry.id); return next; }); }}><FolderIcon /><span>{entry.name}</span><ChevronDownIcon /></button><button className="project-icon" aria-label={`New chat in ${entry.name}`} disabled={busy} onClick={() => void newSession(entry.id)}>+</button></div>
          {expanded && <ul>{sessions.map((session) => <li key={session.id}><button className={selected?.id === session.id ? "is-selected" : ""} aria-current={selected?.id === session.id ? "page" : undefined} onClick={() => choose(session)}><span>{session.title}</span>{(() => { const marker = sessionMarker(session); return marker && <span className="project-session-dot" data-state={marker.state} role="img" aria-label={marker.label} title={marker.label} />; })()}</button></li>)}{!sessions.length && <li className="project-nav-empty">No chats yet</li>}</ul>}
        </section>;
      })}
    </nav>
    <nav className="project-footer" aria-label="Workspace controls">
      <button onClick={() => setPanel("archive")}><ArchiveIcon />Archived chats</button>
      <button onClick={() => setPanel("usage")}><PulseIcon />Usage</button>
      <button onClick={() => openSettings()}><GearIcon />Settings</button>
      <p>Local workspace <span className="project-connection" data-online={store.online}>{store.online ? "Connected" : "Offline"}</span></p>
    </nav>
  </aside>;

  if (advanced) return <div className="project-advanced"><button className="project-advanced-back" onClick={() => setAdvanced(false)}>← Projects and conversations</button><AdvancedWorkspace api={api} readOnly /></div>;

  return <div className="project-app">
    {!compact && sidebar}
    {compact && drawerOpen && <Dialog title="Navigation" className="project-navigation-dialog" onClose={() => setDrawerOpen(false)}>{sidebar}</Dialog>}
    <main className="project-main" aria-label="HIVE conversation">
      <header className="project-header">
        {compact && <button className="project-icon" aria-label="Open navigation" onClick={() => setDrawerOpen(true)}><SidebarIcon size={20} /></button>}
        <div className="project-context"><button title={project?.repositoryPath} disabled={!project} onClick={() => project && setEdit({ kind: "project.rename", id: project.id, value: project.name })}>{project?.name ?? "HIVE workspace"}</button><span>/</span><h1>{selected?.title ?? "New conversation"}</h1></div>
        <div className="project-header-actions">{selected && <>
          <button className="project-changes-button" aria-label="View changes" title={latest?.patches.length ? `${latest.patches.length} ${latest.patches.length === 1 ? "file" : "files"} changed in the latest run` : undefined} onClick={() => setChangesId(latest?.id ?? "empty")}><DiffIcon /><span>View changes</span>{!!latest?.patches.length && <span className="project-count" aria-hidden="true">{latest.patches.length}</span>}</button>
          <div className="project-chat-actions" ref={chatActionsRef} onKeyDown={(event) => { if (event.key === "Escape" && chatActionsOpen) { event.stopPropagation(); setChatActionsOpen(false); chatActionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); } }}>
            <button className="project-icon" aria-label="Chat actions" aria-expanded={chatActionsOpen} aria-controls="project-chat-menu" onClick={() => setChatActionsOpen((open) => !open)}><MoreIcon /></button>
            {chatActionsOpen && <div id="project-chat-menu" className="project-chat-menu">
              <button onClick={() => { setChatActionsOpen(false); setEdit({ kind: "session.rename", id: selected.id, value: selected.title }); }}><PenIcon />Rename chat</button>
              <button disabled={busy || !!running || sending} title={running ? "Stop the active run before archiving" : undefined} onClick={() => { setChatActionsOpen(false); void perform({ type: selected.archived ? "session.restore" : "session.archive", sessionId: selected.id }); }}><ArchiveIcon />{selected.archived ? "Restore" : "Archive"}</button>
            </div>}
          </div>
        </>}</div>
      </header>
      {!store.online && store.connectionError && <div className="project-banner" role="status">History is offline. Your conversation and draft are preserved.<button onClick={() => void store.reconnect()}>Reconnect</button></div>}
      {store.error && <div className="project-banner is-error" role="alert"><span>{store.error}</span><button aria-label="Dismiss error" onClick={() => store.setError(null)}><CloseIcon /></button></div>}
      {!!store.snapshot?.warnings.length && <details className="project-warnings"><summary>History notices · {store.snapshot.warnings.length}</summary>{store.snapshot.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      <div ref={transcriptRef} className="project-transcript" onScroll={(event) => { if (selected) { const node = event.currentTarget; scrollPositions.current.set(selected.id, { top: node.scrollTop, follow: node.scrollHeight - node.clientHeight - node.scrollTop < 80 }); } }}>
        <div className="project-reading">
          {!selected && <section className="project-empty"><HiveMark size={52} /><h2>{project ? `What are we building in ${project.name}?` : "Your next idea starts here."}</h2><p>{project ? "Start a conversation. HIVE keeps the work, activity, and review together." : "Attach a project folder to give your conversations a shared home."}</p><button onClick={() => void newSession()} disabled={busy}>{project ? "Start a new chat" : "Attach a project"}</button></section>}
          {selected && !selected.messages.length && <section className="project-empty"><HiveMark size={48} /><h2>What would you like to work on?</h2><p>Ask a question, make a plan, or build something in {project?.name}.</p></section>}
          {selected?.messages.map((message, index) => {
            const run = message.runId ? selected.runs.find((entry) => entry.id === message.runId) : undefined;
            const lastForRun = !!run && !selected.messages.slice(index + 1).some((entry) => entry.runId === run.id);
            return <Fragment key={message.id}><article className={`project-message is-${message.role}`} aria-label={`${message.role} message`}>
              {message.role === "user" ? <div>{message.text}</div> : renderMarkdown(message.text)}
            </article>{lastForRun && <RunSummary run={run} showSummary={message.role !== "assistant" || message.text.trim() !== run.summary.trim()} busy={busy} onChanges={() => setChangesId(run.id)} onApprove={(approvalId, approved) => void perform({ type: "run.approve", sessionId: selected.id, runId: run.id, approvalId, approved })} />}</Fragment>;
          })}
          {selected?.runs.filter((run) => !selected.messages.some((message) => message.runId === run.id)).map((run) => <RunSummary key={run.id} run={run} busy={busy} onChanges={() => setChangesId(run.id)} onApprove={(approvalId, approved) => void perform({ type: "run.approve", sessionId: selected.id, runId: run.id, approvalId, approved })} />)}
          {latest && ["interrupted", "failed", "cancelled"].includes(latest.status) && !running && <div className="project-recovery"><p>This attempt {latest.status}. Changes remain in the workspace. A continuation starts a new linked attempt after the engine checks its state.</p><button disabled={selected?.archived} onClick={() => { setResumeId(latest.id); composerRef.current?.focus(); }}>Continue in a new attempt</button></div>}
        </div>
      </div>
      {selected && <div className="project-composer-dock">
        {selected.archived ? <div className="project-archived">This chat is archived.<button disabled={busy} onClick={() => void perform({ type: "session.restore", sessionId: selected.id })}>Restore chat</button></div> : <form className="project-composer" aria-label="Conversation composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          {resumeId && <div className="project-resume-label">New attempt linked to the previous run<button type="button" aria-label="Cancel continuation" onClick={() => setResumeId(null)}><CloseIcon /></button></div>}
          {imagePaths.length > 0 && <ul className="project-attachments">{imagePaths.map((image) => <li key={image} title={image}><span>{image.split(/[\\/]/).at(-1)}</span><button type="button" aria-label={`Remove image ${image.split(/[\\/]/).at(-1)}`} onClick={() => setImageDrafts((current) => ({ ...current, [selected.id]: (current[selected.id] ?? []).filter((path) => path !== image) }))}><CloseIcon size={12} /></button></li>)}</ul>}
          <textarea ref={composerRef} aria-label="Message HIVE" placeholder="Message HIVE" value={draft} rows={2} onChange={(event) => store.setDraft(selected.id, event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return; const sendWithEnter = prefs.composerSendWithEnter !== false; if ((sendWithEnter && !event.ctrlKey && !event.metaKey) || (!sendWithEnter && (event.ctrlKey || event.metaKey))) { event.preventDefault(); void sendMessage(); } }} />
          <div className="project-composer-controls">
            <button type="button" className="project-icon project-attach" aria-label="Attach images" title="Attach local image paths" onClick={() => setAttachment({ sessionId: selected.id, paths: imagePaths.join("\n") })}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7L13 2" /><path d="m7 14 8-8" /></svg></button>
            <label className="project-mode"><span className="sr-only">Workflow</span><select aria-label="Workflow" disabled={!!running || busy || sending} value={selected.settings.mode} onChange={(event) => void perform({ type: "session.settings", sessionId: selected.id, settings: { mode: event.target.value as SessionMode } })}><option value="code">Code</option><option value="plan">Plan</option><option value="chat">Chat</option>{selected.settings.mode === "review" && <option value="review">Review</option>}</select></label>
            <fieldset className="project-model-control" disabled={!!running || busy || sending}><ConfiguredModelPicker showSavedRoute options={modelOptions} selectedModel={selected.settings.providerId && selected.settings.model ? { providerId: selected.settings.providerId, model: selected.settings.model } : null} placeholder="Configured default" onSelectModel={(choice) => void perform({ type: "session.settings", sessionId: selected.id, settings: { providerId: choice.providerId, model: choice.model } })} onOpenSettings={() => openSettings("models")} label="Select model" resetKey={`${selected.id}:${running?.id ?? "idle"}`} /></fieldset>
            <label className="project-permissions"><ShieldIcon size={15} /><span className="sr-only">Permissions</span><select aria-label="Permissions" disabled={!!running || busy || sending} value={selected.settings.permissions} onChange={(event) => void perform({ type: "session.settings", sessionId: selected.id, settings: { permissions: event.target.value as SessionPermissions } })}><option value="guarded">Guarded</option><option value="standard">Standard</option><option value="autonomous">Autonomous</option></select></label>
            {running ? <button type="button" className="project-send" aria-label={running.status === "stopping" ? "Stopping run" : "Stop run"} disabled={busy || running.status === "stopping"} onClick={() => void perform({ type: "run.cancel", sessionId: selected.id, runId: running.id })}><StopIcon size={18} /></button> : <button type="submit" className="project-send" aria-label="Send message" disabled={!draft.trim() || sending || busy || !store.online}><ArrowUpIcon size={21} /></button>}
          </div>
          {!modelOptions.length && <button type="button" className="project-provider-hint" onClick={() => openSettings("models")}>Using the configured HIVE route · Manage desktop providers</button>}
        </form>}
        <p className="project-composer-note">{running ? `Effective policy: ${running.effectivePolicy} · ${running.status.replace(/_/g, " ")}` : `${prefs.composerSendWithEnter === false ? "Ctrl+Enter" : "Enter"} to send · Shift+Enter for a new line`}</p>
      </div>}
    </main>
    {changesId && <ChangesDialog run={changedRun} busy={busy} repositoryRoot={changedRun?.workspace} sessionTitle={selected?.title} request={store.request} onClose={() => setChangesId(null)} onReview={() => { if (selected && changedRun) void perform({ type: "run.review", sessionId: selected.id, runId: changedRun.id }); }} />}
    {attachment && <Dialog title="Attach images" onClose={() => setAttachment(null)}><form className="project-edit-form" onSubmit={(event) => { event.preventDefault(); const paths = [...new Set(attachment.paths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean))]; if (paths.length > 16) { store.setError("Attach up to 16 images per message."); return; } setImageDrafts((current) => ({ ...current, [attachment.sessionId]: paths })); setAttachment(null); }}><p>Enter one absolute local image path per line. HIVE validates the files when you send your message. Images stay attached to this chat's draft.</p><label htmlFor="project-image-paths">Local image paths</label><textarea id="project-image-paths" rows={4} value={attachment.paths} onChange={(event) => setAttachment({ ...attachment, paths: event.target.value })} placeholder="C:\\Pictures\\screenshot.png" />{store.error && <p role="alert">{store.error}</p>}<div className="dialog-actions"><button type="button" onClick={() => setAttachment(null)}>Cancel</button><button>Save attachments</button></div></form></Dialog>}
    {importPreview && <Dialog title="Import legacy history" onClose={() => { if (!busy) setImportPreview(null); }} className="project-list-dialog">
      {importResult ? <div className="project-import-copy"><p role="status">Imported {importResult.imported} conversations. Your current selection and drafts are preserved.</p><p>Backup directory:</p><code>{importResult.backupDirectory}</code><p>Original stores remain in place for rollback. The backup preserves their metadata.</p><div className="dialog-actions"><button onClick={() => setImportPreview(null)}>Done</button></div></div> : <div className="project-import-copy"><p>Preview of this project's existing HIVE history. No source history has been changed.</p><dl><dt>CLI sessions</dt><dd>{importPreview.counts.cli}</dd><dt>Code threads</dt><dd>{importPreview.counts.thread}</dd><dt>Chats</dt><dd>{importPreview.counts.chat}</dd><dt>Messages</dt><dd>{importPreview.counts.messages}</dd></dl>{importPreview.alreadyImported && <p>This exact history has already been imported. Repeating the import will not duplicate it.</p>}{importPreview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}{importPreview.sessions.length > 0 && <><h3>Conversations</h3><ul>{importPreview.sessions.map((session) => <li key={session.id}>{session.title} · {session.messages} messages</li>)}</ul></>}{store.error && <p role="alert">{store.error}</p>}<div className="dialog-actions"><button disabled={busy} onClick={() => setImportPreview(null)}>Cancel</button><button disabled={busy || importPreview.sessions.length === 0} onClick={() => void confirmHistoryImport()}>{busy ? "Backing up and importing…" : "Back up and import"}</button></div></div>}
    </Dialog>}
    {edit && <Dialog title={edit.kind === "attach" ? "Attach a project" : edit.kind === "project.rename" ? "Rename project" : "Rename chat"} onClose={() => { if (!busy) setEdit(null); }}><form className="project-edit-form" onSubmit={(event) => void saveEdit(event)}>
      {edit.kind === "attach" && <><p>Choose an existing folder. HIVE keeps its repository identity and workspaces together.</p><label htmlFor="project-path">Project folder</label><div className="project-folder-input"><input id="project-path" required value={edit.path ?? ""} onChange={(event) => setEdit({ ...edit, path: event.target.value })} /><button type="button" onClick={() => { void store.request({ type: "workspace.pick" }).then((event) => { if (event.type === "workspace.picked" && event.path) { const pickedPath = event.path; setEdit((current) => current ? { ...current, path: pickedPath } : current); } }).catch(() => store.setError("The folder picker could not open. Enter the folder path instead.")); }}>Browse</button></div></>}
      <label htmlFor="project-edit-name">{edit.kind === "attach" ? "Project name (optional)" : "Name"}</label><input id="project-edit-name" required={edit.kind !== "attach"} maxLength={160} value={edit.value} onChange={(event) => setEdit({ ...edit, value: event.target.value })} />
      {store.error && <p role="alert">{store.error}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setEdit(null)}>Cancel</button><button disabled={busy || (edit.kind === "attach" ? !edit.path?.trim() : !edit.value.trim())}>{busy ? "Saving…" : edit.kind === "attach" ? "Attach project" : "Save name"}</button></div>
    </form></Dialog>}
    {panel && <Dialog title={panel === "search" ? "Search chats" : panel === "archive" ? "Archived chats" : "Usage"} onClose={() => setPanel(null)} className="project-list-dialog">
      <button className="project-panel-close project-icon" aria-label={`Close ${panel}`} onClick={() => setPanel(null)}><CloseIcon /></button>
      {panel === "usage" ? <UsageSummary sessions={store.snapshot?.sessions ?? []} /> : <>
        {panel === "search" && <><label htmlFor="project-search" className="sr-only">Search all projects</label><input id="project-search" placeholder="Search titles across all projects" value={query} onChange={(event) => setQuery(event.target.value)} /><label className="project-archive-toggle"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />Include archived chats</label></>}
        <ul className="project-search-results">{store.snapshot?.sessions.filter((session) => panel === "archive" ? session.archived : (includeArchived || !session.archived) && session.title.toLowerCase().includes(query.toLowerCase().trim())).map((session) => <li key={session.id}><button onClick={() => { choose(session); setPanel(null); }}><ChatIcon /><span>{session.title}<small>{store.snapshot?.projects.find((entry) => entry.id === session.projectId)?.name}{session.archived ? " · Archived" : ""}</small></span></button>{session.archived && <button disabled={busy} onClick={() => void perform({ type: "session.restore", sessionId: session.id })}>Restore</button>}</li>)}</ul>
        {!store.snapshot?.sessions.some((session) => panel === "archive" ? session.archived : (includeArchived || !session.archived) && session.title.toLowerCase().includes(query.toLowerCase().trim())) && <p className="project-search-empty">{panel === "archive" ? "No archived chats." : "No matching chats."}</p>}
      </>}
    </Dialog>}
    {settingsOpen && <SettingsDialog initialTab={settingsTab} onClose={() => setSettingsOpen(false)} history={{ importDisabled: !project || busy, onImport: () => void previewHistory(), onOpenLegacy: () => { navigationEpoch.current++; setAdvanced(true); } }} providers={store.providers} modelsByProvider={store.models} modelsLoading={store.loadingModels} onFetchModels={store.fetchModels} onConfigureProvider={(providerId) => { const entry = store.providers.find((item) => item.id === providerId); if (entry) configureProvider(entry); }} onAddCompatibleProvider={async (input) => { const event = await store.request({ type: "provider.configure", input: { ...input, kind: "openai-compatible", authType: "api-key", approved: true } }); if (event.type !== "provider.changed") throw new Error("Configuration not saved."); configureProvider(event.provider); }} />}
    {provider && <ProviderDialog provider={provider} credential={credential} busy={providerBusy} error={providerError} onCredential={setCredential} onClose={closeProvider} onSubmit={async (event, kind, configuration) => { event.preventDefault(); await saveProvider(kind, configuration); }} onApprove={async (entry) => { await saveProvider(null, { id: entry.id, name: entry.name, kind: entry.kind, authType: entry.authType, ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}), ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}), approved: true }); }} />}
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={[{ id: "new", label: "New chat", hint: "Ctrl+N", run: () => void newSession() }, { id: "search", label: "Search chats", run: () => { setPanel("search"); setQuery(""); } }, { id: "attach", label: "Attach a project", run: () => setEdit({ kind: "attach", value: "", path: "" }) }, { id: "settings", label: "Settings", run: () => openSettings() }, { id: "changes", label: "View changes and checks", run: () => setChangesId(latest?.id ?? "empty") }]} />
  </div>;
}

function UsageSummary({ sessions }: { sessions: SharedSession[] }) {
  const runs = sessions.flatMap((session) => session.runs);
  return <div className="project-usage"><p>Recorded shared history on this computer.</p><dl><dt>Chats</dt><dd>{sessions.filter((session) => !session.archived).length}</dd><dt>Messages</dt><dd>{sessions.reduce((count, session) => count + session.messages.length, 0)}</dd><dt>Runs</dt><dd>{runs.length}</dd><dt>Completed runs</dt><dd>{runs.filter((run) => run.status === "completed").length}</dd><dt>Checks passed</dt><dd>{runs.flatMap((run) => run.checks).filter((check) => check.status === "passed").length}</dd><dt>Tokens and cost</dt><dd>Unavailable</dd></dl><p>Token and cost totals are not recorded for shared runs. Nothing here is estimated.</p></div>;
}
