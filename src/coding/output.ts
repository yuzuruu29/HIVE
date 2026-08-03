export interface RuntimeEventLike {
  id: string;
  sequence?: number;
  sessionId: string;
  subagentId?: string;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface FinalReportLike {
  sessionId: string;
  objective: string;
  result: string;
  subagents: {
    completed: number;
    failed: number;
    cancelled: number;
  };
  filesChanged: string[];
  validation: Array<{ name: string; passed: boolean; output?: string }>;
  review: string[];
  outstanding: string[];
}

function value(payload: Record<string, unknown>, key: string): string | undefined {
  const item = payload[key];
  if (typeof item === "string" && item.trim()) return item.trim();
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  return undefined;
}

function nestedTask(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidate = payload.task;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function eventSubagentId(event: RuntimeEventLike): string | undefined {
  return event.subagentId ??
    value(event.payload, "subagentId") ??
    value(event.payload, "taskId") ??
    (nestedTask(event.payload) ? value(nestedTask(event.payload) as Record<string, unknown>, "id") : undefined);
}

function titleCase(valueToFormat: string): string {
  return valueToFormat
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatRuntimeEventText(event: RuntimeEventLike): string {
  const task = nestedTask(event.payload);
  const role = value(event.payload, "role") ?? (task ? value(task, "role") : undefined);
  const subagentId = eventSubagentId(event);
  const label = role
    ? `${titleCase(role)}${subagentId ? ` ${subagentId}` : ""}`
    : subagentId
      ? `Agent ${subagentId}`
      : "Queen";
  const detail =
    value(event.payload, "activity") ??
    value(event.payload, "title") ??
    value(event.payload, "summary") ??
    value(event.payload, "message") ??
    value(event.payload, "command") ??
    value(event.payload, "error");

  switch (event.type) {
    case "session.created":
      return "[Queen] Session created";
    case "session.started":
      return "[Queen] Session started";
    case "session.resumed":
      return "[Queen] Session resumed";
    case "session.cancelled":
      return `[Queen] Session cancelled${detail ? `: ${detail}` : ""}`;
    case "session.completed":
      return `[Queen] Session completed${detail ? `: ${detail}` : ""}`;
    case "plan.created":
      return `[Planner] Completed execution plan${detail ? `: ${detail}` : ""}`;
    case "subagent.created":
    case "task.created":
      return `[${label}] Created${detail ? `: ${detail}` : ""}`;
    case "subagent.started":
    case "task.started":
      return `[${label}] Started${detail ? `: ${detail}` : ""}`;
    case "subagent.progress":
    case "task.progress":
      return `[${label}] ${detail ?? "Working"}`;
    case "subagent.retrying":
    case "task.retrying":
      return `[${label}] Retrying${detail ? `: ${detail}` : ""}`;
    case "subagent.blocked":
    case "task.blocked":
      return `[${label}] Blocked${detail ? `: ${detail}` : ""}`;
    case "subagent.completed":
    case "task.completed":
      return `[${label}] Completed${detail ? `: ${detail}` : ""}`;
    case "subagent.failed":
    case "task.failed":
      return `[${label}] Failed${detail ? `: ${detail}` : ""}`;
    case "subagent.cancelled":
    case "task.cancelled":
      return `[${label}] Cancelled${detail ? `: ${detail}` : ""}`;
    case "command.started":
      return `[${label}] Running ${detail ?? "command"}`;
    case "command.completed":
      return `[${label}] Command ${value(event.payload, "passed") === "false" ? "failed" : "completed"}${detail ? `: ${detail}` : ""}`;
    case "file.changed":
    case "subagent.file_changed":
      return `[${label}] Changed ${value(event.payload, "path") ?? "file"}`;
    case "validation.started":
      return `[Validator${subagentId ? ` ${subagentId}` : ""}] Validation started`;
    case "validation.completed":
      return `[Validator${subagentId ? ` ${subagentId}` : ""}] Validation ${value(event.payload, "passed") === "false" ? "failed" : "completed"}`;
    case "review.completed":
      return `[Reviewer${subagentId ? ` ${subagentId}` : ""}] Review completed${detail ? `: ${detail}` : ""}`;
    default:
      return `[${label}] ${titleCase(event.type)}${detail ? `: ${detail}` : ""}`;
  }
}

export function formatRuntimeEventJson(event: RuntimeEventLike): string {
  return JSON.stringify(event);
}

function bulletLines(values: string[], empty: string): string[] {
  return values.length > 0 ? values.map((item) => `- ${item}`) : [`- ${empty}`];
}

export function formatCodingFinalReport(report: FinalReportLike): string {
  const lines = [
    "HIVE coding session complete",
    "",
    "Objective:",
    report.objective,
    "",
    "Result:",
    report.result,
    "",
    "Subagents:",
    `- ${report.subagents.completed} completed`,
    `- ${report.subagents.failed} failed`,
    `- ${report.subagents.cancelled} cancelled`,
    "",
    "Files changed:",
    ...bulletLines(report.filesChanged, "None"),
    "",
    "Validation:",
    ...(report.validation.length > 0
      ? report.validation.map((item) => `- ${item.name}: ${item.passed ? "passed" : "failed"}`)
      : ["- None run"]),
    "",
    "Review:",
    ...bulletLines(report.review, "No review findings"),
    "",
    "Outstanding:",
    ...bulletLines(report.outstanding, "None"),
    "",
    "Session:",
    report.sessionId,
  ];
  return lines.join("\n");
}

export function createRuntimeReporter(options: {
  json: boolean;
  onLine?: (line: string) => void;
}): {
  lines: string[];
  emit: (event: RuntimeEventLike) => void;
} {
  const lines: string[] = [];
  const roleById = new Map<string, string>();
  return {
    lines,
    emit(event) {
      if (!options.json && (event.type.startsWith("task.") || event.type === "subagent.status_changed")) {
        return;
      }
      const task = nestedTask(event.payload);
      const eventId = eventSubagentId(event);
      const taskRole = task ? value(task, "role") : undefined;
      if (eventId && taskRole) roleById.set(eventId, taskRole);
      const role = eventId ? roleById.get(eventId) : undefined;
      const textEvent = role && !value(event.payload, "role")
        ? { ...event, payload: { ...event.payload, role } }
        : event;
      const line = options.json ? formatRuntimeEventJson(event) : formatRuntimeEventText(textEvent);
      lines.push(line);
      options.onLine?.(line);
    },
  };
}
