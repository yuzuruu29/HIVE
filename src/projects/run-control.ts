import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { SharedRunStatus, WorkspaceRef } from "./types.js";
import { assertProjectId } from "./store.js";

const execute = promisify(execFile);
export const ACTIVE_RUN_STATUSES = new Set<SharedRunStatus>(["queued", "running", "awaiting_approval", "stopping"]);
export function ownerDefinitelyExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH"; }
}
async function git(cwd: string, args: string[]): Promise<string> { return String((await execute("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout).trim(); }
export interface ProjectLocation { id: string; repositoryId: string; repositoryPath: string; workspace: WorkspaceRef }
/** Identity lives beside shared Git metadata, so renames and linked worktrees retain it. */
export async function identifyProject(inputPath: string, options: { create?: boolean } = {}): Promise<ProjectLocation> {
  const cwd = await fs.realpath(inputPath); if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Project path must be a directory.");
  let common: string; let root = cwd; let branch = "folder"; let workspaceKey = "folder";
  let gitRoot: string | undefined;
  try { gitRoot = await git(cwd, ["rev-parse", "--show-toplevel"]); }
  catch (error) { if (!(error instanceof Error && "code" in error && typeof error.code === "number")) throw error; }
  if (gitRoot) {
    root = await fs.realpath(gitRoot);
    common = await fs.realpath(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const gitDirectory = await fs.realpath(await git(root, ["rev-parse", "--absolute-git-dir"]));
    workspaceKey = path.relative(common, gitDirectory).replaceAll("\\", "/") || "primary";
    branch = await git(root, ["branch", "--show-current"]) || "detached";
  } else common = path.join(root, ".hivemind");
  const directory = path.join(common, "hive-interface-v1");
  if (options.create !== false) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory); if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Project identity directory must not be a symbolic link.");
  const file = path.join(directory, "project.json");
  const readIdentity = async (): Promise<string> => {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_024) throw new Error("Invalid project identity file.");
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Object.keys(value).length !== 2 || !("schemaVersion" in value) || value.schemaVersion !== 1 || !("id" in value)) throw new Error("Corrupt project identity; existing data preserved.");
    assertProjectId(value.id); return value.id;
  };
  let id: string;
  if (options.create === false) id = await readIdentity();
  else {
    id = `project-${randomUUID()}`;
    const temporary = path.join(directory, `.project-${randomUUID()}.tmp`); const contents = JSON.stringify({ schemaVersion: 1, id }) + "\n";
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); }
    finally { await handle.close(); }
    try {
      try { await fs.link(temporary, file); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        // Another creator may still be unlinking its owned temporary hard link.
        for (let attempt = 0; ; attempt += 1) { try { id = await readIdentity(); break; } catch (error) { if (attempt >= 20) throw error; await new Promise<void>((resolve) => setTimeout(resolve, 5)); } }
      }
    } finally { await fs.unlink(temporary); }
    id = await readIdentity();
  }
  const repositoryId = id;
  const workspaceId = `workspace-${createHash("sha256").update(`${id}:${workspaceKey}`).digest("hex").slice(0, 24)}`;
  return { id, repositoryId, repositoryPath: root, workspace: { id: workspaceId, path: root, branch, repositoryId } };
}
