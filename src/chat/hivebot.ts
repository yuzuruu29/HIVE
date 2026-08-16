import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { ProviderRegistry } from "../providers/registry.js";
import { CHAT_ROLE_META, type ChatRoleSlug } from "./roles.js";
import { resolveChatTarget, type ChatOptions } from "./chat-cli.js";

async function findRepoRoot(cwd: string): Promise<string> {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
      if (pkg && pkg.name === "hive") return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

/** Locates the built-in hive-mind-council skill (the directory holding agents/Queen.md). */
async function locateSkillRoot(cwd: string): Promise<string | null> {
  const repoRoot = await findRepoRoot(cwd);
  const candidates = [
    path.join(repoRoot, "skills", "hive-mind-council", "skills", "hive-mind-council"),
    path.join(repoRoot, "skills", "hive-mind-council"),
    path.join(cwd, "skills", "hive-mind-council", "skills", "hive-mind-council"),
    path.join(cwd, "skills", "hive-mind-council"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "agents", "Queen.md"));
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function readAgentPrompt(skillRoot: string, agent: string): Promise<string> {
  try {
    return await fs.readFile(path.join(skillRoot, "agents", `${agent}.md`), "utf-8");
  } catch {
    return `${agent} role for the Hive Mind Council.`;
  }
}


const COUNCIL: Array<{ agent: string; slug: ChatRoleSlug; phase: string }> = [
  { agent: "Queen", slug: "planning", phase: "Orchestrate & classify" },
  { agent: "Scout", slug: "coding", phase: "Map context & impact" },
  { agent: "Architect", slug: "planning", phase: "Design executable plan" },
  { agent: "Forger", slug: "coding", phase: "Implement in scope" },
  { agent: "Sentinel", slug: "heavy-reasoning", phase: "Validate & verdict" },
  { agent: "Scribe", slug: "project-coworker", phase: "Document & review" },
];

export async function runHivebot(task: string, options: ChatOptions = {}): Promise<{ exitCode: number; output: string }> {
  if (!task || !task.trim()) {
    return { exitCode: 1, output: "Usage: hive hivebot \"<task>\"" };
  }
  const cwd = options.cwd || process.cwd();
  const projectRegistry = new ProviderRegistry(cwd);
  const globalRegistry = new ProviderRegistry(os.homedir());
  const skillRoot = await locateSkillRoot(cwd);

  const out: string[] = [];
  out.push(`HIVEBOT — swarming the built-in hive-mind-council on:`);
  out.push(`  ${task}\n`);

  let transcript = "";
  for (const step of COUNCIL) {
    const systemPrompt = skillRoot ? await readAgentPrompt(skillRoot, step.agent) : CHAT_ROLE_META[step.slug].systemPrompt;
    const prompt = `Task: ${task}\n\nCouncil transcript so far:\n${transcript || "(none)"}\n\n${step.agent}, perform your phase: ${step.phase}.`;
    const target = await resolveChatTarget(projectRegistry, globalRegistry, { slug: step.slug });
    const result = await target.adapter.complete(target.config, {
      prompt,
      model: target.model,
      systemPrompt,
    });
    const reply = result.output.trim();
    transcript += `\n\n## ${step.agent} (${step.phase}) — ${target.providerId}/${target.model}\n${reply}`;
    out.push(`──────── ${step.agent} · ${step.phase} · ${target.providerId}/${target.model} ────────`);
    out.push(reply);
    out.push("");
  }

  const text = out.join("\n");
  if (process.stdout.isTTY) console.log(text);
  return { exitCode: 0, output: text };
}
