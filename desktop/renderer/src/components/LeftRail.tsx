import { FormEvent } from "react";
import type { DesktopRecentRepository, ThreadRecordV1 } from "../../../../src/desktop/types";
import { formatTime } from "../utils";
import { EmptyState } from "./EmptyState";
import { PanelHeader } from "./inspector-section";
import { ThreadList } from "./ThreadList";

export interface LeftRailProps {
  repositoryPath: string;
  setRepositoryPath: (path: string) => void;
  busy: boolean;
  repositories: DesktopRecentRepository[];
  repositoryRoot: string | null;
  threads: ThreadRecordV1[];
  activeThreadId: string | null;
  newThreadTitle: string;
  setNewThreadTitle: (title: string) => void;
  onOpenRepository: (path: string) => Promise<void>;
  onCreateThread: (event: FormEvent) => Promise<void>;
  onLoadThread: (thread: ThreadRecordV1) => Promise<void>;
}

export function LeftRail({
  repositoryPath,
  setRepositoryPath,
  busy,
  repositories,
  repositoryRoot,
  threads,
  activeThreadId,
  newThreadTitle,
  setNewThreadTitle,
  onOpenRepository,
  onCreateThread,
  onLoadThread,
}: LeftRailProps) {
  const activeThreads = threads.filter((thread) => !thread.archived);
  const archivedThreads = threads.filter((thread) => thread.archived);

  return (
    <nav className="panel left-rail" aria-label="Repositories and threads">
      <PanelHeader eyebrow="Workspace" title="Repositories" />
      <form
        className="stack compact"
        onSubmit={(event) => {
          event.preventDefault();
          void onOpenRepository(repositoryPath);
        }}
      >
        <label htmlFor="repository-path">Repository path</label>
        <div className="input-row">
          <input
            id="repository-path"
            value={repositoryPath}
            onChange={(event) => setRepositoryPath(event.target.value)}
            placeholder="C:\\source\\project"
          />
          <button disabled={!repositoryPath.trim()}>{busy ? "Open another" : "Open"}</button>
        </div>
      </form>

      <section aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="section-label">Recent</h2>
        {repositories.length ? (
          <ul className="plain-list">
            {repositories.map((repository) => (
              <li key={repository.path}>
                <button
                  className="repository-button"
                  aria-current={repositoryRoot === repository.path ? "page" : undefined}
                  onClick={() => void onOpenRepository(repository.path)}
                >
                  <span>{repository.path}</span>
                  <small>{formatTime(repository.lastOpenedAt)}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No recent repositories.</EmptyState>
        )}
      </section>

      {repositoryRoot && (
        <>
          <div className="rail-divider" />
          <section aria-labelledby="threads-heading">
            <div className="section-heading">
              <h2 id="threads-heading" className="section-label">Threads</h2>
              <span>{activeThreads.length}</span>
            </div>
            <form className="input-row" onSubmit={(event) => void onCreateThread(event)}>
              <label className="sr-only" htmlFor="thread-title">New thread title</label>
              <input
                id="thread-title"
                value={newThreadTitle}
                onChange={(event) => setNewThreadTitle(event.target.value)}
                maxLength={200}
              />
              <button aria-label="Create thread">+</button>
            </form>
            {activeThreads.length ? (
              <ThreadList threads={activeThreads} activeId={activeThreadId} onLoad={onLoadThread} />
            ) : (
              <EmptyState>No active threads.</EmptyState>
            )}
            <details className="archived" open>
              <summary>Archived threads ({archivedThreads.length})</summary>
              <ThreadList threads={archivedThreads} activeId={activeThreadId} onLoad={onLoadThread} />
            </details>
          </section>
        </>
      )}
    </nav>
  );
}
