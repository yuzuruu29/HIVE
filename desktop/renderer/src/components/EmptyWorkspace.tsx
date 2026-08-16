import type { DesktopViewState } from "../state";
import { EmptyState } from "./EmptyState";
import { OnboardingChecklist } from "./OnboardingChecklist";

export interface EmptyWorkspaceProps {
  state: DesktopViewState;
}

export function EmptyWorkspace({ state }: EmptyWorkspaceProps) {
  return (
    <div className="center-empty">
      <OnboardingChecklist state={state} />
      <EmptyState className="center-empty">
        <pre aria-hidden="true">
          {"  ___   ___\n /   \\ /   \\\n \\___/ \\___/\n   \\___/"}
        </pre>
        <strong>Open a repository to begin.</strong>
        <span>HIVE keeps threads and isolated worktrees with the project.</span>
        <span className="shortcut-hint">Tip: Press Ctrl+K for command palette</span>
      </EmptyState>
    </div>
  );
}
