import type {
  FreeProviderCatalogEntry,
  ProviderKind,
  RouteCandidate,
} from "@hive-cloud/contracts";

export interface FreeModelDescriptor {
  id: string;
  displayName: string;
  contextWindow: number;
  vision: boolean;
  tools: boolean;
}

interface ProviderDefinition {
  kind: Exclude<ProviderKind, "custom">;
  displayName: string;
  baseUrl: string;
  catalogUrl: string;
  documentationUrl: string;
  envKeys: string[];
  defaultModelEnv: string;
  freeMode: FreeProviderCatalogEntry["freeMode"];
  quotaNote: string;
  privacyNote?: string;
  latencyMs: number;
  quality: number;
  models: FreeModelDescriptor[];
}

const OPENCODE_FREE_MODEL_IDS = [
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "north-mini-code-free",
  "nemotron-3-ultra-free",
  "big-pickle",
] as const;

const OPENCODE_FREE_MODELS: FreeModelDescriptor[] = OPENCODE_FREE_MODEL_IDS.map((id) => ({
  id,
  displayName: id,
  contextWindow: 128_000,
  vision: false,
  tools: true,
}));

const NOUS_FREE_MODELS: FreeModelDescriptor[] = [
  { id: "tencent/hy3:free", displayName: "Tencent Hy3", contextWindow: 262_144, vision: false, tools: true },
  { id: "stepfun/step-3.7-flash:free", displayName: "StepFun 3.7 Flash", contextWindow: 128_000, vision: true, tools: true },
];

const PROVIDERS: readonly ProviderDefinition[] = [
  {
    kind: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    catalogUrl: "https://api.groq.com/openai/v1/models",
    documentationUrl: "https://console.groq.com/docs/rate-limits",
    envKeys: ["GROQ_API_KEY"],
    defaultModelEnv: "GROQ_DEFAULT_MODEL",
    freeMode: "free-account-tier",
    quotaNote: "Free-plan limits are model-specific and include requests per day.",
    latencyMs: 180,
    quality: 84,
    models: [{ id: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B Versatile", contextWindow: 128_000, vision: false, tools: true }],
  },
  {
    kind: "nvidia",
    displayName: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    catalogUrl: "https://integrate.api.nvidia.com/v1/models",
    documentationUrl: "https://developer.nvidia.com/nim",
    envKeys: ["NVIDIA_API_KEY"],
    defaultModelEnv: "NVIDIA_DEFAULT_MODEL",
    freeMode: "free-account-tier",
    quotaNote: "Hosted NIM endpoints are free for prototyping under NVIDIA developer limits.",
    latencyMs: 340,
    quality: 84,
    models: [{ id: "meta/llama-3.3-70b-instruct", displayName: "Llama 3.3 70B Instruct", contextWindow: 128_000, vision: false, tools: false }],
  },
  {
    kind: "openrouter",
    displayName: "OpenRouter Free",
    baseUrl: "https://openrouter.ai/api/v1",
    catalogUrl: "https://openrouter.ai/api/v1/models",
    documentationUrl: "https://openrouter.ai/docs/guides/routing/routers/free-router",
    envKeys: ["OPENROUTER_API_KEY"],
    defaultModelEnv: "OPENROUTER_DEFAULT_MODEL",
    freeMode: "free-model",
    quotaNote: "openrouter/free dynamically selects a currently free model and never selects a paid model.",
    latencyMs: 420,
    quality: 80,
    models: [{ id: "openrouter/free", displayName: "OpenRouter Free Router", contextWindow: 128_000, vision: true, tools: true }],
  },
  {
    kind: "gemini",
    displayName: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    catalogUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    documentationUrl: "https://ai.google.dev/gemini-api/docs/rate-limits",
    envKeys: ["GEMINI_API_KEY"],
    defaultModelEnv: "GEMINI_DEFAULT_MODEL",
    freeMode: "free-account-tier",
    quotaNote: "Eligible models have per-project free-tier RPM, token, and daily quotas.",
    latencyMs: 380,
    quality: 86,
    models: [{ id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", contextWindow: 1_000_000, vision: true, tools: true }],
  },
  {
    kind: "opencode",
    displayName: "OpenCode Zen Free",
    baseUrl: "https://opencode.ai/zen/v1",
    catalogUrl: "https://opencode.ai/zen/v1/models",
    documentationUrl: "https://opencode.ai/docs/zen/",
    envKeys: ["OPENCODE_API_KEY"],
    defaultModelEnv: "OPENCODE_DEFAULT_MODEL",
    freeMode: "free-model",
    quotaNote: "Only documented zero-price chat-completion models are routed; availability is refreshed daily.",
    privacyNote: "OpenCode warns that free-model traffic may be retained or used to improve models. Do not send personal or confidential data.",
    latencyMs: 430,
    quality: 82,
    models: OPENCODE_FREE_MODELS,
  },
  {
    kind: "nous",
    displayName: "Nous Portal Free",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    catalogUrl: "https://portal.nousresearch.com/api/nous/recommended-models",
    documentationUrl: "https://hermes-agent.nousresearch.com/docs/integrations/nous-portal",
    envKeys: ["NOUS_API_KEY", "NOUS_PORTAL_TOKEN"],
    defaultModelEnv: "NOUS_DEFAULT_MODEL",
    freeMode: "free-model",
    quotaNote: "HIVE refreshes Nous Portal's public free-model recommendations daily.",
    latencyMs: 440,
    quality: 81,
    models: NOUS_FREE_MODELS,
  },
  {
    kind: "cerebras",
    displayName: "Cerebras Inference",
    baseUrl: "https://api.cerebras.ai/v1",
    catalogUrl: "https://api.cerebras.ai/v1/models",
    documentationUrl: "https://inference-docs.cerebras.ai/support/rate-limits",
    envKeys: ["CEREBRAS_API_KEY"],
    defaultModelEnv: "CEREBRAS_DEFAULT_MODEL",
    freeMode: "free-account-tier",
    quotaNote: "Public models are available on the free trial with daily request and token limits.",
    latencyMs: 160,
    quality: 86,
    models: [{ id: "gpt-oss-120b", displayName: "GPT OSS 120B", contextWindow: 128_000, vision: false, tools: true }],
  },
  {
    kind: "sambanova",
    displayName: "SambaNova Cloud",
    baseUrl: "https://api.sambanova.ai/v1",
    catalogUrl: "https://api.sambanova.ai/v1/models",
    documentationUrl: "https://docs.sambanova.ai/docs/en/models/rate-limits",
    envKeys: ["SAMBANOVA_API_KEY"],
    defaultModelEnv: "SAMBANOVA_DEFAULT_MODEL",
    freeMode: "free-account-tier",
    quotaNote: "Accounts without a payment method receive per-model daily request and token quotas.",
    latencyMs: 240,
    quality: 84,
    models: [{ id: "Meta-Llama-3.3-70B-Instruct", displayName: "Llama 3.3 70B Instruct", contextWindow: 128_000, vision: false, tools: true }],
  },
  {
    kind: "huggingface",
    displayName: "Hugging Face Inference",
    baseUrl: "https://router.huggingface.co/v1",
    catalogUrl: "https://router.huggingface.co/v1/models",
    documentationUrl: "https://huggingface.co/docs/inference-providers/main/en/pricing",
    envKeys: ["HUGGINGFACE_API_KEY", "HF_TOKEN"],
    defaultModelEnv: "HUGGINGFACE_DEFAULT_MODEL",
    freeMode: "monthly-credit",
    quotaNote: "Free accounts receive a small monthly inference credit; provider and model availability vary.",
    latencyMs: 480,
    quality: 82,
    models: [{ id: "openai/gpt-oss-120b:fastest", displayName: "GPT OSS 120B (fastest provider)", contextWindow: 128_000, vision: false, tools: false }],
  },
  {
    kind: "github",
    displayName: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    catalogUrl: "https://models.github.ai/catalog/models",
    documentationUrl: "https://docs.github.com/en/github-models/prototyping-with-ai-models",
    envKeys: ["GITHUB_MODELS_TOKEN"],
    defaultModelEnv: "GITHUB_MODELS_DEFAULT_MODEL",
    freeMode: "free-account-tier",
    quotaNote: "Every GitHub account receives model-specific, rate-limited free inference usage.",
    latencyMs: 410,
    quality: 86,
    models: [{ id: "openai/gpt-4.1-mini", displayName: "GPT-4.1 mini", contextWindow: 128_000, vision: true, tools: true }],
  },
  {
    kind: "mistral",
    displayName: "Mistral Free Mode",
    baseUrl: "https://api.mistral.ai/v1",
    catalogUrl: "https://api.mistral.ai/v1/models",
    documentationUrl: "https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key",
    envKeys: ["MISTRAL_API_KEY"],
    defaultModelEnv: "MISTRAL_DEFAULT_MODEL",
    freeMode: "free-account-tier",
    quotaNote: "Mistral Free mode works without a credit card and blocks usage at its rate limits.",
    latencyMs: 360,
    quality: 84,
    models: [{ id: "mistral-small-latest", displayName: "Mistral Small", contextWindow: 32_768, vision: false, tools: true }],
  },
] as const;

export const BUILTIN_PROVIDER_URLS = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.kind, provider.baseUrl]),
) as Record<Exclude<ProviderKind, "custom">, string>;

export function providerDefinition(kind: ProviderKind): ProviderDefinition | undefined {
  return PROVIDERS.find((provider) => provider.kind === kind);
}

export function providerCatalogUrl(kind: ProviderKind, baseUrl: string): string {
  return providerDefinition(kind)?.catalogUrl ?? `${baseUrl.replace(/\/+$/, "")}/models`;
}

export function providerRequestHeaders(kind: ProviderKind): Record<string, string> {
  if (kind === "openrouter") return {
    "http-referer": "https://github.com/yuzuruu29/HIVE",
    "x-title": "HIVE 0.1",
  };
  if (kind === "github") return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2026-03-10",
  };
  return {};
}

export function isFreeProviderModel(kind: ProviderKind, model: string): boolean {
  if (kind === "custom") return false;
  if (kind === "openrouter") return model === "openrouter/free" || model.endsWith(":free");
  if (kind === "opencode") return (OPENCODE_FREE_MODEL_IDS as readonly string[]).includes(model);
  if (kind === "nous") return model.endsWith(":free");
  return true;
}

type FreeModelsByProvider = Partial<Record<ProviderKind, FreeModelDescriptor[]>>;

function seedModels(): FreeModelsByProvider {
  return Object.fromEntries(PROVIDERS.map((provider) => [provider.kind, provider.models.map((model) => ({ ...model }))]));
}

function configuredKey(provider: ProviderDefinition, env: NodeJS.ProcessEnv): string | undefined {
  for (const name of provider.envKeys) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function managedCandidatesFromEnv(env: NodeJS.ProcessEnv, discovered: FreeModelsByProvider = seedModels()): RouteCandidate[] {
  const localBridge = env.HIVE_LOCAL_PROVIDER_BRIDGE === "true";
  return PROVIDERS.flatMap((provider) => {
    const apiKey = configuredKey(provider, env);
    if (!apiKey) return [];
    const configuredModel = env[provider.defaultModelEnv]?.trim();
    const models = configuredModel
      ? [{ ...(provider.models[0] ?? { displayName: configuredModel, contextWindow: 128_000, vision: false, tools: false }), id: configuredModel, displayName: configuredModel }]
      : discovered[provider.kind]?.length ? discovered[provider.kind]! : provider.models;
    return models.map((model) => ({
      id: `${localBridge ? "local" : "managed"}:${provider.kind}:${model.id}`,
      provider: provider.kind,
      providerName: `${provider.displayName}${localBridge ? " (local)" : ""}`,
      model: model.id,
      baseUrl: provider.baseUrl,
      apiKey,
      managed: !localBridge,
      free: true,
      healthy: true,
      latencyMs: provider.latencyMs,
      quality: provider.quality - (provider.kind === "opencode" && model.id === "big-pickle" ? 5 : 0),
      contextWindow: model.contextWindow,
      vision: model.vision,
      tools: model.tools,
    } satisfies RouteCandidate));
  });
}

function parseOpenCodeModels(payload: unknown): FreeModelDescriptor[] | undefined {
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) return undefined;
  const available = new Set(payload.data.flatMap((entry) => (
    entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string" ? [entry.id] : []
  )));
  const models = OPENCODE_FREE_MODELS.filter((model) => available.has(model.id));
  return models.length ? models : undefined;
}

function parseNousModels(payload: unknown): FreeModelDescriptor[] | undefined {
  if (!payload || typeof payload !== "object" || !("freeRecommendedModels" in payload) || !Array.isArray(payload.freeRecommendedModels)) return undefined;
  const models = payload.freeRecommendedModels.flatMap((entry): FreeModelDescriptor[] => {
    if (!entry || typeof entry !== "object" || !("modelName" in entry) || typeof entry.modelName !== "string" || !entry.modelName.endsWith(":free")) return [];
    const displayName = "displayName" in entry && typeof entry.displayName === "string" ? entry.displayName : entry.modelName;
    const contextWindow = "contextLength" in entry && typeof entry.contextLength === "number" ? entry.contextLength : 128_000;
    const vision = "isVisionModel" in entry && entry.isVisionModel === true;
    return [{ id: entry.modelName, displayName, contextWindow, vision, tools: true }];
  });
  return models.length ? models : undefined;
}

export interface FreeModelDirectoryOptions {
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

export class FreeModelDirectory {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #models: FreeModelsByProvider = seedModels();
  #refreshedAt = 0;
  #refreshing: Promise<void> | undefined;

  public constructor(options: FreeModelDirectoryOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1_000;
  }

  public candidatesFromEnv(env: NodeJS.ProcessEnv): RouteCandidate[] {
    const needsLiveCatalog = Boolean(env.OPENCODE_API_KEY || env.NOUS_API_KEY || env.NOUS_PORTAL_TOKEN);
    if (needsLiveCatalog && this.#now() - this.#refreshedAt >= this.#ttlMs) void this.refresh().catch(() => undefined);
    return managedCandidatesFromEnv(env, this.#models);
  }

  public async refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const request = (url: string) => this.#fetch(url, {
        headers: { accept: "application/json", "user-agent": "HIVE-Cloud/0.1" },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`Catalog returned HTTP ${response.status}.`);
        return response.json() as Promise<unknown>;
      });
      const [openCode, nous] = await Promise.allSettled([
        request("https://opencode.ai/zen/v1/models"),
        request("https://portal.nousresearch.com/api/nous/recommended-models"),
      ]);
      if (openCode.status === "fulfilled") {
        const models = parseOpenCodeModels(openCode.value);
        if (models) this.#models.opencode = models;
      }
      if (nous.status === "fulfilled") {
        const models = parseNousModels(nous.value);
        if (models) this.#models.nous = models;
      }
      this.#refreshedAt = this.#now();
    })().finally(() => { this.#refreshing = undefined; });
    return this.#refreshing;
  }

  public catalog(env: NodeJS.ProcessEnv): FreeProviderCatalogEntry[] {
    const candidates = this.candidatesFromEnv(env);
    const configured = new Set(candidates.map((candidate) => candidate.provider));
    return [
      ...PROVIDERS.map((provider) => {
        const models = this.#models[provider.kind] ?? provider.models;
        return ({
          kind: provider.kind,
          displayName: provider.displayName,
          baseUrl: provider.baseUrl,
          defaultModel: models[0]!.id,
          freeMode: provider.freeMode,
          quotaNote: provider.quotaNote,
          documentationUrl: provider.documentationUrl,
          catalogUrl: provider.catalogUrl,
          ...(provider.privacyNote ? { privacyNote: provider.privacyNote } : {}),
          capabilities: {
            vision: models.some((model) => model.vision),
            tools: models.some((model) => model.tools),
            contextWindow: Math.max(...models.map((model) => model.contextWindow)),
          },
          freeModels: models.map((model) => model.id),
          runtimeConfigured: configured.has(provider.kind),
        } satisfies FreeProviderCatalogEntry);
      }),
      {
        kind: "custom",
        displayName: "Custom OpenAI-compatible",
        defaultModel: "model-id",
        freeMode: "custom",
        quotaNote: "Use any other public HTTPS OpenAI-compatible endpoint; HIVE cannot infer its pricing.",
        documentationUrl: "https://github.com/yuzuruu29/HIVE",
        capabilities: { vision: false, tools: false, contextWindow: 32_768 },
        freeModels: [],
        runtimeConfigured: false,
      },
    ];
  }
}
