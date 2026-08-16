import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { initialDesktopState, reduceDesktopEvent } from "../state";
import { OnboardingChecklist } from "./OnboardingChecklist";

describe("OnboardingChecklist component", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reflects state transitions across checklist steps", () => {
    let state = initialDesktopState();
    const { rerender } = render(<OnboardingChecklist state={state} />);

    expect(screen.getByText("Open a repository")).toBeInTheDocument();
    // Initially all 5 steps are [ ]
    expect(screen.getAllByText("[ ]").length).toBe(5);

    // Open repo
    state = reduceDesktopEvent(state, {
      type: "desktop.ready",
      timestamp: new Date().toISOString(),
      repositoryRoot: "C:\\source\\my-project",
    });
    rerender(<OnboardingChecklist state={state} />);

    // Step 1 done -> 1 [x] and 4 [ ]
    expect(screen.getAllByText("[x]").length).toBe(1);
    expect(screen.getAllByText("[ ]").length).toBe(4);
  });

  it("dismisses checklist and writes preference to localStorage", async () => {
    const state = initialDesktopState();
    const user = userEvent.setup();

    const { container } = render(<OnboardingChecklist state={state} />);
    const dismissBtn = screen.getByRole("button", { name: /dismiss checklist/i });
    await user.click(dismissBtn);

    expect(container).toBeEmptyDOMElement();
    const stored = JSON.parse(localStorage.getItem("hive.desktop.ui.v1") || "{}");
    expect(stored.onboardingDismissed).toContain("workspace-onboarding");
  });
});
