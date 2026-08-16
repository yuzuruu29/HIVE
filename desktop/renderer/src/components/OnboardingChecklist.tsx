import type { DesktopViewState } from "../state";
import { usePrefs } from "../prefs";

export interface OnboardingChecklistProps {
  state: DesktopViewState;
  onDismiss?: () => void;
}

export function OnboardingChecklist({ state, onDismiss }: OnboardingChecklistProps) {
  const { prefs, updatePrefs } = usePrefs();

  const isDismissed = prefs.onboardingDismissed?.includes("workspace-onboarding");
  if (isDismissed) return null;

  const hasRepo = Boolean(state.repositoryRoot);
  const hasThread = state.threads.length > 0;
  const hasRun = state.threads.some((thread) => thread.runs.length > 0) || Boolean(state.run);
  const hasDiff = Boolean(state.diff);
  const hasCommit = prefs.onboardingDismissed?.includes("step-commit-confirmed");

  const steps = [
    { id: "repo", label: "Open a repository", done: hasRepo },
    { id: "thread", label: "Create a thread", done: hasThread },
    { id: "task", label: "Send your first task", done: hasRun },
    { id: "diff", label: "Review the diff", done: hasDiff },
    { id: "commit", label: "Confirm a guarded commit", done: Boolean(hasCommit) },
  ];

  const handleDismiss = () => {
    updatePrefs({
      onboardingDismissed: [...(prefs.onboardingDismissed || []), "workspace-onboarding"],
    });
    if (onDismiss) onDismiss();
  };

  return (
    <div className="onboarding-checklist anim-in" aria-label="Getting started checklist">
      <div className="onboarding-header">
        <h3>Getting Started with HIVE</h3>
        <button type="button" onClick={handleDismiss} aria-label="Dismiss checklist">
          Dismiss [x]
        </button>
      </div>

      <ul className="onboarding-steps">
        {steps.map((step) => (
          <li key={step.id} className={`onboarding-step ${step.done ? "step-done" : ""}`}>
            <span className="glyph" aria-hidden="true">
              {step.done ? "[x]" : "[ ]"}
            </span>
            <span>{step.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
