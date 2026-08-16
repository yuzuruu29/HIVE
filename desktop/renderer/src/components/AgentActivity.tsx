import { useMemo } from "react";
import type { RuntimeEvent } from "../../../../src/coding/types";
import { EmptyState } from "./EmptyState";
import { StatusPill } from "./StatusPill";

export interface AgentActivityProps {
  events: RuntimeEvent[];
}

export function AgentActivity({ events }: AgentActivityProps) {
  const agents = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of events) {
      const payload = event.payload as unknown as Record<string, unknown>;
      if (typeof payload.subagentId === "string") {
        map.set(payload.subagentId, event.type.replace("subagent.", ""));
      }
    }
    return [...map.entries()];
  }, [events]);

  if (!agents.length) return <EmptyState>No agent activity.</EmptyState>;

  return (
    <ul className="agent-list">
      {agents.map(([id, status]) => (
        <li key={id}>
          <code>[{id}]</code>
          <StatusPill tone={status === "failed" ? "error" : status === "completed" ? "success" : "neutral"}>
            {status}
          </StatusPill>
        </li>
      ))}
    </ul>
  );
}
