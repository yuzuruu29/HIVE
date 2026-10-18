import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import type { DesktopViewState } from "../../state";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopEvent, ThreadMessage } from "../../../../../src/desktop/types";
import { identifier, preferredScrollBehavior, terminalStatuses } from "../../utils";
import { renderMarkdown } from "../../markdown";
import { InspectorTabs, type InspectorTab } from "../inspector/InspectorTabs";
import { ConfiguredModelPicker, type ConfiguredModelOption } from "../ConfiguredModelPicker";
import { AgentActivity } from "./AgentActivity";
import { ArrowUpIcon, CodeIcon, FolderIcon, HiveMark, StopIcon } from "../../shell/icons";

export interface CodexSurfaceProps {
  state: DesktopViewState;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  activeModelName?: string;
  /** The model shown in the composer; new runs use it. */
  selectedModel?: { providerId: string; model: string } | null;
  modelOptions?: ConfiguredModelOption[];
  onSelectModel?: (choice: ConfiguredModelOption) => void;
  onOpenModelPicker?: () => void;
  onOpenSettings?: () => void;
  onOpenRepositoryPicker?: () => void;
  onSelectFile?: (filePath: string) => Promise<void>;
  onToggleDir?: (dirPath: string) => Promise<void>;
  onPreviewGit?: (action: "commit" | "discard" | "push" | "pull-request") => void;
  onLoadThread?: (threadId: string) => Promise<void>;
  onRunAction?: (action: "pause" | "resume" | "cancel") => Promise<void>;
  hideInspector?: boolean;
  defaultInspectorTab?: "changes" | "files" | "terminal" | "evidence" | "run";
  inspectorTab?: InspectorTab;
  onSelectInspectorTab?: (tab: InspectorTab) => void;
}

export type CodexComposerMode = "agent" | "plan";
export type CodexApprovalPosture = "ask" | "auto" | "autonomous";

const POSTURES: { key: CodexApprovalPosture; label: string; title: string }[] = [
  { key: "ask", label: "Guarded", title: "Guarded: confirm each file modification" },
  { key: "auto", label: "Standard", title: "Standard: auto-apply safe changes" },
  { key: "autonomous", label: "Autonomous", title: "Autonomous: run unattended inside the worktree" },
];

const TITLE_MAX = 72;

export function CodexSurface({
  state,
  send,
  activeModelName = "No model",
  selectedModel = null,
  modelOptions = [],
  onSelectModel,
  onOpenModelPicker,
  onOpenSettings,
  onOpenRepositoryPicker,
  onSelectFile,
  onToggleDir,
  onPreviewGit,
  onRunAction,
  hideInspector = false,
  defaultInspectorTab = "changes",
  inspectorTab,
  onSelectInspectorTab,
}: CodexSurfaceProps) {
  const { repositoryRoot, threads, activeThreadId, reports, runtimeEvents, run, selectedSessionId } = state;

  const [composerMode, setComposerMode] = useState<CodexComposerMode>("agent");
  const [posture, setPosture] = useState<CodexApprovalPosture>("auto");
  const [inputTask, setInputTask] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const latestRun = activeThread?.runs[activeThread.runs.length - 1];
  const runStatus = run?.status ?? latestRun?.status ?? null;
  const running = Boolean(runStatus && !terminalStatuses.has(runStatus));
  const codingSessionId = selectedSessionId ?? run?.codingSessionId ?? latestRun?.codingSessionId ?? null;
  const activeReport = codingSessionId ? reports[codingSessionId] ?? null : null;
  const hasMessages = Boolean(activeThread && activeThread.messages.length > 0);

  useEffect(() => {
    try {
      if (transcriptEndRef.current && typeof transcriptEndRef.current.scrollIntoView === "function") {
        transcriptEndRef.current.scrollIntoView({ behavior: preferredScrollBehavior() });
      }
    } catch {
      // Ignore jsdom absence
    }
  }, [activeThread?.messages?.length]);

  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [inputTask]);

  const handleSendTask = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const task = inputTask.trim();
    if (!task || !repositoryRoot || submitting || running) return;
    setError(null);
    setSubmitting(true);
    try {
      // A task typed with no thread open starts a new one, titled from its first line.
      let threadId = activeThreadId;
      if (!threadId) {
        const firstLine = task.split("\n")[0];
        const title = firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
        const created = await send({ type: "thread.create", input: { title } });
        if (created.type !== "thread.changed") {
          setError(created.type === "request.failed" ? created.message : "Could not start a task. Try again.");
          return;
        }
        threadId = created.thread.id;
      }
      const message: ThreadMessage = { id: identifier("message"), role: "user", content: task, createdAt: new Date().toISOString() };
      const appended = await send({ type: "thread.message.append", input: { threadId, message } });
      if (appended.type === "request.failed") {
        setError(appended.message);
        return;
      }
      setInputTask("");
      const started = await send({
        type: "run.start",
        input: {
          threadId,
          repositoryRoot,
          currentUserMessageId: message.id,
          options: {
            mode: composerMode === "plan" ? "plan" : "auto",
            approvalPolicy: posture === "ask" ? "always" : posture === "autonomous" ? "safe" : "changes",
            ...(selectedModel ? { providerId: selectedModel.providerId, model: selectedModel.model } : {}),
          },
        },
      });
      if (started.type === "request.failed") setError(started.message);
    } finally {
      setSubmitting(false);
    }
  };

  const composer = (
    <form className="hive-composer-wrap" onSubmit={(event) => void handleSendTask(event)}>
      <div className="hive-composer">
        <textarea
          ref={inputRef}
          rows={1}
          aria-label="Message HIVE"
          maxLength={20000}
          className="hive-composer-input"
          placeholder={repositoryRoot ? "Ask HIVE to build, fix or refactor..." : "Open a folder, then ask HIVE to build something"}
          value={inputTask}
          onChange={(e) => setInputTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void handleSendTask();
            }
          }}
        />
        <div className="hive-composer-bar">
          <div className="hive-composer-left">
            <div className="hive-segment" role="group" aria-label="Run mode">
              <button type="button" className={composerMode === "agent" ? "is-active" : ""} aria-pressed={composerMode === "agent"} onClick={() => setComposerMode("agent")} title="Plan, build, validate and review">
                Agent
              </button>
              <button type="button" className={composerMode === "plan" ? "is-active" : ""} aria-pressed={composerMode === "plan"} onClick={() => setComposerMode("plan")} title="Plan only, no file changes">
                Plan
              </button>
            </div>
            <ConfiguredModelPicker options={modelOptions} selectedModel={selectedModel} onSelectModel={onSelectModel}
              onOpenModelPicker={onOpenModelPicker} onOpenSettings={onOpenSettings} label={`Model: ${activeModelName}`}
              placeholder={activeModelName} resetKey={repositoryRoot ?? ""} />
          </div>
          {running && onRunAction ? (
            <button type="button" className="hive-send-btn is-stop" aria-label="Stop run" onClick={() => void onRunAction("cancel")}>
              <StopIcon size={14} />
            </button>
          ) : (
            <button type="submit" className="hive-send-btn" disabled={!inputTask.trim() || !repositoryRoot || submitting || running} aria-label="Send task">
              <ArrowUpIcon size={16} />
            </button>
          )}
        </div>
      </div>
      {error && <p className="composer-send-error" role="alert">{error}</p>}
    </form>
  );

  return (
    <div className="hive-code-layout" aria-label="Hive Code Surface">
      <section className="hive-code-center">
        <div className="hive-code-head">
          <div className="hive-segment" role="group" aria-label="Safety Posture">
            {POSTURES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={posture === item.key ? "is-active" : ""}
                aria-pressed={posture === item.key}
                onClick={() => setPosture(item.key)}
                title={item.title}
              >
                {item.label}
              </button>
            ))}
          </div>
          {running && onRunAction && (
            <button type="button" className="hive-pill-btn" onClick={() => void onRunAction("pause")}>Pause</button>
          )}
          {runStatus === "paused" && onRunAction && (
            <button type="button" className="hive-pill-btn" onClick={() => void onRunAction("resume")}>Resume</button>
          )}
        </div>

        <div className="hive-code-scroll">
          <div className="hive-code-column">
            {!hasMessages && (
              <div className="hive-code-hero">
                <span className="chat-hero-mark"><CodeIcon size={26} /></span>
                <h2 className="chat-hero-title">{repositoryRoot ? "What should HIVE build?" : "Open a project to start"}</h2>
                <p className="chat-hero-sub">
                  {repositoryRoot
                    ? "Describe the change. HIVE plans it, edits in an isolated worktree, runs your checks and records evidence before anything is committed."
                    : "Hive Code works inside a Git repository. Pick a folder and HIVE will index it for this session."}
                </p>
                {!repositoryRoot && onOpenRepositoryPicker && (
                  <button type="button" className="hive-primary-btn" onClick={onOpenRepositoryPicker}>
                    <FolderIcon size={16} />
                    Open folder
                  </button>
                )}
              </div>
            )}

            <AgentActivity events={runtimeEvents} runStatus={runStatus} sessionId={selectedSessionId} />

            {hasMessages && (
              <div className="messages-flow">
                {activeThread!.messages.map((m) => (
                  <div key={m.id} className={`hive-message-row chat-message-row role-${m.role}`}>
                    {m.role === "user" ? (
                      <div className="user-message-bubble">
                        <div className="message-content">{m.content}</div>
                      </div>
                    ) : (
                      <div className="assistant-message">
                        <span className="assistant-avatar" aria-hidden="true"><HiveMark size={16} /></span>
                        <div className="assistant-content">{renderMarkdown(m.content)}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        <div className="hive-chat-dock">{composer}</div>
      </section>

      {!hideInspector && (
        <InspectorTabs
          state={state}
          report={activeReport}
          sessionId={codingSessionId ?? undefined}
          defaultTab={defaultInspectorTab}
          selectedTab={inspectorTab}
          onSelectTab={onSelectInspectorTab}
          onSelectFile={onSelectFile}
          onToggleDir={onToggleDir}
          onPreviewGit={onPreviewGit}
        />
      )}
    </div>
  );
}
