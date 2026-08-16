import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CouncilRunView } from "../../state";
import { CouncilTranscript } from "./CouncilTranscript";

const runningRun: CouncilRunView = {
  runId: "hivebot-1789200000000-ab12",
  preset: "quick",
  stages: [
    { type: "stage-started", agent: "Queen", attempt: 1 },
    { type: "stage-completed", agent: "Queen", attempt: 1, receipt: { role: "queen", providerId: "p1", model: "m1", promptTokens: 3, completionTokens: 4, totalTokens: 7, latencyMs: 5 }, output: "Task analysis:\n- **risk**: parser edge cases" },
    { type: "stage-started", agent: "Forger", attempt: 1 },
  ],
};

const completedRun: CouncilRunView = {
  ...runningRun,
  stages: [...runningRun.stages, { type: "stage-completed", agent: "Sentinel", attempt: 1, receipt: { role: "heavyReasoning", providerId: "p1", model: "m1", totalTokens: 9 }, output: "VERDICT: PASS" }],
  summary: {
    status: "COMPLETE",
    reason: "All criteria satisfied; Sentinel PASS.",
    preset: "quick",
    totalTokens: 16,
    artifactDir: "C:\\repo\\.hivemind\\hivebot-runs\\hivebot-1789200000000-ab12",
    stageCount: 4,
  },
};

describe("CouncilTranscript", () => {
  it("renders progressive stage strips, completed bodies, and a running status", () => {
    render(<CouncilTranscript run={runningRun} repositoryRoot={"C:\\repo"} onOpenArtifacts={() => {}} />);
    expect(screen.getByText(/---- QUEEN - attempt 1 \[ok\]/)).toBeInTheDocument();
    expect(screen.getByText(/---- FORGER - attempt 1 \[~\]/)).toBeInTheDocument();
    expect(screen.getByText("risk")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByText(/p1\/m1 - 7 tok/)).toBeInTheDocument();
    expect(screen.getByText(/running\.\.\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open artifacts folder/i })).not.toBeInTheDocument();
  });

  it("shows the summary card and opens the artifacts folder with a guarded relative path", async () => {
    const onOpenArtifacts = vi.fn();
    render(<CouncilTranscript run={completedRun} repositoryRoot={"C:\\repo"} onOpenArtifacts={onOpenArtifacts} />);
    expect(screen.getByText(/COMPLETE - All criteria satisfied/)).toBeInTheDocument();
    expect(screen.getByText(/4 stages - 16 tokens - preset quick/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /open artifacts folder/i }));
    expect(onOpenArtifacts).toHaveBeenCalledWith(".hivemind/hivebot-runs/hivebot-1789200000000-ab12");
  });

  it("hides the artifacts button when the artifact dir escapes the repository root", () => {
    render(<CouncilTranscript run={completedRun} repositoryRoot={"C:\\other"} onOpenArtifacts={() => {}} />);
    expect(screen.queryByRole("button", { name: /open artifacts folder/i })).not.toBeInTheDocument();
  });

  it("surfaces failure messages", () => {
    render(<CouncilTranscript run={{ ...runningRun, failed: "artifacts unwritable" }} repositoryRoot={null} onOpenArtifacts={() => {}} />);
    expect(screen.getByText(/artifacts unwritable/)).toBeInTheDocument();
  });
});
