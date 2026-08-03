import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redactSecrets } from "../runner.js";
import type {
  AgentToolExecutor,
  AgentToolName,
  AgentToolResult,
} from "./agent-loop.js";
import type {
  ApprovalPolicy,
  FileChangeRecord,
  JsonValue,
  RuntimeEventInput,
  RuntimeEventPayloadMap,
  RuntimeEventType,
  SubagentTask,
} from "./types.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const COMMAND_ID_PATTERN = /^cmd-[A-Za-z0-9._-]{1,120}$/;
const SHELL_METACHARACTERS = /[;&|<>`$\r\n]/;
const DEFAULT_OUTPUT_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_READ_CHARS = 1_000_000;
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const IGNORED_SEARCH_DIRECTORIES = new Set([
  ".git",
  ".hivemind",
  "node_modules",
  "coverage",
]);
const ALLOWED_EXECUTABLES = new Set([
  "bun",
  "cargo",
  "deno",
  "dotnet",
  "go",
  "gradle",
  "gradlew",
  "java",
  "javac",
  "mvn",
  "mvnw",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python",
  "python3",
  "pytest",
  "tsc",
  "yarn",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);
const SAFE_SCRIPT_NAMES = new Set([
  "build",
  "check",
  "lint",
  "test",
  "test:unit",
  "test:integration",
  "typecheck",
  "verify",
]);
const EXTERNAL_EFFECT_WORDS = new Set([
  "deploy",
  "login",
  "logout",
  "publish",
  "push",
  "release",
  "upload",
]);
const DESTRUCTIVE_WORDS = new Set([
  "clean",
  "delete",
  "destroy",
  "drop",
  "erase",
  "prune",
  "purge",
  "remove-all",
]);
const SENSITIVE_INPUT_KEY =
  /(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|password|private[-_]?key|secret|token)$/i;
const COMMON_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[opsu]_[A-Za-z0-9_]{12,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
];

export interface RepositoryToolServiceOptions {
  repositoryRoot: string;
  sessionId: string;
  approvalPolicy: ApprovalPolicy;
  fileScope?: readonly string[];
  sessionDirectory?: string;
  subagentId?: string;
  defaultTimeoutMs?: number;
  outputCapChars?: number;
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEventInput) => void;
  clock?: () => string;
  idFactory?: () => string;
}

export interface ToolExecutionContext {
  fileScope?: readonly string[];
  subagentId?: string;
  taskId?: string;
  signal?: AbortSignal;
}

export interface FileReadResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export interface DirectoryEntryResult {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface TextSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface SymbolSearchMatch extends TextSearchMatch {
  kind: string;
  symbol: string;
}

export interface SearchOptions {
  paths?: readonly string[];
  caseSensitive?: boolean;
  regex?: boolean;
  maxResults?: number;
}

export interface FileWriteResult {
  path: string;
  operation: FileChangeRecord["operation"];
  bytes: number;
}

export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  taskId?: string;
  subagentId?: string;
}

export interface CommandResult {
  commandId: string;
  command: string[];
  cwd: string;
  exitCode: number | null;
  signal?: string;
  passed: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
  logPath: string;
  filesChanged?: string[];
}

interface ProcessOptions extends CommandRunOptions {
  input?: string;
  skipPolicyValidation?: boolean;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function abortError(message = "Tool execution cancelled."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function normalizeRepositoryPath(value: string, allowRoot = false): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Path must be a valid string.");
  const slashed = value.trim().replace(/\\/g, "/");
  if (!slashed || slashed === ".") {
    if (allowRoot) return "";
    throw new Error("A repository-relative file path is required.");
  }
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(slashed)) {
    throw new Error(`Absolute paths are outside the repository boundary: ${value}`);
  }
  const normalized = path.posix.normalize(slashed).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path traversal outside the repository is not allowed: ${value}`);
  }
  return normalized;
}

function scopeKey(value: string): string {
  const normalized = normalizeRepositoryPath(value);
  if (/[*?\[\]{}]/.test(normalized)) {
    throw new Error(`File scope must name an exact path, not a pattern: ${value}`);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function executableName(command: string): string {
  return path.basename(command).toLowerCase().replace(/\.(?:cmd|exe|bat)$/i, "");
}

function combineSignals(primary?: AbortSignal, secondary?: AbortSignal): {
  signal?: AbortSignal;
  dispose: () => void;
} {
  if (!primary) return { signal: secondary, dispose: () => undefined };
  if (!secondary || primary === secondary) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  if (primary.aborted || secondary.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener("abort", abort);
      secondary.removeEventListener("abort", abort);
    },
  };
}

function parseCommandString(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("Command is required.");
  if (SHELL_METACHARACTERS.test(trimmed)) {
    throw new Error("Shell composition and metacharacters are not allowed.");
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && trimmed[index + 1] === quote) {
        current += quote;
        index += 1;
      } else {
        current += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (quote) throw new Error("Command contains an unterminated quote.");
  if (current) tokens.push(current);
  if (tokens.length === 0) throw new Error("Command is required.");
  return tokens;
}

function parseCommand(command: string | readonly string[]): string[] {
  if (typeof command === "string") return parseCommandString(command);
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.includes("\0"))) {
    throw new Error("Command arguments must be non-empty strings.");
  }
  return [...command];
}

function normalizedWord(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/^--?/, "");
}

function looksLikeVersionCheck(args: readonly string[]): boolean {
  return args.length === 1 && ["--version", "-v", "version"].includes(args[0].toLowerCase());
}

function isDependencyInstallation(executable: string, args: readonly string[]): boolean {
  const first = normalizedWord(args[0]);
  if (executable === "npx") return !args.includes("--no-install");
  if (["npm", "pnpm"].includes(executable)) {
    return new Set(["add", "ci", "exec", "i", "install", "link", "remove", "uninstall", "unlink", "update", "upgrade"]).has(first);
  }
  if (executable === "yarn") {
    return new Set(["add", "dlx", "install", "link", "plugin", "remove", "set", "up", "upgrade"]).has(first);
  }
  if (executable === "bun") return new Set(["add", "install", "remove", "update", "x"]).has(first);
  if (executable === "cargo") return new Set(["add", "install", "update"]).has(first);
  if (executable === "go") return new Set(["get", "install"]).has(first);
  if (executable === "dotnet") return new Set(["add", "nuget", "remove", "restore", "tool"]).has(first);
  return false;
}

function isExternalOrDestructive(args: readonly string[]): { external?: string; destructive?: string } {
  for (const arg of args) {
    const word = normalizedWord(arg).split(":")[0];
    if (EXTERNAL_EFFECT_WORDS.has(word)) return { external: word };
    if (DESTRUCTIVE_WORDS.has(word)) return { destructive: word };
  }
  return {};
}

function assertGitSafety(args: readonly string[]): void {
  const subcommand = normalizedWord(args[0]);
  const lower = args.map((arg) => arg.toLowerCase());
  if (subcommand === "reset" && lower.includes("--hard")) {
    throw new Error("Prohibited Git operation: reset --hard.");
  }
  if (subcommand === "clean" && lower.some((arg) => /-[a-z]*f[a-z]*d|-[a-z]*d[a-z]*f/i.test(arg)) ||
      subcommand === "clean" && lower.includes("-f") && lower.includes("-d")) {
    throw new Error("Prohibited Git operation: clean -fd.");
  }
  if (subcommand === "push") {
    throw new Error("Git push is an external operation and is not available to repository tools.");
  }
  if (subcommand === "commit" && lower.includes("--amend")) {
    throw new Error("Prohibited Git operation: commit --amend.");
  }
  if (lower.some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force="))) {
    if (subcommand === "push") throw new Error("Prohibited Git operation: force push.");
  }
}

export function filteredCodingToolEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION)/i.test(key)) continue;
    environment[key] = value;
  }
  return environment;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string.`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number.`);
  return value;
}

function redactToolText(value: string): string {
  let redacted = redactSecrets(value);
  for (const pattern of COMMON_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function jsonValue(value: unknown, key?: string): JsonValue {
  if (key && SENSITIVE_INPUT_KEY.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return redactToolText(value);
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry));
  if (typeof value === "object" && value !== null) {
    const record: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) record[key] = jsonValue(child, key);
    }
    return record;
  }
  return String(value);
}

function stripPatchPrefix(value: string): string | undefined {
  const trimmed = value.trim().split("\t", 1)[0].replace(/^"|"$/g, "");
  if (trimmed === "/dev/null") return undefined;
  return trimmed.replace(/^[ab]\//, "");
}

function extractPatchPaths(patchText: string): string[] {
  if (/GIT binary patch|(?:new|old) file mode 120000/.test(patchText)) {
    throw new Error("Binary and symbolic-link patches are not supported.");
  }
  const paths = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git (?:"a\/(.*?)"|a\/(\S+)) (?:"b\/(.*?)"|b\/(\S+))$/);
      if (!match) throw new Error("Patch contains an unsupported diff header.");
      for (const value of [match[1] ?? match[2], match[3] ?? match[4]]) {
        if (value) paths.add(normalizeRepositoryPath(value.replace(/\\"/g, '"')));
      }
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const filePath = stripPatchPrefix(line.slice(4));
      if (filePath) paths.add(normalizeRepositoryPath(filePath));
    }
  }
  if (paths.size === 0) throw new Error("Patch does not contain any repository file paths.");
  return [...paths];
}

function extractDiffPaths(diffText: string): string[] {
  if (!diffText.trim()) return [];
  try {
    return extractPatchPaths(diffText);
  } catch {
    return [];
  }
}

export class RepositoryToolService implements AgentToolExecutor {
  readonly #repositoryRoot: string;
  readonly #sessionId: string;
  readonly #approvalPolicy: ApprovalPolicy;
  readonly #fileScope: readonly string[];
  readonly #sessionDirectory: string;
  readonly #defaultSubagentId?: string;
  readonly #defaultTimeoutMs: number;
  readonly #outputCapChars: number;
  readonly #defaultSignal?: AbortSignal;
  readonly #onEvent?: RepositoryToolServiceOptions["onEvent"];
  readonly #clock: () => string;
  readonly #idFactory: () => string;
  #rootRealPath?: string;

  public constructor(options: RepositoryToolServiceOptions) {
    if (!SESSION_ID_PATTERN.test(options.sessionId)) throw new Error("RepositoryToolService requires a safe session id.");
    this.#repositoryRoot = path.resolve(options.repositoryRoot);
    this.#sessionId = options.sessionId;
    this.#approvalPolicy = options.approvalPolicy;
    this.#fileScope = options.fileScope ?? [];
    this.#sessionDirectory = path.resolve(
      options.sessionDirectory ?? path.join(this.#repositoryRoot, ".hivemind", "sessions", options.sessionId),
    );
    if (!isInside(this.#repositoryRoot, this.#sessionDirectory)) {
      throw new Error("Session directory must stay inside the repository root.");
    }
    this.#defaultSubagentId = options.subagentId;
    this.#defaultTimeoutMs = Math.min(Math.max(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
    this.#outputCapChars = Math.max(options.outputCapChars ?? DEFAULT_OUTPUT_CAP, 1_024);
    this.#defaultSignal = options.signal;
    this.#onEvent = options.onEvent;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  public get repositoryRoot(): string {
    return this.#repositoryRoot;
  }

  public get sessionDirectory(): string {
    return this.#sessionDirectory;
  }

  async #rootReal(): Promise<string> {
    this.#rootRealPath ??= await fs.realpath(this.#repositoryRoot);
    return this.#rootRealPath;
  }

  async #resolvePath(relativePath: string, options: { allowRoot?: boolean; forWrite?: boolean } = {}): Promise<{
    relative: string;
    absolute: string;
  }> {
    const relative = normalizeRepositoryPath(relativePath, options.allowRoot);
    const absolute = path.resolve(this.#repositoryRoot, ...relative.split("/").filter(Boolean));
    if (!isInside(this.#repositoryRoot, absolute)) throw new Error("Resolved path escapes the repository root.");
    const rootReal = await this.#rootReal();
    try {
      const stat = await fs.lstat(absolute);
      const real = await fs.realpath(absolute);
      if (!isInside(rootReal, real)) throw new Error(`Symbolic-link path escapes the repository root: ${relative}`);
      if (options.forWrite && stat.isSymbolicLink()) {
        throw new Error(`Writing through a symbolic link is not allowed: ${relative}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let parent = path.dirname(absolute);
      while (true) {
        try {
          const realParent = await fs.realpath(parent);
          if (!isInside(rootReal, realParent)) {
            throw new Error(`Parent symbolic link escapes the repository root: ${relative}`);
          }
          break;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
          const next = path.dirname(parent);
          if (next === parent) throw new Error(`Unable to resolve a safe parent for ${relative}`);
          parent = next;
        }
      }
    }
    return { relative, absolute };
  }

  #scopeFor(context?: ToolExecutionContext): readonly string[] {
    return context?.fileScope ?? this.#fileScope;
  }

  #assertWriteAllowed(relativePath: string, context?: ToolExecutionContext): void {
    if (this.#approvalPolicy === "safe") {
      throw new Error("Approval policy 'safe' blocks repository writes until the user approves changes.");
    }
    const allowed = new Set(this.#scopeFor(context).map(scopeKey));
    const key = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    if (!allowed.has(key)) {
      throw new Error(`Write blocked: ${relativePath} is outside the exact declared file scope.`);
    }
  }

  #contextSubagent(context?: ToolExecutionContext): string | undefined {
    return context?.subagentId ?? context?.taskId ?? this.#defaultSubagentId;
  }

  #emit<TType extends RuntimeEventType>(type: TType, payload: RuntimeEventPayloadMap[TType]): void {
    this.#onEvent?.({
      sessionId: this.#sessionId,
      timestamp: this.#clock(),
      type,
      payload,
    } as unknown as RuntimeEventInput);
  }

  #emitTool(tool: AgentToolName, input: Record<string, unknown>, context?: ToolExecutionContext): void {
    const subagentId = this.#contextSubagent(context);
    if (!subagentId) return;
    this.#emit("subagent.tool_call", { subagentId, tool, input: jsonValue(input) });
  }

  #emitFileChange(result: FileWriteResult, context?: ToolExecutionContext): void {
    const subagentId = this.#contextSubagent(context);
    const change: FileChangeRecord = {
      path: result.path,
      operation: result.operation,
      taskId: context?.taskId ?? subagentId,
      recordedAt: this.#clock(),
    };
    this.#emit("file.changed", { change });
    if (subagentId) {
      this.#emit("subagent.file_changed", {
        subagentId,
        path: result.path,
        operation: result.operation,
      });
    }
  }

  public async readFile(relativePath: string, maxChars = MAX_READ_CHARS): Promise<FileReadResult> {
    const resolved = await this.#resolvePath(relativePath);
    const stat = await fs.stat(resolved.absolute);
    if (!stat.isFile()) throw new Error(`${resolved.relative} is not a file.`);
    const content = await fs.readFile(resolved.absolute, "utf8");
    const limit = Math.max(1, Math.min(maxChars, MAX_READ_CHARS));
    return {
      path: resolved.relative,
      content: content.length > limit ? content.slice(0, limit) : content,
      size: stat.size,
      truncated: content.length > limit,
    };
  }

  public async listDirectory(relativePath = "."): Promise<DirectoryEntryResult[]> {
    const resolved = await this.#resolvePath(relativePath, { allowRoot: true });
    const entries = await fs.readdir(resolved.absolute, { withFileTypes: true });
    return entries
      .map((entry): DirectoryEntryResult => ({
        path: [resolved.relative, entry.name].filter(Boolean).join("/"),
        name: entry.name,
        kind: entry.isFile()
          ? "file"
          : entry.isDirectory()
            ? "directory"
            : entry.isSymbolicLink()
              ? "symlink"
              : "other",
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async #searchableFiles(paths: readonly string[]): Promise<string[]> {
    const pending = [...paths];
    const files: string[] = [];
    while (pending.length > 0 && files.length < MAX_SEARCH_FILES) {
      const candidate = pending.pop() as string;
      const resolved = await this.#resolvePath(candidate, { allowRoot: true });
      const stat = await fs.lstat(resolved.absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile()) {
        if (stat.size <= MAX_SEARCH_FILE_BYTES) files.push(resolved.relative);
        continue;
      }
      if (!stat.isDirectory()) continue;
      const entries = await fs.readdir(resolved.absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && IGNORED_SEARCH_DIRECTORIES.has(entry.name)) continue;
        pending.push([resolved.relative, entry.name].filter(Boolean).join("/"));
      }
    }
    return files.sort();
  }

  public async searchText(query: string, options: SearchOptions = {}): Promise<TextSearchMatch[]> {
    if (!query) throw new Error("Search query is required.");
    const flags = options.caseSensitive ? "g" : "gi";
    let matcher: RegExp;
    try {
      matcher = options.regex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch (error) {
      throw new Error(`Invalid search expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    const maxResults = Math.max(1, Math.min(options.maxResults ?? 200, 2_000));
    const files = await this.#searchableFiles(options.paths ?? ["."]);
    const matches: TextSearchMatch[] = [];
    for (const file of files) {
      const resolved = await this.#resolvePath(file);
      const buffer = await fs.readFile(resolved.absolute);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (const [lineIndex, line] of lines.entries()) {
        matcher.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = matcher.exec(line)) !== null) {
          matches.push({
            path: file,
            line: lineIndex + 1,
            column: match.index + 1,
            text: line,
          });
          if (matches.length >= maxResults) return matches;
          if (match[0].length === 0) matcher.lastIndex += 1;
        }
      }
    }
    return matches;
  }

  public async searchSymbols(query: string, options: Omit<SearchOptions, "regex"> = {}): Promise<SymbolSearchMatch[]> {
    const normalizedQuery = options.caseSensitive ? query : query.toLowerCase();
    const files = await this.#searchableFiles(options.paths ?? ["."]);
    const maxResults = Math.max(1, Math.min(options.maxResults ?? 200, 2_000));
    const matches: SymbolSearchMatch[] = [];
    const declaration = /^\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(class|function|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
    for (const file of files) {
      const resolved = await this.#resolvePath(file);
      const buffer = await fs.readFile(resolved.absolute);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (const [lineIndex, line] of lines.entries()) {
        const match = declaration.exec(line);
        if (!match) continue;
        const comparable = options.caseSensitive ? match[2] : match[2].toLowerCase();
        if (!comparable.includes(normalizedQuery)) continue;
        matches.push({
          path: file,
          line: lineIndex + 1,
          column: line.indexOf(match[2]) + 1,
          text: line,
          kind: match[1],
          symbol: match[2],
        });
        if (matches.length >= maxResults) return matches;
      }
    }
    return matches;
  }

  public async createFile(relativePath: string, content: string, context?: ToolExecutionContext): Promise<FileWriteResult> {
    const resolved = await this.#resolvePath(relativePath, { forWrite: true });
    this.#assertWriteAllowed(resolved.relative, context);
    await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
    await this.#resolvePath(path.posix.dirname(resolved.relative), { allowRoot: true, forWrite: true });
    await fs.writeFile(resolved.absolute, content, { encoding: "utf8", flag: "wx" });
    const result = { path: resolved.relative, operation: "created" as const, bytes: Buffer.byteLength(content) };
    this.#emitFileChange(result, context);
    return result;
  }

  public async writeFile(relativePath: string, content: string, context?: ToolExecutionContext): Promise<FileWriteResult> {
    const resolved = await this.#resolvePath(relativePath, { forWrite: true });
    this.#assertWriteAllowed(resolved.relative, context);
    const existed = await fs.stat(resolved.absolute).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
    await this.#resolvePath(path.posix.dirname(resolved.relative), { allowRoot: true, forWrite: true });
    await fs.writeFile(resolved.absolute, content, "utf8");
    const result: FileWriteResult = {
      path: resolved.relative,
      operation: existed ? "modified" : "created",
      bytes: Buffer.byteLength(content),
    };
    this.#emitFileChange(result, context);
    return result;
  }

  public async editFile(
    relativePath: string,
    search: string,
    replacement: string,
    replaceAll = false,
    context?: ToolExecutionContext,
  ): Promise<FileWriteResult> {
    if (!search) throw new Error("Edit search text must not be empty.");
    const resolved = await this.#resolvePath(relativePath, { forWrite: true });
    this.#assertWriteAllowed(resolved.relative, context);
    const content = await fs.readFile(resolved.absolute, "utf8");
    const occurrences = content.split(search).length - 1;
    if (occurrences === 0) throw new Error(`Edit search text was not found in ${resolved.relative}.`);
    if (!replaceAll && occurrences !== 1) {
      throw new Error(`Edit search text occurs ${occurrences} times in ${resolved.relative}; use replaceAll or a unique match.`);
    }
    const updated = replaceAll ? content.split(search).join(replacement) : content.replace(search, replacement);
    await fs.writeFile(resolved.absolute, updated, "utf8");
    const result: FileWriteResult = {
      path: resolved.relative,
      operation: "modified",
      bytes: Buffer.byteLength(updated),
    };
    this.#emitFileChange(result, context);
    return result;
  }

  public async applyPatch(patchText: string, context?: ToolExecutionContext): Promise<FileWriteResult[]> {
    if (this.#approvalPolicy === "safe") {
      throw new Error("Approval policy 'safe' blocks patch application until the user approves changes.");
    }
    const paths = extractPatchPaths(patchText);
    const existed = new Map<string, boolean>();
    for (const file of paths) {
      const resolved = await this.#resolvePath(file, { forWrite: true });
      this.#assertWriteAllowed(resolved.relative, context);
      existed.set(file, await fs.stat(resolved.absolute).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }));
    }
    const check = await this.#executeProcess(["git", "apply", "--check", "--recount", "-"], {
      input: patchText,
      skipPolicyValidation: true,
      signal: context?.signal,
      taskId: context?.taskId,
      subagentId: this.#contextSubagent(context),
    });
    if (!check.passed) throw new Error(`Patch check failed: ${check.output}`);
    const applied = await this.#executeProcess(["git", "apply", "--recount", "--whitespace=nowarn", "-"], {
      input: patchText,
      skipPolicyValidation: true,
      signal: context?.signal,
      taskId: context?.taskId,
      subagentId: this.#contextSubagent(context),
    });
    if (!applied.passed) throw new Error(`Patch application failed: ${applied.output}`);

    const results: FileWriteResult[] = [];
    for (const file of paths) {
      const resolved = await this.#resolvePath(file, { forWrite: true });
      const existsNow = await fs.stat(resolved.absolute).then(() => true).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      const operation: FileChangeRecord["operation"] = !existed.get(file) && existsNow
        ? "created"
        : existed.get(file) && !existsNow
          ? "deleted"
          : "modified";
      const bytes = existsNow ? (await fs.stat(resolved.absolute)).size : 0;
      const result = { path: file, operation, bytes };
      results.push(result);
      this.#emitFileChange(result, context);
    }
    return results;
  }

  public async inspectDiff(options: CommandRunOptions = {}): Promise<CommandResult> {
    const result = await this.#executeProcess(
      ["git", "diff", "--no-ext-diff", "--no-color", "--"],
      options,
    );
    return { ...result, filesChanged: extractDiffPaths(result.output) };
  }

  #validateCommand(tokens: readonly string[]): void {
    const executable = executableName(tokens[0]);
    if (executable === "git") {
      assertGitSafety(tokens.slice(1));
      const subcommand = normalizedWord(tokens[1]);
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
        throw new Error(`Git subcommand '${subcommand || "(missing)"}' is not available through run_command.`);
      }
      return;
    }
    if (!ALLOWED_EXECUTABLES.has(executable)) {
      throw new Error(`Executable '${executable}' is not an approved test/build tool.`);
    }
    if (this.#approvalPolicy === "safe" && !looksLikeVersionCheck(tokens.slice(1))) {
      throw new Error("Approval policy 'safe' blocks commands that may write; approve repository changes first.");
    }
    const effects = isExternalOrDestructive(tokens.slice(1));
    if (effects.external) {
      throw new Error(`External command operation '${effects.external}' is prohibited.`);
    }
    if (this.#approvalPolicy === "changes" && effects.destructive) {
      throw new Error(`Destructive command operation '${effects.destructive}' requires policy 'always'.`);
    }
    if (this.#approvalPolicy === "changes" && isDependencyInstallation(executable, tokens.slice(1))) {
      throw new Error("Dependency installation requires policy 'always'.");
    }
    if (this.#approvalPolicy === "changes" && ["npm", "pnpm", "yarn", "bun"].includes(executable)) {
      const first = normalizedWord(tokens[1]);
      if (first === "run") {
        const script = tokens[2]?.toLowerCase();
        if (!script || !SAFE_SCRIPT_NAMES.has(script)) {
          throw new Error(`Script '${script || "(missing)"}' is not an approved test/build script under policy 'changes'.`);
        }
      }
    }
  }

  async #assertCommandArgumentsStayInside(tokens: readonly string[], cwd: string): Promise<void> {
    const rootReal = await this.#rootReal();
    for (const arg of tokens.slice(1)) {
      const candidate = arg.replace(/^--[^=]+=/, "");
      if (!path.isAbsolute(candidate) && !/(^|[\\/])\.\.([\\/]|$)/.test(candidate)) continue;
      const absolute = path.resolve(cwd, candidate);
      if (!isInside(this.#repositoryRoot, absolute)) {
        throw new Error(`Command argument escapes the repository root: ${arg}`);
      }
      try {
        const real = await fs.realpath(absolute);
        if (!isInside(rootReal, real)) throw new Error(`Command argument follows a symlink outside the repository: ${arg}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  public async runCommand(
    command: string | readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    return this.#executeProcess(parseCommand(command), options);
  }

  public async runTestCommand(
    command: string | readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    return this.#executeProcess(parseCommand(command), options);
  }

  async #executeProcess(tokens: string[], options: ProcessOptions): Promise<CommandResult> {
    if (!options.skipPolicyValidation) this.#validateCommand(tokens);
    const cwdResolved = await this.#resolvePath(options.cwd ?? ".", { allowRoot: true });
    await this.#assertCommandArgumentsStayInside(tokens, cwdResolved.absolute);
    const combined = combineSignals(this.#defaultSignal, options.signal);
    const signal = combined.signal;
    const commandId = `cmd-${this.#idFactory()}`;
    const logDirectory = path.join(this.#sessionDirectory, "logs");
    await fs.mkdir(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `${commandId}.log`);
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? this.#defaultTimeoutMs, 1), MAX_TIMEOUT_MS);
    const startedAt = Date.now();
    const displayCommand = redactToolText(tokens.join(" "));
    await fs.writeFile(logPath, `[command] ${displayCommand}\n[cwd] ${cwdResolved.absolute}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    this.#emit("command.started", {
      commandId,
      taskId: options.taskId,
      command: displayCommand,
      cwd: cwdResolved.absolute,
    });

    let output = "";
    let truncated = false;
    let timedOut = false;
    let cancelled = signal?.aborted ?? false;
    let logWrites = Promise.resolve();
    const append = (stream: "stdout" | "stderr", chunk: string) => {
      const redacted = redactToolText(chunk);
      logWrites = logWrites.then(() => fs.appendFile(logPath, `[${stream}] ${redacted}`, "utf8"));
      if (output.length < this.#outputCapChars) {
        const remaining = this.#outputCapChars - output.length;
        output += redacted.slice(0, remaining);
        if (redacted.length > remaining) truncated = true;
      } else {
        truncated = true;
      }
      this.#emit("command.output", {
        commandId,
        stream,
        chunk: redacted.slice(0, 4_096),
        truncated: redacted.length > 4_096,
      });
    };

    if (cancelled) {
      combined.dispose();
      const durationMs = Date.now() - startedAt;
      this.#emit("command.completed", { commandId, exitCode: null, signal: "ABORT", durationMs });
      return {
        commandId,
        command: tokens,
        cwd: cwdResolved.absolute,
        exitCode: null,
        signal: "ABORT",
        passed: false,
        timedOut: false,
        cancelled: true,
        durationMs,
        output: "Command cancelled before start.",
        truncated: false,
        logPath,
      };
    }

    const executable = executableName(tokens[0]) === "node" ? process.execPath : tokens[0];
    const result = await new Promise<{ exitCode: number | null; closeSignal?: string; spawnError?: Error }>((resolve) => {
      const child = spawn(executable, tokens.slice(1), {
        cwd: cwdResolved.absolute,
        shell: false,
        windowsHide: true,
        env: filteredCodingToolEnvironment(),
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk.toString()));
      if (options.input !== undefined) child.stdin?.end(options.input);
      let spawnError: Error | undefined;
      child.on("error", (error) => {
        spawnError = error;
      });
      const stop = (reason: "timeout" | "cancel") => {
        if (reason === "timeout") timedOut = true;
        if (reason === "cancel") cancelled = true;
        child.kill("SIGTERM");
      };
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      const onAbort = () => stop("cancel");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("close", (exitCode, closeSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode, closeSignal: closeSignal ?? undefined, spawnError });
      });
    });
    combined.dispose();
    await logWrites;
    if (result.spawnError) append("stderr", `${result.spawnError.message}\n`);
    await logWrites;
    const durationMs = Date.now() - startedAt;
    const closeSignal = result.closeSignal ?? (timedOut ? "TIMEOUT" : cancelled ? "ABORT" : undefined);
    this.#emit("command.completed", {
      commandId,
      exitCode: result.exitCode,
      signal: closeSignal,
      durationMs,
    });
    return {
      commandId,
      command: tokens,
      cwd: cwdResolved.absolute,
      exitCode: result.exitCode,
      signal: closeSignal,
      passed: result.exitCode === 0 && !timedOut && !cancelled && !result.spawnError,
      timedOut,
      cancelled,
      durationMs,
      output: output.trim(),
      truncated,
      logPath,
    };
  }

  public async readCommandOutput(commandId: string, maxChars = MAX_READ_CHARS): Promise<FileReadResult> {
    if (!COMMAND_ID_PATTERN.test(commandId)) throw new Error("Invalid command id.");
    const relative = `.hivemind/sessions/${this.#sessionId}/logs/${commandId}.log`;
    const resolved = await this.#resolvePath(relative);
    if (path.resolve(resolved.absolute) !== path.join(this.#sessionDirectory, "logs", `${commandId}.log`)) {
      throw new Error("Command log path does not match this session.");
    }
    return this.readFile(relative, maxChars);
  }

  public async execute(
    name: AgentToolName,
    args: Record<string, unknown>,
    task: SubagentTask,
    signal: AbortSignal,
  ): Promise<AgentToolResult> {
    const context: ToolExecutionContext = {
      fileScope: task.fileScope,
      subagentId: task.id,
      taskId: task.id,
      signal,
    };
    this.#emitTool(name, args, context);
    try {
      assertNotAborted(signal);
      switch (name) {
        case "read_file": {
          const result = await this.readFile(requiredString(args, "path"), optionalNumber(args, "maxChars"));
          return { ok: true, output: result.content, metadata: { path: result.path, size: result.size, truncated: result.truncated } };
        }
        case "list_directory": {
          const result = await this.listDirectory(typeof args.path === "string" ? args.path : ".");
          return { ok: true, output: JSON.stringify(result, null, 2) };
        }
        case "search_text": {
          const result = await this.searchText(requiredString(args, "query"), {
            paths: Array.isArray(args.paths) ? args.paths.filter((entry): entry is string => typeof entry === "string") : undefined,
            caseSensitive: args.caseSensitive === true,
            regex: args.regex === true,
            maxResults: optionalNumber(args, "maxResults"),
          });
          return { ok: true, output: JSON.stringify(result, null, 2), metadata: { matches: result.length } };
        }
        case "search_symbols": {
          const result = await this.searchSymbols(requiredString(args, "query"), {
            paths: Array.isArray(args.paths) ? args.paths.filter((entry): entry is string => typeof entry === "string") : undefined,
            caseSensitive: args.caseSensitive === true,
            maxResults: optionalNumber(args, "maxResults"),
          });
          return { ok: true, output: JSON.stringify(result, null, 2), metadata: { matches: result.length } };
        }
        case "create_file": {
          const result = await this.createFile(
            requiredString(args, "path"),
            requiredString(args, "content"),
            context,
          );
          return {
            ok: true,
            output: `created ${result.path}`,
            metadata: {
              path: result.path,
              operation: result.operation,
              bytes: result.bytes,
            },
          };
        }
        case "write_file": {
          const result = await this.writeFile(requiredString(args, "path"), requiredString(args, "content"), context);
          return {
            ok: true,
            output: `${result.operation} ${result.path}`,
            metadata: { path: result.path, operation: result.operation, bytes: result.bytes },
          };
        }
        case "edit_file": {
          const result = await this.editFile(
            requiredString(args, "path"),
            requiredString(args, "search"),
            typeof args.replacement === "string" ? args.replacement : "",
            args.replaceAll === true,
            context,
          );
          return {
            ok: true,
            output: `modified ${result.path}`,
            metadata: { path: result.path, operation: result.operation, bytes: result.bytes },
          };
        }
        case "apply_patch": {
          const result = await this.applyPatch(requiredString(args, "patch"), context);
          const filesChanged = result.map((entry) => entry.path);
          return {
            ok: true,
            output: JSON.stringify(result, null, 2),
            metadata: { files: filesChanged, filesChanged },
          };
        }
        case "inspect_diff": {
          const result = await this.inspectDiff({ signal, taskId: task.id, subagentId: task.id });
          return {
            ok: result.passed,
            output: result.output,
            metadata: {
              commandId: result.commandId,
              logPath: result.logPath,
              filesChanged: result.filesChanged ?? [],
            },
          };
        }
        case "run_command":
        case "run_test": {
          const rawCommand = args.command;
          if (typeof rawCommand !== "string" && !Array.isArray(rawCommand)) throw new Error("command must be a string or string array.");
          const command = typeof rawCommand === "string"
            ? rawCommand
            : rawCommand.filter((entry): entry is string => typeof entry === "string");
          const result = name === "run_test"
            ? await this.runTestCommand(command, {
                cwd: typeof args.cwd === "string" ? args.cwd : undefined,
                timeoutMs: optionalNumber(args, "timeoutMs"),
                signal,
                taskId: task.id,
                subagentId: task.id,
              })
            : await this.runCommand(command, {
                cwd: typeof args.cwd === "string" ? args.cwd : undefined,
                timeoutMs: optionalNumber(args, "timeoutMs"),
                signal,
                taskId: task.id,
                subagentId: task.id,
              });
          return {
            ok: result.passed,
            output: result.output || `Command exited with ${String(result.exitCode)}.`,
            metadata: {
              commandId: result.commandId,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              cancelled: result.cancelled,
              truncated: result.truncated,
              logPath: result.logPath,
            },
          };
        }
        case "read_command_output": {
          const result = await this.readCommandOutput(requiredString(args, "commandId"), optionalNumber(args, "maxChars"));
          return { ok: true, output: result.content, metadata: { truncated: result.truncated, size: result.size } };
        }
      }
    } catch (error) {
      const message = redactToolText(error instanceof Error ? error.message : String(error));
      return { ok: false, output: message };
    }
  }
}

export { parseCommandString as parseRepositoryCommand };
