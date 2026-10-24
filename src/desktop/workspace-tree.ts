import { promises as fs } from "node:fs";
import path from "node:path";
import type { WorkspaceFilePreview, WorkspaceTreeEntry, WorkspaceTreeListing } from "./types.js";

export const MAX_WORKSPACE_LIST_ENTRIES = 400;
export const MAX_WORKSPACE_READ_LINES = 2000;
export const MAX_WORKSPACE_READ_BYTES = 256 * 1024;

const DENYLIST = [".git", "node_modules", ".hivemind", "dist"] as const;

export function isDeniedWorkspacePath(relative: string): boolean {
  if (!relative) return false;
  const segments = relative.replaceAll("\\", "/").toLowerCase().split("/").filter(Boolean);
  return segments.some((segment) => {
    if ((DENYLIST as readonly string[]).includes(segment)) return true;
    if (segment.startsWith(".env")) return true;
    return false;
  });
}

export function resolveWorkspacePath(repositoryRoot: string, relative: string): string | null {
  const root = path.resolve(repositoryRoot);
  const clean = (relative || "").replaceAll("\\", "/");
  if (clean === ".." || clean.startsWith("../") || path.posix.isAbsolute(clean) || /^[A-Za-z]:\//.test(clean)) {
    return null;
  }
  const joined = path.resolve(root, clean);
  if (joined !== root && !joined.startsWith(root + path.sep)) return null;
  return joined;
}

async function canonicalWorkspaceTarget(repositoryRoot: string, target: string): Promise<string> {
  const [root, canonical] = await Promise.all([fs.realpath(repositoryRoot), fs.realpath(target)]);
  const relative = path.relative(root, canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workspace path is outside the repository.");
  }
  if (isDeniedWorkspacePath(relative)) throw new Error("Workspace path is deny-listed.");
  return canonical;
}

export function languageHintForPath(relative: string): string {
  const ext = path.extname(relative).replace(".", "").toLowerCase();
  if (!ext || ext.length > 16 || !/^[a-z0-9]+$/.test(ext)) return "text";
  return ext;
}

export async function listWorkspaceEntries(
  repositoryRoot: string,
  relativePath = "",
): Promise<WorkspaceTreeListing> {
  const root = path.resolve(repositoryRoot);
  const target = resolveWorkspacePath(root, relativePath);
  if (!target) throw new Error("Workspace path is outside the repository.");
  const rel = path.relative(root, target).replaceAll("\\", "/");
  if (isDeniedWorkspacePath(rel)) throw new Error("Workspace path is deny-listed.");

  let stat;
  try {
    stat = target === root ? await fs.stat(target) : await fs.lstat(target);
  } catch {
    throw new Error("Workspace path was not found.");
  }
  if (stat.isSymbolicLink()) throw new Error("Workspace path must not be a symlink.");
  if (!stat.isDirectory()) throw new Error("Workspace list target must be a directory.");
  const canonical = await canonicalWorkspaceTarget(root, target);

  let children;
  try {
    children = await fs.readdir(canonical, { withFileTypes: true });
  } catch {
    throw new Error("Workspace directory could not be read.");
  }

  const entries: WorkspaceTreeEntry[] = [];
  const sorted = [...children].sort((a, b) => {
    const aDir = a.isDirectory() && !a.isSymbolicLink() ? 0 : 1;
    const bDir = b.isDirectory() && !b.isSymbolicLink() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  for (const child of sorted) {
    if (entries.length >= MAX_WORKSPACE_LIST_ENTRIES) break;
    const childRel = (rel ? `${rel}/` : "") + child.name;
    if (isDeniedWorkspacePath(childRel)) continue;
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) {
      entries.push({ name: child.name, path: childRel, kind: "dir" });
    } else if (child.isFile()) {
      entries.push({ name: child.name, path: childRel, kind: "file" });
    }
  }

  return {
    repositoryRoot: root,
    path: rel,
    truncated: entries.length >= MAX_WORKSPACE_LIST_ENTRIES,
    entries,
  };
}

export async function readWorkspaceFile(
  repositoryRoot: string,
  relativePath: string,
): Promise<WorkspaceFilePreview> {
  const root = path.resolve(repositoryRoot);
  const target = resolveWorkspacePath(root, relativePath);
  if (!target) throw new Error("Workspace path is outside the repository.");
  const rel = path.relative(root, target).replaceAll("\\", "/");
  if (!rel) throw new Error("Workspace read target must be a file.");
  if (isDeniedWorkspacePath(rel)) throw new Error("Workspace path is deny-listed.");

  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    throw new Error("Workspace path was not found.");
  }
  if (stat.isSymbolicLink()) throw new Error("Workspace path must not be a symlink.");
  if (!stat.isFile()) throw new Error("Workspace read target must be a file.");
  const canonical = await canonicalWorkspaceTarget(root, target);

  const handle = await fs.open(canonical, "r");
  try {
    const probe = Buffer.alloc(Math.min(8192, MAX_WORKSPACE_READ_BYTES));
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (probe.subarray(0, bytesRead).includes(0)) throw new Error("Workspace file is binary.");

    const raw = await handle.readFile({ encoding: "utf8" });
    const limitedBytes = raw.length > MAX_WORKSPACE_READ_BYTES ? raw.slice(0, MAX_WORKSPACE_READ_BYTES) : raw;
    const lines = limitedBytes.split(/\r?\n/);
    const truncatedByLines = lines.length > MAX_WORKSPACE_READ_LINES;
    const content = truncatedByLines ? lines.slice(0, MAX_WORKSPACE_READ_LINES).join("\n") : limitedBytes;
    return {
      repositoryRoot: root,
      path: rel,
      content,
      truncated: truncatedByLines || raw.length > MAX_WORKSPACE_READ_BYTES,
      languageHint: languageHintForPath(rel),
    };
  } finally {
    await handle.close();
  }
}

export function markCodeForGitXy(xy: string): "U" | "M" | "A" | "." {
  const code = xy.replaceAll(" ", "");
  if (xy.includes("?")) return "U";
  if (code.includes("A")) return "A";
  if (code.includes("M") || code.includes("D") || code.includes("R")) return "M";
  return ".";
}
