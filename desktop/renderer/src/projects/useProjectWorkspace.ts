import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopEvent, DesktopProviderMetadata, DesktopModelInfo } from "../../../../src/desktop/types";
import type { ProjectAction, ProjectActionResult, ProjectSnapshot, SharedExecutionContext, SharedSession } from "../../../../src/projects/types";
import type { DesktopCommandInput, HiveDesktopBridge } from "../bridge";
import { identifier } from "../utils";

export const activeRunStates = new Set(["queued", "running", "awaiting_approval", "stopping"]);
const selectionKey = "hive.projects.selection.v1";
const providerFailureMessage = "Provider settings could not be loaded. Reconnect or open Settings to try again.";
export type ActionInput = ProjectAction extends infer Action ? Action extends { requestId: string } ? Omit<Action, "requestId"> : never : never;

/** Shared history is server-owned. Focus, drafts and scrolling stay with this client. */
export function useProjectWorkspace(api: HiveDesktopBridge) {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return localStorage.getItem(selectionKey); } catch { return null; }
  });
  const selectedRef = useRef(selectedId);
  const initialized = useRef(false);
  const mounted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [providers, setProviders] = useState<DesktopProviderMetadata[]>([]);
  const [models, setModels] = useState<Record<string, DesktopModelInfo[]>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const sendAttempts = useRef(new Map<string, { text: string; requestId: string; contextKey: string }>());

  const select = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedId(id);
    try { if (id) localStorage.setItem(selectionKey, id); else localStorage.removeItem(selectionKey); } catch { /* Selection is still usable in memory. */ }
  }, []);

  const ingest = useCallback((event: DesktopEvent) => {
    if (!mounted.current) return;
    const incoming = event.type === "projects.snapshot" ? event.snapshot : event.type === "projects.imported" ? event.result.snapshot : null;
    if (incoming) {
      setSnapshot((current) => current && current.revision > incoming.revision ? current : incoming);
      setOnline(true);
      setConnectionError(false);
      if (!initialized.current) {
        initialized.current = true;
        const remembered = incoming.sessions.find((session) => session.id === selectedRef.current);
        if (!remembered) {
          const project = incoming.projects[0];
          const hint = incoming.sessions.find((session) => session.projectId === project?.id && session.id === project?.lastSessionId && !session.archived);
          select(hint?.id ?? incoming.sessions.find((session) => !session.archived)?.id ?? null);
        }
      }
    } else if (event.type === "provider.listed") setProviders(event.providers);
    else if (event.type === "provider.changed") setProviders((current) => [...current.filter((provider) => provider.id !== event.provider.id), event.provider]);
    else if (event.type === "models.listed") setModels((current) => ({ ...current, [event.providerId]: event.models }));
  }, [select]);

  const request = useCallback(async (input: DesktopCommandInput): Promise<DesktopEvent> => {
    const event = await api.request({ ...input, requestId: input.requestId ?? identifier("request") });
    ingest(event);
    if (event.type === "request.failed") throw new Error(event.message);
    return event;
  }, [api, ingest]);

  const refresh = useCallback(async () => {
    try { await request({ type: "projects.snapshot" }); }
    catch { if (mounted.current) { setOnline(false); setConnectionError(true); } }
  }, [request]);
  const refreshProviders = useCallback(async () => {
    try { await request({ type: "provider.list" }); if (mounted.current) setError((current) => current === providerFailureMessage ? null : current); }
    catch { if (mounted.current) setError(providerFailureMessage); }
  }, [request]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = api.subscribe(ingest);
    void refresh();
    void refreshProviders();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { mounted.current = false; unsubscribe(); window.clearInterval(timer); };
  }, [api, ingest, refresh, refreshProviders]);

  async function fetchModels(providerId: string): Promise<void> {
    setLoadingModels((current) => ({ ...current, [providerId]: true }));
    try { await request({ type: "models.list", providerId }); }
    catch { setError("Available models could not be loaded. Configured defaults are still shown."); }
    finally { if (mounted.current) setLoadingModels((current) => ({ ...current, [providerId]: false })); }
  }

  const requestedModels = useRef(new Set<string>());
  useEffect(() => {
    for (const provider of providers) {
      if (!provider.configured || requestedModels.current.has(provider.id)) continue;
      requestedModels.current.add(provider.id);
      void fetchModels(provider.id);
    }
  }, [providers]);

  async function action(input: ActionInput, requestId = identifier("project")): Promise<ProjectActionResult> {
    const event = await request({ type: "projects.action", requestId, action: { ...input, requestId } });
    if (event.type !== "projects.snapshot") throw new Error("HIVE did not acknowledge this action. Try again.");
    setError(null);
    return event.result ?? {};
  }

  function setDraft(sessionId: string, text: string): void {
    const next = { ...draftsRef.current, [sessionId]: text };
    draftsRef.current = next;
    setDrafts(next);
  }

  async function sendSession(session: SharedSession, parentRunId?: string, executionContext?: SharedExecutionContext): Promise<boolean> {
    const text = draftsRef.current[session.id] ?? "";
    if (!text.trim() || inFlight.current.has(session.id)) return false;
    const previous = sendAttempts.current.get(session.id);
    const contextKey = JSON.stringify({ parentRunId, executionContext });
    // Lost acknowledgments retry the exact accepted request, rather than creating a second run.
    const attempt = previous?.text === text && previous.contextKey === contextKey ? previous : { text, contextKey, requestId: identifier("send") };
    sendAttempts.current.set(session.id, attempt);
    inFlight.current.add(session.id);
    setSendingIds(new Set(inFlight.current));
    try {
      await action({ type: "session.send", sessionId: session.id, text, ...(parentRunId ? { parentRunId } : {}), ...(executionContext ? { executionContext } : {}) }, attempt.requestId);
      if (draftsRef.current[session.id] === text) setDraft(session.id, "");
      sendAttempts.current.delete(session.id);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The message could not be sent. Your draft is preserved.");
      return false;
    } finally {
      inFlight.current.delete(session.id);
      if (mounted.current) setSendingIds(new Set(inFlight.current));
    }
  }

  async function reconnect() { await Promise.all([refresh(), refreshProviders()]); }
  return { snapshot, selectedId, select, online, connectionError, error, setError, refresh, reconnect, refreshProviders, request, action, providers, models, loadingModels, fetchModels, drafts, setDraft, sendingIds, sendSession };
}
