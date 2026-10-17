import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WorktreeManager, branchNameForTask, validateTaskId, type CreatedManagedWorktree } from "../worktree.js";
import { inspectManagedWorktree } from "./runtime.js";
import { findRepositoryRoot } from "./repository.js";
import { acquireCodingSessionLeaseAtRoot } from "./session-lease.js";
import { CodingSessionStore } from "./session-store.js";
import type { CodingSessionRecord, CodingSessionTurn } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 100_000;
const PRIVATE_DIRECTORY = /^(?:\.git|\.hivemind|node_modules|\.ssh|\.aws|\.azure|\.gnupg|\.secrets)$/i;
const PRIVATE_FILE = /^(?:\.npmrc|\.netrc|\.pypirc|\.envrc|credentials?|secrets?|tokens?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|(?:credentials?|secrets?|tokens?)(?:[._-].*)?\.(?:json5?|jsonl|ya?ml|toml|env|ini|txt|key|pem|p12|pfx|db|sqlite3?)(?:[._-].*)?)$/i;

export interface ForkCodingSessionOptions {
  signal?: AbortSignal;
  /** Optional deterministic identity for integrations; existing identities are never reused. */
  sessionId?: string;
}

interface SnapshotFile {
  name: string;
  contents: Buffer | null;
  mode: number;
}

interface WorkspaceSnapshot {
  head: string;
  index: Buffer;
  indexPath: string;
  files: SnapshotFile[];
  signature: string;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Coding session fork cancelled.", "AbortError");
}

async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeName(name: string): void {
  const parts = name.split("/");
  if (!name || path.isAbsolute(name) || name.includes("\\") || parts.some((part) => !part || part === "." || part === ".." || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Cannot fork an unsafe Git path: ${JSON.stringify(name)}.`);
  }
  if (parts.some((part) => PRIVATE_DIRECTORY.test(part)) || parts.some((part) => PRIVATE_FILE.test(part)) || parts.some((part) => /^\.env(?:\.|$)/i.test(part) && !/^\.env\.(?:example|sample|template)$/i.test(part))) {
    throw new Error(`Cannot fork private storage or credential file ${name}. Remove it from the Git-visible workspace before forking.`);
  }
}

async function readRegular(root: string, name: string, signal?: AbortSignal): Promise<SnapshotFile> {
  cancelled(signal);
  safeName(name);
  const target = path.resolve(root, name);
  if (!inside(root, target)) throw new Error(`Fork file escapes its workspace: ${name}.`);
  let current = root;
  for (const part of name.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return { name, contents: null, mode: 0 };
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) return { name, contents: null, mode: 0 };
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(current, await fs.realpath(current)) !== "") {
      throw new Error(`Cannot fork a file through a linked or non-directory parent: ${name}.`);
    }
  }
  const before = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!before) return { name, contents: null, mode: 0 };
  if (before.isDirectory() && !before.isSymbolicLink() && path.relative(target, await fs.realpath(target)) === "") return { name, contents: null, mode: 0 };
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`Cannot fork non-regular or linked file ${name}.`);
  if (before.size > MAX_FILE_BYTES) throw new Error(`Fork file ${name} exceeds the 64 MiB per-file limit.`);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error(`Fork file changed while opening: ${name}.`);
    const contents = await handle.readFile();
    const after = await handle.stat();
    const named = await fs.lstat(target);
    if (contents.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.dev !== before.dev || named.ino !== before.ino || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1) throw new Error(`Fork file changed while reading: ${name}.`);
    return { name, contents, mode: before.mode & 0o777 };
  } finally { await handle.close(); }
}

async function writeOwnedFile(destination: string, contents: Buffer, create: boolean, mode?: number, guard?: () => Promise<void>): Promise<void> {
  if (path.relative(path.dirname(destination), await fs.realpath(path.dirname(destination))) !== "") throw new Error(`Fork destination parent changed: ${destination}.`);
  const handle = await fs.open(destination, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (create ? constants.O_CREAT | constants.O_EXCL : 0), mode ?? 0o600);
  try {
    const stat = await handle.stat();
    const named = await fs.lstat(destination);
    if (!stat.isFile() || stat.nlink !== 1 || !named.isFile() || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino || named.nlink !== 1) throw new Error(`Fork destination is not a regular owned file: ${destination}.`);
    await guard?.();
    await handle.truncate(0);
    await handle.writeFile(contents);
    if (mode !== undefined) await handle.chmod(mode);
  } finally { await handle.close(); }
}

async function snapshot(root: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  const [headOutput, indexOutput, sharedIndex, unmerged, staged, tree, untracked, flags] = await Promise.all([
    git(root, ["rev-parse", "HEAD"], signal),
    git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], signal),
    git(root, ["rev-parse", "--shared-index-path"], signal),
    git(root, ["ls-files", "--unmerged", "-z"], signal),
    git(root, ["ls-files", "--stage", "-z"], signal),
    git(root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], signal),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ":(exclude,top).hivemind"], signal),
    git(root, ["ls-files", "-v", "-z"], signal),
  ]);
  if (sharedIndex.trim()) throw new Error("Cannot fork a split Git index; use a regular index before forking.");
  if (unmerged) throw new Error("Cannot fork an unresolved Git index; resolve conflicts before forking.");
  if (flags.split("\0").some((entry) => /^[Ss] /.test(entry))) throw new Error("Cannot fork a sparse/skip-worktree index; materialize the complete workspace first.");
  const names = new Set<string>();
  for (const entry of [...tree.split("\0"), ...staged.split("\0")].filter(Boolean)) {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Cannot read Git file identity for a fork.");
    const mode = entry.slice(0, 6);
    const name = entry.slice(tab + 1);
    if (mode !== "100644" && mode !== "100755") throw new Error(`Cannot fork Git symlinks, submodules, or special entries: ${name}.`);
    safeName(name);
    names.add(name);
  }
  for (const name of untracked.split("\0").filter(Boolean)) { safeName(name); names.add(name); }
  if (names.size > MAX_FILES) throw new Error("Fork exceeds the 100,000 Git-visible file limit.");
  const indexPath = path.resolve(indexOutput.trim());
  const indexParent = await fs.realpath(path.dirname(indexPath));
  const common = await fs.realpath((await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim());
  if (!inside(common, indexParent) || path.relative(indexParent, path.dirname(indexPath)) !== "") throw new Error("Fork index escapes the verified Git repository.");
  const indexFile = await readRegular(indexParent, path.basename(indexPath), signal);
  if (!indexFile.contents || indexFile.contents.subarray(0, 4).toString("ascii") !== "DIRC") throw new Error("Cannot fork a missing or invalid Git index.");
  let bytes = indexFile.contents.length;
  const files: SnapshotFile[] = [];
  const hash = createHash("sha256").update(headOutput.trim()).update("\0").update(indexFile.contents);
  for (const name of [...names].sort()) {
    const file = await readRegular(root, name, signal);
    bytes += file.contents?.length ?? 0;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("Fork exceeds the 256 MiB snapshot limit.");
    files.push(file);
    hash.update(name).update("\0").update(String(file.mode)).update("\0").update(file.contents === null ? "absent" : "present").update("\0");
    if (file.contents) hash.update(file.contents);
    hash.update("\0");
  }
  return { head: headOutput.trim(), index: indexFile.contents, indexPath, files, signature: hash.digest("hex") };
}

function remapTurn(source: CodingSessionTurn, id: string): CodingSessionTurn {
  const turn = structuredClone(source);
  turn.id = id;
  turn.forkedFrom = source.id;
  for (const task of turn.tasks) task.sessionId = id;
  for (const event of turn.events) { event.sessionId = id; event.id = `fork-${randomUUID()}`; }
  return turn;
}

function forkRecord(source: CodingSessionRecord, id: string, worktreePath: string, fingerprint: string, head: string): CodingSessionRecord {
  const { turnHistory = [], ...current } = source;
  let endSequence = 0;
  const history = [...turnHistory, current].map((turn) => {
    const start = turn.turnStartSequence ?? endSequence + 1;
    endSequence = Math.max(endSequence, turn.events.at(-1)?.sequence ?? 0);
    return remapTurn({ ...turn, turnStartSequence: start, events: turn.events.filter((event) => event.sequence >= start) }, id);
  });
  const now = new Date().toISOString();
  return {
    schemaVersion: source.schemaVersion, id, forkedFrom: source.id, objective: source.objective,
      ...(source.outputStyleId ? { outputStyleId: source.outputStyleId } : {}),
      ...(source.pluginAgentId ? { pluginAgentId: source.pluginAgentId } : {}),
    mode: source.mode, approvalPolicy: source.approvalPolicy, status: "cancelled", createdAt: now, updatedAt: now,
    cancellationReason: "Independent workspace fork created. Start a new turn to generate current validation and review evidence.",
    repository: { ...source.repository, worktreePath, worktreeFingerprint: fingerprint, worktreeBaseCommit: head, capturedAt: now },
    turnHistory: history, turnStartSequence: endSequence + 1, tasks: [], events: history.flatMap((turn) => turn.events),
    providerBindings: structuredClone(source.providerBindings), validationResults: [], reviewResults: [],
    files: structuredClone(source.files), failures: [], integrations: [], verdict: "BLOCKED",
  };
}

async function ensureAbsent(file: string, description: string): Promise<void> {
  try { await fs.lstat(file); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  throw new Error(`${description} already exists; a fork never reuses it.`);
}

async function assertSessionStorage(root: string, sourceId: string): Promise<void> {
  let directory = root;
  for (const component of [".hivemind", "sessions", sourceId]) {
    directory = path.join(directory, component);
    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== "") throw new Error("Fork session metadata requires plain directories inside the repository.");
  }
  const file = await fs.lstat(path.join(directory, "session.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (file && (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > MAX_FILE_BYTES)) throw new Error("Fork source metadata must be a regular single-link session file no larger than 64 MiB.");
}

async function assertOwnedDirectory(directory: string, identity: CreatedManagedWorktree["identity"]): Promise<void> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.birthtimeNs !== identity.birthtimeNs || path.relative(directory, await fs.realpath(directory)) !== "") throw new Error(`Fork directory was replaced; preserved ${directory} for inspection.`);
}

async function removeOwnedWorktree(root: string, id: string, expectedPath: string, identity: CreatedManagedWorktree["identity"]): Promise<void> {
  const manager = new WorktreeManager(root);
  if (path.relative(manager.getWorktreePath(id), expectedPath) !== "") throw new Error("Partial fork cleanup path changed; preserved it for inspection.");
  await assertOwnedDirectory(expectedPath, identity);
  const marker = await fs.lstat(path.join(expectedPath, ".git")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (marker) await inspectManagedWorktree(root, id, expectedPath);
  else {
    const candidate = await fs.lstat(expectedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (candidate) throw new Error(`Partial fork has no verified Git identity; preserved ${expectedPath}.`);
  }
  await assertOwnedDirectory(expectedPath, identity);
  await manager.discardWorktree(id, { disableHooks: true });
  await ensureAbsent(expectedPath, "Partial fork worktree");
  const branches = await git(root, ["for-each-ref", "--format=%(refname)", `refs/heads/${branchNameForTask(id)}`]);
  if (branches.trim()) throw new Error(`Partial fork branch remains: ${branchNameForTask(id)}.`);
}

/** Snapshot a settled run into an independent managed branch without mutating the source worktree or index. */
export async function forkCodingSession(repositoryPath: string, sourceId: string, options: ForkCodingSessionOptions = {}): Promise<CodingSessionRecord> {
  cancelled(options.signal);
  const resolved = await findRepositoryRoot(repositoryPath, options.signal).catch(() => {
    cancelled(options.signal);
    return repositoryPath;
  });
  const root = await fs.realpath(resolved);
  const lease = await acquireCodingSessionLeaseAtRoot(root, sourceId, options.signal);
  try {
    const store = new CodingSessionStore(root);
    await assertSessionStorage(root, sourceId);
    const source = await store.load(sourceId);
    if (!source) throw new Error(`Coding session ${sourceId} not found.`);
    if (!["completed", "failed", "cancelled"].includes(source.status)) throw new Error("Only settled coding sessions can be forked; finish or interrupt the active run first.");
    if (source.archived) throw new Error(`Coding session ${sourceId} is archived; unarchive it before forking.`);
    if (path.relative(root, await fs.realpath(source.repository.root)) !== "") throw new Error("Coding session belongs to another repository.");
    cancelled(options.signal);
    if (!source.repository.worktreePath) return await store.fork(sourceId);
    const original = await inspectManagedWorktree(root, sourceId, source.repository.worktreePath);
    if (!source.repository.worktreeFingerprint || original.fingerprint !== source.repository.worktreeFingerprint) throw new Error("Managed worktree changed or has no saved fingerprint; inspect it before forking.");
    const captured = await snapshot(source.repository.worktreePath, options.signal);
    const id = options.sessionId ?? `hive-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    validateTaskId(id);
    if (id === sourceId) throw new Error("A fork requires a new coding session identity.");
    const manager = new WorktreeManager(root);
    const target = manager.getWorktreePath(id);
    await ensureAbsent(store.getSessionDirectory(id), "Fork session");
    await ensureAbsent(target, "Fork worktree");
    const branch = branchNameForTask(id);
    if ((await git(root, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`], options.signal)).trim()) throw new Error("Fork branch already exists; it will not be reused.");
    const targetLease = await acquireCodingSessionLeaseAtRoot(root, id, options.signal);
    let created: CreatedManagedWorktree | undefined;
    try {
      cancelled(options.signal);
      created = await manager.createWorktreeFromExclusive(id, captured.head, options.signal);
      await assertOwnedDirectory(target, created.identity);
      await inspectManagedWorktree(root, id, target);
      if ((await git(target, ["rev-parse", "HEAD"], options.signal)).trim() !== captured.head) throw new Error("New fork worktree is on an unexpected commit.");
      const targetIndex = path.resolve((await git(target, ["rev-parse", "--path-format=absolute", "--git-path", "index"], options.signal)).trim());
      const indexParent = await fs.realpath(path.dirname(targetIndex));
      const common = await fs.realpath((await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], options.signal)).trim());
      if (!inside(common, indexParent) || path.relative(indexParent, path.dirname(targetIndex)) !== "") throw new Error("Fork destination index escapes its verified repository.");
      await ensureAbsent(targetIndex, "Fork destination index");
      const identity = created.identity;
      const guard = () => assertOwnedDirectory(target, identity);
      for (const file of captured.files) {
        cancelled(options.signal);
        await assertOwnedDirectory(target, created.identity);
        const destination = path.resolve(target, file.name);
        const existing = await readRegular(target, file.name, options.signal);
        if (file.contents === null) {
          if (existing.contents !== null) await fs.unlink(destination);
        } else {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await writeOwnedFile(destination, file.contents, existing.contents === null, file.mode, guard);
        }
      }
      await assertOwnedDirectory(target, created.identity);
      await writeOwnedFile(targetIndex, captured.index, true, undefined, guard);
      await created.shareDependencies();
      const [sourceAfter, copied] = await Promise.all([snapshot(source.repository.worktreePath, options.signal), snapshot(target, options.signal)]);
      if (sourceAfter.signature !== captured.signature) throw new Error("Source workspace changed while forking; no fork was saved.");
      if (copied.signature !== captured.signature) throw new Error("Fork did not reproduce the source workspace and index exactly; no fork was saved.");
      const [sourceIdentity, forkIdentity] = await Promise.all([
        inspectManagedWorktree(root, sourceId, source.repository.worktreePath), inspectManagedWorktree(root, id, target),
      ]);
      await assertOwnedDirectory(target, created.identity);
      if (sourceIdentity.fingerprint !== original.fingerprint) throw new Error("Source workspace fingerprint changed while forking; no fork was saved.");
      await assertSessionStorage(root, sourceId);
      if (JSON.stringify(await store.load(sourceId)) !== JSON.stringify(source)) throw new Error("Source session metadata changed while forking; no fork was saved.");
      cancelled(options.signal);
      await ensureAbsent(store.getSessionDirectory(id), "Fork session");
      return await store.save(forkRecord(source, id, target, forkIdentity.fingerprint, captured.head));
    } catch (error) {
      if (created) {
        try { await removeOwnedWorktree(root, id, target, created.identity); }
        catch (cleanupError) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message} Partial fork cleanup needs inspection at ${target}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: error });
        }
      }
      throw error;
    } finally { await targetLease.release(); }
  } finally { await lease.release(); }
}
