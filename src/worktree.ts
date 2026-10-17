import { execFile } from 'child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);
const BRANCH_PREFIX = 'hive-coder/';
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CreatedManagedWorktree {
  path: string;
  // birthtimeNs catches a same-path replacement that reuses the inode (common on Linux); 0 where unsupported.
  identity: { dev: bigint; ino: bigint; birthtimeNs: bigint };
  shareDependencies(): Promise<void>;
}

export function validateTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error('Invalid taskId: use 1-64 letters, numbers, dot, underscore, or dash characters.');
  }
}

export function branchNameForTask(taskId: string): string {
  validateTaskId(taskId);
  return `${BRANCH_PREFIX}${taskId}`;
}

export function isHiveCoderBranch(branchName: string): boolean {
  return branchName.startsWith(BRANCH_PREFIX) && branchName.length > BRANCH_PREFIX.length;
}

function assertInside(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved path escapes the HIVE coder workspace.');
  }
}

export class WorktreeManager {
  constructor(private repoPath: string, private readonly gitExecutable = 'git') {}

  private worktreeBase(): string {
    return path.resolve(this.repoPath, '.hivemind', 'worktrees');
  }

  public getWorktreePath(taskId: string): string {
    validateTaskId(taskId);
    const resolved = path.resolve(this.worktreeBase(), taskId);
    assertInside(this.worktreeBase(), resolved);
    return resolved;
  }

  public async createWorktree(taskId: string): Promise<string> {
    return this.createWorktreeFrom(taskId, 'HEAD');
  }

  public async createWorktreeFrom(taskId: string, baseRef: string): Promise<string> {
    const branchName = branchNameForTask(taskId);
    const worktreePath = this.getWorktreePath(taskId);

    const existingGitMarker = await fs.stat(path.join(worktreePath, '.git')).catch(() => null);
    if (existingGitMarker) {
      const { stdout } = await execFileAsync(this.gitExecutable, ['branch', '--show-current'], { cwd: worktreePath });
      if (stdout.trim() !== branchName) {
        throw new Error(`Existing HIVE worktree is on unexpected branch: ${stdout.trim() || '(detached)'}`);
      }
      await this.shareNodeDependencies(worktreePath);
      return worktreePath;
    }

    let branchExists = false;
    try {
      await execFileAsync(this.gitExecutable, ['rev-parse', '--verify', branchName], { cwd: this.repoPath });
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      await execFileAsync(this.gitExecutable, ['worktree', 'add', worktreePath, branchName], { cwd: this.repoPath });
    } else {
      await execFileAsync(this.gitExecutable, ['worktree', 'add', '-b', branchName, worktreePath, baseRef], { cwd: this.repoPath });
    }

    await this.shareNodeDependencies(worktreePath);
    return worktreePath;
  }

  /** Forks require atomic new-branch creation; an existing path or branch is never adopted. */
  public async createWorktreeFromExclusive(taskId: string, baseCommit: string, signal?: AbortSignal): Promise<CreatedManagedWorktree> {
    const branchName = branchNameForTask(taskId);
    const worktreePath = this.getWorktreePath(taskId);
    if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) throw new Error('Exclusive worktree creation requires an exact commit SHA.');
    const existing = await fs.lstat(worktreePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) throw new Error('Exclusive worktree path already exists; it will not be adopted.');
    // `-b` is the atomic branch reservation. A racing branch creator makes Git fail.
    try {
      await execFileAsync(this.gitExecutable, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--no-checkout', '-b', branchName, worktreePath, baseCommit], { cwd: this.repoPath, signal, timeout: 30_000 });
    } catch (error) {
      // A Git failure can reject after registration. A nonzero
      // exit does not prove ownership: a racing creator may own the same ref.
      const [partial, branches] = await Promise.all([
        fs.lstat(worktreePath).catch((failure: NodeJS.ErrnoException) => {
          if (failure.code === 'ENOENT') return null;
          throw failure;
        }),
        execFileAsync(this.gitExecutable, ['for-each-ref', '--format=%(refname)', `refs/heads/${branchName}`], { cwd: this.repoPath, timeout: 10_000 }),
      ]);
      if (partial || branches.stdout.trim()) {
        throw new Error(`${error instanceof Error ? error.message : String(error)} Exclusive creation did not complete. Preserved possible partial or concurrently created state; inspect ${worktreePath} and branch ${branchName} before retrying.`, { cause: error });
      }
      throw error;
    }
    try {
      const created = await fs.lstat(worktreePath, { bigint: true });
      if (!created.isDirectory() || created.isSymbolicLink() || path.relative(worktreePath, await fs.realpath(worktreePath)) !== '') throw new Error('New worktree directory identity is invalid.');
      const identity = { dev: created.dev, ino: created.ino, birthtimeNs: created.birthtimeNs };
      const assertIdentity = async (): Promise<void> => {
        const current = await fs.lstat(worktreePath, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs || path.relative(worktreePath, await fs.realpath(worktreePath)) !== '') throw new Error('New worktree directory was replaced during initialization.');
      };
      return { path: worktreePath, identity, shareDependencies: async () => {
        await assertIdentity();
        if (signal?.aborted) throw new DOMException('Coding session fork cancelled.', 'AbortError');
        let ignored = false;
        // Git sees a Windows junction as a directory but a POSIX symlink as a file, so a
        // dir-only "node_modules/" rule would leave the POSIX link Git-visible.
        const linkPath = process.platform === 'win32' ? 'node_modules/' : 'node_modules';
        try { await execFileAsync(this.gitExecutable, ['check-ignore', '--quiet', '--', linkPath], { cwd: worktreePath, signal, timeout: 10_000 }); ignored = true; }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 1)) throw error; }
        if (ignored) await this.shareNodeDependencies(worktreePath);
        await assertIdentity();
      } };
    } catch (error) {
      throw new Error(`Exclusive worktree identity could not be established; preserved ${worktreePath} and ${branchName} for inspection.`, { cause: error });
    }
  }

  private async shareNodeDependencies(worktreePath: string): Promise<void> {
    const source = path.join(this.repoPath, 'node_modules');
    const target = path.join(worktreePath, 'node_modules');
    const [sourceStat, targetStat] = await Promise.all([
      fs.stat(source).catch(() => null),
      fs.lstat(target).catch(() => null),
    ]);
    if (!sourceStat?.isDirectory() || targetStat) return;
    await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  }

  public async commitWorktree(taskId: string, message: string, filesToCommit: string[] = []): Promise<void> {
    const branchName = branchNameForTask(taskId);
    const worktreePath = this.getWorktreePath(taskId);
    const { stdout } = await execFileAsync(this.gitExecutable, ['branch', '--show-current'], { cwd: worktreePath });
    const currentBranch = stdout.trim();
    if (currentBranch !== branchName || !isHiveCoderBranch(currentBranch)) {
      throw new Error(`Refusing to approve non-HIVE coder branch: ${currentBranch || '(detached)'}`);
    }
    
    if (filesToCommit.length === 0) {
      throw new Error('No files declared to commit. HIVE commit flows must use scoped staging.');
    }

    const normalizedFiles = filesToCommit.map((file) => file.replaceAll('\\', '/'));
    if (new Set(normalizedFiles).size !== normalizedFiles.length) {
      throw new Error('Files declared for commit must be unique.');
    }

    const { stdout: stagedBeforeOutput } = await execFileAsync(
      this.gitExecutable,
      ['diff', '--cached', '--name-only', '--no-renames', '-z'],
      { cwd: worktreePath },
    );
    const stagedBefore = stagedBeforeOutput.split('\0').filter(Boolean);
    if (stagedBefore.length > 0) {
      throw new Error(`Refusing scoped commit because the index already contains pre-staged entries: ${stagedBefore.join(', ')}`);
    }

    try {
      for (const file of normalizedFiles) {
        if (file.includes('.hivemind/coder/') || file.includes('.env') || file.includes('.git/')) {
          throw new Error(`Blocked file staging attempt: ${file}`);
        }
        await execFileAsync(this.gitExecutable, ['add', '--', file], { cwd: worktreePath });
      }

      const { stdout: stagedAfterOutput } = await execFileAsync(
        this.gitExecutable,
        ['diff', '--cached', '--name-only', '--no-renames', '-z'],
        { cwd: worktreePath },
      );
      const stagedAfter = stagedAfterOutput.split('\0').filter(Boolean).sort();
      const approved = [...normalizedFiles].sort();
      if (stagedAfter.length !== approved.length || stagedAfter.some((file, index) => file !== approved[index])) {
        throw new Error(`Refusing commit because the staged set does not exactly match approved paths: ${stagedAfter.join(', ')}`);
      }

      await execFileAsync(this.gitExecutable, ['commit', '-m', message], { cwd: worktreePath });
    } catch (error) {
      let cleanupError: unknown;
      try {
        const { stdout: stagedOutput } = await execFileAsync(
          this.gitExecutable,
          ['diff', '--cached', '--name-only', '--no-renames', '-z'],
          { cwd: worktreePath },
        );
        const approvedSet = new Set(normalizedFiles);
        const introduced = stagedOutput.split('\0').filter((file) => approvedSet.has(file));
        for (const file of introduced) {
          await execFileAsync(this.gitExecutable, ['restore', '--staged', '--', file], { cwd: worktreePath });
        }
      } catch (cleanup) {
        cleanupError = cleanup;
      }
      if (cleanupError) {
        const original = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`Commit failed: ${original}. Failed to clean operation staging: ${cleanup}`, { cause: error });
      }
      throw error;
    }
  }

  public async discardWorktree(taskId: string, options: { disableHooks?: boolean } = {}): Promise<void> {
    const worktreePath = this.getWorktreePath(taskId);
    const branchName = branchNameForTask(taskId);
    if (!isHiveCoderBranch(branchName)) {
      throw new Error(`Refusing to discard non-HIVE coder branch: ${branchName}`);
    }
    
    // Remove worktree
    const gitOptions = options.disableHooks ? ['-c', 'core.hooksPath=/dev/null'] : [];
    try {
      await execFileAsync(this.gitExecutable, [...gitOptions, 'worktree', 'remove', '--force', worktreePath], { cwd: this.repoPath });
    } catch {
      // Ignore if worktree doesn't exist
    }

    // Delete branch
    try {
      await execFileAsync(this.gitExecutable, [...gitOptions, 'branch', '-D', branchName], { cwd: this.repoPath });
    } catch {
      // Ignore if branch doesn't exist
    }
  }
}
