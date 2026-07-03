import fs from "node:fs/promises";
import path from "node:path";
import { CoderOrchestrator } from "./orchestrator.js";
import { StandaloneExecutor } from "./api-client.js";
import { GitHubForge } from "./forge.js";
import { TaskStore } from "./store.js";

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

export async function runCoderCli(args: string[], options: CoderCliOptions = {}): Promise<CoderCliResult> {
  const cwd = options.cwd || process.cwd();
  const store = new TaskStore(cwd);
  
  if (args.length === 0) {
    return { exitCode: 1, output: "Usage: hive <run|status|diff|approve|discard|push|pr>" };
  }
  
  const [command, ...rest] = args;
  
  try {
    if (command === "run") {
      const prompt = rest.join(" ");
      if (!prompt) throw new Error("Task prompt is required. Usage: hive run \"<task>\"");
      
      const taskId = `cli-${Date.now()}`;
      await setActiveTask(cwd, taskId);
      
      const providers = [
        { role: 'Planner' as const, providerType: 'openai', modelId: 'gpt-4o' },
        { role: 'Builder' as const, providerType: 'openai', modelId: 'gpt-4o' },
        { role: 'Validator' as const, providerType: 'openai', modelId: 'gpt-4o' },
        { role: 'Reviewer' as const, providerType: 'openai', modelId: 'gpt-4o' }
      ];
      
      console.log(`Starting HIVE standalone task: ${taskId}`);
      console.log(`Executing orchestration loop synchronously (Plan -> Build -> Verify -> Review)...`);
      
      const executor = new StandaloneExecutor();
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
      
      let output = `Task ID: ${taskId}\nState: ${data.state}\n`;
      if (data.reviewerVerdict) output += `Reviewer Verdict: ${data.reviewerVerdict}\n`;
      
      return { exitCode: 0, output: output.trim() };
    }
    
    if (command === "diff") {
      const taskId = await getActiveTask(cwd);
      const p = path.join(cwd, ".hivemind", "coder-tasks", taskId, "diff.patch");
      try {
        const diff = await fs.readFile(p, "utf-8");
        return { exitCode: 0, output: diff || "No changes." };
      } catch (err) {
        throw new Error("No diff available yet or task not complete.");
      }
    }
    
    if (command === "approve") {
      const taskId = await getActiveTask(cwd);
      const message = rest.join(" ") || "Approved via CLI";
      const record = await store.load(taskId);
      if (!record) throw new Error("Task data not found.");
      
      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor());
      await orchestrator.approve(message);
      
      return { exitCode: 0, output: `Task ${taskId} approved.` };
    }
    
    if (command === "discard") {
      const taskId = await getActiveTask(cwd);
      const record = await store.load(taskId);
      if (record) {
        const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor());
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
      
      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor());
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
      
      const orchestrator = await CoderOrchestrator.fromRecord(record, cwd, new StandaloneExecutor());
      const forge = new GitHubForge(owner, repo, token);
      const prUrl = await orchestrator.createPR(forge);
      
      return { exitCode: 0, output: `PR created for ${taskId}.\nURL: ${prUrl}` };
    }
    
    return { exitCode: 1, output: `Unknown command: ${command}` };
    
  } catch (err: any) {
    return { exitCode: 1, output: err.message };
  }
}
