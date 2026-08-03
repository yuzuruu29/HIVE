import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { generateContextPack, formatScoutText } from "../scout/index.js";
import type { RepositorySnapshot as PersistedRepositorySnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

export interface RepositoryStateSnapshot {
  root: string;
  baseCommit: string;
  branch: string;
  dirty: boolean;
  dirtyFiles: string[];
  statusFingerprint: string;
  capturedAt: string;
}

export interface RepositoryContext {
  snapshot: RepositoryStateSnapshot;
  packageScripts: string[];
  projectMetadata: Record<string, string>;
  instructions: Array<{ path: string; content: string }>;
  scoutContext: string;
  summary: string;
}

const INSTRUCTION_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".codex/instructions.md",
];

const MAX_INSTRUCTION_CHARS = 20_000;

function normalizeRelative(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    signal,
    maxBuffer: 2 * 1024 * 1024,
  });
  return String(result.stdout).trim();
}

export async function findRepositoryRoot(startPath: string, signal?: AbortSignal): Promise<string> {
  const resolved = path.resolve(startPath);
  try {
    return path.resolve(await git(resolved, ["rev-parse", "--show-toplevel"], signal));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to detect a Git repository from ${resolved}: ${message}`);
  }
}

function parseDirtyFiles(status: string): string[] {
  const files = new Set<string>();
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const raw = line.length > 3 ? line.slice(3).trim() : "";
    const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1) ?? raw : raw;
    const unquoted = renamed.startsWith('"') && renamed.endsWith('"')
      ? renamed.slice(1, -1)
      : renamed;
    if (unquoted) files.add(normalizeRelative(unquoted));
  }
  return [...files].sort();
}

function repositoryStatus(status: string): string {
  return status
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false;
      const raw = line.length > 3 ? line.slice(3).trim() : "";
      const paths = raw.includes(" -> ") ? raw.split(" -> ") : [raw];
      return paths.some((candidate) => {
        const normalized = candidate.replace(/^"|"$/g, "").replace(/\\/g, "/");
        return normalized !== ".hivemind" && !normalized.startsWith(".hivemind/");
      });
    })
    .join("\n");
}

async function readPackageMetadata(root: string): Promise<{
  scripts: string[];
  metadata: Record<string, string>;
}> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const scripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? Object.keys(parsed.scripts as Record<string, unknown>).sort()
      : [];
    const metadata: Record<string, string> = {};
    for (const key of ["name", "version", "type", "packageManager"]) {
      if (typeof parsed[key] === "string") metadata[key] = parsed[key] as string;
    }
    return { scripts, metadata };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { scripts: [], metadata: {} };
    throw new Error(`Invalid package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readInstructions(root: string): Promise<Array<{ path: string; content: string }>> {
  const found: Array<{ path: string; content: string }> = [];
  for (const relativePath of INSTRUCTION_PATHS) {
    try {
      const content = await fs.readFile(path.join(root, relativePath), "utf8");
      found.push({
        path: relativePath,
        content: content.length > MAX_INSTRUCTION_CHARS
          ? `${content.slice(0, MAX_INSTRUCTION_CHARS)}\n...[truncated]`
          : content,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found;
}

export async function inspectCodingRepository(
  startPath: string,
  objective: string,
  signal?: AbortSignal,
): Promise<RepositoryContext> {
  const root = await findRepositoryRoot(startPath, signal);
  const [baseCommit, branch, status, packageData, instructions, scoutPack] = await Promise.all([
    git(root, ["rev-parse", "HEAD"], signal),
    git(root, ["branch", "--show-current"], signal),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"], signal),
    readPackageMetadata(root),
    readInstructions(root),
    generateContextPack(root, objective),
  ]);
  const relevantStatus = repositoryStatus(status);
  const dirtyFiles = parseDirtyFiles(relevantStatus);
  const statusFingerprint = createHash("sha256")
    .update(`${baseCommit}\n${relevantStatus}`)
    .digest("hex");
  const snapshot: RepositoryStateSnapshot = {
    root,
    baseCommit,
    branch: branch || "detached",
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    statusFingerprint,
    capturedAt: new Date().toISOString(),
  };
  const metadata = Object.entries(packageData.metadata)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const summary = [
    `Repository: ${root}`,
    `Branch: ${snapshot.branch}`,
    `Base commit: ${baseCommit}`,
    `Working tree: ${snapshot.dirty ? `${dirtyFiles.length} changed path(s)` : "clean"}`,
    metadata ? `Project: ${metadata}` : "Project metadata: no package.json metadata",
    `Scripts: ${packageData.scripts.join(", ") || "none detected"}`,
    `Instructions: ${instructions.map((item) => item.path).join(", ") || "none detected"}`,
  ].join("\n");
  const instructionContext = instructions
    .map((item) => `[${item.path}]\n${item.content}`)
    .join("\n\n");

  return {
    snapshot,
    packageScripts: packageData.scripts,
    projectMetadata: packageData.metadata,
    instructions,
    scoutContext: [summary, instructionContext, formatScoutText(scoutPack)].filter(Boolean).join("\n\n"),
    summary,
  };
}

function globToRegExp(scope: string): RegExp {
  const normalized = normalizeRelative(scope);
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${pattern}${normalized.endsWith("/") ? ".*" : ""}$`, "i");
}

export function pathMatchesScope(filePath: string, scope: string): boolean {
  const normalizedPath = normalizeRelative(filePath);
  const normalizedScope = normalizeRelative(scope);
  if (normalizedPath === normalizedScope) return true;
  if (normalizedScope.endsWith("/") && normalizedPath.startsWith(normalizedScope)) return true;
  return globToRegExp(normalizedScope).test(normalizedPath);
}

export function findDirtyScopeConflicts(dirtyFiles: string[], scopes: string[]): string[] {
  return dirtyFiles.filter((file) => scopes.some((scope) => pathMatchesScope(file, scope)));
}

export function toPersistedRepositorySnapshot(
  snapshot: RepositoryStateSnapshot,
): PersistedRepositorySnapshot {
  return {
    root: snapshot.root,
    capturedAt: snapshot.capturedAt,
    baseCommit: snapshot.baseCommit,
    branch: snapshot.branch,
    dirty: snapshot.dirty,
    changedFiles: [...snapshot.dirtyFiles],
    fingerprint: snapshot.statusFingerprint,
  };
}

export async function repositoryStillMatches(
  snapshot: RepositoryStateSnapshot,
  signal?: AbortSignal,
): Promise<{ matches: boolean; current: RepositoryStateSnapshot }> {
  const baseCommit = await git(snapshot.root, ["rev-parse", "HEAD"], signal);
  const status = await git(snapshot.root, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
  const relevantStatus = repositoryStatus(status);
  const dirtyFiles = parseDirtyFiles(relevantStatus);
  const fingerprint = createHash("sha256").update(`${baseCommit}\n${relevantStatus}`).digest("hex");
  return {
    matches: baseCommit === snapshot.baseCommit && fingerprint === snapshot.statusFingerprint,
    current: {
      ...snapshot,
      baseCommit,
      dirty: dirtyFiles.length > 0,
      dirtyFiles,
      statusFingerprint: fingerprint,
      capturedAt: new Date().toISOString(),
    },
  };
}
