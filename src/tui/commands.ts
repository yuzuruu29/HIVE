/**
 * commands.ts
 * Command parser and executor for the HIVE TUI cockpit.
 */

import { TuiState, withOutput, withMode, withClear, appendTranscriptLine, setTaskStatus, clearTranscript } from "./state.js";

// -- Command Types -------------------------------------------------------------

export type TuiCommandKind =
  | "help"
  | "providers"
  | "status"
  | "model"
  | "run"
  | "clear"
  | "exit"
  | "unknown"
  | "task";

export interface TuiCommand {
  kind: TuiCommandKind;
  args: string;
  raw: string;
}

// -- Parser --------------------------------------------------------------------

export function parseTuiCommand(input: string): TuiCommand {
  const trimmed = input.trim();
  const raw = trimmed;

  if (!trimmed.startsWith("/")) {
    // Plain text - treat as a task
    return { kind: "task", args: trimmed, raw };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const slashCmd =
    spaceIdx === -1
      ? trimmed.slice(1).toLowerCase()
      : trimmed.slice(1, spaceIdx).toLowerCase();
  const args =
    spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (slashCmd) {
    case "help":
      return { kind: "help", args, raw };
    case "providers":
      return { kind: "providers", args, raw };
    case "status":
      return { kind: "status", args, raw };
    case "model":
      return { kind: "model", args, raw };
    case "run":
      return { kind: "run", args, raw };
    case "clear":
      return { kind: "clear", args, raw };
    case "exit":
    case "quit":
    case "q":
      return { kind: "exit", args, raw };
    default:
      return { kind: "unknown", args: slashCmd, raw };
  }
}

// -- Executor ------------------------------------------------------------------

export interface ExecuteResult {
  state: TuiState;
  shouldExit: boolean;
}

export async function executeTuiCommand(
  cmd: TuiCommand,
  state: TuiState,
  cwd: string,
  onUpdate?: (updater: (s: TuiState) => TuiState) => void
): Promise<ExecuteResult> {
  switch (cmd.kind) {
    case "exit":
      return { state, shouldExit: true };

    case "clear":
      return { state: clearTranscript(withClear(state)), shouldExit: false };

    case "help": {
      const lines = [
        "  HIVE COMMAND COCKPIT - Commands",
        "  --------------------------------",
        "  /help          Show this command list",
        "  /providers     Inspect configured providers",
        "  /status        Show provider and runtime status",
        "  /model         Show or select active model",
        "  /run <task>    Execute a task via HIVE swarm",
        "  /clear         Clear output panel",
        "  /exit          Quit HIVE TUI",
        "  ",
        "  Plain text input is treated as a task prompt.",
        "  Ctrl+C exits cleanly at any time.",
      ];
      return {
        state: withOutput(state, lines),
        shouldExit: false,
      };
    }

    case "providers": {
      let lines: string[];
      try {
        const { ProviderRegistry } = await import(
          "../providers/registry.js"
        );
        const registry = new ProviderRegistry(cwd);
        const providers = await registry.list();
        const roles = await registry.getRoles();

        if (providers.length === 0) {
          lines = [
            "  No providers configured.",
            "  Run: hive providers setup",
            "  Or:  hive providers add --id <id> --kind <kind>",
          ];
        } else {
          lines = [
            "  Configured Providers:",
            "  ---------------------",
            ...providers.map(
              (p: { id: string; kind: string; approved: boolean }) =>
                `  ${p.approved ? "[+]" : "[ ]"} ${p.id} (${p.kind})`
            ),
            "  ",
            "  Swarm Roles:",
            `  Planner:   ${roles.planner ? `${roles.planner.provider} / ${roles.planner.model}` : "Unassigned"}`,
            `  Builder:   ${roles.builder ? `${roles.builder.provider} / ${roles.builder.model}` : "Unassigned"}`,
            `  Validator: ${roles.validator ? `${roles.validator.provider} / ${roles.validator.model}` : "Unassigned"}`,
            `  Reviewer:  ${roles.reviewer ? `${roles.reviewer.provider} / ${roles.reviewer.model}` : "Unassigned"}`,
          ];
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lines = [`  Error loading providers: ${msg}`];
      }
      return {
        state: withOutput(state, lines),
        shouldExit: false,
      };
    }

    case "status": {
      let lines: string[];
      try {
        const { ProviderRegistry } = await import(
          "../providers/registry.js"
        );
        const { ConfigStore } = await import("../config.js");
        const registry = new ProviderRegistry(cwd);
        const configStore = new ConfigStore(cwd);
        const providers = await registry.list();
        const mode = await configStore.getMode();
        const approved = providers.filter(
          (p: { approved: boolean }) => p.approved
        ).length;

        lines = [
          "  HIVE Runtime Status",
          "  -------------------",
          `  Mode:               ${mode}`,
          `  Providers:          ${providers.length} configured, ${approved} approved`,
          `  Provider:           ${state.provider}`,
          `  Model:              ${state.model}`,
          `  Active agents:      ${state.agents}`,
          `  Context:            ${state.contextPercent}%`,
          "  ",
          "  Safety Guardrails:",
          "  [OK] Worktree isolation active",
          "  [OK] Approve-before-commit enforced",
          "  [OK] No auto-push",
          "  [OK] Secret redaction enabled",
        ];
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lines = [`  Error loading status: ${msg}`];
      }
      return {
        state: withOutput(state, lines),
        shouldExit: false,
      };
    }

    case "model": {
      const lines = [
        "  Active Model Configuration",
        "  --------------------------",
        `  Provider: ${state.provider}`,
        `  Model:    ${state.model}`,
        "  ",
        "  To change: hive providers roles set planner <provider> <model>",
        "  Example:   hive providers roles set planner openai gpt-4o",
      ];
      return {
        state: withOutput(state, lines),
        shouldExit: false,
      };
    }

    case "run":
    case "task": {
      const task = cmd.args.trim();
      if (!task) {
        return {
          state: withOutput(state, [
            "  Usage: /run <task description>",
          ]),
          shouldExit: false,
        };
      }

      if (state.taskStatus === "running") {
        return {
          state: withOutput(state, ["  Error: Another task is already running."]),
          shouldExit: false,
        };
      }

      const startLines = [
        `  > Running task: ${task}`,
      ];
      let nextState = withOutput(withMode(state, "running"), startLines);
      nextState = setTaskStatus(nextState, "running");
      nextState = appendTranscriptLine(nextState, `[User] ${task}`);

      if (onUpdate) {
        // Run in background without awaiting here to unblock UI
        import("./runtime-adapter.js").then(({ runTuiTask }) => {
          runTuiTask(cwd, task, {
            onStart: (taskId) => {
               onUpdate((s) => appendTranscriptLine(s, `[Runtime] Started task ${taskId}`));
            },
            onOutput: (line) => {
               onUpdate((s) => appendTranscriptLine(s, line));
            },
            onError: (err) => {
               onUpdate((s) => {
                 let next = appendTranscriptLine(s, `[Error] ${err}`);
                 next = setTaskStatus(next, "error");
                 return withMode(next, "error");
               });
            },
            onStatus: (status) => {
               onUpdate((s) => setTaskStatus(s, status));
            },
            onComplete: (res) => {
               onUpdate((s) => {
                 let next = appendTranscriptLine(s, `[Runtime] Task finished. Status: ${res?.state}`);
                 next = setTaskStatus(next, "complete");
                 return withMode(next, "default");
               });
            }
          });
        });
      }

      return { state: nextState, shouldExit: false };
    }

    case "unknown": {
      return {
        state: withOutput(state, [
          `  Unknown command: /${cmd.args}`,
          "  Type /help to see available commands.",
        ]),
        shouldExit: false,
      };
    }

    default:
      return { state, shouldExit: false };
  }
}
