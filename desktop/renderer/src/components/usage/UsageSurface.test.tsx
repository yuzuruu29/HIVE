import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageSurface } from "./UsageSurface";

describe("UsageSurface", () => {
  it("does not fabricate empty-workspace metrics", () => {
    render(<UsageSurface />);

    expect(screen.getByText("0 / 30")).toBeInTheDocument();
    expect(screen.getByText("No completed runs")).toBeInTheDocument();
    expect(screen.getByText("Unavailable", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Model-level usage is not persisted")).toBeInTheDocument();
    expect(screen.queryByText(/\d+(\.\d+)?M\b/)).not.toBeInTheDocument();
  });

  it("counts only recorded chats and runs, never estimated tokens", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const at = new Date(now - 3_600_000).toISOString();
    render(
      <UsageSurface
        now={now}
        conversations={[{ id: "c1", title: "A", role: "auto", updatedAt: at, messageCount: 4 }]}
        threads={[{
          schemaVersion: 1,
          id: "t1",
          title: "Task",
          createdAt: at,
          updatedAt: at,
          archived: false,
          messages: [],
          runs: [
            { userMessageId: "m1", codingSessionId: "s1", status: "completed", createdAt: at, updatedAt: at },
            { userMessageId: "m2", codingSessionId: "s2", status: "failed", createdAt: at, updatedAt: at },
          ],
        }]}
      />,
    );

    expect(screen.getByText("4 messages")).toBeInTheDocument();
    expect(screen.getByText("50% completed · 1 tasks")).toBeInTheDocument();
    expect(screen.getByText("1 / 30")).toBeInTheDocument();
    expect(screen.getByText("Unavailable", { exact: true })).toBeInTheDocument();
  });
});
