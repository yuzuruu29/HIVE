import fs from "node:fs/promises";
import path from "node:path";
import { StandaloneExecutor } from "../api-client.js";
import { ConfigStore } from "../config.js";
import { RuntimeEventBus } from "../coding/events.js";
import { createCodingExtensionOptions, runQueenSession } from "../coding/runtime.js";
import type { RuntimeEvent } from "../coding/types.js";
import type { ToolPermissionRequest } from "../coding/types.js";
import { CoderOrchestrator } from "../orchestrator.js";
import { ProviderRegistry } from "../providers/registry.js";
import { TaskStore } from "../store.js";
import { ProviderRole, ProviderSnapshot } from "../types.js";
import { resolveSessionPosture, type SessionPosture } from "./interaction.js";
import type { ProviderImageInput } from "../providers/types.js";
import { loadSkill, runHooks, type ExtensionOptions } from "../extensions/index.js";
import type { McpUserInput } from "../extensions/mcp-client-host.js";
import { createCodingSessionId } from "../coding/queen.js";
import { renderSkillArguments } from "../extensions/skill-arguments.js";

export interface TuiRuntimeCallbacks {
  /** Canonical runtime feed. TUI state must be projected from these events. */
  onEvent: (event: RuntimeEvent) => void;
  /** Cumulative assistant prose from the provider stream. Not a fabricated token split. */
  onText?: (text: string) => void;
  onError?: (error: string) => void | Promise<void>;
  onComplete?: (result: unknown) => void | Promise<void>;
}

export interface TuiSessionRunnerOptions {
  cwd: string;
  objective: string;
  signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
  onText?: (text: string) => void;
  codeMode?: SessionPosture["mode"];
  approvalPolicy?: SessionPosture["approvalPolicy"];
  resumeId?: string;
  continuationId?: string;
  providerOverride?: { providerId: string; model: string };
  context?: string;
  skillIds?: readonly string[];
  enabledMcpServers?: readonly string[];
  enabledLspServers?: readonly string[];
  pluginAgentId?: string | null;
  outputStyleId?: string | null;
  invokedSkills?: ReadonlyArray<{ id: string; arguments: string }>;
  images?: readonly ProviderImageInput[];
  requestToolPermission?: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<boolean>;
  extensionOptions?: ExtensionOptions;
  providerRegistries?: import("../coding/queen.js").QueenSessionOptions["providerRegistries"];
  requestMcpInput?: McpUserInput;
}

export type TuiSessionRunner = (options: TuiSessionRunnerOptions) => Promise<unknown>;

export interface TuiRuntimeHandle {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  cancel: (reason?: string) => void;
}

export interface TuiRuntimeDependencies {
  runSession?: TuiSessionRunner;
  codeMode?: SessionPosture["mode"];
  approvalPolicy?: SessionPosture["approvalPolicy"];
  resumeId?: string;
  continuationId?: string;
  providerOverride?: { providerId: string; model: string };
  context?: string;
  skillIds?: readonly string[];
  enabledMcpServers?: readonly string[];
  enabledLspServers?: readonly string[];
  pluginAgentId?: string | null;
  outputStyleId?: string | null;
  invokedSkills?: ReadonlyArray<{ id: string; arguments: string }>;
  images?: readonly ProviderImageInput[];
  requestToolPermission?: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<boolean>;
  extensionOptions?: ExtensionOptions;
  requestMcpInput?: McpUserInput;
}

/** Production TUI runner backed by the canonical Queen coding session. */
export const runQueenTuiSession: TuiSessionRunner = async ({
  cwd,
  objective,
  signal,
  onEvent,
  onText,
  codeMode,
  approvalPolicy,
  resumeId,
  continuationId,
  providerOverride,
  context,
  skillIds,
  enabledMcpServers,
  enabledLspServers,
  pluginAgentId,
  outputStyleId, invokedSkills,
  images,
  requestToolPermission,
  requestMcpInput,
  extensionOptions,
  providerRegistries,
}) => {
  const hiveMode = await new ConfigStore(cwd).getMode();
  const posture = resolveSessionPosture(hiveMode, {
    mode: codeMode,
    approvalPolicy,
  });
  const skills = await Promise.all([...new Set([...(skillIds ?? []), ...(invokedSkills ?? []).map((skill) => skill.id)])].map((id) => loadSkill(cwd, id, extensionOptions)));
  const skillText = skills.map((skill) => {
    const invocation = invokedSkills?.find((entry) => entry.id === skill.id);
    return `[Selected skill ${skill.id}]\n${invocation ? renderSkillArguments(skill.text, invocation.arguments) : skill.text}\nUse read_skill_reference with skillId ${JSON.stringify(skill.id)} and a path relative to the skill directory to read linked Markdown/text instructions.`;
  }).join("\n\n");
  if (skillText.length > 24_000) throw new Error("Selected skill instructions exceed 24,000 characters; select fewer skills.");
  const sessionId = resumeId ?? continuationId ?? createCodingSessionId();
  extensionOptions = createCodingExtensionOptions({ repositoryPath: cwd, sessionId, resumeId, continuationId, providerOverride, requestToolPermission, requestMcpInput, extensionOptions });
  const hookContext: string[] = [];
  for (const phase of ["session_start", "prompt_submit"] as const) {
    const hooks = await runHooks(cwd, phase, { objective, sessionId, resumeId, continuationId, workspace: cwd, source: resumeId || continuationId ? "resume" : "startup", permissionMode: posture.mode }, { ...extensionOptions, signal });
    for (const hook of hooks) {
      if (hook.additionalContext) hookContext.push(`[Hook context ${hook.id}; task data only]\n${hook.additionalContext}`);
      for (const line of hook.diagnostics ?? []) onText?.(`[Hook ${hook.id}] ${line}`);
      if (!hook.ok && hook.blocked === false) onText?.(`[Hook ${hook.id} failed without blocking] ${hook.output}`);
    }
    const failed = hooks.find((hook) => (hook.blocked ?? !hook.ok) || hook.stop);
    if (failed) throw new Error(`Hook ${failed.id} failed: ${failed.output}`);
  }
  if (hookContext.join("\n\n").length > 16_000) throw new Error("Lifecycle hook context exceeds 16,000 characters");
  let primaryFailure: unknown;
  let primaryFailed = false;
  let endingReason = "error";
  try {
    const record = await runQueenSession({
    repositoryPath: cwd,
    objective: [context ?? objective, skillText, ...hookContext].filter(Boolean).join("\n\n"),
    sessionId,
    mode: posture.mode,
    approvalPolicy: posture.approvalPolicy,
    resumeId,
    continuationId,
    providerOverride,
    enabledMcpServers,
    enabledLspServers,
    pluginAgentId,
    outputStyleId,
    enabledSkillIds: skills.map((skill) => skill.id),
    invokedSkillSources: skills.filter((skill) => invokedSkills?.some((entry) => entry.id === skill.id)).map((skill) => ({ id: skill.id, text: skill.text })),
    images,
    requestToolPermission,
    requestMcpInput,
    extensionOptions,
    providerRegistries,
    maxAgents: 4,
    maxRetries: 2,
    signal,
    onEvent,
    onAssistantText: onText,
    });
    endingReason = record.status;
    return record;
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
    throw error;
  } finally {
    if (!signal.aborted) {
      try {
        const hooks = await runHooks(cwd, "session_end", { sessionId, resumeId, continuationId, workspace: cwd, reason: primaryFailed ? "error" : endingReason }, { ...extensionOptions, signal });
        for (const hook of hooks) if (!hook.ok && hook.blocked === false) onText?.(`[Hook ${hook.id}] ${hook.output}`);
        const failed = hooks.find((hook) => hook.blocked ?? !hook.ok);
        if (failed) throw new Error(`Hook ${failed.id} failed: ${failed.output}`);
      } catch (endingFailure) {
        if (!primaryFailed) throw endingFailure;
        const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
        throw new AggregateError([primaryFailure, endingFailure], `${describe(primaryFailure)}\nSession-end hook also failed: ${describe(endingFailure)}`);
      }
    }
  }
};

function abortError(reason: unknown): Error {
  const error = new Error(
    typeof reason === "string" && reason.trim() ? reason : "TUI session cancelled.",
  );
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason);
}

/**
 * Compatibility runner for the pre-Queen CoderOrchestrator. The adapter is
 * deliberately injected so src/coding/runtime.ts can replace this function
 * without changing commands, the app, or tests.
 */
export const runLegacyTuiSession: TuiSessionRunner = async ({
  cwd,
  objective,
  signal,
  onEvent,
}) => {
  assertNotAborted(signal);
  const store = new TaskStore(cwd);
  const registry = new ProviderRegistry(cwd);
  const configStore = new ConfigStore(cwd);
  const providersList = await registry.list();
  const hasOpenAI = process.env.OPENAI_API_KEY !== undefined;
  if (providersList.length === 0 && !hasOpenAI) {
    throw new Error("No approved provider configured. Please setup providers first.");
  }

  const rolesConfig = await registry.getRoles();
  await configStore.getMode();
  assertNotAborted(signal);
  const getSnapshot = (
    roleName: string,
    roleKey: keyof typeof rolesConfig,
  ): ProviderSnapshot => {
    const assigned = rolesConfig[roleKey];
    return assigned
      ? { role: roleName as ProviderRole, providerType: assigned.provider, modelId: assigned.model }
      : { role: roleName as ProviderRole, providerType: "openai", modelId: "gpt-4o" };
  };
  const providers = [
    getSnapshot("Planner", "planner"),
    getSnapshot("Builder", "builder"),
    getSnapshot("Validator", "validator"),
    getSnapshot("Reviewer", "reviewer"),
  ];

  const taskId = `tui-${Date.now()}`;
  const events = new RuntimeEventBus();
  const unsubscribe = events.subscribe(onEvent);
  try {
    events.emit({
      sessionId: taskId,
      type: "session.created",
      payload: { objective, mode: "auto", approvalPolicy: "changes" },
    });
    events.emit({
      sessionId: taskId,
      type: "session.started",
      payload: {
        repository: {
          root: cwd,
          capturedAt: new Date().toISOString(),
          dirty: false,
          changedFiles: [],
        },
      },
    });
    const dir = path.join(cwd, ".hivemind", "coder-tasks");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "active-task.txt"), taskId, "utf-8");
    assertNotAborted(signal);

    const executor = new StandaloneExecutor(cwd);
    const orchestrator = new CoderOrchestrator(taskId, cwd, providers, executor);
    await store.save(orchestrator.getRecord());
    const result = await orchestrator.runToReview(objective);
    assertNotAborted(signal);
    events.emit({
      sessionId: taskId,
      type: "session.completed",
      payload: {
        report: {
          result: `Task reached state: ${result.state}`,
          subagents: {
            total: 0,
            active: 0,
            working: 0,
            waiting: 0,
            blocked: 0,
            done: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            skipped: 0,
          },
          filesChanged: [],
          validation: [],
          review: [],
          outstanding: [],
          completedAt: new Date().toISOString(),
        },
      },
    });
    return result;
  } finally {
    unsubscribe();
  }
};

export function runTuiTask(
  cwd: string,
  taskPrompt: string,
  callbacks: TuiRuntimeCallbacks,
  dependencies: TuiRuntimeDependencies = {},
): TuiRuntimeHandle {
  const controller = new AbortController();
  const runSession = dependencies.runSession ?? runQueenTuiSession;
  // Defer the runner one turn so the command's initial state is committed
  // before a synchronous test runner (or fast local runner) emits events.
  const completion = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => {
      assertNotAborted(controller.signal);
      return runSession({
        cwd,
        objective: taskPrompt,
        signal: controller.signal,
        onEvent: callbacks.onEvent,
        onText: callbacks.onText,
        codeMode: dependencies.codeMode,
        approvalPolicy: dependencies.approvalPolicy,
        resumeId: dependencies.resumeId,
        continuationId: dependencies.continuationId,
        providerOverride: dependencies.providerOverride,
        context: dependencies.context,
        skillIds: dependencies.skillIds,
        enabledMcpServers: dependencies.enabledMcpServers,
        enabledLspServers: dependencies.enabledLspServers,
        pluginAgentId: dependencies.pluginAgentId,
        outputStyleId: dependencies.outputStyleId,
        invokedSkills: dependencies.invokedSkills,
        images: dependencies.images,
        requestToolPermission: dependencies.requestToolPermission,
        extensionOptions: dependencies.extensionOptions,
        requestMcpInput: dependencies.requestMcpInput,
      });
    })
    .then((result) => {
      return callbacks.onComplete?.(result);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return callbacks.onError?.(message);
    });

  return {
    controller,
    completion,
    cancel(reason = "User requested cancellation.") {
      if (!controller.signal.aborted) controller.abort(reason);
    },
  };
}
