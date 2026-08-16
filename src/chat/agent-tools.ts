import path from "node:path";
import fs from "node:fs/promises";
import type {
  AgentToolExecutor,
  AgentToolResult,
} from "../coding/agent-loop.js";

/** read_file refuses to emit more than this many lines. */
export const MAX_READ_LINES = 2000;
/** list_files stops after this many entries. */
export const MAX_LIST_ENTRIES = 500;
/** search_files stops after this many matches. */
export const MAX_SEARCH_RESULTS = 100;

/** Directory names that are always refused regardless of nesting. */
const DENYLIST = [".git", "node_modules", ".hivemind", "dist"] as const;

function isDeniedPath(relative: string): boolean {
  const segments = relative.split(path.sep);
  return segments.some((segment) => {
    if ((DENYLIST as readonly string[]).includes(segment)) return true;
    if (segment.startsWith(".env")) return true;
    return false;
  });
}

/**
 * Resolves `input` against the chat cwd and returns the absolute path, or
 * `null` when input is not a string, is empty, or escapes the cwd
 * (`path.resolve` + prefix check).
 */
export function resolveWithinCwd(cwd: string, input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const joined = path.resolve(cwd, input);
  if (joined !== cwd && !joined.startsWith(cwd + path.sep)) return null;
  return joined;
}

/**
 * Creates a read-only {@link AgentToolExecutor} scoped to `cwd`.
 * Supported tools: read_file, list_files, search_files. Anything else
 * (including write tools) is refused.
 */
export function createReadOnlyToolExecutor(cwd: string): AgentToolExecutor {
  return {
    execute(name, args) {
      return runReadOnlyTool(cwd, name, args);
    },
  };
}

/** Human-readable tool descriptions used to seed the agent system prompt. */
export function describeReadOnlyTools(): string {
  return [
    "- read_file: read the text file at <path>; output is capped at 2000 lines.",
    "- list_files: recursively list files under <path>; output is capped at 500 entries.",
    "- search_files: literal substring search for <query> across text files under <path>; returns \"file:line\" per match, capped at 100 matches.",
    "All tools resolve paths against the chat cwd and are read-only: they refuse paths outside it and deny-listed entries (.git, node_modules, .env*, .hivemind, dist).",
  ].join("\n");
}

async function runReadOnlyTool(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
): Promise<AgentToolResult> {
  switch (name) {
    case "read_file":
      return readFileTool(cwd, args);
    case "list_files":
      return listFilesTool(cwd, args);
    case "search_files":
      return searchFilesTool(cwd, args);
    default:
      return {
        ok: false,
        output: `read-only mode: tool '${name}' is not available.`,
      };
  }
}

async function readFileTool(
  cwd: string,
  args: Record<string, unknown>,
): Promise<AgentToolResult> {
  const target = resolveWithinCwd(cwd, args.path);
  if (!target) return { ok: false, output: "refused: path outside the chat cwd." };
  const rel = path.relative(cwd, target);
  if (isDeniedPath(rel)) return { ok: false, output: `refused: deny-listed path '${rel}'.` };

  let content: string;
  try {
    content = await fs.readFile(target, "utf-8");
  } catch (error) {
    return {
      ok: false,
      output: `could not read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const lines = content.split("\n");
  let output = content;
  let emittedLines = lines.length;
  if (lines.length > MAX_READ_LINES) {
    emittedLines = MAX_READ_LINES;
    output =
      lines.slice(0, MAX_READ_LINES).join("\n") +
      `\n...[truncated ${lines.length - MAX_READ_LINES} lines]`;
  }
  return {
    ok: true,
    output,
    metadata: { path: rel, lines: emittedLines, truncated: lines.length > MAX_READ_LINES },
  };
}

async function listFilesTool(
  cwd: string,
  args: Record<string, unknown>,
): Promise<AgentToolResult> {
  const base =
    typeof args.path === "string" && args.path.trim()
      ? resolveWithinCwd(cwd, args.path)
      : cwd;
  if (!base) return { ok: false, output: "refused: path outside the chat cwd." };
  const relBase = path.relative(cwd, base);
  if (isDeniedPath(relBase)) return { ok: false, output: `refused: deny-listed path '${relBase}'.` };

  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    let children;
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      const full = path.join(dir, child.name);
      const relative = path.relative(cwd, full);
      if (isDeniedPath(relative)) continue;
      if (child.isDirectory()) {
        await walk(full);
      } else if (child.isFile()) {
        entries.push(relative);
      }
    }
  }
  await walk(base);

  const truncated = entries.length >= MAX_LIST_ENTRIES && entries.length > 0;
  return {
    ok: true,
    output: entries.join("\n"),
    metadata: { entries: entries.length, truncated },
  };
}

async function searchFilesTool(
  cwd: string,
  args: Record<string, unknown>,
): Promise<AgentToolResult> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) return { ok: false, output: "search_files requires a non-empty 'query'." };

  const base =
    typeof args.path === "string" && args.path.trim()
      ? resolveWithinCwd(cwd, args.path)
      : cwd;
  if (!base) return { ok: false, output: "refused: path outside the chat cwd." };
  const relBase = path.relative(cwd, base);
  if (isDeniedPath(relBase)) return { ok: false, output: `refused: deny-listed path '${relBase}'.` };

  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    let children;
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (results.length >= MAX_SEARCH_RESULTS) return;
      const full = path.join(dir, child.name);
      const relative = path.relative(cwd, full);
      if (isDeniedPath(relative)) continue;
      if (child.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!child.isFile()) continue;
      let text: string;
      try {
        text = await fs.readFile(full, "utf-8");
      } catch {
        continue;
      }
      if (!text.includes(query)) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (results.length >= MAX_SEARCH_RESULTS) break;
        if (lines[i].includes(query)) results.push(`${relative}:${i + 1}`);
      }
    }
  }
  await walk(base);

  const truncated = results.length >= MAX_SEARCH_RESULTS && results.length > 0;
  return {
    ok: true,
    output: results.join("\n"),
    metadata: { matches: results.length, truncated },
  };
}
