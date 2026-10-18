import { useEffect, useRef, useState } from "react";
import type { DesktopEvent, GuardedGitActionPreview, GuardedGitPreviewInput } from "../../../../src/desktop/types";
import type { SharedRun } from "../../../../src/projects/types";
import type { DesktopCommandInput } from "../bridge";
import { ConfirmationDialog } from "../components/ConfirmationDialog";
import { activeRunStates } from "./useProjectWorkspace";

interface Props {
  run: SharedRun;
  repositoryRoot: string;
  sessionTitle: string;
  request(command: DesktopCommandInput): Promise<DesktopEvent>;
  onBusy(busy: boolean): void;
}

/** Existing guarded Git services own eligibility, scope, stale-state and one-use token checks. */
export function GuardedRunActions({ run, repositoryRoot, sessionTitle, request, onBusy }: Props) {
  const [message, setMessage] = useState(`HIVE: ${sessionTitle}`);
  const [remote, setRemote] = useState("origin");
  const [base, setBase] = useState("main");
  const [title, setTitle] = useState(sessionTitle);
  const [body, setBody] = useState("Changes inspected in HIVE Desktop.");
  const [draft, setDraft] = useState(true);
  const [preview, setPreview] = useState<GuardedGitActionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const scope = `${repositoryRoot}\u0000${run.id}\u0000${run.engineSessionId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setPreview(null); setConfirmationError(null); setError(null); setResult(null); setMessage(`HIVE: ${sessionTitle}`); setTitle(sessionTitle); }, [scope]);

  async function checked(command: DesktopCommandInput): Promise<DesktopEvent> {
    const event = await request(command);
    if (event.type === "request.failed") throw new Error(event.message);
    return event;
  }
  function setWorking(value: boolean) { pending.current = value; setBusy(value); onBusy(value); }

  async function prepare(action: GuardedGitPreviewInput["action"]) {
    if (pending.current || !run.engineSessionId || activeRunStates.has(run.status)) return;
    const expectedScope = scope;
    setWorking(true); setError(null); setResult(null); setConfirmationError(null);
    try {
      const opened = await checked({ type: "repository.open", repositoryRoot });
      if (opened.type !== "desktop.ready" || opened.repositoryRoot !== repositoryRoot) throw new Error("The selected repository changed. Reopen this result and request a fresh preview.");
      if (scopeRef.current !== expectedScope) return;
      const context = { repositoryRoot, codingSessionId: run.engineSessionId };
      let proposal: GuardedGitPreviewInput;
      if (action === "commit") {
        const event = await checked({ type: "changes.diff", input: context });
        if (event.type !== "changes.diffed" || event.diff.codingSessionId !== context.codingSessionId || event.diff.repositoryRoot !== repositoryRoot) throw new Error("The recorded change scope could not be verified. Request a fresh preview.");
        if (event.diff.commitEligibility !== "eligible") throw new Error(`Commit is unavailable: ${event.diff.commitEligibility.replace(/-/g, " ")}. Inspect the recorded checks and reviewer result.`);
        proposal = { ...context, action, message: message.trim(), paths: event.diff.reviewedFiles };
      } else if (action === "push") proposal = { ...context, action, remote: remote.trim() };
      else if (action === "pull-request") proposal = { ...context, action, remote: remote.trim(), base: base.trim(), title: title.trim(), body, draft };
      else proposal = { ...context, action };
      if (scopeRef.current !== expectedScope) return;
      const event = action === "commit" && proposal.action === "commit" ? await checked({ type: "git.commit.preview", input: proposal })
        : action === "push" && proposal.action === "push" ? await checked({ type: "git.push.preview", input: proposal })
        : action === "pull-request" && proposal.action === "pull-request" ? await checked({ type: "git.pull-request.preview", input: proposal })
        : proposal.action === "discard" ? await checked({ type: "git.discard.preview", input: proposal }) : null;
      if (!event || event.type !== "git.previewed") throw new Error("The Git action preview was not acknowledged.");
      if (mounted.current && scopeRef.current === expectedScope) setPreview(event.preview);
    } catch (failure) { if (mounted.current && scopeRef.current === expectedScope) setError(failure instanceof Error ? failure.message : "The Git preview could not be prepared. Your conversation and draft are preserved."); }
    finally { if (mounted.current) setWorking(false); }
  }

  async function confirm(value: GuardedGitActionPreview) {
    if (pending.current || confirmationError || value.proposal.repositoryRoot !== repositoryRoot || value.proposal.codingSessionId !== run.engineSessionId) return;
    const expectedScope = scope;
    setWorking(true);
    try {
      const proposal = value.proposal;
      const token = { confirmationToken: value.confirmationToken };
      const event = proposal.action === "commit" ? await checked({ type: "git.commit.confirm", input: { ...token, proposal } })
        : proposal.action === "push" ? await checked({ type: "git.push.confirm", input: { ...token, proposal } })
        : proposal.action === "pull-request" ? await checked({ type: "git.pull-request.confirm", input: { ...token, proposal } })
        : await checked({ type: "git.discard.confirm", input: { ...token, proposal } });
      if (event.type !== "git.action-completed" || event.action !== proposal.action) throw new Error("The Git action result was not acknowledged. Inspect the repository before requesting a fresh preview.");
      if (mounted.current && scopeRef.current === expectedScope) { setPreview(null); setResult(event.summary ?? (event.url ? `Pull request created: ${event.url}` : `${proposal.action} completed`)); }
    } catch (failure) { if (mounted.current && scopeRef.current === expectedScope) setConfirmationError(`${failure instanceof Error ? failure.message : "The confirmation failed."} Cancel this dialog and request a fresh preview before retrying.`); }
    finally { if (mounted.current) setWorking(false); }
  }

  if (!run.engineSessionId) return <p className="project-git-note">Git actions become available when this run has an authoritative coding record.</p>;
  const disabled = busy || activeRunStates.has(run.status);
  return <section className="project-git-actions" aria-label="Guarded Git actions">
    <h3>Git actions</h3><p>Each action requires a fresh preview and explicit confirmation. Marking a run reviewed grants no Git permission.</p>
    <details><summary>Git action settings</summary><label>Commit message<input value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} /></label><label>Remote<input value={remote} disabled={busy} onChange={(event) => setRemote(event.target.value)} /></label><label>Base branch<input value={base} disabled={busy} onChange={(event) => setBase(event.target.value)} /></label><label>PR title<input value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label><label>PR description<textarea value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} rows={3} /></label><label className="project-git-checkbox"><input type="checkbox" checked={draft} disabled={busy} onChange={(event) => setDraft(event.target.checked)} />Create as draft</label></details>
    <div className="project-actions"><button disabled={disabled || !message.trim()} onClick={() => void prepare("commit")}>Preview commit</button><button disabled={disabled || !remote.trim()} onClick={() => void prepare("push")}>Preview push</button><button disabled={disabled || !remote.trim() || !base.trim() || !title.trim()} onClick={() => void prepare("pull-request")}>Preview PR</button><button disabled={disabled} onClick={() => void prepare("discard")}>Preview discard</button></div>
    {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
    {preview && <div onKeyDown={(event) => event.stopPropagation()}><ConfirmationDialog preview={preview} busy={busy} error={confirmationError} onCancel={() => { if (!pending.current) { setPreview(null); setConfirmationError(null); } }} onConfirm={confirm} /></div>}
  </section>;
}
