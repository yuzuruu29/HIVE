import { FormEvent, MutableRefObject } from "react";
import type { CodingFinalReport } from "../../../../src/coding/types";
import type { ThreadRecordV1, ThreadRunRef } from "../../../../src/desktop/types";
import type { CenterTab, DesktopViewState } from "../state";
import { titleCase } from "../utils";
import { ChangesView } from "./ChangesView";
import { Conversation } from "./Conversation";
import { EmptyState } from "./EmptyState";
import { EmptyWorkspace } from "./EmptyWorkspace";
import { ReportView } from "./ReportView";

export interface CenterStageProps {
  state: DesktopViewState;
  activeThread?: ThreadRecordV1;
  activeRun: ThreadRunRef | null;
  currentRun: ThreadRunRef | null;
  repositoryActiveRun: ThreadRunRef | null;
  report: CodingFinalReport | null;
  sessionId?: string;
  composer: string;
  setComposer: (value: string) => void;
  saving: boolean;
  retryMessageId: string | null;
  mainRef: MutableRefObject<HTMLElement | null>;
  tabRefs: MutableRefObject<Record<CenterTab, HTMLButtonElement | null>>;
  onArchiveThread: (threadId: string) => Promise<void>;
  onChooseTab: (tab: CenterTab) => Promise<void>;
  onRetryRun: (messageId: string) => Promise<void>;
  onSubmitMessage: (event: FormEvent) => Promise<void>;
}

export function CenterStage({
  state,
  activeThread,
  activeRun,
  currentRun,
  repositoryActiveRun,
  report,
  sessionId,
  composer,
  setComposer,
  saving,
  retryMessageId,
  mainRef,
  tabRefs,
  onArchiveThread,
  onChooseTab,
  onRetryRun,
  onSubmitMessage,
}: CenterStageProps) {
  return (
    <main id="main-workspace" ref={mainRef} className="panel center-stage" tabIndex={-1}>
      {!state.repositoryRoot ? (
        <EmptyWorkspace state={state} />
      ) : !activeThread ? (
        <EmptyState className="center-empty">
          <strong>Choose or create a thread.</strong>
          <span>Each message starts a verified coding session.</span>
        </EmptyState>
      ) : (
        <>
          <header className="thread-header">
            <div>
              <span className="eyebrow">Active thread</span>
              <h1>{activeThread.title}</h1>
              <code>{state.repositoryRoot}</code>
            </div>
            <button
              disabled={Boolean(activeRun)}
              onClick={() => void onArchiveThread(activeThread.id)}
            >
              Archive
            </button>
          </header>
          <div className="tabs" role="tablist" aria-label="Thread views">
            {(["conversation", "changes", "report"] as CenterTab[]).map((tab, _index, tabs) => (
              <button
                key={tab}
                ref={(node) => {
                  tabRefs.current[tab] = node;
                }}
                role="tab"
                tabIndex={state.tab === tab ? 0 : -1}
                aria-selected={state.tab === tab}
                aria-controls={`panel-${tab}`}
                id={`tab-${tab}`}
                onClick={() => void onChooseTab(tab)}
                onKeyDown={(event) => {
                  let target: CenterTab | undefined;
                  const current = tabs.indexOf(tab);
                  if (event.key === "ArrowRight") target = tabs[(current + 1) % tabs.length];
                  else if (event.key === "ArrowLeft") target = tabs[(current - 1 + tabs.length) % tabs.length];
                  else if (event.key === "Home") target = tabs[0];
                  else if (event.key === "End") target = tabs.at(-1);
                  if (target) {
                    event.preventDefault();
                    void onChooseTab(target);
                    queueMicrotask(() => tabRefs.current[target!]?.focus());
                  }
                }}
              >
                {titleCase(tab)}
              </button>
            ))}
          </div>
          <section
            className="tab-panel"
            role="tabpanel"
            id={`panel-${state.tab}`}
            aria-labelledby={`tab-${state.tab}`}
          >
            {state.tab === "conversation" && (
              <Conversation
                thread={activeThread}
                composer={composer}
                setComposer={setComposer}
                saving={saving}
                disabled={Boolean(repositoryActiveRun)}
                paused={currentRun?.status === "paused"}
                retryMessageId={retryMessageId}
                repositoryRoot={state.repositoryRoot}
                currentRun={currentRun}
                runtimeEvents={state.runtimeEvents}
                isPausing={Boolean(currentRun && state.pausingSessionId === currentRun.codingSessionId)}
                onRetry={onRetryRun}
                onSubmit={onSubmitMessage}
              />
            )}
            {state.tab === "changes" && (
              <ChangesView patch={state.diff?.patch} truncated={state.diff?.truncated} />
            )}
            {state.tab === "report" && (
              <ReportView report={report} hasRun={Boolean(sessionId)} />
            )}
          </section>
        </>
      )}
    </main>
  );
}
