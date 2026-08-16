import type { ChatReceipt } from "../../../../../src/chat/types";
import { renderMarkdown } from "../../markdown";
import type { CouncilRunView } from "../../state";

export interface CouncilTranscriptProps {
  run: CouncilRunView;
  repositoryRoot: string | null;
  onOpenArtifacts: (relativeDir: string) => void;
}

function receiptText(receipt: ChatReceipt): string {
  const tokens = receipt.totalTokens ?? (receipt.promptTokens ?? 0) + (receipt.completionTokens ?? 0);
  return `${receipt.providerId}/${receipt.model} - ${tokens.toLocaleString()} tok`;
}

function statusTone(status: string | undefined): string {
  if (!status) return "running";
  if (status === "COMPLETE") return "success";
  if (status === "FAILED") return "error";
  return "warning";
}

function relativeArtifactDir(repositoryRoot: string | null, artifactDir: string): string | null {
  if (!repositoryRoot) return null;
  const root = repositoryRoot.replaceAll("/", "\\").toLowerCase().replace(/\\$/, "");
  const dir = artifactDir.replaceAll("/", "\\");
  if (!dir.toLowerCase().startsWith(`${root}\\`)) return null;
  return dir.slice(root.length + 1).replaceAll("\\", "/");
}

/** Progressive council (hivebot) run block rendered inside a conversation. */
export function CouncilTranscript({ run, repositoryRoot, onOpenArtifacts }: CouncilTranscriptProps) {
  const tone = statusTone(run.summary?.status);
  const artifactDir = run.summary ? relativeArtifactDir(repositoryRoot, run.summary.artifactDir) : null;

  return (
    <div className={`council-block anim-in tone-${tone}`} aria-label={`Council run ${run.runId}`}>
      <div className="council-head">
        <span className="council-title">[/council {run.preset}]</span>
        {run.summary ? (
          <span className={`council-status status-${tone}`}>
            {run.summary.status} - {run.summary.reason}
          </span>
        ) : run.failed ? (
          <span className="council-status status-error">{run.failed}</span>
        ) : (
          <span className="council-status status-running anim-running">running...</span>
        )}
      </div>

      <ol className="council-stages">
        {run.stages.map((stage, index) => (
          <li key={`${stage.agent}-${stage.attempt}-${index}`} className={`council-stage ${stage.type === "stage-started" ? "stage-active" : ""}`}>
            <div className="council-strip">
              ---- {stage.agent.toUpperCase()} - attempt {stage.attempt} {stage.type === "stage-started" ? "[~]" : stage.receipt ? "[ok]" : ""}
            </div>
            {stage.type === "stage-completed" && (
              <>
                {stage.output ? <div className="council-stage-body">{renderMarkdown(stage.output)}</div> : null}
                {stage.receipt ? <span className="receipt-chip">{receiptText(stage.receipt)}</span> : null}
              </>
            )}
          </li>
        ))}
      </ol>

      {run.summary && (
        <div className="council-summary">
          <span>
            {run.summary.stageCount} stages - {run.summary.totalTokens.toLocaleString()} tokens - preset {run.summary.preset}
          </span>
          {artifactDir && (
            <button type="button" className="link-btn" onClick={() => onOpenArtifacts(artifactDir)}>
              open artifacts folder
            </button>
          )}
        </div>
      )}
    </div>
  );
}
