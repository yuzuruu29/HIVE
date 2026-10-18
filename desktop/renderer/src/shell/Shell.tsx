import React from "react";
import type { DesktopMode } from "../state";
import { Sidebar, type SidebarSession } from "./Sidebar";
import { FolderIcon } from "./icons";

export interface ShellProps {
  mode: DesktopMode;
  onSelectMode: (mode: DesktopMode) => void;
  onCreateTask: () => void;
  onNewCodeTask?: () => void;
  sessions: SidebarSession[];
  onSelectSession: (id: string) => void;
  /** What the main pane is showing, e.g. the open conversation's title. */
  title: string;
  repositoryPath?: string;
  setRepositoryPath?: (path: string) => void;
  onOpenRepository?: (path: string) => Promise<void>;
  onPickRepository?: () => void;
  busy?: boolean;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  worker?: string;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  children: React.ReactNode;
}

/** Sidebar plus one routed workspace, the layout Claude and ChatGPT desktop share. */
export function Shell({
  mode,
  onSelectMode,
  onCreateTask,
  onNewCodeTask,
  sessions,
  onSelectSession,
  title,
  repositoryPath,
  setRepositoryPath,
  onOpenRepository,
  onPickRepository,
  busy,
  onOpenSettings,
  onOpenUsage,
  worker = "idle",
  sidebarCollapsed = false,
  onToggleSidebar,
  children,
}: ShellProps) {
  const workspaceName = repositoryPath?.split(/[\\/]/).filter(Boolean).at(-1);

  return (
    <div className="hive-shell" data-mode={mode}>
      <Sidebar
        mode={mode}
        onSelectMode={onSelectMode}
        onCreateTask={onCreateTask}
        onNewCodeTask={onNewCodeTask}
        sessions={sessions}
        onSelectSession={onSelectSession}
        onOpenUsage={onOpenUsage}
        onOpenSettings={onOpenSettings}
        repositoryPath={repositoryPath}
        setRepositoryPath={setRepositoryPath}
        onOpenRepository={onOpenRepository}
        onPickRepository={onPickRepository}
        busy={busy}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={onToggleSidebar}
      />
      <div className="hive-stage">
        <div className="hive-topbar">
          <h1 className="hive-topbar-title" title={title}>{title}</h1>
          <div className="hive-topbar-right">
            {worker !== "idle" && (
              <span className={`hive-chip is-${worker}`} aria-label={`Worker ${worker}`}>
                <span className="hive-chip-dot" aria-hidden="true" />
                {worker}
              </span>
            )}
            {workspaceName && (
              <button type="button" className="hive-chip is-button" onClick={onPickRepository} title={repositoryPath} disabled={!onPickRepository}>
                <FolderIcon size={14} />
                <span className="hive-workspace-chip-label">{workspaceName}</span>
              </button>
            )}
          </div>
        </div>
        <main className="hive-main" id="main-workspace" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
