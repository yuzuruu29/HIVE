import { useMemo, useRef, useState } from "react";
import { groupUnifiedDiff, parseUnifiedDiff } from "../diff";
import { EmptyState } from "./EmptyState";
import { StatusPill } from "./StatusPill";

export interface ChangesViewProps {
  patch?: string;
  truncated?: boolean;
}

export function ChangesView({ patch, truncated }: ChangesViewProps) {
  const [wrapLines, setWrapLines] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  const lineRefs = useRef<Record<number, HTMLLIElement | null>>({});

  const parsed = useMemo(() => {
    if (patch === undefined || !patch) return null;
    return parseUnifiedDiff(patch, truncated);
  }, [patch, truncated]);

  const fileGroups = useMemo(() => {
    if (!parsed) return [];
    return groupUnifiedDiff(parsed);
  }, [parsed]);

  if (patch === undefined) {
    return (
      <EmptyState>
        <strong>No diff loaded.</strong>
        <span>Select a completed run or refresh changes.</span>
      </EmptyState>
    );
  }
  if (!patch || !parsed) {
    return (
      <EmptyState>
        <strong>No HIVE changes.</strong>
        <span>The selected worktree matches its base.</span>
      </EmptyState>
    );
  }

  const toggleFile = (path: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const scrollToFile = (startLineIndex: number) => {
    lineRefs.current[startLineIndex]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="diff-view" aria-label="Read-only unified diff">
      <header>
        <span>Unified diff / read only</span>
        <div className="diff-view-controls">
          <button
            type="button"
            className="secondary"
            onClick={() => setWrapLines((prev) => !prev)}
            aria-label="Toggle line wrapping"
          >
            Wrap lines: {wrapLines ? "ON" : "OFF"}
          </button>
          {parsed.truncated && <StatusPill tone="warning">Truncated safely</StatusPill>}
        </div>
      </header>

      <div className="diff-container">
        {fileGroups.length > 0 && (
          <nav className="diff-file-rail" aria-label="Modified files">
            <ul className="diff-file-list">
              {fileGroups.map((group) => (
                <li key={group.path}>
                  <button
                    type="button"
                    className="diff-file-button"
                    onClick={() => scrollToFile(group.lineSpan[0])}
                  >
                    <span>{group.path}</span>
                    <div className="diff-file-chips">
                      {group.added > 0 && <span className="chip-added">+{group.added}</span>}
                      {group.removed > 0 && <span className="chip-removed">−{group.removed}</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="diff-content">
          <ol className={`diff-lines ${wrapLines ? "wrap-lines" : ""}`}>
            {parsed.lines.map((line, index) => {
              // Check if this line belongs to a collapsed file group
              const owningGroup = fileGroups.find(
                (g) => index >= g.lineSpan[0] && index <= g.lineSpan[1]
              );
              const isCollapsed = owningGroup && collapsedFiles[owningGroup.path];

              if (isCollapsed && line.kind !== "file") {
                return null;
              }

              if (line.kind === "file") {
                const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.text);
                const filePath = match ? match[2] : line.text.replace(/^diff --git /, "");
                const groupCollapsed = Boolean(collapsedFiles[filePath]);

                return (
                  <li
                    key={`${index}-${line.text}`}
                    ref={(node) => {
                      lineRefs.current[index] = node;
                    }}
                    className="diff-line diff-file"
                  >
                    <span className="diff-number" aria-hidden="true" />
                    <div className="diff-file-header-row">
                      <code>{line.text}</code>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => toggleFile(filePath)}
                        aria-label={`Toggle ${filePath}`}
                      >
                        {groupCollapsed ? "[+]" : "[−]"}
                      </button>
                    </div>
                  </li>
                );
              }

              const text = line.text || " ";
              const metadata = `${line.label}${line.oldLine ? `, old line ${line.oldLine}` : ""}${line.newLine ? `, new line ${line.newLine}` : ""}`;

              return (
                <li
                  key={`${index}-${line.text}`}
                  ref={(node) => {
                    lineRefs.current[index] = node;
                  }}
                  className={`diff-line diff-${line.kind}`}
                  aria-label={`${text} — ${metadata}`}
                >
                  <span className="diff-number" aria-hidden="true">
                    {line.newLine ?? line.oldLine ?? ""}
                  </span>
                  <code>{text}</code>
                  <span className="sr-only"> — {metadata}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
