import type { SubagentRole, SubagentTask } from "./types.js";

export type AgentToolName =
  | "read_file"
  | "list_directory"
  | "search_text"
  | "search_symbols"
  | "create_file"
  | "write_file"
  | "edit_file"
  | "apply_patch"
  | "inspect_diff"
  | "run_command"
  | "run_test"
  | "read_command_output";

export interface AgentToolCall {
  id?: string;
  name: AgentToolName;
  arguments: Record<string, unknown>;
}

export interface AgentTurn {
  done: boolean;
  summary?: string;
  activity?: string;
  toolCalls?: AgentToolCall[];
  data?: Record<string, unknown>;
}

export interface AgentTokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

export interface AgentCompletionRequest {
  role: SubagentRole;
  providerId: string;
  model?: string;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
}

export interface AgentCompletionResponse {
  output: string;
  usage?: AgentTokenUsage;
}

export interface AgentCompletionClient {
  complete(request: AgentCompletionRequest): Promise<AgentCompletionResponse>;
}

export interface AgentToolResult {
  ok: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface AgentToolExecutor {
  execute(
    name: AgentToolName,
    args: Record<string, unknown>,
    task: SubagentTask,
    signal: AbortSignal,
  ): Promise<AgentToolResult>;
}

export interface AgentLoopEvent {
  type:
    | "subagent.progress"
    | "subagent.tool_call"
    | "subagent.file_changed"
    | "command.started"
    | "command.completed";
  subagentId: string;
  payload: Record<string, unknown>;
}

export interface AgentLoopOptions {
  task: SubagentTask;
  cwd: string;
  sharedContext: string;
  dependencyOutputs?: Record<string, string>;
  completionClient: AgentCompletionClient;
  tools: AgentToolExecutor;
  signal: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  maxTurns?: number;
  maxToolCalls?: number;
  maxInvalidResponses?: number;
}

export interface AgentLoopResult {
  summary: string;
  data?: Record<string, unknown>;
  usage?: AgentTokenUsage;
  turns: number;
  toolCalls: number;
}

const WRITE_TOOLS = new Set<AgentToolName>([
  "write_file",
  "create_file",
  "edit_file",
  "apply_patch",
]);

const READ_ONLY_ROLES = new Set<SubagentRole>([
  "planner",
  "scout",
  "validator",
  "reviewer",
]);

const MAX_PROMPT_CHARS = 80_000;
const MAX_TOOL_OUTPUT_CHARS = 16_000;

function abortError(): Error {
  const error = new Error("Subagent execution cancelled.");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
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

export function parseAgentTurn(output: string): AgentTurn {
  if (!output.trim()) throw new Error("Provider returned an empty response.");

  let value: unknown;
  try {
    value = JSON.parse(extractJsonCandidate(output));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid structured response: ${message}`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid structured response: expected a JSON object.");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.done !== "boolean") {
    throw new Error("Invalid structured response: 'done' must be boolean.");
  }

  let toolCalls: AgentToolCall[] | undefined;
  if (candidate.toolCalls !== undefined) {
    if (!Array.isArray(candidate.toolCalls)) {
      throw new Error("Invalid structured response: 'toolCalls' must be an array.");
    }
    toolCalls = candidate.toolCalls.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Invalid tool call at index ${index}.`);
      }
      const call = item as Record<string, unknown>;
      if (typeof call.name !== "string" || !call.name) {
        throw new Error(`Invalid tool call name at index ${index}.`);
      }
      const args = call.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error(`Invalid tool call arguments at index ${index}.`);
      }
      return {
        id: typeof call.id === "string" ? call.id : undefined,
        name: call.name as AgentToolName,
        arguments: args as Record<string, unknown>,
      };
    });
  }

  const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : undefined;
  if (candidate.done && !summary) {
    throw new Error("Invalid structured response: completed turns require a summary.");
  }
  if (!candidate.done && (!toolCalls || toolCalls.length === 0)) {
    throw new Error("Invalid structured response: unfinished turns require tool calls.");
  }

  return {
    done: candidate.done,
    summary,
    activity: typeof candidate.activity === "string" ? candidate.activity.trim() : undefined,
    toolCalls,
    data:
      candidate.data && typeof candidate.data === "object" && !Array.isArray(candidate.data)
        ? candidate.data as Record<string, unknown>
        : undefined,
  };
}

function rolePolicy(role: SubagentRole): string {
  switch (role) {
    case "planner":
      return "Plan only. Do not request file-write or command tools.";
    case "scout":
      return "Inspect only. Use targeted reads and searches; never edit files.";
    case "validator":
      return "Validate acceptance criteria. You may inspect files and run approved checks, but never edit.";
    case "reviewer":
      return "Review the diff for correctness, maintainability, security, and architectural consistency. Never edit.";
    case "fixer":
      return "Repair only the supplied failed checks or review findings, within the declared file scope.";
    case "builder":
      return "Implement only the bounded assignment, within the declared file scope.";
  }
}

function systemPrompt(task: SubagentTask): string {
  return [
    `You are the HIVE ${task.role} subagent ${task.id}.`,
    "The Queen owns the primary objective. Do not redefine or broaden it.",
    rolePolicy(task.role),
    "Use repository tools when evidence or changes are required.",
    "Return exactly one JSON object per turn with this shape:",
    '{"done":false,"activity":"short current action","toolCalls":[{"id":"call-1","name":"read_file","arguments":{"path":"src/file.ts"}}]}',
    "When finished return:",
    '{"done":true,"summary":"files changed, checks run, assumptions, and unresolved issues","data":{}}',
    "Do not wrap JSON in commentary. Never include secrets.",
  ].join("\n");
}

function initialPrompt(options: AgentLoopOptions): string {
  const dependencies = options.dependencyOutputs && Object.keys(options.dependencyOutputs).length > 0
    ? JSON.stringify(options.dependencyOutputs, null, 2)
    : "None";
  return [
    "[Shared repository context]",
    options.sharedContext,
    "",
    "[Bounded assignment]",
    `Title: ${options.task.title}`,
    `Objective: ${options.task.objective}`,
    `File scope: ${options.task.fileScope.length > 0 ? options.task.fileScope.join(", ") : "read-only"}`,
    `Expected output: ${options.task.expectedOutput}`,
    `Completion criteria: ${options.task.completionCriteria.join("; ")}`,
    "",
    "[Dependency outputs]",
    dependencies,
  ].join("\n");
}

function mergeUsage(current: AgentTokenUsage, next?: AgentTokenUsage): AgentTokenUsage {
  if (!next) return current;
  return {
    input: (current.input ?? 0) + (next.input ?? 0),
    output: (current.output ?? 0) + (next.output ?? 0),
    total: (current.total ?? 0) + (next.total ?? next.input ?? 0) + (next.total === undefined ? (next.output ?? 0) : 0),
  };
}

function bounded(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} characters]`;
}

function buildTurnPrompt(initial: string, history: string[], correction?: string): string {
  const suffix = correction ? `\n\n[Protocol correction]\n${correction}` : "";
  const joined = [initial, ...history.slice(-12)].join("\n\n");
  return bounded(joined + suffix, MAX_PROMPT_CHARS);
}

export class StructuredAgentLoop {
  async run(options: AgentLoopOptions): Promise<AgentLoopResult> {
    const maxTurns = options.maxTurns ?? 16;
    const maxToolCalls = options.maxToolCalls ?? 48;
    const maxInvalid = options.maxInvalidResponses ?? 2;
    const history: string[] = [];
    const usage: AgentTokenUsage = {};
    const firstPrompt = initialPrompt(options);
    let invalidResponses = 0;
    let totalToolCalls = 0;
    let accumulatedUsage = usage;
    let correction: string | undefined;

    for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber += 1) {
      assertNotAborted(options.signal);
      const response = await options.completionClient.complete({
        role: options.task.role,
        providerId: options.task.providerId,
        model: options.task.model,
        systemPrompt: systemPrompt(options.task),
        prompt: buildTurnPrompt(firstPrompt, history, correction),
        cwd: options.cwd,
        signal: options.signal,
      });
      accumulatedUsage = mergeUsage(accumulatedUsage, response.usage);

      let agentTurn: AgentTurn;
      try {
        agentTurn = parseAgentTurn(response.output);
        invalidResponses = 0;
        correction = undefined;
      } catch (error) {
        invalidResponses += 1;
        if (invalidResponses > maxInvalid) throw error;
        correction = `${error instanceof Error ? error.message : String(error)} Return only the required JSON object.`;
        continue;
      }

      options.onEvent?.({
        type: "subagent.progress",
        subagentId: options.task.id,
        payload: {
          turn: turnNumber,
          activity: agentTurn.activity ?? agentTurn.summary ?? "Processing assignment",
        },
      });

      if (agentTurn.done) {
        return {
          summary: agentTurn.summary as string,
          data: agentTurn.data,
          usage: accumulatedUsage,
          turns: turnNumber,
          toolCalls: totalToolCalls,
        };
      }

      const calls = agentTurn.toolCalls ?? [];
      if (calls.length > 8) {
        throw new Error("Subagent requested more than 8 tools in one turn.");
      }
      if (totalToolCalls + calls.length > maxToolCalls) {
        throw new Error(`Subagent exceeded the ${maxToolCalls} tool-call limit.`);
      }

      const results: Array<Record<string, unknown>> = [];
      for (const [index, call] of calls.entries()) {
        assertNotAborted(options.signal);
        if (READ_ONLY_ROLES.has(options.task.role) && WRITE_TOOLS.has(call.name)) {
          results.push({
            id: call.id ?? `call-${turnNumber}-${index + 1}`,
            name: call.name,
            ok: false,
            output: `${options.task.role} agents are not authorized to use ${call.name}.`,
          });
          continue;
        }

        const callId = call.id ?? `call-${turnNumber}-${index + 1}`;
        options.onEvent?.({
          type: "subagent.tool_call",
          subagentId: options.task.id,
          payload: { callId, name: call.name, arguments: call.arguments },
        });
        const result = await options.tools.execute(call.name, call.arguments, options.task, options.signal);
        totalToolCalls += 1;
        if (
          WRITE_TOOLS.has(call.name) &&
          typeof result.metadata?.path === "string" &&
          typeof result.metadata?.operation === "string"
        ) {
          options.onEvent?.({
            type: "subagent.file_changed",
            subagentId: options.task.id,
            payload: {
              path: result.metadata.path,
              operation: result.metadata.operation,
            },
          });
        }
        results.push({
          id: callId,
          name: call.name,
          ok: result.ok,
          output: bounded(result.output, MAX_TOOL_OUTPUT_CHARS),
          metadata: result.metadata,
        });
      }

      history.push(
        `[Agent turn ${turnNumber}]\n${bounded(response.output, 8_000)}`,
        `[Tool results ${turnNumber}]\n${JSON.stringify(results)}`,
      );
    }

    throw new Error(`Subagent exceeded the ${maxTurns}-turn execution limit.`);
  }
}
