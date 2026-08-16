import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const PROVIDER_ENV = {
  groq: "GROQ_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  nous: "NOUS_API_KEY",
  "nous-portal": "NOUS_PORTAL_TOKEN",
  cerebras: "CEREBRAS_API_KEY",
  sambanova: "SAMBANOVA_API_KEY",
  huggingface: "HUGGINGFACE_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

const PROVIDER_SECRET_ENV = new Set([
  ...Object.values(PROVIDER_ENV),
  "NOUS_PORTAL_TOKEN",
  "HF_TOKEN",
  "GITHUB_MODELS_TOKEN",
]);

async function readable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function secretString(value, env) {
  if (typeof value !== "string") return undefined;
  const reference = value.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/)?.[1];
  const resolved = reference ? env[reference] : value;
  return typeof resolved === "string" && resolved.trim().length >= 8 ? resolved.trim() : undefined;
}

function addCredential(result, envName, value, source, env) {
  const secret = secretString(value, env);
  if (!secret || result.variables[envName] || env[envName]) return;
  result.variables[envName] = secret;
  result.loaded.push({ provider: envName.replace(/_(?:API_KEY|PORTAL_TOKEN)$/, "").toLowerCase(), source });
}

export async function discoverLocalFreeProviderCredentials(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const openCodeAuth = options.openCodeAuthPath ?? join(home, ".local", "share", "opencode", "auth.json");
  const openCodeConfig = options.openCodeConfigPath ?? join(home, ".config", "opencode", "opencode.jsonc");
  const openClawModels = options.openClawModelsPath ?? join(home, ".openclaw", "agents", "main", "agent", "models.json");
  const claudeRouterConfig = options.claudeRouterConfigPath ?? join(home, ".claude-code-router", "config.json");
  const result = {
    variables: {},
    loaded: [],
    scanned: [openCodeAuth, openCodeConfig, openClawModels, claudeRouterConfig],
    routers: {
      openCode: await readable(openCodeAuth) || await readable(openCodeConfig),
      openClaw: await readable(openClawModels),
      claudeCodeRouter: await readable(claudeRouterConfig),
    },
  };

  const auth = await readJson(openCodeAuth);
  if (auth && typeof auth === "object") {
    for (const [provider, record] of Object.entries(auth)) {
      const envName = PROVIDER_ENV[provider.toLowerCase()];
      if (!envName || !record || typeof record !== "object") continue;
      addCredential(result, envName, record.key, "OpenCode auth", env);
    }
  }

  const models = await readJson(openClawModels);
  const providers = models?.providers ?? models?.models?.providers;
  if (providers && typeof providers === "object") {
    for (const [provider, record] of Object.entries(providers)) {
      const envName = PROVIDER_ENV[provider.toLowerCase()];
      if (!envName || !record || typeof record !== "object") continue;
      addCredential(result, envName, record.apiKey ?? record.api_key, "OpenClaw models", env);
    }
  }

  return result;
}

function printRedactedInventory(result) {
  console.log(JSON.stringify({
    routers: result.routers,
    credentials: result.loaded,
    scanned: result.scanned,
    note: "Only provider names and source files are shown. Secret values were not printed or persisted.",
  }, null, 2));
}

async function main() {
  const result = await discoverLocalFreeProviderCredentials();
  if (process.argv.includes("--scan-only")) {
    printRedactedInventory(result);
    return;
  }
  if (process.env.NODE_ENV === "production") throw new Error("The local credential bridge is development-only.");

  const loadedProviders = result.loaded.map((item) => item.provider).join(", ") || "none";
  console.log(`HIVE local free-provider bridge loaded: ${loadedProviders}. Credentials stay in memory and are never printed or written.`);
  const safeServiceEnv = { ...process.env };
  for (const name of PROVIDER_SECRET_ENV) delete safeServiceEnv[name];
  delete safeServiceEnv.HIVE_LOCAL_PROVIDER_BRIDGE;
  const apiEnv = { ...process.env, ...result.variables, HIVE_LOCAL_PROVIDER_BRIDGE: "true" };
  const services = [
    { name: "web", workspace: "@hive-cloud/web", env: safeServiceEnv },
    { name: "api", workspace: "@hive-cloud/api", env: apiEnv },
    { name: "worker", workspace: "@hive-cloud/worker", env: safeServiceEnv },
  ];
  const children = services.map((service) => {
    const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", `npm run dev -w ${service.workspace}`]
      : ["run", "dev", "-w", service.workspace];
    const child = spawn(command, args, { cwd: process.cwd(), env: service.env, stdio: "inherit", shell: false });
    child.once("error", (error) => console.error(`${service.name}: ${error.message}`));
    return child;
  });
  let stopping = false;
  const stop = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  for (const child of children) child.once("exit", (code, signal) => {
    if (stopping) return;
    stop(signal ?? "SIGTERM");
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
