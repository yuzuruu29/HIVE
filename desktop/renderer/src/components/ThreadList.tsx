import type { ThreadRecordV1 } from "../../../../src/desktop/types";
import { latestRun } from "../state";
import { EmptyState } from "./EmptyState";

export interface ThreadListProps {
  threads: ThreadRecordV1[];
  activeId: string | null;
  onLoad: (thread: ThreadRecordV1) => Promise<void>;
}

export function ThreadList({ threads, activeId, onLoad }: ThreadListProps) {
  if (!threads.length) return <EmptyState>None.</EmptyState>;

  return (
    <ul className="plain-list thread-list">
      {threads.map((thread) => {
        const run = latestRun(thread);
        const isRunning = run && !["completed", "failed", "cancelled"].includes(run.status);
        const isCompleted = run?.status === "completed";
        const isFailed = run?.status === "failed" || run?.status === "cancelled";

        return (
          <li key={thread.id}>
            <button
              aria-current={thread.id === activeId ? "page" : undefined}
              onClick={() => void onLoad(thread)}
            >
              <div className="thread-row">
                <div className="thread-row-info">
                  <span>{thread.title}</span>
                  <small>{thread.messages.length} messages / {thread.runs.length} runs</small>
                </div>
                {run && (
                  <span
                    className={`thread-badge ${
                      isRunning ? "badge-running anim-running" : isCompleted ? "badge-completed" : isFailed ? "badge-failed" : ""
                    }`}
                  >
                    {isRunning ? "[~]" : isCompleted ? "[ok]" : isFailed ? "[!!]" : ""}
                  </span>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
