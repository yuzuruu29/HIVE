import * as readline from 'node:readline/promises';
import { ProviderRegistry } from '../providers/registry.js';
import { ProviderKind } from '../providers/types.js';
import { getHiveProvidersHeader } from './branding.js';
import { getRenderMode } from './terminal.js';

export async function runProviderSetupWizard(registry: ProviderRegistry): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  if (getRenderMode() !== 'suppressed') {
    console.log(getHiveProvidersHeader());
    console.log("\nLet's configure a new model provider.\n");
  }

  try {
    const id = (await rl.question("Provider ID (e.g., my-openrouter, local-ollama): ")).trim();
    if (!id) throw new Error("Provider ID cannot be empty.");

    console.log(`
Select Provider Kind:
  [1] HIVE 0.1
  [2] openrouter
  [3] ollama
  [4] openai-compatible
  [5] openai
`);
    const kindChoice = (await rl.question("Choice [1-5]: ")).trim();
    let kind: ProviderKind;
    let defaultBaseUrl = "";
    let defaultModel = "";
    let defaultKeyEnv = "";
    let needsKey = true;

    if (kindChoice === "1") {
      kind = "openai-compatible";
      defaultBaseUrl = (process.env.HIVE_CLOUD_BASE_URL || "").replace(/\/+$/, "");
      defaultModel = "hive-0.1";
      defaultKeyEnv = "HIVE_API_KEY";
    } else if (kindChoice === "2") {
      kind = "openrouter";
      defaultBaseUrl = "https://openrouter.ai/api/v1";
      defaultModel = "qwen/qwen3-coder";
    } else if (kindChoice === "3") {
      kind = "ollama";
      defaultBaseUrl = "http://localhost:11434";
      defaultModel = "llama3";
      needsKey = false;
    } else if (kindChoice === "4") {
      kind = "openai-compatible";
      defaultBaseUrl = "http://localhost:1234/v1";
      defaultModel = "local-model";
    } else if (kindChoice === "5") {
      kind = "openai";
      defaultBaseUrl = "https://api.openai.com/v1";
      defaultModel = "gpt-4o";
    } else {
      throw new Error("Invalid choice.");
    }

    const baseUrlInput = (await rl.question(`Base URL [${defaultBaseUrl}]: `)).trim();
    const baseUrl = baseUrlInput || defaultBaseUrl;
    if (!baseUrl) throw new Error("Base URL is required. Paste the HIVE Cloud API URL ending in /v1.");

    const modelInput = (await rl.question(`Default Model [${defaultModel}]: `)).trim();
    const model = modelInput || defaultModel;

    let apiKeyEnv = "";
    if (needsKey) {
      console.log("\nHIVE reads API keys securely from your environment variables.");
      const envInput = (await rl.question(`API Key Environment Variable${defaultKeyEnv ? ` [${defaultKeyEnv}]` : " (e.g., OPENROUTER_API_KEY)"}: `)).trim();
      apiKeyEnv = envInput || defaultKeyEnv;
      if (!apiKeyEnv) throw new Error("API Key Environment Variable is required for this provider.");
    }

    const config = {
      id,
      name: id,
      kind,
      baseUrl,
      authType: (needsKey ? "bearer" : "none") as any,
      apiKeyEnv,
      defaultModel: model
    };

    console.log("\nSaving provider...");
    await registry.add(config);

    console.log("Testing provider health...");
    try {
      const res = await registry.test(id);
      if (res.ok) {
        console.log(`[PASS] ${res.message}`);
        await registry.approve(id);
        console.log(`Provider ${id} is approved and ready to use!`);
      } else {
        console.log(`[FAIL] Health check failed: ${res.message}`);
        console.log(`The provider was saved but NOT approved. Fix your environment or config, then run: hive providers approve ${id}`);
      }
    } catch (testErr: any) {
      console.log(`[ERROR] Health check encountered an error: ${testErr.message}`);
      console.log(`The provider was saved but NOT approved. Run: hive providers approve ${id}`);
    }

  } finally {
    rl.close();
  }
}
