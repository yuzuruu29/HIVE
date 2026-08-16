import { randomBytes } from "node:crypto";

import type { DesktopEvent } from "./types.js";
import { runHivebot, type HivebotOptions, type HivebotResult } from "../chat/hivebot.js";

export interface DesktopCouncilStartInput {
  task: string;
  preset?: "quick" | "standard" | "deep" | "audit";
  providerId?: string;
  model?: string;
}

export interface DesktopCouncilServiceOptions {
  /** Injectable hivebot runner for tests; defaults to runHivebot. */
  runner?: (task: string, options: HivebotOptions) => Promise<HivebotResult>;
  clock?: () => string;
}

function makeRunId(): string {
  return `hivebot-${Date.now()}-${randomBytes(2).toString("hex")}`;
}

/**
 * Council (hivebot) runs for the desktop shell. One-shot per task, keyed by
 * runId, executed against the currently open repository root.
 */
export class DesktopCouncilService {
  readonly #projectRootProvider: () => string;
  readonly #emit: (event: DesktopEvent) => void;
  readonly #runner: NonNullable<DesktopCouncilServiceOptions["runner"]>;
  readonly #clock: () => string;
  readonly #controllers = new Map<string, AbortController>();

  public constructor(projectRootProvider: () => string, emit: (event: DesktopEvent) => void, options: DesktopCouncilServiceOptions = {}) {
    this.#projectRootProvider = projectRootProvider;
    this.#emit = emit;
    this.#runner = options.runner ?? ((task, runOptions) => runHivebot(task, runOptions));
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  /** Initiates a council run; resolves once started (stages stream via events). */
  public async start(input: DesktopCouncilStartInput): Promise<string> {
    const root = this.#projectRootProvider();
    const runId = makeRunId();
    const controller = new AbortController();
    this.#controllers.set(runId, controller);
    this.#emit({ type: "council.started", timestamp: this.#clock(), runId, preset: input.preset ?? "standard" });

    void this.#runner(input.task, {
      cwd: root,
      preset: input.preset,
      providerId: input.providerId,
      model: input.model,
      runId,
      signal: controller.signal,
      onStage: (stage) => this.#emit({ type: "council.stage", timestamp: this.#clock(), runId, stage }),
    })
      .then((result) => {
        const { exitCode: _exitCode, output: _output, ...summary } = result;
        this.#emit({ type: "council.completed", timestamp: this.#clock(), runId, summary });
      })
      .catch((error: unknown) => {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000) || "Council run failed.";
        this.#emit({ type: "council.failed", timestamp: this.#clock(), runId, message });
      })
      .finally(() => {
        if (this.#controllers.get(runId) === controller) this.#controllers.delete(runId);
      });
    return runId;
  }

  public cancel(runId: string): void {
    this.#controllers.get(runId)?.abort();
  }

  public cancelAll(): void {
    for (const controller of this.#controllers.values()) controller.abort();
  }
}
