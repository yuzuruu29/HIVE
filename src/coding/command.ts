import { parseCodeCommandArgs, type CodeCommandOptions } from "./cli-options.js";
import { createRuntimeReporter, formatCodingFinalReport } from "./output.js";
import { type QueenProviderOverride } from "./queen.js";
import { createQueenSession } from "./runtime.js";
import { CodingSessionStore } from "./session-store.js";
import type { CodingSessionRecord, ProviderBindingRole, RuntimeEvent } from "./types.js";

export interface CodingCommandRuntime {
  run(): Promise<CodingSessionRecord>;
  cancel?(reason?: unknown): void;
}

export interface CodingRuntimeFactoryOptions {
  repositoryPath: string;
  command: CodeCommandOptions;
  onEvent: (event: RuntimeEvent) => void;
  signal?: AbortSignal;
}

export type CodingRuntimeFactory = (
  options: CodingRuntimeFactoryOptions,
) => CodingCommandRuntime | Promise<CodingCommandRuntime>;

export interface CodingCommandDependencies {
  createRuntime?: CodingRuntimeFactory;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface CodingCommandResult {
  exitCode: number;
  output: string;
  session?: CodingSessionRecord;
}

function roleOverrides(command: CodeCommandOptions): Partial<Record<ProviderBindingRole, QueenProviderOverride>> {
  const overrides: Partial<Record<ProviderBindingRole, QueenProviderOverride>> = {};
  for (const [role, binding] of Object.entries(command.roleBindings)) {
    if (binding) overrides[role as ProviderBindingRole] = {
      providerId: binding.providerId,
      model: binding.model,
    };
  }
  return overrides;
}

export async function createDefaultCodingRuntime(
  options: CodingRuntimeFactoryOptions,
): Promise<CodingCommandRuntime> {
  const overrides = roleOverrides(options.command);
  if (options.command.provider && options.command.model) {
    for (const role of ["queen", "planner", "scout", "builder", "validator", "reviewer", "fixer"] as const) {
      overrides[role] ??= { providerId: options.command.provider, model: options.command.model };
    }
  }
  const { orchestrator } = await createQueenSession({
    repositoryPath: options.repositoryPath,
    objective: options.command.objective,
    resumeId: options.command.resume,
    mode: options.command.mode,
    approvalPolicy: options.command.approval,
    maxAgents: options.command.maxAgents,
    maxRetries: options.command.maxRetries,
    providerOverride: options.command.provider && options.command.model
      ? { providerId: options.command.provider, model: options.command.model }
      : undefined,
    roleOverrides: overrides,
    signal: options.signal,
    onEvent: options.onEvent,
  });
  return orchestrator;
}

function exitCodeForStatus(status: CodingSessionRecord["status"]): number {
  if (status === "completed") return 0;
  if (status === "cancelled") return 130;
  return 1;
}

function finalReport(record: CodingSessionRecord): string {
  if (!record.finalReport) {
    return `Coding session ${record.id} is ${record.status}.`;
  }
  return formatCodingFinalReport({
    sessionId: record.id,
    objective: record.objective,
    result: record.finalReport.result,
    subagents: {
      completed: record.finalReport.subagents.completed,
      failed: record.finalReport.subagents.failed,
      cancelled: record.finalReport.subagents.cancelled,
    },
    filesChanged: record.finalReport.filesChanged,
    validation: record.finalReport.validation.map((item) => ({
      name: item.label,
      passed: item.status === "passed",
    })),
    review: record.finalReport.review,
    outstanding: record.finalReport.outstanding,
  });
}

/** Execute arguments occurring after `hive code`. */
export async function runCodeCommand(
  args: readonly string[],
  repositoryPath: string,
  dependencies: CodingCommandDependencies = {},
): Promise<CodingCommandResult> {
  let command: CodeCommandOptions;
  try {
    command = parseCodeCommandArgs(args);
  } catch (error) {
    return { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  }

  const reporter = createRuntimeReporter({ json: command.json, onLine: dependencies.onLine });
  const factory = dependencies.createRuntime ?? createDefaultCodingRuntime;
  try {
    const runtime = await factory({
      repositoryPath,
      command,
      onEvent: reporter.emit,
      signal: dependencies.signal,
    });
    const record = await runtime.run();
    await new CodingSessionStore(record.repository.root).setActive(record.id).catch(() => undefined);
    const streamed = dependencies.onLine !== undefined;
    if (command.json) {
      return { exitCode: exitCodeForStatus(record.status), output: streamed ? "" : reporter.lines.join("\n"), session: record };
    }
    const report = finalReport(record);
    const output = streamed ? report : [...reporter.lines, report].filter(Boolean).join("\n");
    return { exitCode: exitCodeForStatus(record.status), output, session: record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (command.json) {
      const line = JSON.stringify({ type: "error", error: message });
      if (dependencies.onLine) dependencies.onLine(line);
      return { exitCode: 1, output: dependencies.onLine ? "" : line };
    }
    return { exitCode: 1, output: message };
  }
}
