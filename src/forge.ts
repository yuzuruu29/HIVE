import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface RemoteForge {
  push(worktreePath: string, branchName: string): Promise<void>;
  createPR(title: string, body: string, branchName: string, baseBranch: string): Promise<string>;
}

export class GitHubForge implements RemoteForge {
  constructor(
    private repoOwner: string,
    private repoName: string,
    private token?: string
  ) {}

  public async push(worktreePath: string, branchName: string): Promise<void> {
    const args = ['push', 'origin', `HEAD:${branchName}`];
    
    // In real environments, standard git auth mechanisms (SSH, helpers) will handle auth.
    // For local tests where token is passed, we might just rely on local setup or inject it 
    // into the remote URL if needed, but the prompt says "Never persist ... tokens" and we
    // will assume the underlying `origin` is authenticated or the token handles it. 
    // We'll just run git push.
    await execFileAsync('git', args, { cwd: worktreePath });
  }

  public async createPR(title: string, body: string, branchName: string, baseBranch: string): Promise<string> {
    if (!this.token) {
      throw new Error('GitHub token is required to create a PR via API');
    }

    const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/pulls`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Hive-Mind-Coder'
      },
      body: JSON.stringify({
        title,
        body,
        head: branchName,
        base: baseBranch
      })
    });

    const data = await response.json() as any;
    
    if (!response.ok) {
      throw new Error(`Failed to create PR: ${data.message || JSON.stringify(data)}`);
    }

    return data.html_url;
  }
}
