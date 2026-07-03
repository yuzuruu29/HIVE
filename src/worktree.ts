import { execFile } from 'child_process';
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
  constructor(private repoPath: string) {}

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
    const branchName = branchNameForTask(taskId);
    const worktreePath = this.getWorktreePath(taskId);
    
    // Check if branch exists
    try {
      await execFileAsync('git', ['rev-parse', '--verify', branchName], { cwd: this.repoPath });
      // Branch exists, create worktree for it
      await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], { cwd: this.repoPath });
    } catch {
      // Branch doesn't exist, create it from HEAD
      await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: this.repoPath });
    }

    return worktreePath;
  }

  public async commitWorktree(taskId: string, message: string, filesToCommit: string[] = []): Promise<void> {
    const branchName = branchNameForTask(taskId);
    const worktreePath = this.getWorktreePath(taskId);
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: worktreePath });
    const currentBranch = stdout.trim();
    if (currentBranch !== branchName || !isHiveCoderBranch(currentBranch)) {
      throw new Error(`Refusing to approve non-HIVE coder branch: ${currentBranch || '(detached)'}`);
    }
    
    if (filesToCommit.length === 0) {
      throw new Error('No files declared to commit. HIVE commit flows must use scoped staging.');
    }

    for (const file of filesToCommit) {
      if (file.includes('.hivemind/coder/') || file.includes('.env') || file.includes('.git/')) {
        throw new Error(`Blocked file staging attempt: ${file}`);
      }
      await execFileAsync('git', ['add', '--', file], { cwd: worktreePath });
    }

    await execFileAsync('git', ['commit', '-m', message], { cwd: worktreePath });
  }

  public async discardWorktree(taskId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(taskId);
    const branchName = branchNameForTask(taskId);
    if (!isHiveCoderBranch(branchName)) {
      throw new Error(`Refusing to discard non-HIVE coder branch: ${branchName}`);
    }
    
    // Remove worktree
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: this.repoPath });
    } catch {
      // Ignore if worktree doesn't exist
    }

    // Delete branch
    try {
      await execFileAsync('git', ['branch', '-D', branchName], { cwd: this.repoPath });
    } catch {
      // Ignore if branch doesn't exist
    }
  }
}
