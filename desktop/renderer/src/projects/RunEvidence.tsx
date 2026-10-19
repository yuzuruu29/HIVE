import { useState } from "react";
import type { DesktopEvent } from "../../../../src/desktop/types";
import type { SharedRun } from "../../../../src/projects/types";
import type { DesktopCommandInput } from "../bridge";
import { Dialog } from "../Dialog";
import { ArrowRightIcon, CheckIcon, CloseIcon, CopyIcon, DiffIcon } from "../shell/icons";
import { activeRunStates } from "./useProjectWorkspace";
import { GuardedRunActions } from "./GuardedRunActions";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Keeps the drive and the folder name of a long path visible. */
function middleTruncate(text: string, max = 48): string {
  if (text.length <= max) return text;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${text.slice(0, max - 1 - tail)}…${text.slice(-tail)}`;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "completed" || status === "passed") return <CheckIcon size={14} />;
  if (["failed", "cancelled", "interrupted"].includes(status)) return <CloseIcon size={14} />;
  return null;
}

export function RunSummary({ run, onChanges, onApprove, busy, showSummary = true }: { run: SharedRun; onChanges(): void; onApprove(approvalId: string, approved: boolean): void; busy: boolean; showSummary?: boolean }) {
  const pending = run.approvals.filter((approval) => approval.status === "pending");
  const roles = [...new Set(run.events.map((event) => event.role))];
  const agentRoles = roles.filter((role) => role !== "HIVE");
  return <section className="project-run" aria-label={`Run ${run.status}`}>
    <div className="project-run-status" role="status">
      <span data-status={run.status}><StatusIcon status={run.status} />{run.status.replace(/_/g, " ")}</span>
      {run.engine === "imported" && <span>Imported history</span>}
      {run.engine === "unavailable" && <span>Engine unavailable</span>}
    </div>
    {showSummary && run.summary && <p>{run.summary}</p>}
    {run.events.length > 0 && <details className="project-activity">
      <summary>Activity · {agentRoles.length ? agentRoles.join(", ") : "HIVE"} · {plural(run.events.length, "event")}</summary>
      {roles.map((role) => <details key={role} className="project-role">
        <summary>{role}</summary>
        <ol>{run.events.filter((event) => event.role === role).map((event) => <li key={event.id}><span>{event.kind.replace(/_/g, " ")}</span> {event.text}</li>)}</ol>
      </details>)}
    </details>}
    {pending.map((approval) => <section key={approval.id} className="project-approval" aria-label="Tool approval">
      <h3>Approval required · {approval.tool}</h3>
      <p>{approval.description}</p>
      <dl><dt>Workspace</dt><dd>{approval.workspace}</dd><dt>Effective policy</dt><dd>{run.effectivePolicy}</dd><dt>Scope</dt><dd>This action only{approval.external ? " · external access" : ""}</dd><dt>Expires</dt><dd>{new Date(approval.expiresAt).toLocaleString()}</dd></dl>
      <details><summary>Action arguments</summary><pre>{JSON.stringify(approval.input, null, 2)}</pre></details>
      <div className="project-actions"><button disabled={busy} onClick={() => onApprove(approval.id, false)}>Decline</button><button disabled={busy} onClick={() => onApprove(approval.id, true)}>Approve this action</button></div>
    </section>)}
    {(run.patches.length > 0 || run.checks.length > 0 || run.reviewedAt) && <button className="project-evidence-link" onClick={onChanges}>
      <DiffIcon />
      <span>{plural(run.patches.length, "file")} changed{run.patches.length > 0 && <> <span className="is-add">+{run.patches.reduce((sum, patch) => sum + patch.additions, 0)}</span> <span className="is-remove">−{run.patches.reduce((sum, patch) => sum + patch.deletions, 0)}</span></>}</span>
      {run.checks.length > 0 && <span>{run.checks.filter((check) => check.status === "passed").length} of {plural(run.checks.length, "check")} passed</span>}
      <span className="project-evidence-action">{run.reviewedAt ? <><CheckIcon size={14} />Reviewed</> : <>Review changes<ArrowRightIcon size={14} /></>}</span>
    </button>}
  </section>;
}

export function ChangesDialog({ run, onClose, onReview, busy, repositoryRoot, sessionTitle = "HIVE changes", request }: { run?: SharedRun; onClose(): void; onReview(): void; busy: boolean; repositoryRoot?: string; sessionTitle?: string; request?(command: DesktopCommandInput): Promise<DesktopEvent> }) {
  const [gitBusy, setGitBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  function close() { if (!gitBusy) onClose(); }
  function copyWorkspace(path: string) { void navigator.clipboard?.writeText(path).then(() => setCopied(true), () => undefined); }
  return <Dialog title="Changes and checks" className="project-changes-dialog" onClose={close}>
    <div className="project-panel-header"><p>Recorded evidence from this attempt.</p><button className="project-icon" aria-label="Close changes" disabled={gitBusy} onClick={close}><CloseIcon /></button></div>
    {!run && <p>No run has been recorded in this session.</p>}
    {run && <>
      <p className="project-evidence-meta">{run.status.replace(/_/g, " ")} · {run.engine === "imported" ? "Imported history" : run.engine === "live" ? "Live engine" : "Engine unavailable"}</p>
      <p className="project-evidence-meta project-workspace-line">Workspace <code title={run.workspace}>{middleTruncate(run.workspace)}</code><button type="button" className="project-icon" aria-label={copied ? "Workspace path copied" : "Copy workspace path"} onClick={() => copyWorkspace(run.workspace)}>{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}</button></p>
      <h3>Changes · {plural(run.patches.length, "file")}</h3>
      {!run.patches.length && <p>No patches recorded for this attempt.</p>}
      {run.patches.map((patch, index) => <details className="project-patch" key={`${patch.path}-${index}`}>
        <summary><span>{patch.previousPath ? `${patch.previousPath} → ` : ""}{patch.path}</span><span>{patch.state} · +{patch.additions} −{patch.deletions}{patch.stale ? " · stale" : ""}</span></summary>
        {(patch.workspace !== run.workspace || patch.baseRevision) && <p>{[patch.workspace !== run.workspace ? `Workspace: ${patch.workspace}` : "", patch.baseRevision ? `Base: ${patch.baseRevision}` : ""].filter(Boolean).join(" · ")}</p>}
        {patch.binary ? <p>Binary file · textual diff unavailable.</p> : patch.diff ? <pre>{patch.diff.split("\n").map((line, lineIndex) => <span key={lineIndex} className={line.startsWith("+") ? "is-add" : line.startsWith("-") ? "is-remove" : ""}>{line}{"\n"}</span>)}</pre> : <p>No textual diff recorded.</p>}
        {patch.truncated && <p>Recorded output is truncated.</p>}
      </details>)}
      <h3>Checks{run.checks.length ? ` · ${run.checks.filter((check) => check.status === "passed").length} of ${run.checks.length} passed` : ""}</h3>
      {!run.checks.length && <p>No checks were recorded. No pass is implied.</p>}
      {run.checks.map((check) => <details className="project-check" key={check.id}>
        <summary><span className="project-check-status" data-status={check.status}><StatusIcon status={check.status} />{check.status.replace(/_/g, " ")}</span>{check.name}{check.exitCode === null ? "" : ` · exit ${check.exitCode}`}</summary>
        <p>Command: <code>{check.command}</code></p>{check.workspace !== run.workspace && <p>Workspace: <code>{check.workspace}</code></p>}
        {check.startedAt && <p>Started: {new Date(check.startedAt).toLocaleString()}</p>}{check.endedAt && <p>Finished: {new Date(check.endedAt).toLocaleString()}</p>}
        {check.output && <pre>{check.output}</pre>}
      </details>)}
      {repositoryRoot && request && <details className="project-git-disclosure"><summary>Git actions</summary><GuardedRunActions run={run} repositoryRoot={repositoryRoot} sessionTitle={sessionTitle} request={request} onBusy={setGitBusy} /></details>}
      <footer className="project-review">
        <p>Review records your inspection of this result. It grants no tool permission and does not commit or publish changes.</p>
        {run.reviewedAt ? <p className="project-reviewed"><CheckIcon /> Reviewed {new Date(run.reviewedAt).toLocaleString()}</p> : <button disabled={busy || gitBusy || activeRunStates.has(run.status) || run.status !== "completed"} onClick={onReview}>Mark reviewed</button>}
      </footer>
    </>}
  </Dialog>;
}
