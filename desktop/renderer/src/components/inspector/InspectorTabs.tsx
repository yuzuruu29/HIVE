import React, { useId, useRef, useState } from "react";
import type { DesktopViewState } from "../../state";
import type { CodingFinalReport } from "../../../../../src/coding/types";
import { ChangesView } from "../ChangesView";
import { FileTree } from "../FileTree";
import { TerminalOutput } from "../TerminalOutput";
import { EvidencePanel } from "./EvidencePanel";
import { CollapseIcon, ExpandIcon } from "../../shell/icons";

export type InspectorTab = "changes" | "files" | "terminal" | "evidence" | "run";

// Each opens a guarded preview; nothing touches Git until the confirmation dialog is accepted.
const GIT_ACTIONS = [
  { action: "commit", label: "commit" },
  { action: "push", label: "push" },
  { action: "pull-request", label: "PR" },
  { action: "discard", label: "discard" },
] as const;

export interface InspectorTabsProps {
  state: DesktopViewState;
  report?: CodingFinalReport | null;
  sessionId?: string;
  defaultTab?: InspectorTab;
  selectedTab?: InspectorTab;
  onSelectFile?: (filePath: string) => Promise<void>;
  onToggleDir?: (dirPath: string) => Promise<void>;
  onPreviewGit?: (action: "commit" | "discard" | "push" | "pull-request") => void;
  onSelectTab?: (tab: InspectorTab) => void;
}

export function InspectorTabs({
  state,
  report,
  sessionId,
  defaultTab = "changes",
  selectedTab,
  onSelectFile,
  onToggleDir,
  onPreviewGit,
  onSelectTab,
}: InspectorTabsProps) {
  const [localTab, setLocalTab] = useState<InspectorTab>(defaultTab);
  const tab = selectedTab ?? localTab;
  const tabId = useId();
  const tabListRef = useRef<HTMLDivElement>(null);
  const selectTab = (next: InspectorTab) => { setLocalTab(next); onSelectTab?.(next); };
  const [expandedReview, setExpandedReview] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { repositoryRoot, diff, workspaceListings, selectedWorkspacePath, gitStatus, activeThreadId, threads } = state;
  const activeThread = threads.find((t) => t.id === activeThreadId);
  const activeRun = activeThread?.runs[activeThread.runs.length - 1];

  const rootListing = workspaceListings[""] ?? null;
  const changedFilesCount = diff?.recordedFiles?.length || 0;
  const sessionLabel = activeRun?.codingSessionId ?? sessionId ?? "—";
  const repositoryLabel = repositoryName(repositoryRoot);

  return (
    <aside className={`hive-inspector ${expandedReview ? "is-expanded" : ""}`} aria-label="Harness Inspector">
      {/* Inspector Tab Bar */}
      <div className="hive-inspector-header" role="tablist" aria-label="Task inspector" ref={tabListRef} onKeyDown={(event) => {
        if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
        const tabs: InspectorTab[] = ["changes", "files", "terminal", "evidence", "run"];
        const index = tabs.indexOf(tab);
        const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
          : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
        if (!next) return;
        event.preventDefault();
        selectTab(next);
        tabListRef.current?.querySelector<HTMLButtonElement>(`[data-inspector-tab="${next}"]`)?.focus();
      }}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "changes"}
          id={`${tabId}-changes`} data-inspector-tab="changes" aria-controls={`${tabId}-panel`} tabIndex={tab === "changes" ? 0 : -1}
          className={`hive-inspector-tab ${tab === "changes" ? "is-active" : ""}`}
          onClick={() => selectTab("changes")}
        >
          Changes {changedFilesCount > 0 && <span className="hive-badge">{changedFilesCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "files"}
          id={`${tabId}-files`} data-inspector-tab="files" aria-controls={`${tabId}-panel`} tabIndex={tab === "files" ? 0 : -1}
          className={`hive-inspector-tab ${tab === "files" ? "is-active" : ""}`}
          onClick={() => selectTab("files")}
        >
          Files
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "terminal"}
          id={`${tabId}-terminal`} data-inspector-tab="terminal" aria-controls={`${tabId}-panel`} tabIndex={tab === "terminal" ? 0 : -1}
          className={`hive-inspector-tab ${tab === "terminal" ? "is-active" : ""}`}
          onClick={() => selectTab("terminal")}
        >
          Terminal
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "evidence"}
          id={`${tabId}-evidence`} data-inspector-tab="evidence" aria-controls={`${tabId}-panel`} tabIndex={tab === "evidence" ? 0 : -1}
          className={`hive-inspector-tab ${tab === "evidence" ? "is-active" : ""}`}
          onClick={() => selectTab("evidence")}
        >
          Evidence
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "run"}
          id={`${tabId}-run`} data-inspector-tab="run" aria-controls={`${tabId}-panel`} tabIndex={tab === "run" ? 0 : -1}
          className={`hive-inspector-tab ${tab === "run" ? "is-active" : ""}`}
          onClick={() => selectTab("run")}
        >
          Run
        </button>
        <button
          type="button"
          className="hive-inspector-expand-btn"
          title={expandedReview ? "Collapse review (standard width)" : "Expand review (wide code diff)"}
          onClick={() => setExpandedReview((prev) => !prev)}
          aria-label={expandedReview ? "Collapse review pane" : "Expand review pane"}
        >
          {expandedReview ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
        </button>
      </div>

      <div className="hive-inspector-content" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
        {/* Tab 1: Changes */}
        {tab === "changes" && (
          <div className="hive-inspector-stack">
            {onPreviewGit && sessionLabel !== "—" && (
              <div className="hive-git-actions" role="group" aria-label="Review actions">
                {GIT_ACTIONS.map(({ action, label }) => (
                  <button
                    key={action}
                    type="button"
                    className={`pane-action-btn${action === "discard" ? " is-danger" : ""}`}
                    aria-label={`Preview ${label}`}
                    onClick={() => onPreviewGit(action)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {diff && diff.patch ? (
              <ChangesView
                patch={diff.patch}
                truncated={diff.truncated}
              />
            ) : (
              <div className="empty-state">
                <strong>No changes yet</strong>
                <span>Files HIVE edits in this task show up here for review.</span>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Files */}
        {tab === "files" && (
          <FileTree
            listing={rootListing}
            listings={workspaceListings}
            expanded={expanded}
            selectedPath={selectedWorkspacePath}
            fileMarks={gitStatus?.fileMarks}
            truncated={rootListing?.truncated}
            onToggleDir={(path) => {
              setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
              if (onToggleDir) void onToggleDir(path);
            }}
            onSelectFile={(path) => {
              if (onSelectFile) void onSelectFile(path);
            }}
          />
        )}

        {/* Tab 3: Terminal */}
        {tab === "terminal" && (
          <TerminalOutput events={state.runtimeEvents} />
        )}

        {/* Tab 4: Evidence */}
        {tab === "evidence" && <EvidencePanel report={report} />}

        {/* Tab 5: Run */}
        {tab === "run" && (
          <div className="hive-evidence-rows">
            <div className="hive-evidence-row">
              <span>Session ID</span>
              <span className="hive-mono">{sessionLabel}</span>
            </div>
            <div className="hive-evidence-row">
              <span>Active Run Status</span>
              <span className={runBadgeClass(activeRun?.status)}>{activeRun?.status ?? "no run"}</span>
            </div>
            <div className="hive-evidence-row">
              <span>Repository</span>
              <span className="hive-mono">{repositoryLabel}</span>
            </div>
            <div className="hive-evidence-row">
              <span>Branch</span>
              <span className="hive-mono">{gitStatus?.branch ?? "—"}</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function repositoryName(root: string | null): string {
  if (!root) return "No repository";
  const name = root.split(/[\\/]/).filter(Boolean).pop();
  return name || root;
}

function runBadgeClass(status?: string): string {
  if (status === "completed") return "hive-badge is-success";
  if (status === "failed" || status === "cancelled") return "hive-badge is-error";
  if (status === "paused") return "hive-badge is-warning";
  if (status) return "hive-badge is-violet";
  return "hive-badge";
}
