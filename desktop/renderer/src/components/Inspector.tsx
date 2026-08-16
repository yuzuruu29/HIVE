import { ChangeEvent } from "react";
import type { CodingFinalReport } from "../../../../src/coding/types";
import type { DesktopCommand, DesktopEvent, ThreadRunRef } from "../../../../src/desktop/types";
import type { DesktopViewState } from "../state";
import { commitBlockedCopy, phaseTone } from "../utils";
import { EmptyState } from "./EmptyState";
import { HiveView } from "./HiveView";
import { InspectorSection, PanelHeader } from "./inspector-section";
import { StatusPill } from "./StatusPill";
import { ValidationSummary } from "./ValidationSummary";

type DesktopCommandInput = DesktopCommand extends infer Command
  ? Command extends { requestId: string } ? Omit<Command, "requestId"> & { requestId?: string } : never
  : never;

export interface InspectorProps {
  state: DesktopViewState;
  currentRun: ThreadRunRef | null;
  activeRun: ThreadRunRef | null;
  isPausing: boolean;
  sessionId?: string;
  report: CodingFinalReport | null;
  onClearCredential: () => void;
  onProviderChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onOpenProviderDialog: () => void;
  onRunAction: (type: "pause" | "resume" | "cancel") => Promise<void>;
  onPreviewGit: (action: "commit" | "discard" | "push" | "pull-request") => Promise<void>;
  onSendExternal: (command: DesktopCommandInput) => Promise<DesktopEvent>;
}

export function Inspector({
  state,
  currentRun,
  activeRun,
  isPausing,
  sessionId,
  report,
  onClearCredential: _onClearCredential,
  onProviderChange,
  onOpenProviderDialog,
  onRunAction,
  onPreviewGit,
  onSendExternal,
}: InspectorProps) {
  return (
    <aside className="panel right-rail" aria-label="Run inspector">
      <PanelHeader eyebrow="Live telemetry" title="Run inspector" />

      <InspectorSection label="Phase">
        <StatusPill tone={phaseTone(isPausing ? "paused" : currentRun?.status)}>
          {isPausing ? "Pausing…" : currentRun?.status ?? "No active run"}
        </StatusPill>
        <small>
          {currentRun ? `Session ${currentRun.codingSessionId}` : "Start a turn from Conversation."}
        </small>
      </InspectorSection>

      <InspectorSection label="Agents">
        <HiveView events={state.runtimeEvents} report={report} />
      </InspectorSection>

      <InspectorSection label="Provider">
        {state.providers.length ? (
          <>
            <label className="sr-only" htmlFor="provider">Provider</label>
            <select id="provider" value={state.selectedProviderId} onChange={onProviderChange}>
              {state.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} / {provider.defaultModel ?? "default"}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={onOpenProviderDialog}>
              Configure provider
            </button>
          </>
        ) : (
          <EmptyState>No providers configured.</EmptyState>
        )}
      </InspectorSection>

      <InspectorSection label="Validation">
        <ValidationSummary events={state.runtimeEvents} report={report} />
      </InspectorSection>

      <InspectorSection label="Controls">
        <div className="button-grid">
          <button
            disabled={currentRun?.status !== "paused" || isPausing}
            onClick={() => void onRunAction("resume")}
          >
            Resume
          </button>
          <button
            disabled={!activeRun || currentRun?.status === "paused" || state.worker !== "running" || isPausing}
            aria-busy={isPausing || undefined}
            title="Pause after active tool work reaches a safe checkpoint."
            onClick={() => void onRunAction("pause")}
          >
            {isPausing ? "Pausing…" : "Pause"}
          </button>
          <button
            className="danger"
            disabled={!activeRun}
            onClick={() => void onRunAction("cancel")}
          >
            Cancel
          </button>
        </div>
        <p className="technical-note">
          Pause is persisted only at a HIVE safe checkpoint; active tool work is never relabeled as paused.
        </p>
      </InspectorSection>

      <InspectorSection label="Changes and Git">
        {!sessionId ? (
          <EmptyState>Run a turn to review changes.</EmptyState>
        ) : (
          <>
            <div className="button-grid git-actions">
              <button
                disabled={
                  state.diff?.codingSessionId !== sessionId ||
                  state.diff.commitEligibility !== "eligible" ||
                  state.diff.reviewedFiles.length === 0
                }
                onClick={() => void onPreviewGit("commit")}
              >
                Preview commit
              </button>
              <button className="danger" onClick={() => void onPreviewGit("discard")}>
                Preview discard
              </button>
              <button onClick={() => void onPreviewGit("push")}>
                Preview push
              </button>
              <button onClick={() => void onPreviewGit("pull-request")}>
                Preview PR
              </button>
            </div>
            {state.diff?.codingSessionId === sessionId && state.diff.commitEligibility !== "eligible" && (
              <p className="technical-note">{commitBlockedCopy(state.diff.commitEligibility)}</p>
            )}
          </>
        )}
      </InspectorSection>

      <InspectorSection label="External tools">
        <div className="button-grid external-actions">
          <button
            disabled={!state.repositoryRoot}
            onClick={() =>
              state.repositoryRoot &&
              void onSendExternal({
                type: "external.open-editor",
                input: { repositoryRoot: state.repositoryRoot },
              })
            }
          >
            Open in Editor
          </button>
          <button
            disabled={!state.repositoryRoot}
            onClick={() =>
              state.repositoryRoot &&
              void onSendExternal({
                type: "external.open-terminal",
                repositoryRoot: state.repositoryRoot,
              })
            }
          >
            Open Terminal
          </button>
          <button
            disabled={!state.repositoryRoot}
            onClick={() =>
              state.repositoryRoot &&
              void onSendExternal({
                type: "external.open-explorer",
                input: { repositoryRoot: state.repositoryRoot },
              })
            }
          >
            Open Explorer
          </button>
        </div>
      </InspectorSection>

      <div className="report-snapshot">{report ? `Report: ${report.result}` : "No run report yet."}</div>
    </aside>
  );
}
