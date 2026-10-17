import React, { useState } from "react";
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
}: SplitWorkspaceProps) {
  const [splitPct, setSplitPct] = useState(46);

  return (
    <div className="hive-split-layout" data-testid="split-workspace">
      <div className="hive-split-pane" style={{ width: `${splitPct}%` }}>
        <ChatSurface
          state={state}
          send={send}
          activeModelName={activeModelName}
          modelOptions={modelOptions}
          selectedModel={selectedModel}
          onSelectModel={onSelectModel}
          onOpenModelPicker={onOpenModelPicker}
          onOpenSettings={onOpenSettings}
          onHandoffToCoder={onHandoffToCoder}
        />
      </div>

      <div
        className="hive-split-divider"
        role="separator"
        aria-label="Resize Chat and Code Panes"
      />

      <div className="hive-split-pane" style={{ width: `${100 - splitPct}%` }}>
        <CodexSurface
          state={state}
          send={send}
          activeModelName={activeModelName}
          selectedModel={selectedModel}
          onOpenModelPicker={onOpenModelPicker}
          onOpenSettings={onOpenSettings}
          onOpenRepositoryPicker={onOpenRepositoryPicker}
          onSelectFile={onSelectFile}
          onToggleDir={onToggleDir}
          onPreviewGit={onPreviewGit}
          onLoadThread={onLoadThread}
          hideInspector={true}
        />
      </div>
    </div>
  );
}
