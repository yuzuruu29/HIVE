import { createHash, randomUUID } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodingSessionRecord, FileChangeRecord } from "../coding/types.js";
import { CodingSessionStore } from "../coding/session-store.js";
import { WorktreeManager, branchNameForTask } from "../worktree.js";
import { containsKnownSecret } from "../security/secrets.js";
import type {
  DesktopChangesDiff,
  DesktopChangesDiffRequest,
  GuardedGitActionPreview,
  GuardedGitCommitConfirmationInput,
  GuardedGitCommitPreviewInput,
  GuardedGitDiscardConfirmationInput,
  GuardedGitPreviewInput,
  GuardedGitPullRequestConfirmationInput,
  GuardedGitPushConfirmationInput,
  GuardedGitResult,
  GuardedGitService,
  GuardedGitStatus,
} from "./types.js";

const TOKEN_LIFETIME_MS = 5 * 60_000;
const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

interface SessionLoader {
  load(sessionId: string): Promise<CodingSessionRecord | null>;
}

interface WorktreeGateway {
  getWorktreePath(sessionId: string): string;
  commitWorktree(sessionId: string, message: string, files: string[]): Promise<void>;
  discardWorktree(sessionId: string): Promise<void>;
}

interface DesktopRemoteForge {
  push(worktreePath: string, branchName: string): Promise<void>;
  createPR(title: string, body: string, branchName: string, baseBranch: string, draft?: boolean): Promise<string>;
}

type ExecFileOptions = { cwd: string; encoding: "utf8"; maxBuffer: number };
type ExecFileResult = { stdout: string; stderr: string };
type ExecFileRunner = (file: string, args: readonly string[], options: ExecFileOptions) => Promise<ExecFileResult>;

export interface DefaultGuardedGitServiceOptions {
  sessionStoreFactory?: (repositoryRoot: string) => SessionLoader;
  worktreeManagerFactory?: (repositoryRoot: string) => WorktreeGateway;
  forge: DesktopRemoteForge;
  execFile?: ExecFileRunner;
  clock?: () => Date | string | number;
  tokenFactory?: () => string;
  maxDiffBytes?: number;
  remoteHeadResolver?: (worktreePath: string, remote: string, branch: string) => Promise<string | null>;
}

interface ConfirmationRecord {
  action: GuardedGitPreviewInput["action"];
  serializedProposal: string;
  proposal: GuardedGitPreviewInput;
  observedHead: string | null;
  worktreePath: string;
  branch: string;
  createdAtMs: number;
  expiresAtMs: number;
  remoteFingerprint?: string;
}

function defaultExecFile(file: string, args: readonly string[], options: ExecFileOptions): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Guarded Git proposal has unexpected or missing details.");
  }
}

function safeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error("Invalid Git path.");
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) throw new Error("Git path must be repository-relative.");
  const clean = path.posix.normalize(normalized);
  if (clean === ".." || clean.startsWith("../") || clean === "." || clean.startsWith(".git/") || clean === ".git") {
    throw new Error("Git path escapes or targets protected repository metadata.");
  }
  return clean;
}

function uniqueRecordedPaths(files: readonly FileChangeRecord[]): string[] {
  const values: string[] = [];
  for (const file of files) {
    values.push(safeRelativePath(file.path));
    if (file.operation === "renamed" && file.previousPath) values.push(safeRelativePath(file.previousPath));
  }
  return [...new Set(values)].sort();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return { value, truncated: false };
  let shortened = encoded.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(shortened, "utf8") > maxBytes) shortened = shortened.slice(0, -1);
  return { value: shortened, truncated: true };
}

export class DefaultGuardedGitService implements GuardedGitService {
  readonly #sessionStoreFactory: (repositoryRoot: string) => SessionLoader;
  readonly #worktreeManagerFactory: (repositoryRoot: string) => WorktreeGateway;
  readonly #forge: DesktopRemoteForge;
  readonly #execFile: ExecFileRunner;
  readonly #clock: () => Date | string | number;
  readonly #tokenFactory: () => string;
  readonly #maxDiffBytes: number;
  readonly #remoteHeadResolver: (worktreePath: string, remote: string, branch: string) => Promise<string | null>;
  readonly #confirmations = new Map<string, ConfirmationRecord>();

  public constructor(options: DefaultGuardedGitServiceOptions) {
    this.#sessionStoreFactory = options.sessionStoreFactory ?? ((root) => new CodingSessionStore(root));
    this.#worktreeManagerFactory = options.worktreeManagerFactory ?? ((root) => new WorktreeManager(root));
    this.#forge = options.forge;
    this.#execFile = options.execFile ?? defaultExecFile;
    this.#clock = options.clock ?? (() => new Date());
    this.#tokenFactory = options.tokenFactory ?? randomUUID;
    this.#maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
    this.#remoteHeadResolver = options.remoteHeadResolver ?? ((worktree, remote, branch) =>
      this.#resolveRemoteHead(worktree, remote, branch));
    if (!Number.isSafeInteger(this.#maxDiffBytes) || this.#maxDiffBytes < 1 || this.#maxDiffBytes > 16 * 1024 * 1024) {
      throw new RangeError("maxDiffBytes must be between 1 and 16 MiB.");
    }
  }

  public async inspect(repositoryRoot: string): Promise<GuardedGitStatus> {
    const root = await this.#canonicalRepository(repositoryRoot);
    const [branch, head, status] = await Promise.all([
      this.#git(root, ["branch", "--show-current"]),
      this.#head(root),
      this.#git(root, ["status", "--porcelain=v1", "-z"]),
    ]);
    const changedFiles = status.stdout.split("\0").filter(Boolean).map((line) => line.slice(3)).sort();
    let ahead = 0;
    let behind = 0;
    try {
      const counts = (await this.#git(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).stdout.trim().split(/\s+/).map(Number);
      behind = counts[0] ?? 0;
      ahead = counts[1] ?? 0;
    } catch {
      // A repository without an upstream is neither reported ahead nor behind.
    }
    return { repositoryRoot: root, branch: branch.stdout.trim() || null, head, dirty: changedFiles.length > 0, changedFiles, ahead, behind };
  }

  public async inspectDiff(request: DesktopChangesDiffRequest): Promise<DesktopChangesDiff> {
    const root = await this.#canonicalRepository(request.repositoryRoot);
    const { worktreePath } = await this.#derivedWorktree(root, request.codingSessionId);
    const session = await this.#sessionChanges(root, request.codingSessionId);
    const paths = request.paths?.map(safeRelativePath) ?? session.recordedFiles;
    if (new Set(paths).size !== paths.length) throw new Error("Diff paths must be unique.");
    if (paths.some((file) => !session.recordedFiles.includes(file))) throw new Error("Diff paths must belong to the recorded coding session.");
    if (paths.length === 0) return { repositoryRoot: root, codingSessionId: request.codingSessionId, patch: "", truncated: false, ...session };
    const args = ["diff", "--no-ext-diff", "--unified=3"];
    if (request.staged) args.push("--cached");
    if (paths.length > 0) args.push("--", ...paths);
    const result = await this.#git(worktreePath, args, 16 * 1024 * 1024);
    const bounded = truncateUtf8(result.stdout, this.#maxDiffBytes);
    return { repositoryRoot: root, codingSessionId: request.codingSessionId, patch: bounded.value, truncated: bounded.truncated, ...session };
  }

  public async prepareConfirmation(proposal: GuardedGitPreviewInput): Promise<GuardedGitActionPreview> {
    const canonical = await this.#validateProposal(proposal);
    const { worktreePath, branch } = await this.#derivedWorktree(canonical.repositoryRoot, canonical.codingSessionId);
    await this.#assertDerivedBranch(worktreePath, branch);
    const observedHead = await this.#head(worktreePath);
    if (canonical.action === "commit") await this.#validateCommitSession(canonical);
    const remoteFingerprint = canonical.action === "push" || canonical.action === "pull-request"
      ? await this.#safeRemoteFingerprint(worktreePath, canonical.remote)
      : undefined;
    if (canonical.action === "pull-request") {
      const remoteHead = await this.#remoteHeadResolver(worktreePath, canonical.remote, branch);
      if (!observedHead || remoteHead !== observedHead) {
        throw new Error("The derived branch must be explicitly pushed at the current HEAD before opening a pull request.");
      }
    }
    const nowMs = this.#nowMs();
    this.#pruneExpiredConfirmations(nowMs);
    const token = this.#tokenFactory();
    if (!token || this.#confirmations.has(token)) throw new Error("Confirmation token factory returned a duplicate or empty token.");
    this.#confirmations.set(token, {
      action: canonical.action,
      serializedProposal: JSON.stringify(canonical),
      proposal: canonical,
      observedHead,
      worktreePath,
      branch,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + TOKEN_LIFETIME_MS,
      remoteFingerprint,
    });
    return {
      confirmationToken: token,
      proposal: canonical,
      observedHead,
      summary: this.#summary(canonical, branch),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + TOKEN_LIFETIME_MS).toISOString(),
      oneUse: true,
    };
  }

  public async confirmCommit(input: GuardedGitCommitConfirmationInput): Promise<GuardedGitResult> {
    const record = await this.#consume(input.confirmationToken, input.proposal, "commit");
    const proposal = record.proposal as GuardedGitCommitPreviewInput;
    await this.#validateCommitSession(proposal);
    await this.#worktreeManagerFactory(proposal.repositoryRoot).commitWorktree(
      proposal.codingSessionId,
      proposal.message,
      proposal.paths,
    );
    return { head: await this.#head(record.worktreePath), summary: `Committed ${proposal.paths.length} reviewed file(s).` };
  }

  public async confirmPush(input: GuardedGitPushConfirmationInput): Promise<GuardedGitResult> {
    const record = await this.#consume(input.confirmationToken, input.proposal, "push");
    await this.#assertRemoteUnchanged(record, (record.proposal as Extract<GuardedGitPreviewInput, { action: "push" }>).remote);
    await this.#forge.push(record.worktreePath, record.branch);
    const head = await this.#head(record.worktreePath);
    const proposal = record.proposal as Extract<GuardedGitPreviewInput, { action: "push" }>;
    const remoteHead = await this.#remoteHeadResolver(record.worktreePath, proposal.remote, record.branch);
    if (!head || remoteHead !== head) throw new Error("Push did not verify the derived remote branch at the current HEAD.");
    return { head, summary: `Pushed ${record.branch}.` };
  }

  public async confirmPullRequest(input: GuardedGitPullRequestConfirmationInput): Promise<{ url: string }> {
    const record = await this.#consume(input.confirmationToken, input.proposal, "pull-request");
    const proposal = record.proposal as Extract<GuardedGitPreviewInput, { action: "pull-request" }>;
    await this.#assertRemoteUnchanged(record, proposal.remote);
    const remoteHead = await this.#remoteHeadResolver(record.worktreePath, proposal.remote, record.branch);
    if (!record.observedHead || remoteHead !== record.observedHead) {
      throw new Error("The remote branch no longer matches the confirmed local HEAD.");
    }
    const url = await this.#forge.createPR(proposal.title, proposal.body, record.branch, proposal.base, proposal.draft);
    return { url };
  }

  public async confirmDiscard(input: GuardedGitDiscardConfirmationInput): Promise<void> {
    const record = await this.#consume(input.confirmationToken, input.proposal, "discard");
    await this.#worktreeManagerFactory(record.proposal.repositoryRoot).discardWorktree(record.proposal.codingSessionId);
    const marker = await fs.lstat(path.join(record.worktreePath, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (marker) throw new Error("Discard failed: the derived HIVE worktree .git marker still exists.");
    if (await this.#branchExists(record.proposal.repositoryRoot, record.branch)) {
      throw new Error("Discard failed: the derived HIVE branch still exists.");
    }
  }

  async #consume(
    token: string,
    proposal: GuardedGitPreviewInput,
    action: GuardedGitPreviewInput["action"],
  ): Promise<ConfirmationRecord> {
    const nowMs = this.#nowMs();
    const record = this.#confirmations.get(token);
    this.#pruneExpiredConfirmations(nowMs);
    if (!record) throw new Error("Unknown guarded Git confirmation token.");
    this.#confirmations.delete(token);
    if (nowMs >= record.expiresAtMs) throw new Error("Guarded Git confirmation token expired.");
    if (record.action !== action) throw new Error("Guarded Git confirmation token is for a different action.");
    const canonical = await this.#validateProposal(proposal);
    if (JSON.stringify(canonical) !== record.serializedProposal) {
      throw new Error("Guarded Git confirmation details changed after preview.");
    }
    const currentHead = await this.#head(record.worktreePath);
    if (currentHead !== record.observedHead) throw new Error("Guarded Git confirmation is stale because HEAD changed.");
    await this.#assertDerivedBranch(record.worktreePath, record.branch);
    return record;
  }

  #pruneExpiredConfirmations(nowMs: number): void {
    for (const [token, record] of this.#confirmations) {
      if (nowMs >= record.expiresAtMs) this.#confirmations.delete(token);
    }
  }

  async #validateProposal(proposal: GuardedGitPreviewInput): Promise<GuardedGitPreviewInput> {
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw new Error("Guarded Git proposal is required.");
    const root = await this.#canonicalRepository(proposal.repositoryRoot);
    if (!SAFE_REF.test(proposal.codingSessionId)) throw new Error("Invalid coding session id.");
    if (proposal.action === "commit") {
      assertExactKeys(proposal as unknown as Record<string, unknown>, ["action", "repositoryRoot", "codingSessionId", "message", "paths"]);
      if (!proposal.message.trim() || proposal.message.length > 500) throw new Error("Commit message must contain 1-500 characters.");
      const paths = proposal.paths.map(safeRelativePath);
      if (paths.length === 0 || new Set(paths).size !== paths.length) throw new Error("Commit paths must be non-empty and unique.");
      return { ...proposal, repositoryRoot: root, paths };
    }
    if (proposal.action === "push") {
      assertExactKeys(proposal as unknown as Record<string, unknown>, ["action", "repositoryRoot", "codingSessionId", "remote"]);
      if (proposal.remote !== "origin") throw new Error("Only the configured origin remote is supported.");
      return { ...proposal, repositoryRoot: root };
    }
    if (proposal.action === "pull-request") {
      assertExactKeys(proposal as unknown as Record<string, unknown>, ["action", "repositoryRoot", "codingSessionId", "remote", "base", "title", "body", "draft"]);
      if (proposal.remote !== "origin") throw new Error("Only the configured origin remote is supported.");
      if (!SAFE_REF.test(proposal.base) || proposal.base.includes("..")) throw new Error("Invalid pull-request base branch.");
      if (!proposal.title.trim() || proposal.title.length > 500 || proposal.body.length > 100_000 || typeof proposal.draft !== "boolean") {
        throw new Error("Invalid pull-request details.");
      }
      return { ...proposal, repositoryRoot: root };
    }
    if (proposal.action === "discard") {
      assertExactKeys(proposal as unknown as Record<string, unknown>, ["action", "repositoryRoot", "codingSessionId"]);
      return { ...proposal, repositoryRoot: root };
    }
    throw new Error("Unsupported guarded Git action.");
  }

  async #validateCommitSession(proposal: GuardedGitCommitPreviewInput): Promise<void> {
    const changes = await this.#sessionChanges(proposal.repositoryRoot, proposal.codingSessionId);
    if (changes.commitEligibility === "session-not-completed") throw new Error("Only completed coding sessions may be committed.");
    if (changes.commitEligibility === "validation-required") throw new Error("Coding session validation must pass before commit.");
    if (changes.commitEligibility === "review-required") throw new Error("The latest coding review must pass before commit.");
    if (changes.commitEligibility === "no-recorded-files") throw new Error("Coding session has no recorded files to commit.");
    const proposed = [...proposal.paths].sort();
    if (!arraysEqual(proposed, changes.reviewedFiles)) throw new Error("Commit paths must exactly match the unique recorded coding-session file paths.");
  }

  async #sessionChanges(repositoryRoot: string, codingSessionId: string): Promise<Pick<DesktopChangesDiff, "recordedFiles" | "reviewedFiles" | "commitEligibility">> {
    const record = await this.#sessionStoreFactory(repositoryRoot).load(codingSessionId);
    if (!record) throw new Error(`Coding session ${codingSessionId} was not found.`);
    const recordedRepository = await fs.realpath(record.repository.root).catch(() => null);
    if (recordedRepository !== repositoryRoot) {
      throw new Error("Coding session belongs to a different repository.");
    }
    const recordedFiles = uniqueRecordedPaths(record.files);
    if (recordedFiles.length === 0) return { recordedFiles, reviewedFiles: [], commitEligibility: "no-recorded-files" };
    if (record.status !== "completed") return { recordedFiles, reviewedFiles: [], commitEligibility: "session-not-completed" };
    const latestValidations = new Map<string, (typeof record.validationResults)[number]>();
    for (const validation of record.validationResults) latestValidations.set(validation.command, validation);
    if (latestValidations.size === 0 || [...latestValidations.values()].some((validation) => validation.status !== "passed")) {
      return { recordedFiles, reviewedFiles: [], commitEligibility: "validation-required" };
    }
    const latestReview = [...record.reviewResults].sort((left, right) => left.completedAt.localeCompare(right.completedAt)).at(-1);
    if (!latestReview || latestReview.status !== "passed") return { recordedFiles, reviewedFiles: [], commitEligibility: "review-required" };
    return { recordedFiles, reviewedFiles: recordedFiles, commitEligibility: "eligible" };
  }

  async #canonicalRepository(repositoryRoot: string): Promise<string> {
    if (typeof repositoryRoot !== "string" || !repositoryRoot.trim()) throw new Error("A repository root is required.");
    const canonical = await fs.realpath(repositoryRoot);
    const top = (await this.#git(canonical, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const canonicalTop = await fs.realpath(top);
    if (path.relative(canonicalTop, canonical) !== "") throw new Error("The selected path must be the repository root.");
    return canonicalTop;
  }

  async #derivedWorktree(repositoryRoot: string, sessionId: string): Promise<{ worktreePath: string; branch: string }> {
    const manager = this.#worktreeManagerFactory(repositoryRoot);
    const expected = manager.getWorktreePath(sessionId);
    const worktreePath = await fs.realpath(expected);
    const base = path.resolve(repositoryRoot, ".hivemind", "worktrees");
    const relative = path.relative(base, worktreePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Derived worktree path escapes the HIVE worktree directory.");
    return { worktreePath, branch: branchNameForTask(sessionId) };
  }

  async #assertDerivedBranch(worktreePath: string, branch: string): Promise<void> {
    const current = (await this.#git(worktreePath, ["branch", "--show-current"])).stdout.trim();
    if (current !== branch) throw new Error("Derived HIVE worktree is on an unexpected branch.");
  }

  async #head(cwd: string): Promise<string | null> {
    try { return (await this.#git(cwd, ["rev-parse", "HEAD"])).stdout.trim() || null; }
    catch { return null; }
  }

  async #resolveRemoteHead(worktreePath: string, remote: string, branch: string): Promise<string | null> {
    try {
      const ref = `refs/heads/${branch}`;
      const output = (await this.#git(worktreePath, ["ls-remote", "--heads", remote, ref])).stdout.trim();
      for (const line of output.split(/\r?\n/)) {
        const [head, remoteRef] = line.trim().split(/\s+/);
        if (remoteRef === ref && /^[0-9a-f]{40}$/i.test(head ?? "")) return head;
      }
      return null;
    } catch {
      return null;
    }
  }

  async #assertRemoteUnchanged(record: ConfirmationRecord, remote: string): Promise<void> {
    const current = await this.#safeRemoteFingerprint(record.worktreePath, remote);
    if (!record.remoteFingerprint || current !== record.remoteFingerprint) throw new Error("The configured Git remote changed after preview.");
  }

  async #safeRemoteFingerprint(worktreePath: string, remote: string): Promise<string> {
    const fetchUrls = await this.#safeRemoteUrls(worktreePath, remote, false);
    const pushUrls = await this.#safeRemoteUrls(worktreePath, remote, true);
    return createHash("sha256").update(JSON.stringify({ fetchUrls, pushUrls })).digest("hex");
  }

  async #safeRemoteUrls(worktreePath: string, remote: string, push: boolean): Promise<string[]> {
    let output: string;
    try { output = (await this.#git(worktreePath, ["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote], 64 * 1024)).stdout; }
    catch { throw new Error("The configured Git remote is unavailable or unsafe."); }
    const urls = [...new Set(output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))].sort();
    if (urls.length === 0 || urls.some((url) => !this.#isSafeRemoteUrl(url))) throw new Error("The configured Git remote is unavailable or unsafe.");
    return urls;
  }

  #isSafeRemoteUrl(value: string): boolean {
    if (!value || value.includes("\0") || containsKnownSecret(value)) return false;
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\")) return true;
    if (/^git@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return true;
    try {
      const parsed = new URL(value);
      if (!new Set(["https:", "http:", "ssh:", "git:", "file:"]).has(parsed.protocol)) return false;
      if (parsed.password || ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.username)) return false;
      return Boolean(parsed.hostname || parsed.protocol === "file:");
    } catch { return false; }
  }

  async #branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
    try {
      await this.#git(repositoryRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  #git(cwd: string, args: readonly string[], maxBuffer = 1024 * 1024): Promise<ExecFileResult> {
    return this.#execFile("git", args, { cwd, encoding: "utf8", maxBuffer });
  }

  #nowMs(): number {
    const value = this.#clock();
    const millis = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(millis)) throw new Error("Guarded Git clock returned an invalid time.");
    return millis;
  }

  #summary(proposal: GuardedGitPreviewInput, branch: string): string {
    if (proposal.action === "commit") return `Commit ${proposal.paths.length} reviewed file(s) on ${branch}.`;
    if (proposal.action === "push") return `Push ${branch} to ${proposal.remote}.`;
    if (proposal.action === "pull-request") return `Open ${proposal.draft ? "draft " : ""}pull request from ${branch} to ${proposal.base}.`;
    return `Discard HIVE worktree and branch ${branch}.`;
  }
}
