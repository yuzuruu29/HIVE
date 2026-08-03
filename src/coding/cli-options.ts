import type {
  ApprovalPolicy,
  CodeMode,
  ProviderBindingRole,
} from "./types.js";

export interface CodeRoleBinding {
  providerId: string;
  model: string;
}

export interface CodeCommandOptions {
  objective?: string;
  mode: CodeMode;
  maxAgents: number;
  maxRetries: number;
  provider?: string;
  model?: string;
  approval: ApprovalPolicy;
  resume?: string;
  noTui: boolean;
  json: boolean;
  noMotion: boolean;
  roleBindings: Partial<Record<ProviderBindingRole, CodeRoleBinding>>;
}

const VALUE_FLAGS = new Set([
  "--mode",
  "--max-agents",
  "--max-retries",
  "--provider",
  "--model",
  "--approval",
  "--resume",
  "--queen",
  "--planner",
  "--scout",
  "--builder",
  "--validator",
  "--reviewer",
  "--fixer",
]);

const BOOLEAN_FLAGS = new Set([
  "--no-tui",
  "--json",
  "--no-motion",
]);

const ROLE_FLAGS: Record<string, ProviderBindingRole> = {
  "--queen": "queen",
  "--planner": "planner",
  "--scout": "scout",
  "--builder": "builder",
  "--validator": "validator",
  "--reviewer": "reviewer",
  "--fixer": "fixer",
};

function parseIntegerInRange(
  flag: string,
  raw: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function parseEnum<T extends string>(
  flag: string,
  raw: string,
  allowed: readonly T[],
): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${flag} must be one of: ${allowed.join(", ")}.`);
  }
  return raw as T;
}

function parseRoleBinding(flag: string, raw: string): CodeRoleBinding {
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(`${flag} must use provider:model format.`);
  }
  const providerId = raw.slice(0, separator).trim();
  const model = raw.slice(separator + 1).trim();
  if (!providerId || !model) {
    throw new Error(`${flag} must use provider:model format.`);
  }
  return { providerId, model };
}

function splitFlagToken(token: string): {
  flag: string;
  inlineValue?: string;
  hasInlineValue: boolean;
} {
  const separator = token.indexOf("=");
  if (separator < 0) {
    return { flag: token, hasInlineValue: false };
  }
  return {
    flag: token.slice(0, separator),
    inlineValue: token.slice(separator + 1),
    hasInlineValue: true,
  };
}

function requiredValue(
  args: readonly string[],
  index: number,
  flag: string,
  inlineValue: string | undefined,
  hasInlineValue: boolean,
): { value: string; consumed: number } {
  if (hasInlineValue) {
    if (!inlineValue || inlineValue.trim() === "") {
      throw new Error(`${flag} requires a value.`);
    }
    return { value: inlineValue.trim(), consumed: 0 };
  }

  const next = args[index + 1];
  if (next === undefined || next.trim() === "" || next.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return { value: next.trim(), consumed: 1 };
}

/** Parse arguments occurring after the `hive code` command. */
export function parseCodeCommandArgs(args: readonly string[]): CodeCommandOptions {
  let mode: CodeMode = "auto";
  let maxAgents = 4;
  let maxRetries = 2;
  let provider: string | undefined;
  let model: string | undefined;
  let approval: ApprovalPolicy = "changes";
  let resume: string | undefined;
  let noTui = false;
  let json = false;
  let noMotion = false;
  const objectiveParts: string[] = [];
  const roleBindings: Partial<Record<ProviderBindingRole, CodeRoleBinding>> = {};
  const seen = new Set<string>();
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (positionalOnly) {
      if (token.trim() !== "") objectiveParts.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!token.startsWith("-")) {
      if (token.trim() !== "") objectiveParts.push(token);
      continue;
    }

    const { flag, inlineValue, hasInlineValue } = splitFlagToken(token);
    if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) {
      throw new Error(`Unknown hive code option: ${flag}.`);
    }
    if (seen.has(flag)) {
      throw new Error(`Duplicate hive code option: ${flag}.`);
    }
    seen.add(flag);

    if (BOOLEAN_FLAGS.has(flag)) {
      if (hasInlineValue) {
        throw new Error(`${flag} does not accept a value.`);
      }
      if (flag === "--no-tui") noTui = true;
      else if (flag === "--json") json = true;
      else noMotion = true;
      continue;
    }

    const parsed = requiredValue(args, index, flag, inlineValue, hasInlineValue);
    index += parsed.consumed;
    const value = parsed.value;

    if (flag === "--mode") {
      mode = parseEnum(flag, value, ["auto", "plan", "review"] as const);
    } else if (flag === "--max-agents") {
      maxAgents = parseIntegerInRange(flag, value, 1, 16);
    } else if (flag === "--max-retries") {
      maxRetries = parseIntegerInRange(flag, value, 0, 10);
    } else if (flag === "--provider") {
      provider = value;
    } else if (flag === "--model") {
      model = value;
    } else if (flag === "--approval") {
      approval = parseEnum(flag, value, ["safe", "changes", "always"] as const);
    } else if (flag === "--resume") {
      resume = value;
    } else {
      const role = ROLE_FLAGS[flag];
      roleBindings[role] = parseRoleBinding(flag, value);
    }
  }

  const objective = objectiveParts.join(" ").trim() || undefined;
  if (!objective && !resume) {
    throw new Error("A coding objective is required unless --resume is provided.");
  }
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error("--provider and --model must be provided together.");
  }

  // Machine output never enters an interactive renderer or emits motion frames.
  if (json) {
    noTui = true;
    noMotion = true;
  }

  return {
    objective,
    mode,
    maxAgents,
    maxRetries,
    provider,
    model,
    approval,
    resume,
    noTui,
    json,
    noMotion,
    roleBindings,
  };
}

export const CODE_COMMAND_HELP = `Usage:
  hive code "<objective>" [options]
  hive code --resume <session-id> [options]

Workflow:
  --mode auto|plan|review       auto plans, edits, validates, and reviews (default: auto)
                                plan inspects and plans without production edits
                                review inspects and validates existing changes
  --max-agents <1..16>          maximum concurrent subagents (default: 4)
  --max-retries <0..10>         retry limit per subagent (default: 2)
  --approval safe|changes|always
                                safe asks before repository changes
                                changes permits repository-local edits (default)
                                always permits configured local operations; prohibited Git actions remain blocked

Provider routing:
  --provider <provider-id>      session provider; must be paired with --model
  --model <model-id>            session model; must be paired with --provider
  --queen <provider:model>      bind the Queen role
  --planner <provider:model>    bind the Planner role
  --scout <provider:model>      bind the Scout role
  --builder <provider:model>    bind the Builder role
  --validator <provider:model>  bind the Validator role
  --reviewer <provider:model>   bind the Reviewer role
  --fixer <provider:model>      bind the Fixer role
                                model names may contain slashes; the first colon separates provider and model

Session and output:
  --resume <session-id>         resume a saved session; objective is optional
  --no-tui                      stream plain terminal logs instead of the TUI
  --json                        emit newline-delimited JSON (NDJSON) events only on stdout;
                                implies --no-tui and --no-motion
  --no-motion                   disable terminal animation`;
