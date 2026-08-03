import os from "node:os";
import { redactSecrets } from "../runner.js";
import { ProviderRegistry } from "../providers/registry.js";
import type {
  ProviderAdapter,
  ProviderCompletionResult,
  ProviderConfig,
  ProviderHealthResult,
  ProviderRoles,
  RoleAssignment,
} from "../providers/types.js";
import type { AgentCompletionClient, AgentCompletionResponse } from "./agent-loop.js";
import type {
  ProviderBinding,
  ProviderBindingRole,
  SubagentRole,
} from "./types.js";

export interface ProviderRegistryLike {
  get(id: string): Promise<ProviderConfig | undefined>;
  getRoles(): Promise<ProviderRoles>;
  test(id: string): Promise<ProviderHealthResult>;
  getAdapter(id: string): Promise<{
    adapter: ProviderAdapter;
    config: ProviderConfig;
  }>;
}

export interface ProviderOverride {
  providerId?: string;
  model?: string;
  fallbackProviderId?: string;
  fallbackModel?: string;
}

export interface RoutedProviderCompletionRequest {
  role: ProviderBindingRole;
  providerId?: string;
  model?: string;
  fallbackProviderId?: string;
  fallbackModel?: string;
  systemPrompt?: string;
  prompt: string;
  cwd?: string;
  signal?: AbortSignal;
}

export interface ResolvedProviderRoute {
  role: ProviderBindingRole;
  providerId: string;
  model: string;
  source: "explicit" | "session" | "project" | "global" | "fallback";
  registryScope: "project" | "global";
  degraded: boolean;
  config: ProviderConfig;
  adapter: ProviderAdapter;
}

export interface ProviderRouterOptions {
  projectRoot: string;
  sessionId: string;
  sessionBindings?: readonly ProviderBinding[];
  cliOverrides?: Partial<Record<ProviderBindingRole, ProviderOverride>>;
  projectRegistry?: ProviderRegistryLike;
  globalRegistry?: ProviderRegistryLike;
  onDegradedRoute?: (route: ResolvedProviderRoute, failures: readonly string[]) => void;
}

interface RouteCandidate {
  role: ProviderBindingRole;
  providerId: string;
  model?: string;
  source: ResolvedProviderRoute["source"];
  fallbackProviderId?: string;
  fallbackModel?: string;
}

interface LocatedProvider {
  registry: ProviderRegistryLike;
  registryScope: ResolvedProviderRoute["registryScope"];
  config: ProviderConfig;
}

function abortError(): Error {
  const error = new Error("Provider request cancelled.");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  assertNotAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function roleAssignment(roles: ProviderRoles, role: ProviderBindingRole): RoleAssignment | undefined {
  return roles[role];
}

function candidateFromBinding(
  binding: ProviderBinding,
  source: RouteCandidate["source"],
): RouteCandidate {
  return {
    role: binding.role,
    providerId: binding.providerId,
    model: binding.model,
    source,
    fallbackProviderId: binding.fallbackProviderId,
    fallbackModel: binding.fallbackModel,
  };
}

function candidateFromAssignment(
  role: ProviderBindingRole,
  assignment: RoleAssignment,
  source: RouteCandidate["source"],
): RouteCandidate {
  return {
    role,
    providerId: assignment.provider,
    model: assignment.model,
    source,
  };
}

function completionUsage(result: ProviderCompletionResult): AgentCompletionResponse["usage"] {
  if (!result.usage) return undefined;
  return {
    input: result.usage.promptTokens,
    output: result.usage.completionTokens,
    total: result.usage.totalTokens,
  };
}

function safeFailure(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function configuredModel(candidate: RouteCandidate, config: ProviderConfig): string {
  const model = candidate.model?.trim() || config.defaultModel?.trim() || config.model?.trim();
  if (!model) {
    throw new Error(`Provider ${config.id} has no configured model for role ${candidate.role}.`);
  }
  return model;
}

export class ProviderRouter implements AgentCompletionClient {
  readonly #sessionId: string;
  readonly #sessionBindings: readonly ProviderBinding[];
  readonly #cliOverrides: Partial<Record<ProviderBindingRole, ProviderOverride>>;
  readonly #projectRegistry: ProviderRegistryLike;
  readonly #globalRegistry: ProviderRegistryLike;
  readonly #onDegradedRoute?: ProviderRouterOptions["onDegradedRoute"];
  readonly #healthyProviders = new Set<string>();

  public constructor(options: ProviderRouterOptions) {
    if (!options.sessionId.trim()) throw new Error("ProviderRouter requires a session id.");
    this.#sessionId = options.sessionId;
    this.#sessionBindings = options.sessionBindings ?? [];
    this.#cliOverrides = options.cliOverrides ?? {};
    this.#projectRegistry = options.projectRegistry ?? new ProviderRegistry(options.projectRoot);
    this.#globalRegistry = options.globalRegistry ?? new ProviderRegistry(os.homedir());
    this.#onDegradedRoute = options.onDegradedRoute;
  }

  public get sessionId(): string {
    return this.#sessionId;
  }

  public clearHealthCache(): void {
    this.#healthyProviders.clear();
  }

  public async resolve(
    role: ProviderBindingRole,
    override?: ProviderOverride,
    signal?: AbortSignal,
  ): Promise<ResolvedProviderRoute> {
    const { candidates, failures } = await this.#buildCandidates(role, override);
    for (const [index, candidate] of candidates.entries()) {
      assertNotAborted(signal);
      try {
        const route = await this.#resolveCandidate(
          candidate,
          index > 0 || candidate.source === "fallback",
          signal,
        );
        if (route.degraded) this.#onDegradedRoute?.(route, failures);
        return route;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        failures.push(`${candidate.providerId}: ${safeFailure(error)}`);
      }
    }
    throw new Error(`No healthy provider route for ${role}. ${failures.join(" | ")}`.trim());
  }

  public async complete(request: RoutedProviderCompletionRequest): Promise<AgentCompletionResponse> {
    const explicit: ProviderOverride | undefined = request.providerId || request.model ||
      request.fallbackProviderId || request.fallbackModel
      ? {
          providerId: request.providerId,
          model: request.model,
          fallbackProviderId: request.fallbackProviderId,
          fallbackModel: request.fallbackModel,
        }
      : undefined;
    const { candidates, failures } = await this.#buildCandidates(request.role, explicit);

    for (const [index, candidate] of candidates.entries()) {
      assertNotAborted(request.signal);
      try {
        const route = await this.#resolveCandidate(
          candidate,
          index > 0 || candidate.source === "fallback",
          request.signal,
        );
        const result = await withAbort(
          route.adapter.complete(route.config, {
            prompt: request.prompt,
            model: route.model,
            systemPrompt: request.systemPrompt,
          }),
          request.signal,
        );
        if (!result.output || !result.output.trim()) {
          throw new Error(`Provider ${route.providerId} returned an empty response.`);
        }
        if (route.degraded) this.#onDegradedRoute?.(route, failures);
        return { output: result.output, usage: completionUsage(result) };
      } catch (error) {
        if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        failures.push(`${candidate.providerId}: ${safeFailure(error)}`);
      }
    }

    throw new Error(`All configured provider routes failed for ${request.role}. ${failures.join(" | ")}`.trim());
  }

  public async bindingForRole(
    role: ProviderBindingRole,
    override?: ProviderOverride,
    signal?: AbortSignal,
  ): Promise<ProviderBinding> {
    const route = await this.resolve(role, override, signal);
    return {
      role,
      providerId: route.providerId,
      model: route.model,
      degraded: route.degraded,
    };
  }

  async #buildCandidates(
    role: ProviderBindingRole,
    directOverride?: ProviderOverride,
  ): Promise<{ candidates: RouteCandidate[]; failures: string[] }> {
    const projectRoles = await this.#projectRegistry.getRoles();
    const globalRoles = await this.#globalRegistry.getRoles();
    const configuredOverride = directOverride ?? this.#cliOverrides[role];
    const sessionBinding = this.#sessionBindings.find((binding) => binding.role === role);
    const projectAssignment = roleAssignment(projectRoles, role);
    const globalAssignment = roleAssignment(globalRoles, role);

    let primary: RouteCandidate | undefined;
    if (configuredOverride?.providerId) {
      primary = {
        role,
        providerId: configuredOverride.providerId,
        model: configuredOverride.model,
        source: "explicit",
        fallbackProviderId: configuredOverride.fallbackProviderId,
        fallbackModel: configuredOverride.fallbackModel,
      };
    } else if (sessionBinding) {
      primary = candidateFromBinding(sessionBinding, "session");
      if (configuredOverride?.model) primary.model = configuredOverride.model;
    } else if (projectAssignment) {
      primary = candidateFromAssignment(role, projectAssignment, "project");
      if (configuredOverride?.model) primary.model = configuredOverride.model;
    } else if (globalAssignment) {
      primary = candidateFromAssignment(role, globalAssignment, "global");
      if (configuredOverride?.model) primary.model = configuredOverride.model;
    }

    const candidates: RouteCandidate[] = primary ? [primary] : [];
    const addFallback = (providerId?: string, model?: string) => {
      if (!providerId) return;
      if (candidates.some((candidate) => candidate.providerId === providerId && candidate.model === model)) return;
      candidates.push({ role, providerId, model, source: "fallback" });
    };

    addFallback(primary?.fallbackProviderId, primary?.fallbackModel);
    addFallback(
      configuredOverride?.fallbackProviderId,
      configuredOverride?.fallbackModel,
    );
    const sessionFallback = this.#sessionBindings.find((binding) =>
      binding.role === role && binding.fallbackProviderId,
    );
    addFallback(sessionFallback?.fallbackProviderId, sessionFallback?.fallbackModel);
    addFallback(projectRoles.fallback?.provider, projectRoles.fallback?.model);
    addFallback(globalRoles.fallback?.provider, globalRoles.fallback?.model);
    if (candidates.length === 0) {
      throw new Error(`No provider binding configured for role ${role}.`);
    }
    return { candidates, failures: [] };
  }

  async #locateProvider(providerId: string): Promise<LocatedProvider> {
    const projectConfig = await this.#projectRegistry.get(providerId);
    if (projectConfig) {
      return {
        registry: this.#projectRegistry,
        registryScope: "project",
        config: projectConfig,
      };
    }
    const globalConfig = await this.#globalRegistry.get(providerId);
    if (globalConfig) {
      return {
        registry: this.#globalRegistry,
        registryScope: "global",
        config: globalConfig,
      };
    }
    throw new Error(`Provider ${providerId} is not configured in the project or global registry.`);
  }

  async #resolveCandidate(
    candidate: RouteCandidate,
    degraded: boolean,
    signal?: AbortSignal,
  ): Promise<ResolvedProviderRoute> {
    const located = await this.#locateProvider(candidate.providerId);
    if (!located.config.approved) {
      throw new Error(`Provider ${candidate.providerId} is configured but not approved.`);
    }
    const model = configuredModel(candidate, located.config);
    const healthKey = `${located.registryScope}:${located.config.id}`;
    if (!this.#healthyProviders.has(healthKey)) {
      const health = await withAbort(located.registry.test(located.config.id), signal);
      if (!health.ok) throw new Error(health.redactedError || health.message || "health check failed");
      this.#healthyProviders.add(healthKey);
    }
    const { adapter, config } = await located.registry.getAdapter(located.config.id);
    return {
      role: candidate.role,
      providerId: config.id,
      model,
      source: degraded ? "fallback" : candidate.source,
      registryScope: located.registryScope,
      degraded,
      config,
      adapter,
    };
  }
}

export function asSubagentCompletionClient(router: ProviderRouter): AgentCompletionClient {
  return {
    complete: (request) => router.complete({
      role: request.role as SubagentRole,
      providerId: request.providerId,
      model: request.model,
      systemPrompt: request.systemPrompt,
      prompt: request.prompt,
      cwd: request.cwd,
      signal: request.signal,
    }),
  };
}
