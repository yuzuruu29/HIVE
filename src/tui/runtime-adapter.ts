import fs from "node:fs/promises";
import path from "node:path";
import { TaskStore } from "../store.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ConfigStore } from "../config.js";
import { StandaloneExecutor } from "../api-client.js";
import { CoderOrchestrator } from "../orchestrator.js";
import { ProviderRole, ProviderSnapshot } from "../types.js";

export interface TuiRuntimeCallbacks {
  onStart: (taskId: string) => void;
  onOutput: (line: string) => void;
  onError: (error: string) => void;
  onComplete: (result: any) => void;
  onStatus: (status: "idle" | "running" | "verifying" | "complete" | "error") => void;
}

export async function runTuiTask(cwd: string, taskPrompt: string, callbacks: TuiRuntimeCallbacks): Promise<void> {
  try {
    const store = new TaskStore(cwd);
    const registry = new ProviderRegistry(cwd);
    const configStore = new ConfigStore(cwd);

    const providersList = await registry.list();
    const hasOpenAI = process.env.OPENAI_API_KEY !== undefined;
    
    if (providersList.length === 0 && !hasOpenAI) {
      callbacks.onError("No approved provider configured. Please setup providers first.");
      callbacks.onStatus("error");
      return;
    }

    const rolesConfig = await registry.getRoles();
    const getSnapshot = (roleName: string, roleKey: keyof typeof rolesConfig): ProviderSnapshot => {
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

    const taskId = `tui-${Date.now()}`;
    callbacks.onStart(taskId);
    callbacks.onOutput(`[HIVE] Starting task: ${taskId}`);
    callbacks.onOutput(`[HIVE] Initializing swarm orchestration...`);
    callbacks.onStatus("running");

    const dir = path.join(cwd, ".hivemind", "coder-tasks");
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(dir, "active-task.txt");
    await fs.writeFile(p, taskId, "utf-8");

    const executor = new StandaloneExecutor(cwd);
    const orchestrator = new CoderOrchestrator(taskId, cwd, providers, executor);
    await store.save(orchestrator.getRecord());

    callbacks.onOutput(`[HIVE] Orchestrator loop: Plan -> Build -> Verify -> Review`);
    
    // In the future this should stream tokens and transition events.
    // For now, it awaits the result.
    const result = await orchestrator.runToReview(taskPrompt);

    callbacks.onOutput(`[HIVE] Task reached state: ${result.state}`);
    
    if (result.state === "FAILED") {
       callbacks.onStatus("error");
    } else {
       callbacks.onStatus("complete");
    }
    
    callbacks.onComplete(result);
  } catch (err: any) {
    callbacks.onError(err.message);
    callbacks.onStatus("error");
  }
}
