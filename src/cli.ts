import fs from "node:fs/promises";
import path from "node:path";
import { CoderOrchestrator } from "./orchestrator.js";
import { StandaloneExecutor } from "./api-client.js";
import { GitHubForge } from "./forge.js";
import { TaskStore } from "./store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ProviderRole, ProviderSnapshot } from "./types.js";
import { ProviderKind } from "./providers/types.js";
import { getHiveHelpHeader, getHiveProvidersHeader, getHiveRunHeader, renderDashboard, renderStatus, runProviderSetupWizard } from "./ui/index.js";
import { ConfigStore, HiveMode } from "./config.js";
import { shouldSuppressBranding, isCI } from "./ui/terminal.js";
import { runCodeCommand, type CodingRuntimeFactory } from "./coding/command.js";
import { CODE_COMMAND_HELP } from "./coding/cli-options.js";
import { CodingSessionStore } from "./coding/session-store.js";
import { findRepositoryRoot } from "./coding/repository.js";
import {
  createHiveRunReport,
  formatHiveRunReportMarkdown,
  writeHiveRunReport,
} from "./coding/report.js";

export interface CoderCliOptions {
  cwd?: string;
  /** Receives live coding runtime lines. The CLI binary uses this for streaming output. */
  stream?: (line: string) => void;
  /** Injectable coding runtime boundary for tests and embedders. */
  codingRuntimeFactory?: CodingRuntimeFactory;
  signal?: AbortSignal;
}

export type CoderCliResult = {
  exitCode: number;
  output: string;
};

async function getActiveTask(cwd: string): Promise<string> {
  const p = path.join(cwd, ".hivemind", "coder-tasks", "active-task.txt");
  try {
    const content = await fs.readFile(p, "utf-8");
    return content.trim();
  } catch (err) {
    throw new Error("No active task found. Run 'hive run <task>' first.");
  }
}

async function getActiveTaskSafe(cwd: string): Promise<string | null> {
  try {
    return await getActiveTask(cwd);
  } catch {
    return null;
  }
}

async function setActiveTask(cwd: string, taskId: string): Promise<void> {
  const dir = path.join(cwd, ".hivemind", "coder-tasks");
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, "active-task.txt");
  await fs.writeFile(p, taskId, "utf-8");
}

async function clearActiveTask(cwd: string): Promise<void> {
  const p = path.join(cwd, ".hivemind", "coder-tasks", "active-task.txt");
  await fs.rm(p, { force: true }).catch(() => {});
}

function parseRunArgs(args: string[]): { prompt: string; options: Record<string, string> } {
  const options: Record<string, string> = {};
  const promptParts: string[] = [];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i+1].startsWith('--')) {
        options[key] = args[i+1];
        i++;
      } else {
        options[key] = "true";
      }
    } else {
      promptParts.push(args[i]);
    }
  }
  
  return { prompt: promptParts.join(" "), options };
}

export async function runCoderCli(args: string[], cliOptions: CoderCliOptions = {}): Promise<CoderCliResult> {
  const cwd = cliOptions.cwd || process.cwd();
  const store = new TaskStore(cwd);
  const codingRoot = await findRepositoryRoot(cwd).catch(() => cwd);
  const codingStore = new CodingSessionStore(codingRoot);
  const registry = new ProviderRegistry(cwd);
  const configStore = new ConfigStore(cwd);
  const currentMode = await configStore.getMode();

  const isSuppressed = args.includes("--json") || shouldSuppressBranding();

  // If help flag is used anywhere top level, treat it as help command
  if (args.includes("--help") || args.includes("-h")) {
    if (args[0] === "code") {
      return { exitCode: 0, output: CODE_COMMAND_HELP };
    } else if (args[0] === "providers") {
      args = ["providers", "help"];
    } else {
      args = ["help"];
    }
  }

  // Filter out options so command parsing is clean
  const globalArgs = args.filter(a => !a.startsWith('--'));

  if (globalArgs.length === 0) {
    if (process.stdout.isTTY && !isSuppressed && !isCI()) {
      // Persistent interactive TUI cockpit
      const { startHiveTui } = await import("./tui/index.js");
      await startHiveTui(cwd);
      return { exitCode: 0, output: "__TUI_STARTED__" };
    } else {
      const providers = await registry.list();
      const rolesConfig = await registry.getRoles();
      const tasks = await store.list();
      const rolesAssigned = [];
      if (rolesConfig.planner) rolesAssigned.push("Planner");
      if (rolesConfig.builder) rolesAssigned.push("Builder");
      if (rolesConfig.validator) rolesAssigned.push("Validator");
      if (rolesConfig.reviewer) rolesAssigned.push("Reviewer");

      const out = renderDashboard({
        providersApproved: providers.filter(p => p.approved).length,
        rolesAssigned,
        tasksCount: tasks.length,
        mode: currentMode
      });
      return { exitCode: 0, output: out };
    }
  }

  if (globalArgs[0] === "tui") {
    if (isSuppressed) return { exitCode: 1, output: JSON.stringify({ error: "TUI not available in --json mode" }) };
    if (isCI()) return { exitCode: 1, output: "TUI is disabled in CI environments." };
    if (!process.stdout.isTTY) return { exitCode: 1, output: "TUI requires an interactive terminal." };
    const { startHiveTui } = await import("./tui/index.js");
    await startHiveTui(cwd);
    return { exitCode: 0, output: "__TUI_STARTED__" };
  }

  if (globalArgs[0] === "help") {
    const header = getHiveHelpHeader();
    const helpContent = `
Usage:
  hive code "<objective>" [options]
  hive code --resume <session-id> [options]
  hive run "<task>"
  hive tui
  hive status
  hive diff [--full]
  hive approve
  hive discard
  hive push --confirmed
  hive pr --confirmed
  hive providers setup
  hive providers list
  hive sessions [list]
  hive sessions show <id>
  hive resume <id>
  hive agents [show <id>]
  hive report <session-id> [--json|--markdown] [--output <path>]
  hive mode
  hive chat ["message"]            (interactive chatbot; blank = REPL)
  hive hivebot "<task>"           (swarm the built-in hive-mind-council)
  hive scout [--task "<task>"] [--json] [--files]

Safety:
  worktree isolation - approve-before-commit - no auto-push - secret redaction`;
    const full = (header ? header + "\n\n" : "") + helpContent.trim();
    return { exitCode: 0, output: full };
  }
  
  const [command, ...rest] = globalArgs;
  
  try {
    if (command === "code") {
      if (args.length === 1 && process.stdout.isTTY && !isCI()) {
        const { startHiveTui } = await import("./tui/index.js");
        await startHiveTui(cwd);
        return { exitCode: 0, output: "__TUI_STARTED__" };
      }
      return await runCodeCommand(args.slice(1), cwd, {
        createRuntime: cliOptions.codingRuntimeFactory,
        onLine: cliOptions.stream,
        signal: cliOptions.signal,
      });
    }

    if (command === "report") {
      const reportArgs = args.slice(1);
      let sessionId: string | undefined;
      let outputPath: string | undefined;
      let format: "json" | "markdown" = "markdown";
      let formatWasSet = false;
      for (let index = 0; index < reportArgs.length; index += 1) {
        const argument = reportArgs[index];
        if (argument === "--json" || argument === "--markdown") {
          if (formatWasSet) throw new Error("Choose exactly one report format.");
          format = argument === "--json" ? "json" : "markdown";
          formatWasSet = true;
        } else if (argument === "--output") {
          const value = reportArgs[index + 1];
          if (!value || value.startsWith("--")) throw new Error("--output requires a path.");
          if (outputPath) throw new Error("--output may only be specified once.");
          outputPath = value;
          index += 1;
        } else if (argument.startsWith("--")) {
          throw new Error(`Unknown report option: ${argument}`);
        } else if (sessionId) {
          throw new Error("Usage: hive report <session-id> [--json|--markdown] [--output <path>]");
        } else {
          sessionId = argument;
        }
      }
      if (!sessionId) throw new Error("Usage: hive report <session-id> [--json|--markdown] [--output <path>]");
      const session = await codingStore.load(sessionId);
      if (!session) throw new Error(`Coding session ${sessionId} not found.`);
      const report = createHiveRunReport(session);
      const rendered = format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatHiveRunReportMarkdown(report);
      if (!outputPath) return { exitCode: 0, output: rendered };
      const written = await writeHiveRunReport(codingRoot, outputPath, rendered);
      return { exitCode: 0, output: `Report written to ${path.relative(codingRoot, written)}.` };
    }

    if (command === "resume") {
      const id = rest[0];
      if (!id) throw new Error("Usage: hive resume <id>");
      const coding = await codingStore.load(id);
      if (coding) {
        await codingStore.setActive(id);
        return await runCodeCommand([
          "--resume", id,
          "--mode", coding.mode,
          "--approval", coding.approvalPolicy,
          "--no-tui",
          ...(args.includes("--json") ? ["--json"] : []),
        ], cwd, {
          createRuntime: cliOptions.codingRuntimeFactory,
          onLine: cliOptions.stream,
          signal: cliOptions.signal,
        });
      }
      const legacy = await store.load(id);
      if (!legacy) throw new Error(`Session ${id} not found.`);
      await setActiveTask(cwd, id);
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, id, kind: "legacy" }) };
      return { exitCode: 0, output: `Resumed task cell ${id}.` };
    }

    if (command === "agents") {
      const codingSessions = await codingStore.list();
      if (rest[0] === "show") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive agents show <id>");
        const active = await codingStore.getActive();
        const candidates = active
          ? [active, ...codingSessions.filter((session) => session.id !== active.id)]
          : codingSessions;
        for (const session of candidates) {
          const agent = session.tasks.find((task) => task.id === id);
          if (agent) return { exitCode: 0, output: JSON.stringify(agent, null, 2) };
        }
        throw new Error(`Subagent ${id} not found.`);
      }
      if (rest.length > 0) return { exitCode: 1, output: "Usage: hive agents [show <id>]" };
      const agents = codingSessions.flatMap((session) => session.tasks);
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify(agents) };
      if (agents.length === 0) return { exitCode: 0, output: "No coding subagents found." };
      return {
        exitCode: 0,
        output: agents.map((agent) => `${agent.id} [${agent.role}] ${agent.status} - ${agent.title} (${agent.sessionId})`).join("\n"),
      };
    }

    if (command === "providers") {
      if (rest.length === 0) return { exitCode: 1, output: "Usage: hive providers <setup|list|add|test|approve|remove|roles>" };
      const [sub, ...subRest] = rest;
      
      if (sub === "list") {
        const providers = await registry.list();
        if (providers.length === 0) return { exitCode: 0, output: isSuppressed ? "[]" : "No providers configured." };
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify(providers) };
        const out = providers.map(p => `- ${p.id} (${p.kind}) [Approved: ${p.approved}]`).join("\n");
        return { exitCode: 0, output: out };
      }

      if (sub === "setup") {
        await runProviderSetupWizard(registry);
        return { exitCode: 0, output: "" };
      }
      
      if (sub === "help") {
        const header = getHiveProvidersHeader();
        const helpContent = `
Commands:
  hive providers setup
  hive providers list
  hive providers add
  hive providers test <id>
  hive providers approve <id>
  hive providers remove <id>
  hive providers roles`;
        const full = (header ? header + "\n\n" : "") + helpContent.trim();
        return { exitCode: 0, output: full };
      }
      
      if (sub === "add") {
        const { options } = parseRunArgs(args.slice(2)); // Use raw args to get flags
        if (!options.id || !options.kind) {
          throw new Error("Usage: hive providers add --id <id> --kind <kind> [--base-url <url>] [--api-key-env <env>] [--model <model>]");
        }
        await registry.add({
          id: options.id,
          name: options.id,
          kind: options.kind as ProviderKind,
          baseUrl: options['base-url'],
          authType: options['api-key-env'] ? 'bearer' : 'none',
          apiKeyEnv: options['api-key-env'],
          defaultModel: options.model
        });
        const out = isSuppressed ? JSON.stringify({ success: true, id: options.id }) : `Provider ${options.id} added. Run 'hive providers approve ${options.id}' to enable it.`;
        return { exitCode: 0, output: out };
      }
      
      if (sub === "test") {
        const id = subRest[0];
        if (!id) throw new Error("Usage: hive providers test <provider-id>");
        const res = await registry.test(id);
        if (isSuppressed) return { exitCode: res.ok ? 0 : 1, output: JSON.stringify(res) };
        return { exitCode: res.ok ? 0 : 1, output: `[${res.ok ? 'PASS' : 'FAIL'}] ${res.message}` };
      }
      
      if (sub === "approve") {
        const id = subRest[0];
        if (!id) throw new Error("Usage: hive providers approve <provider-id>");
        await registry.approve(id);
        return { exitCode: 0, output: isSuppressed ? JSON.stringify({ success: true }) : `Provider ${id} approved.` };
      }
      
      if (sub === "remove") {
        const id = subRest[0];
        if (!id) throw new Error("Usage: hive providers remove <provider-id>");
        const removed = await registry.remove(id);
        const outMsg = removed ? `Provider ${id} removed.` : `Provider ${id} not found.`;
        if (isSuppressed) return { exitCode: removed ? 0 : 1, output: JSON.stringify({ success: removed }) };
        return { exitCode: removed ? 0 : 1, output: outMsg };
      }
      
      if (sub === "roles") {
        if (subRest[0] === "set") {
          const role = subRest[1] as any;
          const providerId = subRest[2];
          const model = subRest[3];
          if (!role || !providerId || !model) throw new Error("Usage: hive providers roles set <role> <provider-id> <model>");
          await registry.setRole(role, providerId, model);
          return { exitCode: 0, output: isSuppressed ? JSON.stringify({ success: true }) : `Role ${role} set to ${providerId}/${model}.` };
        }
        
        const roles = await registry.getRoles();
        return { exitCode: 0, output: JSON.stringify(roles, null, 2) };
      }
      
      return { exitCode: 1, output: `Unknown providers command: ${sub}` };
    }

    if (command === "run") {
      // Need original args to parse flags correctly
      const runIndex = args.indexOf("run");
      const { prompt, options } = parseRunArgs(args.slice(runIndex + 1));
      if (!prompt) throw new Error("Task prompt is required. Usage: hive run \"<task>\"");
      
      const rolesConfig = await registry.getRoles();
      const providersList = await registry.list();
      
      if (providersList.length === 0 && !options.provider && !process.env.OPENAI_API_KEY) {
        throw new Error("No approved provider configured. Run `hive providers setup` or add a provider with `hive providers add`.");
      }

      const getSnapshot = (roleName: string, roleKey: keyof typeof rolesConfig): ProviderSnapshot => {
        const cliOverride = options[roleKey];
        if (cliOverride) {
          const [p, m] = cliOverride.split('/');
          return { role: roleName as ProviderRole, providerType: p, modelId: m || "" };
        }
        if (options.provider) {
          return { role: roleName as ProviderRole, providerType: options.provider, modelId: options.model || "" };
        }
        const roleAssigned = rolesConfig[roleKey];
        if (roleAssigned) {
          return { role: roleName as ProviderRole, providerType: roleAssigned.provider, modelId: roleAssigned.model };
        }
        return { role: roleName as ProviderRole, providerType: 'openai', modelId: 'gpt-4o' };
      };

      const providers = [
        getSnapshot('Planner', 'planner'),
        getSnapshot('Builder', 'builder'),
        getSnapshot('Validator', 'validator'),
        getSnapshot('Reviewer', 'reviewer')
      ];
      
      const taskId = `cli-${Date.now()}`;
      await setActiveTask(cwd, taskId);
      
      if (!isSuppressed) {
        const primaryProvider = providers[0];
        const runHeader = getHiveRunHeader({
          provider: primaryProvider.providerType,
          model: primaryProvider.modelId,
          mode: currentMode,
          agents: 4
        });
        if (runHeader) console.log(runHeader + "\n");
        console.log(`Starting standalone task: ${taskId}`);
        console.log(`Executing orchestration loop synchronously (Plan -> Build -> Verify -> Review)...`);
      }
      
      const executor = new StandaloneExecutor(cwd);
      const orchestrator = new CoderOrchestrator(taskId, cwd, providers, executor);
      await store.save(orchestrator.getRecord());
      
      const result = await orchestrator.runToReview(prompt);
      
      if (isSuppressed) {
        return { exitCode: 0, output: JSON.stringify(result) };
      }
      return { exitCode: 0, output: `Task reached state: ${result.state}\nRun 'hive status' or 'hive diff' to review.` };
    }
    
    if (command === "status") {
      // Check legacy active task first (backward compatibility)
      const taskId = await getActiveTaskSafe(cwd);
      if (taskId) {
        const data = await store.load(taskId);
        if (!data) throw new Error("Task data not found.");

        if (isSuppressed) {
          return { exitCode: 0, output: JSON.stringify(data) };
        }

        const nextCommands = [];
        if (data.state === 'AWAITING_APPROVAL') {
          nextCommands.push("hive diff", "hive approve");
        } else if (data.state === 'COMPLETED') {
          nextCommands.push("hive push --confirmed", "hive pr --confirmed");
        } else if (data.state === 'FAILED' || data.state === 'DISCARDED') {
          nextCommands.push("hive discard", "hive run <task>");
        } else {
          nextCommands.push("hive status (refresh)");
        }

        const output = renderStatus({
          taskId,
          mode: currentMode,
          branch: data.branchName,
          state: data.state,
          plannerState: data.plan ? "complete" : "pending",
          builderState: data.diffSummary ? "complete" : "pending",
          validatorState: data.verificationResults.length > 0 ? (data.verificationResults.every(v => v.passed) ? "passed" : "failed") : "pending",
          reviewerState: data.reviewerVerdict ? (data.reviewerVerdict.includes('REJECT') ? 'rejected' : 'approved') : "pending",
          filesChanged: data.diffSummary?.filesChanged.length || 0,
          testsPassed: data.verificationResults.length > 0 && data.verificationResults.every(v => v.passed),
          safety: currentMode,
          nextCommands
        });

        return { exitCode: 0, output };
      }

      // Fall through to coding session status
      const activeCoding = await codingStore.getActive();
      if (activeCoding) {
        if (isSuppressed) {
          return { exitCode: 0, output: JSON.stringify({
            kind: "coding",
            id: activeCoding.id,
            status: activeCoding.status,
            verdict: activeCoding.verdict,
            objective: activeCoding.objective,
          }) };
        }
        const verdict = activeCoding.verdict ?? "Not computed";
        const validation = activeCoding.validationResults ?? [];
        const failures = activeCoding.failures ?? [];
        const lines = [
          `Session: ${activeCoding.id}`,
          `Status: ${activeCoding.status}`,
          `Verdict: ${verdict}`,
          `Objective: ${activeCoding.objective}`,
          `Mode: ${activeCoding.mode}`,
          "",
          `Agents: ${activeCoding.tasks.length}`,
          `Files changed: ${activeCoding.files?.length ?? 0}`,
          `Validations: ${validation.length} (${validation.filter((v) => v.status === "passed").length} passed)`,
          `Failures: ${failures.length}`,
        ];
        if (activeCoding.finalReport?.finalSha) {
          lines.push(`Final SHA: ${activeCoding.finalReport.finalSha}`);
        }
        return { exitCode: 0, output: lines.join("\n") };
      }

      throw new Error("No active task found. Run 'hive run <task>' or 'hive code' first.");
    }
    
    if (command === "diff") {
      const taskId = await getActiveTask(cwd);
      const p = path.join(cwd, ".hivemind", "coder-tasks", taskId, "diff.patch");
      const runIndex = args.indexOf("diff");
      const { options } = parseRunArgs(args.slice(runIndex + 1));
      
      try {
        const diff = await fs.readFile(p, "utf-8");
        if (isSuppressed) {
          return { exitCode: 0, output: JSON.stringify({ diff }) };
        }

        const header = getHiveProvidersHeader() || "";
        if (options.full) {
          return { exitCode: 0, output: `${header}\n\n${diff}`.trim() || "No changes." };
        } else {
          const data = await store.load(taskId);
          const summary = data?.diffSummary;
          if (!summary) return { exitCode: 0, output: "No diff summary available." };
          const out = `${header}\n\nFiles Changed: ${summary.filesChanged.join(', ')}\nInsertions: ${summary.insertions}, Deletions: ${summary.deletions}\nRun 'hive diff --full' to see raw patch.`;
          return { exitCode: 0, output: out.trim() };
        }
      } catch (err) {
        throw new Error("No diff available yet or task not complete.");
      }
    }
    
    if (command === "approve") {
      const runIndex = args.indexOf("approve");
      const messageArgs = args.slice(runIndex + 1).filter(a => !a.startsWith('--'));
      const taskId = await getActiveTask(cwd);
      const message = messageArgs.join(" ") || "Approved via CLI";
      const record = await store.load(taskId);
      if (!record) throw new Error("Task data not found.");

      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
      await orchestrator.approve(message);

      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true }) };
      const header = getHiveProvidersHeader() || "";
      return { exitCode: 0, output: `${header}\nTask ${taskId} approved.`.trim() };
    }

    if (command === "reject") {
      const codingSession = await codingStore.getActive();
      if (!codingSession) throw new Error("No active coding session.");
      codingSession.verdict = "REJECTED";
      codingSession.status = "failed";
      await codingStore.save(codingSession);
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, verdict: "REJECTED" }) };
      return { exitCode: 0, output: `Session ${codingSession.id} rejected.` };
    }

    if (command === "discard") {
      const codingSession = await codingStore.getActive();
      if (codingSession) {
        codingSession.status = "cancelled";
        codingSession.cancelledAt = new Date().toISOString();
        codingSession.cancellationReason = "Discarded by user";
        codingSession.verdict = "BLOCKED";
        await codingStore.save(codingSession);
        await codingStore.clearActive();
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true }) };
        return { exitCode: 0, output: `Coding session ${codingSession.id} discarded.` };
      }
      const taskId = await getActiveTask(cwd);
      const record = await store.load(taskId);
      if (record) {
        const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
        await orchestrator.discard();
      }
      await clearActiveTask(cwd);
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true }) };
      return { exitCode: 0, output: `Task ${taskId} discarded.` };
    }
    
    if (command === "push") {
      const confirmedIndex = args.indexOf("--confirmed");
      if (confirmedIndex === -1) {
        throw new Error("Must provide --confirmed flag to push.");
      }
      const taskId = await getActiveTask(cwd);
      const owner = process.env.GITHUB_OWNER;
      const repo = process.env.GITHUB_REPO;
      const token = process.env.GITHUB_TOKEN;
      if (!owner || !repo || !token) throw new Error("GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN must be set.");
      
      const record = await store.load(taskId);
      if (!record) throw new Error("Task data not found.");
      
      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
      const forge = new GitHubForge(owner, repo, token);
      await orchestrator.push(forge);
      
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true }) };
      return { exitCode: 0, output: `Task ${taskId} pushed to remote.` };
    }
    
    if (command === "pr") {
      const confirmedIndex = args.indexOf("--confirmed");
      if (confirmedIndex === -1) {
        throw new Error("Must provide --confirmed flag to create PR.");
      }
      const taskId = await getActiveTask(cwd);
      const owner = process.env.GITHUB_OWNER;
      const repo = process.env.GITHUB_REPO;
      const token = process.env.GITHUB_TOKEN;
      if (!owner || !repo || !token) throw new Error("GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN must be set.");
      
      const record = await store.load(taskId);
      if (!record) throw new Error("Task data not found.");
      
      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
      const forge = new GitHubForge(owner, repo, token);
      const prUrl = await orchestrator.createPR(forge);
      
      if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, url: prUrl }) };
      return { exitCode: 0, output: `PR created for ${taskId}.\nURL: ${prUrl}` };
    }
    
    if (command === "mode") {
      if (rest.length === 0) {
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ mode: currentMode }) };
        return { exitCode: 0, output: `Current Mode: ${currentMode}` };
      }
      if (rest[0] === "set" && rest[1]) {
        const newMode = rest[1] as HiveMode;
        if (!["guarded", "standard", "autonomous", "plan", "review"].includes(newMode)) {
          throw new Error("Invalid mode. Choose from: guarded, standard, autonomous, plan, review");
        }
        await configStore.setMode(newMode);
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, mode: newMode }) };
        return { exitCode: 0, output: `Mode set to: ${newMode}` };
      }
      return { exitCode: 1, output: "Usage: hive mode [set <mode>]" };
    }
    
    if (command === "sessions") {
      const sub = rest[0] ?? "list";
      const activeId = await getActiveTaskSafe(cwd);
      const activeCoding = await codingStore.getActive();
      
      if (sub === "list") {
        const tasks = await store.list();
        const codingSessions = await codingStore.list();
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify([
          ...codingSessions.map((session) => ({ kind: "coding", ...session })),
          ...tasks.map((task) => ({ kind: "legacy", ...task })),
        ]) };
        if (tasks.length === 0 && codingSessions.length === 0) return { exitCode: 0, output: "No sessions found." };
        const out = [
          ...codingSessions.map((session) => `${session.id === activeCoding?.id ? '*' : ' '} ${session.id} [${session.status}] - ${session.objective}`),
          ...tasks.map(t => `${t.taskId === activeId ? '*' : ' '} ${t.taskId} [${t.state}] - ${t.branchName}`),
        ].join("\n");
        return { exitCode: 0, output: out };
      }
      if (sub === "show") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions show <id>");
        const coding = await codingStore.load(id);
        if (coding) return { exitCode: 0, output: JSON.stringify(coding, null, 2) };
        const record = await store.load(id);
        if (!record) throw new Error(`Session ${id} not found.`);
        return { exitCode: 0, output: JSON.stringify(record, null, 2) };
      }
      if (sub === "resume") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions resume <id>");
        const coding = await codingStore.load(id);
        if (coding) {
          await codingStore.setActive(id);
          if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, id, kind: "coding" }) };
          return { exitCode: 0, output: `Resumed coding session ${id}. Run 'hive code --resume ${id}' to continue execution.` };
        }
        const record = await store.load(id);
        if (!record) throw new Error(`Session ${id} not found.`);
        await setActiveTask(cwd, id);
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, id }) };
        return { exitCode: 0, output: `Resumed task cell ${id}.` };
      }
      if (sub === "fork") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions fork <id>");
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, message: "Not Implemented" }) };
        return { exitCode: 0, output: `Task cell ${id} forked (Not Implemented).` };
      }
      if (sub === "archive") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions archive <id>");
        if (isSuppressed) return { exitCode: 0, output: JSON.stringify({ success: true, message: "Not Implemented" }) };
        return { exitCode: 0, output: `Task cell ${id} archived (Not Implemented).` };
      }
      return { exitCode: 1, output: `Unknown sessions command: ${sub}` };
    }
    
    if (command === "scout") {
      const scoutIndex = args.indexOf("scout");
      const { options } = parseRunArgs(args.slice(scoutIndex + 1));
      
      const { generateContextPack, formatScoutText } = await import('./scout/index.js');
      const pack = await generateContextPack(cwd, options.task);
      
      if (options.json) {
        return { exitCode: 0, output: JSON.stringify(pack, null, 2) };
      }
      
      if (options.files) {
        const fileList = pack.importantFiles.map(f => {
          const score = f.priorityScore.toString().padStart(3, ' ');
          return `[${score}] ${f.path} (${f.language})`;
        }).join('\n');
        return { exitCode: 0, output: fileList || "No important files found." };
      }
      
      return { exitCode: 0, output: formatScoutText(pack) };
    }

    if (command === "chat") {
      const { runChat } = await import("./chat/chat-cli.js");
      return await runChat(args.slice(1), { cwd, signal: cliOptions.signal });
    }

    if (command === "hivebot") {
      const { runHivebot } = await import("./chat/hivebot.js");
      const task = rest.join(" ");
      return await runHivebot(task, { cwd, signal: cliOptions.signal });
    }

    return { exitCode: 1, output: `Unknown command: ${command}` };
    
  } catch (err: any) {
    if (isSuppressed) {
      return { exitCode: 1, output: JSON.stringify({ error: err.message }) };
    }
    return { exitCode: 1, output: err.message };
  }
}
