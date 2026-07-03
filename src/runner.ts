import { spawn } from 'child_process';
import { VerificationResult, DiffSummary } from './types.js';

const ALLOWED_COMMANDS = new Set(['npm', 'npx', 'node']);
const BLOCKED_ARGS = new Set(['rm', 'rimraf', 'del', 'erase', 'rd', 'rmdir', 'remove-item']);
const SECRET_KEY_PATTERN = /(OPENAI_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*([^\s"'`]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactSecrets(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[REDACTED]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]');
}

export function parseSafeCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Command is required');
  if (/[;&|<>`$]/.test(trimmed)) {
    throw new Error('Blocked: shell metacharacters are not allowed.');
  }

  const parts = trimmed.split(/\s+/);
  const executable = parts[0]?.toLowerCase();
  if (!executable || !ALLOWED_COMMANDS.has(executable)) {
    throw new Error('Blocked: Only npm, npx, or node commands are allowed.');
  }

  if (parts.some((part) => BLOCKED_ARGS.has(part.toLowerCase()))) {
    throw new Error('Blocked: destructive commands are not allowed.');
  }

  if (SECRET_KEY_PATTERN.test(trimmed)) {
    throw new Error('Blocked: command appears to reference a secret-bearing variable.');
  }

  return parts;
}

async function runFile(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  // Resolve 'node' to the absolute executable path so no PATH lookup is needed.
  // When PATH is absent from the child's env, Windows would fail to find 'node'.
  const executable = command === 'node' ? process.execPath : command;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      env: Object.create(null) as Record<string, string>,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Command exited with code ${code}`), { stdout, stderr }));
    });
  });
}

export class SafeRunner {
  constructor(private worktreePath: string) {}

  public async runVerification(command: string): Promise<VerificationResult> {
    let parts: string[];
    try {
      parts = parseSafeCommand(command);
    } catch (err) {
      return {
        command,
        passed: false,
        output: err instanceof Error ? err.message : 'Blocked command.',
      };
    }

    try {
      const { stdout, stderr } = await runFile(parts[0], parts.slice(1), this.worktreePath);
      return {
        command,
        passed: true,
        output: redactSecrets(`${stdout}\n${stderr}`.trim()),
      };
    } catch (err: any) {
      return {
        command,
        passed: false,
        output: redactSecrets(`${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message}`.trim()),
      };
    }
  }

  public async captureDiff(): Promise<DiffSummary> {
    try {
      const { stdout: diffOutput } = await runFile('git', ['diff', 'HEAD'], this.worktreePath);
      const { stdout: nameStatus } = await runFile('git', ['diff', '--name-status', 'HEAD'], this.worktreePath);
      const { stdout: numstat } = await runFile('git', ['diff', '--numstat', 'HEAD'], this.worktreePath);

      let insertions = 0;
      let deletions = 0;
      
      numstat.trim().split('\n').forEach(line => {
        const [ins, del] = line.split('\t');
        if (ins && del) {
          insertions += parseInt(ins, 10) || 0;
          deletions += parseInt(del, 10) || 0;
        }
      });

      const filesChanged = nameStatus.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return parts[parts.length - 1];
      });

      const submodulesChanged: string[] = [];
      for (const file of filesChanged) {
        try {
          const { stdout: lsFiles } = await runFile('git', ['ls-files', '--stage', file], this.worktreePath);
          if (lsFiles.trim().startsWith('160000')) {
            submodulesChanged.push(file);
          }
        } catch {
          // ignore
        }
      }

      return {
        filesChanged,
        submodulesChanged,
        insertions,
        deletions,
        patch: redactSecrets(diffOutput),
      };
    } catch (err) {
      return {
        filesChanged: [],
        submodulesChanged: [],
        insertions: 0,
        deletions: 0,
        patch: ''
      };
    }
  }
}
