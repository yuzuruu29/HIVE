import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../../../src/coding/types";
import { TurnProgress } from "./TurnProgress";

const now = new Date("2026-07-14T10:00:00.000Z").toISOString();

function fakeEvent(sequence: number, type: string, subagentId?: string): RuntimeEvent {
  return {
    schemaVersion: 1,
    id: `event-${sequence}`,
    sequence,
    sessionId: "session-1",
    timestamp: new Date(Date.parse(now) + sequence * 1000).toISOString(),
    type,
    payload: subagentId ? { subagentId } : {},
  } as unknown as RuntimeEvent;
}

describe("TurnProgress component", () => {
  it("renders phase stepper with correct active step and ASCII glyphs", () => {
    const events: RuntimeEvent[] = [
      fakeEvent(1, "session.planning"),
      fakeEvent(2, "scout.complete"),
      fakeEvent(3, "subagent.started", "builder-1"),
    ];

    render(<TurnProgress events={events} status="running" startedAt={now} pausing={false} />);

    expect(screen.getByText(/Live Turn Progress/i)).toBeInTheDocument();
    // plan & scout should be completed [x], build active [~], validate & review pending [ ]
    const steps = screen.getAllByText(/\[x\]|\[~\]|\[ \]/);
    expect(steps.length).toBe(5);
    expect(steps[0]).toHaveTextContent("[x]"); // plan
    expect(steps[1]).toHaveTextContent("[x]"); // scout
    expect(steps[2]).toHaveTextContent("[~]"); // build
    expect(steps[3]).toHaveTextContent("[ ]"); // validate
    expect(steps[4]).toHaveTextContent("[ ]"); // review
  });

  it("caps timeline at 8 rows newest-first and renders with role='log'", () => {
    const events: RuntimeEvent[] = Array.from({ length: 12 }, (_, i) =>
      fakeEvent(i + 1, `task.progress`, `agent-${i + 1}`)
    );

    render(<TurnProgress events={events} status="running" startedAt={now} pausing={false} />);

    const logContainer = screen.getByRole("log");
    expect(logContainer).toHaveAttribute("aria-live", "polite");

    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBe(8);
    // newest event is event 12
    expect(rows[0]).toHaveTextContent("task.progress");
    expect(rows[0]).toHaveTextContent("[agent-12]");
    expect(rows[7]).toHaveTextContent("task.progress");
  });

  it("hides when run reaches terminal status", () => {
    const { container, rerender } = render(
      <TurnProgress events={[fakeEvent(1, "session.started")]} status="completed" startedAt={now} pausing={false} />
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <TurnProgress events={[fakeEvent(1, "session.started")]} status="failed" startedAt={now} pausing={false} />
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <TurnProgress events={[fakeEvent(1, "session.started")]} status="cancelled" startedAt={now} pausing={false} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("displays pausing label when pausing is true", () => {
    render(<TurnProgress events={[fakeEvent(1, "session.started")]} status="running" startedAt={now} pausing={true} />);
    expect(screen.getByText(/Turn Pausing…/i)).toBeInTheDocument();
  });
});
