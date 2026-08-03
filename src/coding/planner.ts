import type { SubagentRole, SubagentTask } from "./types.js";

export interface PlannedTaskDraft {
  key: string;
  role: "builder";
  title: string;
  objective: string;
  dependencies: string[];
  fileScope: string[];
  expectedOutput: string;
  completionCriteria: string[];
  validationCommands?: string[];
}

export interface CodingPlan {
  summary: string;
  architecture: string;
  risks: string[];
  acceptanceCriteria: string[];
  validationCommands: string[];
  tasks: PlannedTaskDraft[];
}

export interface MaterializePlanOptions {
  sessionId: string;
  plan: CodingPlan;
  providerForRole: (role: SubagentRole) => { providerId: string; model?: string };
  maxAttempts: number;
  firstBeeNumber?: number;
  now?: () => string;
}

function extractJsonCandidate(output: string): string {
  const trimmed = output.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function stringArray(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid plan: '${field}' must be an array of strings.`);
  }
  const normalized = value.map((item) => item.trim()).filter(Boolean);
  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`Invalid plan: '${field}' must not be empty.`);
  }
  return normalized;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid plan: '${field}' must be a non-empty string.`);
  }
  return value.trim();
}

export function parseCodingPlan(output: string): CodingPlan {
  if (!output.trim()) throw new Error("Planner returned an empty response.");

  let value: unknown;
  try {
    value = JSON.parse(extractJsonCandidate(output));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Planner returned invalid JSON: ${message}`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid plan: expected a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error("Invalid plan: at least one bounded Builder task is required.");
  }

  const keys = new Set<string>();
  const tasks = raw.tasks.map((item, index): PlannedTaskDraft => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid plan task at index ${index}.`);
    }
    const task = item as Record<string, unknown>;
    const key = requiredString(task.key, `tasks[${index}].key`);
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(key)) {
      throw new Error(`Invalid plan task key '${key}'. Use lower-case letters, numbers, and dashes.`);
    }
    if (keys.has(key)) throw new Error(`Invalid plan: duplicate task key '${key}'.`);
    keys.add(key);
    if (task.role !== "builder") {
      throw new Error(`Invalid plan: task '${key}' must use the builder role.`);
    }
    const fileScope = stringArray(task.fileScope, `tasks[${index}].fileScope`);
    if (fileScope.some((scope) => /[*?[\]]/.test(scope))) {
      throw new Error(`Invalid plan: task '${key}' fileScope must contain exact relative file paths, not globs.`);
    }
    return {
      key,
      role: "builder",
      title: requiredString(task.title, `tasks[${index}].title`),
      objective: requiredString(task.objective, `tasks[${index}].objective`),
      dependencies: stringArray(task.dependencies ?? [], `tasks[${index}].dependencies`, true),
      fileScope,
      expectedOutput: requiredString(task.expectedOutput, `tasks[${index}].expectedOutput`),
      completionCriteria: stringArray(task.completionCriteria, `tasks[${index}].completionCriteria`),
      validationCommands: task.validationCommands === undefined
        ? undefined
        : stringArray(task.validationCommands, `tasks[${index}].validationCommands`, true),
    };
  });

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!keys.has(dependency)) {
        throw new Error(`Invalid plan: task '${task.key}' depends on unknown task '${dependency}'.`);
      }
      if (dependency === task.key) {
        throw new Error(`Invalid plan: task '${task.key}' cannot depend on itself.`);
      }
    }
  }

  return {
    summary: requiredString(raw.summary, "summary"),
    architecture: requiredString(raw.architecture, "architecture"),
    risks: stringArray(raw.risks ?? [], "risks", true),
    acceptanceCriteria: stringArray(raw.acceptanceCriteria, "acceptanceCriteria"),
    validationCommands: stringArray(raw.validationCommands ?? [], "validationCommands", true),
    tasks,
  };
}

export function buildPlannerPrompt(objective: string, sharedContext: string, limits: {
  maxAgents: number;
  maxTasks: number;
  maxDepth: number;
}): string {
  return [
    "You are the HIVE Planner. Convert the objective into bounded, executable Builder tasks.",
    "Do not edit files. Use only evidence in the supplied repository context.",
    `Maximum parallel agents: ${limits.maxAgents}`,
    `Maximum total tasks: ${limits.maxTasks}`,
    `Maximum task depth: ${limits.maxDepth}`,
    "Builder file scopes must be exact repository-relative file paths, never directories or globs. If paths overlap, add a dependency that serializes ownership.",
    "Every task must have an expected output and measurable completion criteria.",
    "Return only JSON with this shape:",
    JSON.stringify({
      summary: "short execution summary",
      architecture: "how the change extends existing systems",
      risks: ["risk"],
      acceptanceCriteria: ["criterion"],
      validationCommands: ["npm test"],
      tasks: [{
        key: "bounded-task-key",
        role: "builder",
        title: "Short task title",
        objective: "Specific bounded objective",
        dependencies: [],
        fileScope: ["src/example.ts"],
        expectedOutput: "Concrete implementation artifact",
        completionCriteria: ["Measurable criterion"],
        validationCommands: ["npm test"],
      }],
    }),
    "",
    "[Objective]",
    objective,
    "",
    "[Repository context]",
    sharedContext,
  ].join("\n");
}

function beeId(number: number): string {
  return `bee-${String(number).padStart(3, "0")}`;
}

export function materializeBuilderTasks(options: MaterializePlanOptions): SubagentTask[] {
  const keyToId = new Map<string, string>();
  const first = options.firstBeeNumber ?? 3;
  options.plan.tasks.forEach((task, index) => keyToId.set(task.key, beeId(first + index)));
  const now = options.now ?? (() => new Date().toISOString());
  const provider = options.providerForRole("builder");

  return options.plan.tasks.map((task, index) => ({
    id: beeId(first + index),
    sessionId: options.sessionId,
    role: "builder",
    title: task.title,
    objective: task.objective,
    status: "created",
    providerId: provider.providerId,
    model: provider.model,
    dependencies: task.dependencies.map((key) => keyToId.get(key) as string),
    fileScope: task.fileScope,
    expectedOutput: task.expectedOutput,
    completionCriteria: task.completionCriteria,
    validationCommands: task.validationCommands ?? [],
    depth: 1,
    attempt: 0,
    maxAttempts: Math.max(1, options.maxAttempts),
    createdAt: now(),
  }));
}
