import type { GuardedGitActionPreview } from "../../../../src/desktop/types";
import { Dialog } from "../Dialog";
import { formatTime } from "../utils";

export interface ConfirmationDialogProps {
  preview: GuardedGitActionPreview;
  onCancel: () => void;
  onConfirm: (preview: GuardedGitActionPreview) => Promise<void>;
}

export function ConfirmationDialog({ preview, onCancel, onConfirm }: ConfirmationDialogProps) {
  const action = preview.proposal.action === "pull-request" ? "PR" : preview.proposal.action;
  return (
    <Dialog title={`Confirm ${action}`} onClose={onCancel}>
      <span className="eyebrow">Guarded Git action</span>
      <p>{preview.summary}</p>
      <dl>
        <dt>Observed HEAD</dt>
        <dd><code>{preview.observedHead ?? "unborn"}</code></dd>
        <dt>Token</dt>
        <dd>One-use / expires {formatTime(preview.expiresAt)}</dd>
      </dl>
      <p className="technical-note">HIVE will reject this confirmation if the repository or proposal changed.</p>
      <div className="dialog-actions">
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button
          className={preview.proposal.action === "discard" ? "danger" : ""}
          onClick={() => void onConfirm(preview)}
        >
          Confirm {action}
        </button>
      </div>
    </Dialog>
  );
}
