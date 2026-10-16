import { useEffect, useMemo, useState } from "react";
import type { CodingSessionStatus, RuntimeEvent } from "../../../../../src/coding/types";
import { terminalStatuses } from "../../utils";
import { deriveAgentActivity, type ActivityPhase } from "./agent-activity";

export interface AgentActivityProps {
  events: readonly RuntimeEvent[];
  runStatus?: CodingSessionStatus | null;
  sessionId?: string | null;
  /** Freeze the elapsed clock. Tests pass this so the readout does not tick. */
  now?: number;
}

export function AgentActivity({ events, runStatus = null, sessionId = null, now }: AgentActivityProps) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  const live = Boolean(runStatus && !terminalStatuses.has(runStatus));

  useEffect(() => {
    if (now !== undefined || !live) return;
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live, now]);

  const rows = useMemo(
    () => deriveAgentActivity(events, { now: now ?? clock, runStatus, sessionId }),
    [events, now, clock, runStatus, sessionId],
  );

  const idle = rows.every((row) => row.phase === "idle");

  return (
    <div className="hive-activity-block" role="log" aria-label="Agent activity" data-idle={idle || undefined}>
      <div className="hive-activity-head" aria-hidden="true">{idle ? "HIVE pipeline" : "Agents"}</div>
      {rows.map((row) => (
        <div
          key={row.role}
          className="hive-activity-row"
          data-phase={row.phase}
          data-role={row.role}
          aria-label={`${row.label}: ${row.detail}`}
        >
          <span className="hive-activity-left">
            <span className={`hive-activity-dot is-${dotClass(row.phase)}`} aria-hidden="true">{row.glyph}</span>
            <span className="hive-activity-role">{row.label}</span>
            <span className="hive-activity-detail">{row.detail}</span>
          </span>
          <span className="hive-activity-time" aria-hidden="true">{row.elapsedLabel}</span>
        </div>
      ))}
    </div>
  );
}

function dotClass(phase: ActivityPhase): string {
  if (phase === "done") return "done";
  if (phase === "active") return "active";
  if (phase === "failed") return "failed";
  return "waiting";
}
