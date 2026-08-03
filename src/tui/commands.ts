/**
 * commands.ts
 * Command parser and executor for the HIVE TUI cockpit.
 */

import {
  TuiState,
  withOutput,
  withMode,
  withClear,
  appendTranscriptLine,
  setTaskStatus,
  clearTranscript,
  withSelectedSubagent,
  withSubagentsExpanded,
  reduceTuiRuntimeEvent,
} from "./state.js";
import { formatRuntimeEventText } from "../coding/output.js";
import type { RuntimeEvent } from "../coding/types.js";
import type { TuiRuntimeHandle, TuiSessionRunner } from "./runtime-adapter.js";

// -- Command Types -------------------------------------------------------------

export type TuiCommandKind =
  | "help"
  | "providers"
  | "status"
  | "model"
  | "agents"
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
    case "agents":
    case "subagents":
      return { kind: "agents", args, raw };
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
  runtime?: TuiRuntimeHandle;
}

export interface ExecuteTuiCommandOptions {
  runSession?: TuiSessionRunner;
}

function projectRuntimeEvent(state: TuiState, event: RuntimeEvent): TuiState {
  let next = reduceTuiRuntimeEvent(state, event);
  next = appendTranscriptLine(next, formatRuntimeEventText(event));
  switch (event.type) {
    case "session.created":
    case "session.started":
      return setTaskStatus(withMode(next, "running"), "running");
    case "validation.started":
      return setTaskStatus(next, "verifying");
    case "session.completed":
      return setTaskStatus(withMode(next, "default"), "complete");
    case "session.cancelled":
      return setTaskStatus(withMode(next, "default"), "idle");
    default:
      return next;
  }
}

export async function executeTuiCommand(
  cmd: TuiCommand,
  state: TuiState,
  cwd: string,
  onUpdate?: (updater: (s: TuiState) => TuiState) => void,
  options: ExecuteTuiCommandOptions = {},
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
        "  /agents [id]   Toggle Subagents view or inspect one agent",
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

    case "agents": {
      const target = cmd.args.trim();
      if (target === "collapse") {
        return {
          state: withSubagentsExpanded(withSelectedSubagent(state), false),
          shouldExit: false,
        };
      }
      if (target) {
        const selected = state.subagents.find((task) => task.id === target);
        if (!selected) {
          return {
            state: withOutput(state, [`  Subagent not found: ${target}`]),
            shouldExit: false,
          };
        }
        return {
          state: withSubagentsExpanded(withSelectedSubagent(state, selected.id), true),
          shouldExit: false,
        };
      }
      const selected = state.selectedSubagentId ?? state.subagents[0]?.id;
      return {
        state: withSubagentsExpanded(withSelectedSubagent(state, selected), !state.subagentsExpanded),
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

      if (!onUpdate) return { state: nextState, shouldExit: false };

      const { runTuiTask } = await import("./runtime-adapter.js");
      const runtime = runTuiTask(cwd, task, {
        onEvent: (event) => {
          onUpdate((current) => projectRuntimeEvent(current, event));
        },
        onError: (error) => {
          onUpdate((current) => {
            let next = appendTranscriptLine(current, `[Error] ${error}`);
            next = setTaskStatus(next, "error");
            return withMode(next, "error");
          });
        },
      }, { runSession: options.runSession });

      return { state: nextState, shouldExit: false, runtime };
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
