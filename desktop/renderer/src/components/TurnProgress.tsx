import { useEffect, useMemo, useState } from "react";
import type { CodingSessionStatus, RuntimeEvent } from "../../../../src/coding/types";
import { usePrefs } from "../prefs";
import { terminalStatuses } from "../utils";

export interface TurnProgressProps {
  events: RuntimeEvent[];
  status: CodingSessionStatus | null;
  startedAt?: string;
  pausing: boolean;
}

const PHASES = ["plan", "scout", "build", "validate", "review"] as const;
type Phase = typeof PHASES[number];

function derivePhase(events: RuntimeEvent[], status: CodingSessionStatus | null): Phase {
  if (status === "created" || status === "planning") return "plan";
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i].type.toLowerCase();
    if (type.includes("review")) return "review";
    if (type.includes("validat")) return "validate";
    if (type.includes("build") || type.includes("forger") || type.includes("subagent") || type.includes("task")) return "build";
    if (type.includes("scout")) return "scout";
    if (type.includes("plan")) return "plan";
  }
  return "plan";
}

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatHHMMSS(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "00:00:00" : date.toLocaleTimeString([], { hour12: false });
}

export function TurnProgress({ events, status, startedAt, pausing }: TurnProgressProps) {
  const { prefs, updatePrefs } = usePrefs();
  const isTerminal = status ? terminalStatuses.has(status) : false;

  const currentPhase = derivePhase(events, status);
  const activePhaseIndex = status === "completed" ? PHASES.length : PHASES.indexOf(currentPhase);

  const startTimeMs = useMemo(() => {
    if (startedAt) {
      const parsed = Date.parse(startedAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (events.length && events[0].timestamp) {
      const parsed = Date.parse(events[0].timestamp);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now();
  }, [startedAt, events]);

  const [elapsedSeconds, setElapsedSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000)));

  useEffect(() => {
    if (isTerminal) return;
    const interval = setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startTimeMs) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTimeMs, isTerminal]);

  const timelineEvents = useMemo(() => {
    return [...events].slice(-8).reverse();
  }, [events]);

  if (isTerminal) return null;

  return (
    <div className="turn-progress anim-in">
      <details
        open={!prefs.turnPanelCollapsed}
        onToggle={(event) => updatePrefs({ turnPanelCollapsed: !event.currentTarget.open })}
      >
        <summary>
          <span>
            {pausing ? "Turn Pausing…" : "Live Turn Progress"} [{formatElapsed(elapsedSeconds)}]
          </span>
          <small>{status ?? "running"}</small>
        </summary>

        <div className="turn-progress-stepper">
          {PHASES.map((phase, index) => {
            const isCompleted = index < activePhaseIndex;
            const isActive = index === activePhaseIndex;
            const glyph = isCompleted ? "[x]" : isActive ? "[~]" : "[ ]";
            const className = `turn-progress-step ${
              isCompleted ? "step-completed" : isActive ? "step-active anim-running" : "step-pending"
            }`;

            return (
              <span key={phase} className={className}>
                <span className="glyph">{glyph}</span>
                <span className="label">{phase}</span>
              </span>
            );
          })}
        </div>

        {(status === "created" || status === "planning") && <div className="skeleton-line anim-shimmer" />}

        <ul className="turn-progress-timeline" role="log" aria-live="polite">
          {timelineEvents.map((event) => {
            const payload = event.payload as unknown as Record<string, unknown>;
            const subagent = typeof payload?.subagentId === "string" ? ` [${payload.subagentId}]` : "";
            return (
              <li key={event.id} className="timeline-row anim-in">
                <span>
                  {formatHHMMSS(event.timestamp)}
                  {subagent}
                </span>
                <code>{event.type}</code>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
