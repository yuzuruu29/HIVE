import fs from "node:fs/promises";
import path from "node:path";
import { CoderOrchestrator } from "./orchestrator.js";
import { StandaloneExecutor } from "./api-client.js";
import { GitHubForge } from "./forge.js";
import { TaskStore } from "./store.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ProviderRole, ProviderSnapshot } from "./types.js";
import { ProviderKind } from "./providers/types.js";
import { renderHiveBanner, renderHiveCompactHeader, renderDashboard, renderStatus, runProviderSetupWizard } from "./ui/index.js";
import { ConfigStore, HiveMode } from "./config.js";

export interface CoderCliOptions {
  cwd?: string;
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
  const registry = new ProviderRegistry(cwd);
  const configStore = new ConfigStore(cwd);
  const currentMode = await configStore.getMode();

  if (args.length === 0) {
    // Show Dashboard
    const providers = await registry.list();
    const rolesConfig = await registry.getRoles();
    const tasks = await store.list();
    
    const rolesAssigned = [];
    if (rolesConfig.planner) rolesAssigned.push("Planner");
    if (rolesConfig.builder) rolesAssigned.push("Builder");
    if (rolesConfig.validator) rolesAssigned.push("Validator");
    if (rolesConfig.reviewer) rolesAssigned.push("Reviewer");

    const dashboard = renderDashboard({
      providersApproved: providers.filter(p => p.approved).length,
      rolesAssigned,
      tasksCount: tasks.length,
      mode: currentMode
    });
    
    return { exitCode: 0, output: dashboard };
  }

  if (args[0] === "help" || args[0] === "--help") {
    const banner = renderHiveBanner();
    const helpText = `
${banner}

Verified Agentic Coding

Usage:
  hive run "<task>"
  hive status
  hive diff [--full]
  hive approve
  hive discard
  hive push --confirmed
  hive pr --confirmed
  hive providers setup
  hive providers list
  hive sessions list
  hive mode

Safety:
  worktree isolation - approve-before-commit - no auto-push - secret redaction`;
    return { exitCode: 0, output: helpText.replace(/^\n/, "").trimEnd() };
  }
  
  const [command, ...rest] = args;
  
  try {
    if (command === "providers") {
      if (rest.length === 0) return { exitCode: 1, output: "Usage: hive providers <setup|list|add|test|approve|remove|roles>" };
      const [sub, ...subRest] = rest;
      
      if (sub === "list") {
        const providers = await registry.list();
        if (providers.length === 0) return { exitCode: 0, output: "No providers configured." };
        const out = providers.map(p => `- ${p.id} (${p.kind}) [Approved: ${p.approved}]`).join("\n");
        return { exitCode: 0, output: out };
      }

      if (sub === "setup") {
        await runProviderSetupWizard(registry);
        return { exitCode: 0, output: "" };
      }
      
      if (sub === "--help" || sub === "help") {
        const header = renderHiveCompactHeader({ suffix: "Providers" });
        const helpText = `
${header}

Commands:
  hive providers setup
  hive providers list
  hive providers add
  hive providers test <id>
  hive providers approve <id>
  hive providers remove <id>
  hive providers roles`;
        return { exitCode: 0, output: helpText.replace(/^\n/, "").trimEnd() };
      }
      
      if (sub === "add") {
        const { options } = parseRunArgs(subRest);
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
        return { exitCode: 0, output: `Provider ${options.id} added. Run 'hive providers approve ${options.id}' to enable it.` };
      }
      
      if (sub === "test") {
        const id = subRest[0];
        if (!id) throw new Error("Usage: hive providers test <provider-id>");
        const res = await registry.test(id);
        if (res.ok) return { exitCode: 0, output: `✅ ${res.message}` };
        return { exitCode: 1, output: `❌ ${res.message}` };
      }
      
      if (sub === "approve") {
        const id = subRest[0];
        if (!id) throw new Error("Usage: hive providers approve <provider-id>");
        await registry.approve(id);
        return { exitCode: 0, output: `Provider ${id} approved.` };
      }
      
      if (sub === "remove") {
        const id = subRest[0];
        if (!id) throw new Error("Usage: hive providers remove <provider-id>");
        const removed = await registry.remove(id);
        return { exitCode: removed ? 0 : 1, output: removed ? `Provider ${id} removed.` : `Provider ${id} not found.` };
      }
      
      if (sub === "roles") {
        if (subRest[0] === "set") {
          const role = subRest[1] as any;
          const providerId = subRest[2];
          const model = subRest[3];
          if (!role || !providerId || !model) throw new Error("Usage: hive providers roles set <role> <provider-id> <model>");
          await registry.setRole(role, providerId, model);
          return { exitCode: 0, output: `Role ${role} set to ${providerId}/${model}.` };
        }
        
        const roles = await registry.getRoles();
        return { exitCode: 0, output: JSON.stringify(roles, null, 2) };
      }
      
      return { exitCode: 1, output: `Unknown providers command: ${sub}` };
    }

    if (command === "run") {
      const { prompt, options } = parseRunArgs(rest);
      if (!prompt) throw new Error("Task prompt is required. Usage: hive run \"<task>\"");
      
      // Determine providers
      const rolesConfig = await registry.getRoles();
      const providersList = await registry.list();
      
      // Basic safety fallback - if nothing is configured, error out.
      // Except if they used OPENAI legacy, we handled that in executor, but let's encourage registry now.
      if (providersList.length === 0 && !options.provider && !process.env.OPENAI_API_KEY) {
        throw new Error("No approved provider configured. Run `hive providers setup` or add a provider with `hive providers add`.");
      }

      const getSnapshot = (roleName: string, roleKey: keyof typeof rolesConfig): ProviderSnapshot => {
        // CLI Override: --<roleKey> <provider>/<model>
        const cliOverride = options[roleKey];
        if (cliOverride) {
          const [p, m] = cliOverride.split('/');
          return { role: roleName as ProviderRole, providerType: p, modelId: m || "" };
        }
        
        // Global CLI Override: --provider <provider> --model <model>
        if (options.provider) {
          return { role: roleName as ProviderRole, providerType: options.provider, modelId: options.model || "" };
        }

        // Registry Roles
        const roleAssigned = rolesConfig[roleKey];
        if (roleAssigned) {
          return { role: roleName as ProviderRole, providerType: roleAssigned.provider, modelId: roleAssigned.model };
        }

        // Default legacy fallback
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
      
      console.log(renderHiveCompactHeader());
      console.log(`Starting standalone task: ${taskId}`);
      console.log(`Executing orchestration loop synchronously (Plan -> Build -> Verify -> Review)...`);
      
      const executor = new StandaloneExecutor(cwd);
      const orchestrator = new CoderOrchestrator(taskId, cwd, providers, executor);
      
      // Save initial state
      await store.save(orchestrator.getRecord());
      
      const result = await orchestrator.runToReview(prompt);
      
      return { exitCode: 0, output: `Task reached state: ${result.state}\nRun 'hive status' or 'hive diff' to review.` };
    }
    
    if (command === "status") {
      const taskId = await getActiveTask(cwd);
      const data = await store.load(taskId);
      if (!data) throw new Error("Task data not found.");
      
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
    
    if (command === "diff") {
      const taskId = await getActiveTask(cwd);
      const p = path.join(cwd, ".hivemind", "coder-tasks", taskId, "diff.patch");
      const { options } = parseRunArgs(rest);
      
      try {
        const diff = await fs.readFile(p, "utf-8");
        if (options.full) {
          return { exitCode: 0, output: `${renderHiveCompactHeader()}\n\n${diff}` || "No changes." };
        } else {
          // Provide diff summary instead
          const data = await store.load(taskId);
          const summary = data?.diffSummary;
          if (!summary) return { exitCode: 0, output: "No diff summary available." };
          const out = `${renderHiveCompactHeader()}\n\nFiles Changed: ${summary.filesChanged.join(', ')}\nInsertions: ${summary.insertions}, Deletions: ${summary.deletions}\nRun 'hive diff --full' to see raw patch.`;
          return { exitCode: 0, output: out };
        }
      } catch (err) {
        throw new Error("No diff available yet or task not complete.");
      }
    }
    
    if (command === "approve") {
      const taskId = await getActiveTask(cwd);
      const message = rest.join(" ") || "Approved via CLI";
      const record = await store.load(taskId);
      if (!record) throw new Error("Task data not found.");
      
      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
      await orchestrator.approve(message);
      
      return { exitCode: 0, output: `${renderHiveCompactHeader()}\nTask ${taskId} approved.` };
    }
    
    if (command === "discard") {
      const taskId = await getActiveTask(cwd);
      const record = await store.load(taskId);
      if (record) {
        const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor(cwd));
        await orchestrator.discard();
      }
      await clearActiveTask(cwd);
      return { exitCode: 0, output: `Task ${taskId} discarded.` };
    }
    
    if (command === "push") {
      const confirmedIndex = rest.indexOf("--confirmed");
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
      
      return { exitCode: 0, output: `Task ${taskId} pushed to remote.` };
    }
    
    if (command === "pr") {
      const confirmedIndex = rest.indexOf("--confirmed");
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
      
      return { exitCode: 0, output: `PR created for ${taskId}.\nURL: ${prUrl}` };
    }
    
    if (command === "mode") {
      if (rest.length === 0) {
        return { exitCode: 0, output: `Current Mode: ${currentMode}` };
      }
      if (rest[0] === "set" && rest[1]) {
        const newMode = rest[1] as HiveMode;
        if (!["guarded", "standard", "autonomous", "plan", "review"].includes(newMode)) {
          throw new Error("Invalid mode. Choose from: guarded, standard, autonomous, plan, review");
        }
        await configStore.setMode(newMode);
        return { exitCode: 0, output: `Mode set to: ${newMode}` };
      }
      return { exitCode: 1, output: "Usage: hive mode [set <mode>]" };
    }
    
    if (command === "sessions") {
      if (rest.length === 0) return { exitCode: 1, output: "Usage: hive sessions <list|show|resume|fork|archive>" };
      const sub = rest[0];
      const activeId = await getActiveTaskSafe(cwd);
      
      if (sub === "list") {
        const tasks = await store.list();
        if (tasks.length === 0) return { exitCode: 0, output: "No task cells found." };
        const out = tasks.map(t => `${t.taskId === activeId ? '*' : ' '} ${t.taskId} [${t.state}] - ${t.branchName}`).join("\n");
        return { exitCode: 0, output: out };
      }
      if (sub === "show") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions show <id>");
        const record = await store.load(id);
        if (!record) throw new Error(`Task cell ${id} not found.`);
        return { exitCode: 0, output: JSON.stringify(record, null, 2) };
      }
      if (sub === "resume") {
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions resume <id>");
        const record = await store.load(id);
        if (!record) throw new Error(`Task cell ${id} not found.`);
        await setActiveTask(cwd, id);
        return { exitCode: 0, output: `Resumed task cell ${id}.` };
      }
      if (sub === "fork") {
        // Stub for now
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions fork <id>");
        return { exitCode: 0, output: `Task cell ${id} forked (Not Implemented).` };
      }
      if (sub === "archive") {
        // Stub for now
        const id = rest[1];
        if (!id) throw new Error("Usage: hive sessions archive <id>");
        return { exitCode: 0, output: `Task cell ${id} archived (Not Implemented).` };
      }
      return { exitCode: 1, output: `Unknown sessions command: ${sub}` };
    }
    
    return { exitCode: 1, output: `Unknown command: ${command}` };
    
  } catch (err: any) {
    return { exitCode: 1, output: err.message };
  }
}
