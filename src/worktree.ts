import { execFile } from 'child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);
const BRANCH_PREFIX = 'hive-coder/';
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

  public async discardWorktree(taskId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(taskId);
    const branchName = branchNameForTask(taskId);
    if (!isHiveCoderBranch(branchName)) {
      throw new Error(`Refusing to discard non-HIVE coder branch: ${branchName}`);
    }
    
    // Remove worktree
    try {
      await execFileAsync(this.gitExecutable, ['worktree', 'remove', '--force', worktreePath], { cwd: this.repoPath });
    } catch {
      // Ignore if worktree doesn't exist
    }

    // Delete branch
    try {
      await execFileAsync(this.gitExecutable, ['branch', '-D', branchName], { cwd: this.repoPath });
    } catch {
      // Ignore if branch doesn't exist
    }
  }
}
