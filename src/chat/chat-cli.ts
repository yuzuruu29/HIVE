import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createInterface } from "node:readline/promises";
import { ProviderRegistry } from "../providers/registry.js";
import type { ProviderAdapter, ProviderConfig, ProviderRoles, RoleAssignment } from "../providers/types.js";
import {
  CHAT_ROLE_META,
  CHAT_ROLE_SLUGS,
  ROLE_KEY,
  classifyTask,
  type ChatRoleSlug,
} from "./roles.js";

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

function isChatRoleSlug(value: string): value is ChatRoleSlug {
  return (CHAT_ROLE_SLUGS as readonly string[]).includes(value);
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

function renderHistory(history: Array<{ role: "user" | "assistant"; content: string }>, max = 12): string {
  const slice = history.slice(-max);
  return slice.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
}

async function chatTurn(
  projectRegistry: ProviderRegistry,
  globalRegistry: ProviderRegistry,
  role: ChatRoleSlug,
  message: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  override?: SessionOverride,
): Promise<string> {
  const target = await resolveChatTarget(projectRegistry, globalRegistry, { slug: role, override });
  const systemPrompt = CHAT_ROLE_META[role].systemPrompt;
  const context = renderHistory(history);
  const prompt = context ? `${context}\n\nUser: ${message}` : message;
  const result = await target.adapter.complete(target.config, {
    prompt,
    model: target.model,
    systemPrompt,
  });
  return result.output.trim();
}

export interface ChatOptions {
  cwd?: string;
  signal?: AbortSignal;
}

export async function runChat(args: string[], options: ChatOptions = {}): Promise<{ exitCode: number; output: string }> {
  const cwd = options.cwd || process.cwd();
  const projectRegistry = new ProviderRegistry(cwd);
  const globalRegistry = new ProviderRegistry(os.homedir());

  let currentRole: ChatRoleSlug | "auto" = "auto";
  let override: SessionOverride | undefined;
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];

  // One-shot: `hive chat "message"`
  if (args.length > 0) {
    const message = args.join(" ");
    const role = currentRole === "auto" ? classifyTask(message) : currentRole;
    const reply = await chatTurn(projectRegistry, globalRegistry, role, message, history, override);
    return { exitCode: 0, output: reply };
  }

  if (!process.stdout.isTTY) {
    return { exitCode: 1, output: "Interactive chat requires a TTY. Use `hive chat \"your message\"` for a single turn." };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("HIVE Chat — type a message. Commands: /role <slug>, /auto, /model <provider/model>, /hivebot <task>, /list, /skill, /clear, /exit");
  console.log(`Current role: ${currentRole}  (auto picks a model per message)\n`);

  try {
    while (true) {
      const line = (await rl.question("› ")).trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        if (cmd === "exit" || cmd === "quit") break;
        if (cmd === "help") {
          console.log("Commands: /role <planning|coding|heavy-reasoning|game-builder|project-coworker|study-buddy>, /auto, /model <provider/model>, /hivebot <task>, /list, /skill, /clear, /exit");
          continue;
        }
        if (cmd === "auto") { currentRole = "auto"; console.log("Role set to auto (classifies each message)."); continue; }
        if (cmd === "clear") { history.length = 0; console.log("Conversation cleared."); continue; }
        if (cmd === "role") {
          const slug = rest[0];
          if (!slug || !isChatRoleSlug(slug)) { console.log(`Unknown role. Choose: ${CHAT_ROLE_SLUGS.join(", ")}`); continue; }
          currentRole = slug; console.log(`Role set to ${slug}.`); continue;
        }
        if (cmd === "model") {
          const [providerId, model] = (rest.join(" ").split("/"));
          if (!providerId) { console.log("Usage: /model <providerId>/<model>"); continue; }
          override = { providerId, model: model || undefined };
          console.log(`Manual model override: ${providerId}/${model || "(default)"}`); continue;
        }
        if (cmd === "list") { console.log(await listChatRoles(projectRegistry, globalRegistry)); continue; }
        if (cmd === "skill") { console.log(describeSkill(cwd)); continue; }
        if (cmd === "hivebot") {
          const { runHivebot } = await import("./hivebot.js");
          await runHivebot(rest.join(" "), options);
          continue;
        }
        console.log(`Unknown command: /${cmd}`);
        continue;
      }

      const role = currentRole === "auto" ? classifyTask(line) : currentRole;
      if (currentRole === "auto") process.stderr.write(`(auto → ${role})\n`);
      try {
        const reply = await chatTurn(projectRegistry, globalRegistry, role, line, history, override);
        history.push({ role: "user", content: line });
        history.push({ role: "assistant", content: reply });
        console.log(`\n${reply}\n`);
      } catch (err: any) {
        console.log(`\nError: ${err.message}\n`);
      }
    }
  } finally {
    rl.close();
  }
  return { exitCode: 0, output: "" };
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

function describeSkill(cwd: string): string {
  const candidates = [
    path.join(cwd, "skills", "hive-mind-council", "skills", "hive-mind-council"),
    path.join(cwd, "skills", "hive-mind-council"),
  ];
  for (const c of candidates) {
    try {
      fsSync.accessSync(path.join(c, "agents", "Queen.md"));
      return `Built-in hive skill: hive-mind-council\nLocated at: ${c}\nSix-role council: Queen, Scout, Architect, Forger, Sentinel, Scribe.\nRun a swarm with: hive hivebot "<task>"`;
    } catch {
      /* next */
    }
  }
  return "Built-in hive skill (hive-mind-council) not found in this build.";
}
