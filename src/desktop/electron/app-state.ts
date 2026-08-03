import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DesktopProviderMetadata, DesktopRecentRepository } from "../types.js";

export const DESKTOP_APP_STATE_SCHEMA_VERSION = 1 as const;

const BUILT_IN_PROVIDER_METADATA: DesktopProviderMetadata[] = [
  { id: "anthropic", name: "Anthropic", kind: "anthropic", authType: "api-key", approved: false, configured: false },
  { id: "hive-cloud", name: "HIVE 0.1", kind: "openai-compatible", authType: "bearer", approved: false, configured: false, defaultModel: "hive-0.1" },
  { id: "ollama", name: "Ollama (local)", kind: "ollama", authType: "none", approved: false, configured: false, baseUrl: "http://127.0.0.1:11434" },
  { id: "openai", name: "OpenAI", kind: "openai", authType: "api-key", approved: false, configured: false },
];

export interface DesktopPreferences {
  theme: "dark" | "system";
  reducedMotion: boolean;
  editor: "vscode" | "cursor" | "visual-studio";
}

export interface DesktopAppStateV1 {
  schemaVersion: typeof DESKTOP_APP_STATE_SCHEMA_VERSION;
  updatedAt: string;
  recentRepositories: DesktopRecentRepository[];
  preferences: DesktopPreferences;
  providers: DesktopProviderMetadata[];
}

export interface JsonDesktopAppStateStoreOptions { clock?: () => string }

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is corrupt.`);
  const candidate = value as Record<string, unknown>;
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has unknown or missing fields.`);
  return candidate;
}

function finiteDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is corrupt.`);
  return value;
}

function nonempty(value: unknown, label: string, maximum = 32_768): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) throw new Error(`${label} is corrupt.`);
  return value;
}

function validateProvider(value: unknown): DesktopProviderMetadata {
  const candidate = value as Record<string, unknown>;
  const required = ["id", "name", "kind", "authType", "approved", "configured"];
  const optional = ["baseUrl", "defaultModel"];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Desktop provider metadata is corrupt.");
  if (required.some((key) => !(key in candidate)) || Object.keys(candidate).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error("Desktop provider metadata has unknown or missing fields.");
  nonempty(candidate.id, "Provider id", 96); nonempty(candidate.name, "Provider name", 200);
  if (!["openai", "openai-compatible", "openrouter", "anthropic", "google", "ollama", "local", "oauth", "custom"].includes(String(candidate.kind))) throw new Error("Provider kind is corrupt.");
  if (!["api-key", "bearer", "oauth", "none"].includes(String(candidate.authType))) throw new Error("Provider auth type is corrupt.");
  if (typeof candidate.approved !== "boolean" || typeof candidate.configured !== "boolean") throw new Error("Provider flags are corrupt.");
  if (candidate.baseUrl !== undefined) {
    const providerUrl = new URL(nonempty(candidate.baseUrl, "Provider URL", 2_048));
    if (providerUrl.protocol !== "https:" && providerUrl.protocol !== "http:") throw new Error("Provider URL is corrupt.");
  }
  if (candidate.defaultModel !== undefined) nonempty(candidate.defaultModel, "Default model", 256);
  return { ...candidate } as unknown as DesktopProviderMetadata;
}

export function validateDesktopAppState(value: unknown): DesktopAppStateV1 {
  const candidate = exact(value, ["schemaVersion", "updatedAt", "recentRepositories", "preferences", "providers"], "Desktop AppData state");
  if (candidate.schemaVersion !== 1) throw new Error("Desktop AppData state schema is corrupt.");
  finiteDate(candidate.updatedAt, "Desktop AppData timestamp");
  if (!Array.isArray(candidate.recentRepositories) || candidate.recentRepositories.length > 100) throw new Error("Recent repositories are corrupt.");
  const recentRepositories = candidate.recentRepositories.map((entry) => {
    const recent = exact(entry, ["path", "lastOpenedAt"], "Recent repository");
    const repositoryPath = nonempty(recent.path, "Recent repository path");
    if (!path.isAbsolute(repositoryPath)) throw new Error("Recent repository path is corrupt.");
    return { path: repositoryPath, lastOpenedAt: finiteDate(recent.lastOpenedAt, "Recent repository timestamp") };
  });
  const preference = exact(candidate.preferences, ["theme", "reducedMotion", "editor"], "Desktop preferences");
  if (!["dark", "system"].includes(String(preference.theme)) || typeof preference.reducedMotion !== "boolean" || !["vscode", "cursor", "visual-studio"].includes(String(preference.editor))) {
    throw new Error("Desktop preferences are corrupt.");
  }
  if (!Array.isArray(candidate.providers) || candidate.providers.length > 100) throw new Error("Desktop provider metadata is corrupt.");
  return {
    schemaVersion: 1,
    updatedAt: candidate.updatedAt as string,
    recentRepositories,
    preferences: preference as unknown as DesktopPreferences,
    providers: candidate.providers.map(validateProvider),
  };
}

const stateLocks = new Map<string, Promise<void>>();

async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = stateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  stateLocks.set(key, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (stateLocks.get(key) === current) stateLocks.delete(key); }
}

export class JsonDesktopAppStateStore {
  readonly #file: string;
  readonly #clock: () => string;

  public constructor(userDataDirectory: string, options: JsonDesktopAppStateStoreOptions = {}) {
    this.#file = path.resolve(userDataDirectory, "desktop-state.json");
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  public async load(): Promise<DesktopAppStateV1> {
    return this.#loadUnlocked();
  }

  async #loadUnlocked(): Promise<DesktopAppStateV1> {
    try {
      return validateDesktopAppState(JSON.parse(await fs.readFile(this.#file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.defaultState();
      if (error instanceof SyntaxError) throw new Error("Desktop AppData state is corrupt and was preserved.");
      throw error;
    }
  }

  public async save(value: unknown): Promise<DesktopAppStateV1> {
    const valid = validateDesktopAppState(value);
    return locked(this.#file.toLowerCase(), async () => {
      try { await fs.access(this.#file); await this.#loadUnlocked(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.#writeUnlocked(valid);
      return valid;
    });
  }

  public async mutate(transform: (current: DesktopAppStateV1) => unknown | Promise<unknown>): Promise<DesktopAppStateV1> {
    if (typeof transform !== "function") throw new TypeError("Desktop AppData mutation requires a transform.");
    return locked(this.#file.toLowerCase(), async () => {
      const current = await this.#loadUnlocked();
      const next = validateDesktopAppState(await transform(structuredClone(current)));
      await this.#writeUnlocked(next);
      return next;
    });
  }

  async #writeUnlocked(valid: DesktopAppStateV1): Promise<void> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.rename(temporary, this.#file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }

  public defaultState(): DesktopAppStateV1 {
    return { schemaVersion: 1, updatedAt: this.#clock(), recentRepositories: [], preferences: { theme: "dark", reducedMotion: false, editor: "vscode" }, providers: structuredClone(BUILT_IN_PROVIDER_METADATA) };
  }
}
