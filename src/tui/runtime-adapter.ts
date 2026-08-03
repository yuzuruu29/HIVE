import fs from "node:fs/promises";
import path from "node:path";
import { StandaloneExecutor } from "../api-client.js";
import { ConfigStore } from "../config.js";
import { RuntimeEventBus } from "../coding/events.js";
import { runQueenSession } from "../coding/runtime.js";
import type { RuntimeEvent } from "../coding/types.js";
import { CoderOrchestrator } from "../orchestrator.js";
import { ProviderRegistry } from "../providers/registry.js";
import { TaskStore } from "../store.js";
import { ProviderRole, ProviderSnapshot } from "../types.js";

export interface TuiRuntimeCallbacks {
  /** Canonical runtime feed. TUI state must be projected from these events. */
  onEvent: (event: RuntimeEvent) => void;
  onError?: (error: string) => void;
  onComplete?: (result: unknown) => void;
}

export interface TuiSessionRunnerOptions {
  cwd: string;
  objective: string;
  signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
}

export type TuiSessionRunner = (options: TuiSessionRunnerOptions) => Promise<unknown>;

export interface TuiRuntimeHandle {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  cancel: (reason?: string) => void;
}

export interface TuiRuntimeDependencies {
  runSession?: TuiSessionRunner;
}

/** Production TUI runner backed by the canonical Queen coding session. */
export const runQueenTuiSession: TuiSessionRunner = ({
  cwd,
  objective,
  signal,
  onEvent,
}) => runQueenSession({
  repositoryPath: cwd,
  objective,
  mode: "auto",
  approvalPolicy: "changes",
  maxAgents: 4,
  maxRetries: 2,
  signal,
  onEvent,
});

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
    .then(() => runSession({
      cwd,
      objective: taskPrompt,
      signal: controller.signal,
      onEvent: callbacks.onEvent,
    }))
    .then((result) => {
      callbacks.onComplete?.(result);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError?.(message);
    });

  return {
    controller,
    completion,
    cancel(reason = "User requested cancellation.") {
      if (!controller.signal.aborted) controller.abort(reason);
    },
  };
}
