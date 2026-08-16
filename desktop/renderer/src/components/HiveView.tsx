import { useMemo } from "react";
import type { CodingFinalReport, RuntimeEvent } from "../../../../src/coding/types";
import { formatTime } from "../utils";
import { EmptyState } from "./EmptyState";
import { StatusPill } from "./StatusPill";

export interface HiveViewProps {
  events: RuntimeEvent[];
  report: CodingFinalReport | null;
}

interface AgentCellState {
  id: string;
  role: string;
  status: string;
  fileScope: string[];
  lastTimestamp: string;
  isTerminal: boolean;
}

export function HiveView({ events, report }: HiveViewProps) {
  const agents = useMemo(() => {
    const map = new Map<string, AgentCellState>();

    for (const event of events) {
      const payload = event.payload as unknown as Record<string, unknown>;
      if (typeof payload?.subagentId === "string") {
        const id = payload.subagentId;
        const current = map.get(id) ?? {
          id,
          role: typeof payload.role === "string" ? payload.role : id,
          status: "starting",
          fileScope: [],
          lastTimestamp: event.timestamp,
          isTerminal: false,
        };

        const eventType = event.type.toLowerCase();
        let status = current.status;
        let isTerminal = current.isTerminal;

        if (eventType.includes("complete") || eventType.includes("succeeded") || eventType.includes("pass")) {
          status = "completed";
          isTerminal = true;
        } else if (eventType.includes("fail") || eventType.includes("error")) {
          status = "failed";
          isTerminal = true;
        } else if (eventType.includes("start") || eventType.includes("progress") || eventType.includes("working")) {
          status = "working";
          isTerminal = false;
        } else if (eventType.includes("skip")) {
          status = "skipped";
          isTerminal = true;
        }

        const fileScope = Array.isArray(payload.fileScope)
          ? (payload.fileScope.filter((f) => typeof f === "string") as string[])
          : current.fileScope;

        map.set(id, {
          id,
          role: typeof payload.role === "string" ? payload.role : current.role,
          status,
          fileScope,
          lastTimestamp: event.timestamp,
          isTerminal,
        });
      }
    }

    return [...map.values()];
  }, [events]);

  const totalAgents = agents.length > 0 ? agents.length : report?.subagents.total ?? 0;
  const settledAgents = agents.filter((a) => a.isTerminal).length;

  if (!agents.length) {
    return <EmptyState>No agent activity.</EmptyState>;
  }

  return (
    <div className="hive-view anim-in">
      <div className="hive-meter">
        <div className="section-heading">
          <span>{`${settledAgents} of ${totalAgents} agents settled`}</span>
        </div>
        <progress value={settledAgents} max={Math.max(1, totalAgents)} />
      </div>

      <div className="hive-grid">
        {agents.map((agent) => {
          const isWorking = agent.status === "working";
          const isCompleted = agent.status === "completed";
          const isFailed = agent.status === "failed";
          const tone = isCompleted ? "success" : isFailed ? "error" : isWorking ? "warning" : "neutral";
          const cardClass = `hive-cell-card ${
            isWorking ? "cell-working anim-running" : isCompleted ? "cell-completed" : isFailed ? "cell-failed" : "cell-neutral"
          }`;

          return (
            <div key={agent.id} className={cardClass}>
              <div className="hive-cell-header">
                <span className="hive-cell-role">{agent.role}</span>
                <StatusPill tone={tone}>{agent.status}</StatusPill>
              </div>

              {agent.fileScope.length > 0 && (
                <div className="hive-cell-scopes">
                  {agent.fileScope.map((file) => (
                    <span key={file} className="hive-scope-chip">
                      {file}
                    </span>
                  ))}
                </div>
              )}

              <small className="dim">{formatTime(agent.lastTimestamp)}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
