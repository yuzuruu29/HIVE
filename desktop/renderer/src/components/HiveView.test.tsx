import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../../../src/coding/types";
import { HiveView } from "./HiveView";

const now = new Date("2026-07-14T10:00:00.000Z").toISOString();

function fakeSubagentEvent(
  id: string,
  subagentId: string,
  type: string,
  role?: string,
  fileScope?: string[]
): RuntimeEvent {
  return {
    schemaVersion: 1,
    id,
    sequence: 1,
    sessionId: "session-1",
    timestamp: now,
    type,
    payload: {
      subagentId,
      ...(role ? { role } : {}),
      ...(fileScope ? { fileScope } : {}),
    },
  } as unknown as RuntimeEvent;
}

describe("HiveView component", () => {
  it("renders empty state when there are no agent events", () => {
    render(<HiveView events={[]} report={null} />);
    expect(screen.getByText(/No agent activity/i)).toBeInTheDocument();
  });

  it("renders agent cards with roles, file scope chips, and calculates settled ratio", () => {
    const events: RuntimeEvent[] = [
      fakeSubagentEvent("ev-1", "agent-builder-1", "subagent.started", "Forger", ["src/index.ts"]),
      fakeSubagentEvent("ev-2", "agent-validator-1", "subagent.completed", "Sentinel", ["tests/index.test.ts"]),
      fakeSubagentEvent("ev-3", "agent-reviewer-1", "subagent.failed", "Reviewer"),
    ];

    render(<HiveView events={events} report={null} />);

    expect(screen.getByText("Forger")).toBeInTheDocument();
    expect(screen.getByText("Sentinel")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("tests/index.test.ts")).toBeInTheDocument();

    // Failed agent has [!!] glyph
    expect(screen.getByText("[!!]")).toBeInTheDocument();

    // 2 settled (Sentinel completed, Reviewer failed) out of 3 total
    expect(screen.getByText(/2 of 3 agents settled/i)).toBeInTheDocument();
    const progress = screen.getByRole("progressbar");
    expect(progress).toHaveAttribute("value", "2");
    expect(progress).toHaveAttribute("max", "3");
  });
});
