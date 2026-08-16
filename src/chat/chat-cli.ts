import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { ProviderRegistry } from "../providers/registry.js";
import type { ProviderAdapter, ProviderConfig, ProviderRoles, RoleAssignment } from "../providers/types.js";
import { createChatEngine, type ChatEngine, type ChatEngineOptions } from "./engine.js";
import {
  CHAT_ROLE_META,
  CHAT_ROLE_SLUGS,
  ROLE_KEY,
  classifyTask,
  normalizeChatRole,
  type ChatRoleSlug,
} from "./roles.js";
import type { ChatBindingRole, SubagentTask } from "../coding/types.js";
import type { AgentCompletionClient } from "../coding/agent-loop.js";
import { StructuredAgentLoop } from "../coding/agent-loop.js";
import type { ChatMessage, ChatReceipt, SessionProviderOverride } from "./types.js";
import { locateSkillRoot } from "./skill-locate.js";
import { createReadOnlyToolExecutor, describeReadOnlyTools } from "./agent-tools.js";

interface ResolvedTarget {
  providerId: string;
  model: string;
  adapter: ProviderAdapter;
  config: ProviderConfig;
}

interface SessionOverride {
  providerId?: string;
  model?: string;
}

async function getAdapterSafe(reg: ProviderRegistry, id: string): Promise<ResolvedTarget | null> {
  try {
    const { adapter, config } = await reg.getAdapter(id);
    const model = config.defaultModel || config.model || "";
    return { providerId: id, model, adapter, config };
  } catch {
    return null;
  }
}

/** Resolves a chat role (or manual override) to a concrete provider + model via BYOK registries. */
export async function resolveChatTarget(
  projectRegistry: ProviderRegistry,
  globalRegistry: ProviderRegistry,
  opts: { slug?: ChatRoleSlug; override?: SessionOverride },
): Promise<ResolvedTarget> {
  if (opts.override?.providerId) {
    const target = (await getAdapterSafe(projectRegistry, opts.override.providerId)) ||
      (await getAdapterSafe(globalRegistry, opts.override.providerId));
    if (!target) throw new Error(`Provider ${opts.override.providerId} not found or not approved.`);
    target.model = opts.override.model || target.config.defaultModel || target.config.model || "";
    return target;
  }

  if (opts.slug) {
    const key = ROLE_KEY[opts.slug];
    const projectRoles = await projectRegistry.getRoles();
    const globalRoles = await globalRegistry.getRoles();
    const assignment: RoleAssignment | undefined = projectRoles[key] ?? globalRoles[key];
    if (assignment) {
      const target = (await getAdapterSafe(projectRegistry, assignment.provider)) ||
        (await getAdapterSafe(globalRegistry, assignment.provider));
      if (target) {
        target.model = assignment.model;
        return target;
      }
    }
  }

  // Fallback: first approved provider from project, then global registry.
  for (const reg of [projectRegistry, globalRegistry]) {
    const providers = await reg.list();
    const approved = providers.filter((p) => p.approved);
    if (approved.length > 0) {
      const target = await getAdapterSafe(reg, approved[0].id);
      if (target) return target;
    }
  }
  throw new Error(
    "No approved provider configured. Run `hive providers setup` (BYOK) or `hive providers add --id <id> --kind <kind> --api-key-env <ENV>`.",
  );
}

// ---------------------------------------------------------------------------
// Flag parsing / history budget trim (exported for tests)
// ---------------------------------------------------------------------------

export interface ParsedChatArgs {
  /** Raw initial role slug (before normalization). */
  role?: string;
  json: boolean;
  agent: boolean;
  override?: SessionOverride;
  positionals: string[];
}

/**
 * Minimal chat flag parser. Flags may appear anywhere; anything that is not a
 * recognized flag is treated as positional (the one-shot message).
 * `--model` splits on the FIRST "/" only so OpenRouter-style provider ids
 * (e.g. `openrouter/providers...`) survive as the model part.
 */
export function parseChatArgs(args: string[]): ParsedChatArgs {
  const parsed: ParsedChatArgs = { json: false, agent: false, positionals: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--agent") {
      parsed.agent = true;
    } else if (arg === "--role") {
      const value = args[i + 1];
      if (value !== undefined) {
        parsed.role = value;
        i += 1;
      }
    } else if (arg === "--model") {
      const value = args[i + 1];
      if (value !== undefined) {
        const slash = value.indexOf("/");
        parsed.override =
          slash === -1
            ? { providerId: value }
            : { providerId: value.slice(0, slash), model: value.slice(slash + 1) || undefined };
        i += 1;
      }
    } else {
      parsed.positionals.push(arg);
    }
  }
  return parsed;
}

/** Rough per-turn budget for history that is sent to the model. */
export const HISTORY_CHAR_BUDGET = 48_000;

/**
 * Returns the most recent messages that together fit within `maxChars` total
 * content length, preserving order. Always keeps at least the newest message.
 */
export function trimHistoryBudget(
  history: ChatMessage[],
  maxChars = HISTORY_CHAR_BUDGET,
): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const size = history[i].content.length;
    if (kept.length > 0 && total + size > maxChars) break;
    kept.unshift(history[i]);
    total += size;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugToBinding(slug: ChatRoleSlug): ChatBindingRole {
  return normalizeChatRole(slug) ?? "coding";
}

function bindingToSlug(binding: ChatBindingRole): ChatRoleSlug {
  for (const slug of CHAT_ROLE_SLUGS) {
    if (slugToBinding(slug) === binding) return slug;
  }
  return "coding";
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function formatReceiptLine(role: string, receipt: ChatReceipt): string {
  const tokens =
    receipt.totalTokens ?? (receipt.promptTokens ?? 0) + (receipt.completionTokens ?? 0);
  const latency = receipt.latencyMs !== undefined ? (receipt.latencyMs / 1000).toFixed(1) : "?";
  const degraded = receipt.degraded ? " (degraded)" : "";
  return `[${role} → ${receipt.providerId}/${receipt.model} · ${formatTokens(tokens)} tok · ${latency}s]${degraded}`;
}

function renderHistory(history: ChatMessage[]): string {
  return history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

interface TurnInput {
  cwd?: string;
  engine: ChatEngine;
  role: ChatRoleSlug;
  message: string;
  history: ChatMessage[];
  override?: SessionOverride;
  signal?: AbortSignal;
}

/** Single (non-agent) completion through the engine. */
async function completeTurn(input: TurnInput): Promise<{ output: string; receipt: ChatReceipt }> {
  const systemPrompt = CHAT_ROLE_META[input.role].systemPrompt;
  const context = renderHistory(trimHistoryBudget(input.history));
  const prompt = context ? `${context}\n\nUser: ${input.message}` : input.message;
  return input.engine.complete({
    role: slugToBinding(input.role),
    prompt,
    systemPrompt,
    providerId: input.override?.providerId,
    model: input.override?.model,
    signal: input.signal,
  });
}

/** Agentic turn driven by StructuredAgentLoop with the engine as completion client. */
async function completeAgentTurn(input: TurnInput): Promise<{ output: string; receipt: ChatReceipt }> {
  const binding = slugToBinding(input.role);
  const persona = CHAT_ROLE_META[input.role].systemPrompt;
  const toolsDesc = describeReadOnlyTools();

  let lastReceipt: ChatReceipt | undefined;
  const completionClient: AgentCompletionClient = {
    complete(request) {
      const systemPrompt = [
        persona,
        toolsDesc,
        "You may use tools to ground answers; you cannot modify anything.",
        'Return exactly one JSON object per turn: {"done":false,"toolCalls":[{"id":"call-1","name":"read_file","arguments":{"path":"src/foo.ts"}}]}',
        'or {"done":true,"summary":"..."}.',
      ].join("\n");
      return input.engine
        .complete({
          role: binding,
          prompt: request.prompt,
          systemPrompt,
          providerId: request.providerId || input.override?.providerId,
          model: request.model || input.override?.model,
          signal: request.signal ?? input.signal,
        })
        .then((result) => {
          lastReceipt = result.receipt;
          return {
            output: result.output,
            usage: {
              input: result.receipt.promptTokens,
              output: result.receipt.completionTokens,
              total: result.receipt.totalTokens,
            },
          };
        });
    },
  };

  const task: SubagentTask = {
    id: `chat-${Date.now()}`,
    sessionId: "",
    role: "scout",
    title: input.message,
    objective: input.message,
    status: "created",
    providerId: input.override?.providerId ?? "",
    model: input.override?.model,
    dependencies: [],
    fileScope: [],
    expectedOutput: input.message,
    completionCriteria: [],
    validationCommands: [],
    depth: 0,
    attempt: 1,
    maxAttempts: 1,
    createdAt: new Date().toISOString(),
  };

  const agentCwd = input.cwd ?? process.cwd();
  const loop = new StructuredAgentLoop();
  const result = await loop.run({
    task,
    cwd: agentCwd,
    sharedContext: renderHistory(trimHistoryBudget(input.history)),
    completionClient,
    tools: createReadOnlyToolExecutor(agentCwd),
    signal: input.signal ?? new AbortController().signal,
    maxTurns: 8,
    maxToolCalls: 24,
  });

  const receipt: ChatReceipt =
    lastReceipt ?? { role: input.role, providerId: "", model: "", degraded: false };
  return { output: result.summary, receipt };
}

function receiptTokens(receipt: ChatReceipt): number {
  return receipt.totalTokens ?? (receipt.promptTokens ?? 0) + (receipt.completionTokens ?? 0);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ChatOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Injectable engine factory for tests; defaults to createChatEngine. */
  createEngine?: (projectRoot: string, sessionId: string, options?: ChatEngineOptions) => ChatEngine;
}

export async function runChat(
  args: string[],
  options: ChatOptions = {},
): Promise<{ exitCode: number; output: string }> {
  const cwd = options.cwd || process.cwd();
  const parsed = parseChatArgs(args);
  const sessionId = `chat-${Date.now()}`;
  const makeEngine =
    options.createEngine ??
    ((projectRoot: string, sid: string, opts?: ChatEngineOptions) =>
      createChatEngine(projectRoot, sid, opts));
  const engine = makeEngine(cwd, sessionId);

  let currentRole: ChatRoleSlug | "auto";
  if (parsed.role) {
    const binding = normalizeChatRole(parsed.role);
    if (!binding) {
      return {
        exitCode: 1,
        output: `Unknown role '${parsed.role}'. Choose: ${CHAT_ROLE_SLUGS.join(", ")}`,
      };
    }
    currentRole = bindingToSlug(binding);
  } else {
    currentRole = "auto";
  }
  let override: SessionOverride | undefined = parsed.override;
  let agentMode = parsed.agent;
  const history: ChatMessage[] = [];
  let sessionTokens = 0;

  const message = parsed.positionals.join(" ");
  if (message) {
    return runOneShot(engine, {
      cwd,
      currentRole,
      override,
      message,
      json: parsed.json,
      signal: options.signal,
    });
  }
  if (parsed.json) {
    return { exitCode: 1, output: "JSON mode requires a message: `hive chat --json \"your message\"`" };
  }
  if (!process.stdout.isTTY) {
    return {
      exitCode: 1,
      output: "Interactive chat requires a TTY. Use `hive chat \"your message\"` for a single turn.",
    };
  }

  // ---- Interactive REPL ----
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const HELP = `Commands: /role <slug>, /auto, /model <providerId>/<model>, /list, /skill, /clear, /agent on|off, /exit, /help`;
  console.log("HIVE Chat — type a message. " + HELP);
  console.log(`Current role: ${currentRole}  (auto picks a model per message)\n`);

  const turnController = new AbortController();
  if (options.signal) {
    options.signal.addEventListener("abort", () => turnController.abort(), { once: true });
  }
  let turnInFlight = false;
  let sigintCount = 0;
  let running = true;

  // Ctrl+C once cancels the in-flight turn; Ctrl+C twice exits the REPL.
  rl.on("SIGINT", () => {
    if (turnInFlight && !turnController.signal.aborted) {
      turnController.abort();
      process.stderr.write("\n[turn interrupted — press Ctrl+C again to exit]\n");
      return;
    }
    sigintCount += 1;
    if (sigintCount >= 2) {
      running = false;
      rl.close();
    } else {
      process.stderr.write("\n[press Ctrl+C again to exit]\n");
    }
  });

  try {
    while (running) {
      let line: string;
      try {
        line = (await rl.question("› ")).trim();
      } catch {
        break; // readline closed on Ctrl+C
      }
      if (!line) continue;

      // Slash commands
      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        if (cmd === "exit" || cmd === "quit") {
          break;
        }
        if (cmd === "help") {
          console.log(HELP);
          continue;
        }
        if (cmd === "auto") {
          currentRole = "auto";
          console.log("Role set to auto (classifies each message).");
          continue;
        }
        if (cmd === "clear") {
          history.length = 0;
          sessionTokens = 0;
          console.log("Conversation cleared.");
          continue;
        }
        if (cmd === "role") {
          const slug = rest[0];
          if (!slug) {
            console.log(`Unknown role. Choose: ${CHAT_ROLE_SLUGS.join(", ")}`);
            continue;
          }
          const binding = normalizeChatRole(slug);
          if (!binding) {
            console.log(`Unknown role. Choose: ${CHAT_ROLE_SLUGS.join(", ")}`);
            continue;
          }
          currentRole = bindingToSlug(binding);
          console.log(`Role set to ${currentRole}.`);
          continue;
        }
        if (cmd === "model") {
          const raw = rest.join(" ");
          const slash = raw.indexOf("/");
          const providerId = slash === -1 ? raw : raw.slice(0, slash);
          const model = slash === -1 ? undefined : raw.slice(slash + 1) || undefined;
          if (!providerId) {
            console.log("Usage: /model <providerId>/<model>");
            continue;
          }
          override = { providerId, model };
          console.log(`Manual model override: ${providerId}/${model ?? "(default)"}`);
          continue;
        }
        if (cmd === "list") {
          console.log(await listChatRoles(new ProviderRegistry(cwd), new ProviderRegistry(os.homedir())));
          continue;
        }
        if (cmd === "skill") {
          console.log(await describeSkill(cwd));
          continue;
        }
        if (cmd === "agent") {
          const state = rest[0];
          if (state === "on") {
            agentMode = true;
            console.log("Agentic mode ON (read-only tools available).");
          } else if (state === "off") {
            agentMode = false;
            console.log("Agentic mode OFF.");
          } else {
            console.log("Usage: /agent on|off");
          }
          continue;
        }
        console.log(`Unknown command: /${cmd}`);
        continue;
      }

      // Resolve role (auto classifies, or use current manual role).
      const role = currentRole === "auto" ? classifyTask(line) : currentRole;
      const roleSource = currentRole === "auto" ? "auto" : "manual";
      if (currentRole === "auto") process.stderr.write(`(auto → ${role})\n`);

      const myTurn = { cwd, engine, role, message: line, history, override };
      const runTurn = agentMode ? completeAgentTurn : completeTurn;

      turnInFlight = true;
      try {
        const result = await runTurn({ ...myTurn, signal: turnController.signal });
        history.push({ role: "user", content: line, at: new Date().toISOString() });
        history.push({ role: "assistant", content: result.output, at: new Date().toISOString(), receipt: result.receipt });
        sessionTokens += receiptTokens(result.receipt);
        process.stderr.write(`${formatReceiptLine(role, result.receipt)}\n`);
        console.log(`\n${result.output}\n`);
      } catch (error) {
        if (turnController.signal.aborted) {
          console.log("\nTurn cancelled.\n");
        } else {
          console.log(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      } finally {
        turnInFlight = false;
      }
    }
  } finally {
    process.stderr.write(`\nSession tokens: ${formatTokens(sessionTokens)}\n`);
    rl.close();
  }
  return { exitCode: 0, output: "" };
}

async function runOneShot(
  engine: ChatEngine,
  opts: {
    cwd: string;
    currentRole: ChatRoleSlug | "auto";
    override?: SessionOverride;
    message: string;
    json: boolean;
    signal?: AbortSignal;
  },
): Promise<{ exitCode: number; output: string }> {
  const role = opts.currentRole === "auto" ? classifyTask(opts.message) : opts.currentRole;
  const roleSource = opts.currentRole === "auto" ? "auto" : "manual";

  if (opts.json) {
    const events: unknown[] = [];
    const push = (event: unknown) => events.push(event);
    const line = (event: unknown) => JSON.stringify(event) + "\n";

    push({ type: "user", role: "user", content: opts.message, at: new Date().toISOString() });
    push({ type: "role", role, source: roleSource });
    try {
      const result = await completeTurn({
        engine,
        role,
        message: opts.message,
        history: [],
        override: opts.override,
        signal: opts.signal,
      });
      push({ type: "receipt", ...result.receipt });
      push({ type: "assistant", role: "assistant", content: result.output });
    } catch (error) {
      push({ type: "error", error: error instanceof Error ? error.message : String(error) });
      return { exitCode: 1, output: events.map(line).join("") };
    }
    // NDJSON is returned as the output so the CLI layers emit it to stdout.
    return { exitCode: 0, output: events.map(line).join("") };
  }

  try {
    const result = await completeTurn({
      engine,
      role,
      message: opts.message,
      history: [],
      override: opts.override,
      signal: opts.signal,
    });
    process.stderr.write(`${formatReceiptLine(role, result.receipt)}\n`);
    return { exitCode: 0, output: result.output };
  } catch (error) {
    return { exitCode: 1, output: `Error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function listChatRoles(projectRegistry: ProviderRegistry, globalRegistry: ProviderRegistry): Promise<string> {
  const projectRoles = await projectRegistry.getRoles();
  const globalRoles = await globalRegistry.getRoles();
  const lines: string[] = ["Chatbot role assignments (BYOK):"];
  for (const slug of CHAT_ROLE_SLUGS) {
    const key = ROLE_KEY[slug];
    const assignment = projectRoles[key] ?? globalRoles[key];
    const scope = projectRoles[key] ? "project" : globalRoles[key] ? "global" : "unset";
    lines.push(`  ${slug.padEnd(18)} ${assignment ? `${assignment.provider}/${assignment.model}` : "(fallback to default provider)"}  [${scope}]`);
  }
  lines.push("");
  lines.push("Providers:");
  const providers = await projectRegistry.list();
  for (const p of providers) lines.push(`  ${p.id} (${p.kind}) [Approved: ${p.approved}]`);
  lines.push("");
  lines.push("Assign a model: `hive providers roles set <camelKey> <providerId> <model>`");
  lines.push("  camelKeys: planning, coding, heavyReasoning, gameBuilder, projectCoworker, studyBuddy");
  return lines.join("\n");
}

async function describeSkill(cwd: string): Promise<string> {
  const root = await locateSkillRoot(cwd);
  if (root) {
    return `Built-in hive skill: hive-mind-council\nLocated at: ${root}\nSix-role council: Queen, Scout, Architect, Forger, Sentinel, Scribe.\nRun a swarm with: hive hivebot "<task>"`;
  }
  return "Built-in hive skill (hive-mind-council) not found in this build.";
}
