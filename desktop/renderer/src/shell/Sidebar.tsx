import React, { useEffect, useState } from "react";
import type { DesktopMode } from "../state";
import { ChatIcon, CodeIcon, ColumnsIcon, FolderIcon, GearIcon, HiveMark, PenIcon, PulseIcon, SearchIcon, SidebarIcon } from "./icons";

export interface SidebarSession {
  id: string;
  title: string;
  kind: "chat" | "coder";
  active: boolean;
  status?: string;
}

export interface SidebarProps {
  mode: DesktopMode;
  onSelectMode: (mode: DesktopMode) => void;
  onCreateTask: () => void;
  onNewCodeTask?: () => void;
  sessions: SidebarSession[];
  onSelectSession: (id: string) => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
  repositoryPath?: string;
  setRepositoryPath?: (path: string) => void;
  onOpenRepository?: (path: string) => Promise<void>;
  onPickRepository?: () => void;
  busy?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

const SURFACES: { key: DesktopMode; label: string; icon: React.ReactNode }[] = [
  { key: "chat", label: "Chat", icon: <ChatIcon /> },
  { key: "coder", label: "Code", icon: <CodeIcon /> },
  { key: "split", label: "Side by side", icon: <ColumnsIcon /> },
];

export function Sidebar({
  mode,
  onSelectMode,
  onCreateTask,
  onNewCodeTask,
  sessions,
  onSelectSession,
  onOpenUsage,
  onOpenSettings,
  repositoryPath = "",
  onOpenRepository,
  onPickRepository,
  busy = false,
  collapsed = false,
  onToggleCollapsed,
}: SidebarProps) {
  const [path, setPath] = useState(repositoryPath);
  const [query, setQuery] = useState("");
  useEffect(() => setPath(repositoryPath), [repositoryPath]);

  const codeMode = mode === "coder";
  const needle = query.trim().toLowerCase();
  const visible = needle ? sessions.filter((session) => session.title.toLowerCase().includes(needle)) : sessions;
  const workspaceName = repositoryPath.split(/[\\/]/).filter(Boolean).at(-1);
  const primary = codeMode && onNewCodeTask
    ? { label: "New task", hint: "Start a Hive Code task", run: onNewCodeTask }
    : { label: "New chat", hint: "New chat (Ctrl+N)", run: onCreateTask };

  return (
    <aside className="hive-sidebar" data-collapsed={collapsed || undefined}>
      <header className="hive-sidebar-head" role="banner">
        <span className="hive-brand">
          <span className="hive-brand-mark"><HiveMark size={20} /></span>
          <span className="hive-brand-word">HIVE</span>
        </span>
        {onToggleCollapsed && (
          <button type="button" className="hive-icon-btn" onClick={onToggleCollapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            <SidebarIcon />
          </button>
        )}
      </header>

      <nav className="hive-sidebar-nav" aria-label="Global Navigation">
        <button type="button" className="hive-new-chat" aria-label={primary.label} onClick={primary.run} title={primary.hint}>
          <PenIcon />
          <span className="hive-label">{primary.label}</span>
          {!codeMode && <kbd className="hive-label">Ctrl N</kbd>}
        </button>

        <label className="hive-search hive-label">
          <SearchIcon size={15} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={codeMode ? "Search tasks" : "Search chats"}
            aria-label={codeMode ? "Search tasks" : "Search chats"}
          />
        </label>

        <div className="hive-nav-group">
          {SURFACES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`hive-nav-item${mode === item.key ? " is-active" : ""}`}
              onClick={() => onSelectMode(item.key)}
              aria-pressed={mode === item.key}
              aria-label={item.label} title={item.label}
            >
              {item.icon}
              <span className="hive-label">{item.label}</span>
            </button>
          ))}
          <button
            type="button"
            className={`hive-nav-item${mode === "usage" ? " is-active" : ""}`}
            onClick={onOpenUsage}
            aria-pressed={mode === "usage"}
            aria-label="Usage" title="Usage"
          >
            <PulseIcon />
            <span className="hive-label">Usage</span>
          </button>
        </div>

        <section className="hive-recents hive-label" aria-label={codeMode ? "Code tasks" : "Recent chats"}>
          <h2 className="hive-section-label">{codeMode ? "Code tasks" : "Recents"}</h2>
          {visible.length === 0 ? (
            <p className="hive-recents-empty">
              {needle ? codeMode ? "No matching tasks" : "No matching chats" : codeMode ? "No active work" : "No chats yet"}
            </p>
          ) : (
            <ul className="hive-session-list">
              {visible.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`hive-session-row${session.active ? " is-active" : ""}`}
                    onClick={() => onSelectSession(session.id)}
                    title={session.title}
                    aria-current={session.active ? "page" : undefined}
                  >
                    <span className="hive-session-title">{session.title}</span>
                    {session.status ? (
                      <span className={`hive-session-status is-${session.status.toLowerCase()}`}>
                        <span className="sr-only">{session.status}</span>
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </nav>

      <footer className="hive-sidebar-foot">
        {onOpenRepository && (
          <form
            className="hive-workspace hive-label"
            onSubmit={(event) => {
              event.preventDefault();
              if (path.trim()) void onOpenRepository(path.trim());
            }}
          >
            <div className="hive-workspace-head">
              <span className="hive-workspace-icon"><FolderIcon size={15} /></span>
              <span className="hive-workspace-name">{workspaceName ?? "No workspace"}</span>
              {onPickRepository && (
                <button type="button" className="hive-link-btn" onClick={onPickRepository} disabled={busy}>
                  Browse
                </button>
              )}
            </div>
            <div className="hive-workspace-row">
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="C:\source\project"
                aria-label="Repository path"
                spellCheck={false}
              />
              <button type="submit" disabled={!path.trim()}>
                {busy || repositoryPath ? "Open another" : "Open"}
              </button>
            </div>
          </form>
        )}
        <button type="button" className="hive-nav-item" onClick={onOpenSettings} aria-label="Settings" title="Settings">
          <GearIcon />
          <span className="hive-label">Settings</span>
        </button>
      </footer>
    </aside>
  );
}
