import type { GuardedGitActionPreview } from "../../../../src/desktop/types";
import { Dialog } from "../Dialog";
import { formatTime } from "../utils";

export interface ConfirmationDialogProps {
  preview: GuardedGitActionPreview;
  onCancel: () => void;
  onConfirm: (preview: GuardedGitActionPreview) => Promise<void>;
  busy?: boolean;
  error?: string | null;
}

export function ConfirmationDialog({ preview, onCancel, onConfirm, busy = false, error = null }: ConfirmationDialogProps) {
  const action = preview.proposal.action === "pull-request" ? "PR" : preview.proposal.action;
  return (
    <Dialog title={`Confirm ${action}`} onClose={() => { if (!busy) onCancel(); }}>
      <span className="eyebrow">Guarded Git action</span>
      <p>{preview.summary}</p>
      <dl>
        <dt>Repository</dt><dd><code>{preview.proposal.repositoryRoot}</code></dd>
        <dt>Coding session</dt><dd><code>{preview.proposal.codingSessionId}</code></dd>
        {preview.proposal.action === "commit" && <><dt>Exact files</dt><dd>{preview.proposal.paths.map((path) => <div key={path}><code>{path}</code></div>)}</dd><dt>Commit message</dt><dd>{preview.proposal.message}</dd></>}
        {(preview.proposal.action === "push" || preview.proposal.action === "pull-request") && <><dt>Remote</dt><dd>{preview.proposal.remote}</dd></>}
        {preview.proposal.action === "pull-request" && <><dt>Base branch</dt><dd>{preview.proposal.base}</dd><dt>PR title</dt><dd>{preview.proposal.title}{preview.proposal.draft ? " · Draft" : ""}</dd></>}
        <dt>Observed HEAD</dt>
        <dd><code>{preview.observedHead ?? "unborn"}</code></dd>
        <dt>Token</dt>
        <dd>One-use / expires {formatTime(preview.expiresAt)}</dd>
      </dl>
      <p className="technical-note">HIVE will reject this confirmation if the repository or proposal changed.</p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Waiting for the Git action acknowledgment…</p>}
      <div className="dialog-actions">
        <button className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button
          className={preview.proposal.action === "discard" ? "danger" : ""}
          disabled={busy || !!error}
          onClick={() => void onConfirm(preview)}
        >
          Confirm {action}
        </button>
      </div>
    </Dialog>
  );
}
