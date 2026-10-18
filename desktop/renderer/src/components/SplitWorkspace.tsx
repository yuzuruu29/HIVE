import React, { useEffect, useId, useRef, useState } from "react";
import type { DesktopViewState } from "../state";
import type { DesktopCommandInput } from "../bridge";
import type { DesktopEvent } from "../../../../src/desktop/types";
import { ChatSurface, type ChatModelOption } from "./chat/ChatSurface";
import { CodexSurface } from "./codex/CodexSurface";

export interface SplitWorkspaceProps {
  state: DesktopViewState;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  activeModelName?: string;
  modelOptions?: ChatModelOption[];
  selectedModel?: { providerId: string; model: string } | null;
  onSelectModel?: (choice: ChatModelOption) => void;
  onOpenModelPicker?: () => void;
  onOpenSettings?: () => void;
  onOpenRepositoryPicker?: () => void;
  onSelectFile?: (filePath: string) => Promise<void>;
  onToggleDir?: (dirPath: string) => Promise<void>;
  onPreviewGit?: (action: "commit" | "discard" | "push" | "pull-request") => void;
  onLoadThread?: (threadId: string) => Promise<void>;
  onHandoffToCoder?: (threadId?: string) => void;
  splitRatio?: number;
  onSplitRatioChange?: (ratio: number) => void;
  onRunAction?: (action: "pause" | "resume" | "cancel") => Promise<void>;
}

export function SplitWorkspace({
  state,
  send,
  activeModelName,
  modelOptions,
  selectedModel,
  onSelectModel,
  onOpenModelPicker,
  onOpenSettings,
  onOpenRepositoryPicker,
  onSelectFile,
  onToggleDir,
  onPreviewGit,
  onLoadThread,
  onHandoffToCoder,
  splitRatio = 0.4,
  onSplitRatioChange,
  onRunAction,
}: SplitWorkspaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  const paneId = useId();
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(() => boundedRatio(splitRatio, 0));
  const ratioRef = useRef(ratio);
  const stacked = width > 0 && width < 900;
  const minimum = minimumRatio(width);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => { const nextWidth = root.getBoundingClientRect().width; if (nextWidth > 0) setWidth(nextWidth); };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(root);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const next = boundedRatio(pointerRef.current === null ? splitRatio : ratioRef.current, width);
    ratioRef.current = next;
    setRatio(next);
  }, [splitRatio, width]);

  function updateRatio(next: number, persist: boolean): void {
    const bounded = boundedRatio(next, width);
    ratioRef.current = bounded;
    setRatio(bounded);
    if (persist) onSplitRatioChange?.(bounded);
  }

  function moveDivider(clientX: number): void {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width < 900) return;
    updateRatio((clientX - bounds.left - 4) / (bounds.width - 8), false);
  }

  return (
    <div className="hive-split-layout" ref={rootRef} data-testid="split-workspace" data-stacked={stacked}>
      <div id={`${paneId}-chat`} className="hive-split-pane" style={stacked ? undefined : { flexGrow: ratio, flexBasis: 0 }}>
        <ChatSurface
          state={state}
          send={send}
          activeModelName={activeModelName}
          modelOptions={modelOptions}
          selectedModel={selectedModel}
          onSelectModel={onSelectModel}
          onOpenModelPicker={onOpenModelPicker}
          onOpenSettings={onOpenSettings}
          onOpenRepositoryPicker={onOpenRepositoryPicker}
          onHandoffToCoder={onHandoffToCoder}
        />
      </div>

      <div
        className="hive-split-divider"
        role="separator"
        aria-label="Resize Chat and Code Panes"
        aria-orientation="vertical"
        aria-controls={`${paneId}-chat ${paneId}-code`}
        aria-valuemin={Math.round(minimum * 100)}
        aria-valuemax={Math.round((1 - minimum) * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={`${Math.round(ratio * 100)}% Chat, ${Math.round((1 - ratio) * 100)}% Code`}
        aria-disabled={stacked}
        tabIndex={stacked ? -1 : 0}
        title="Drag to resize, or use Left and Right arrows"
        onPointerDown={(event) => {
          if (stacked || event.button !== 0) return;
          event.preventDefault();
          pointerRef.current = event.pointerId;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          event.currentTarget.focus();
        }}
        onPointerMove={(event) => {
          if (pointerRef.current !== event.pointerId) return;
          moveDivider(event.clientX);
        }}
        onPointerUp={(event) => {
          if (pointerRef.current !== event.pointerId) return;
          moveDivider(event.clientX);
          pointerRef.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          onSplitRatioChange?.(ratioRef.current);
        }}
        onPointerCancel={() => {
          pointerRef.current = null;
          updateRatio(splitRatio, false);
        }}
        onLostPointerCapture={() => {
          if (pointerRef.current === null) return;
          pointerRef.current = null;
          updateRatio(splitRatio, false);
        }}
        onKeyDown={(event) => {
          if (stacked) return;
          const step = event.shiftKey ? 0.1 : 0.02;
          const next = event.key === "ArrowLeft" ? ratio - step : event.key === "ArrowRight" ? ratio + step
            : event.key === "Home" ? minimum : event.key === "End" ? 1 - minimum : null;
          if (next === null) return;
          event.preventDefault();
          updateRatio(next, true);
        }}
      />

      <div id={`${paneId}-code`} className="hive-split-pane" style={stacked ? undefined : { flexGrow: 1 - ratio, flexBasis: 0 }}>
        <CodexSurface
          state={state}
          send={send}
          activeModelName={activeModelName}
          selectedModel={selectedModel}
          modelOptions={modelOptions}
          onSelectModel={onSelectModel}
          onOpenModelPicker={onOpenModelPicker}
          onOpenSettings={onOpenSettings}
          onOpenRepositoryPicker={onOpenRepositoryPicker}
          onSelectFile={onSelectFile}
          onToggleDir={onToggleDir}
          onPreviewGit={onPreviewGit}
          onLoadThread={onLoadThread}
          hideInspector={true}
          onRunAction={onRunAction}
        />
      </div>
    </div>
  );
}

function minimumRatio(width: number): number {
  return width >= 900 ? Math.max(0.3, 320 / (width - 8)) : 0.3;
}

function boundedRatio(value: number, width: number): number {
  const min = minimumRatio(width);
  return Math.min(1 - min, Math.max(min, Number.isFinite(value) ? value : 0.4));
}
