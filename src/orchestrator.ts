import { RepoInspector } from './inspector.js';
import { WorktreeManager } from './worktree.js';
import { SafeRunner } from './runner.js';
import { CoderState, TaskRecord, ProviderSnapshot, CoderAgentExecutor, ProviderRole, VerificationResult } from './types.js';
import { TaskStore } from './store.js';

export class CoderOrchestrator {
  private record: TaskRecord;
  private store: TaskStore;

  constructor(
    private taskId: string, 
    private repoPath: string,
    providers: ProviderSnapshot[],
    private executor?: CoderAgentExecutor,
    existingRecord?: TaskRecord
  ) {
    this.store = new TaskStore(repoPath);
    this.record = existingRecord || {
      taskId,
      state: 'IDLE',
      branchName: `hive-coder/${taskId}`,
      verificationResults: [],
      providers,
      transcripts: {}
    };
  }

  public static async fromRecord(record: TaskRecord, repoPath: string, executor?: CoderAgentExecutor): Promise<CoderOrchestrator> {
    return new CoderOrchestrator(record.taskId, repoPath, record.providers, executor, record);
  }

  public getRecord(): TaskRecord {
    return this.record;
  }
  
  private async saveState(state: CoderState, updates?: Partial<TaskRecord>) {
    this.record.state = state;
    if (updates) {
      Object.assign(this.record, updates);
    }
    await this.store.save(this.record);
  }

  private async executeWithTranscript(role: string, prompt: string, cwd: string, snapshot: ProviderSnapshot): Promise<string> {
    if (!this.executor) return prompt;
    if (!this.record.transcripts) this.record.transcripts = {};
    if (!this.record.transcripts[role]) this.record.transcripts[role] = [];
    
    // Lazy import of redactSecrets to avoid circular dependencies if any, or just use the one from runner
    const { redactSecrets } = await import('./runner.js');
    
    this.record.transcripts[role].push(`User: ${redactSecrets(prompt)}`);
    const res = await this.executor.execute(snapshot.role, prompt, cwd, snapshot);
    const output = redactSecrets(res.output);
    this.record.transcripts[role].push(`Assistant: ${output}`);
    
    return output;
  }

  public async runToReview(prompt: string): Promise<TaskRecord> {
    try {
      await this.saveState('INSPECTING');
      const inspector = new RepoInspector(this.repoPath);
      const inspection = await inspector.inspect();
      
      if (!inspection.isValidRepo) {
        throw new Error('Invalid repository for task');
      }

      const plannerSnapshot = this.record.providers.find((p: ProviderSnapshot) => p.role === 'Planner');
      if (this.executor && plannerSnapshot) {
        await this.saveState('PLANNING');
        let planPrompt = `Please write a plan for: ${prompt}\n\nYou MUST also explicitly output a list of expected changed paths (one per line) wrapped in <expected_files>...</expected_files> tags.`;
        if (inspection.scoutContext) {
          planPrompt = `[Scout Context]\n${inspection.scoutContext}\n\n${planPrompt}`;
        }
        const planOutput = await this.executeWithTranscript('Planner', planPrompt, this.repoPath, plannerSnapshot);
        
        let expectedFiles: string[] = [];
        const match = planOutput.match(/<expected_files>([\s\S]*?)<\/expected_files>/);
        if (match) {
          expectedFiles = match[1].trim().split('\n').map(l => l.trim()).filter(Boolean);
        }
        await this.saveState('PLANNING', { plan: planOutput, expectedFiles });
      } else {
        await this.saveState('PLANNING', { plan: prompt, expectedFiles: [] });
      }

      await this.saveState('WORKTREE_CREATING');
      const wm = new WorktreeManager(this.repoPath);
      const worktreePath = await wm.createWorktree(this.taskId);

      const builderSnapshot = this.record.providers.find((p: ProviderSnapshot) => p.role === 'Builder');
      const validatorSnapshot = this.record.providers.find((p: ProviderSnapshot) => p.role === 'Validator');
      const reviewerSnapshot = this.record.providers.find((p: ProviderSnapshot) => p.role === 'Reviewer');
      
      let retryCount = 0;
      const MAX_RETRIES = 2;
      let feedback = '';

      while (retryCount <= MAX_RETRIES) {
        if (this.executor && builderSnapshot) {
          await this.saveState('BUILDING');
          const planToExecute = this.record.plan || prompt;
          const buildPrompt = feedback 
            ? `The reviewer rejected the previous attempt with this feedback:\n${feedback}\n\nPlease fix the implementation.`
            : `Implement this plan:\n${planToExecute}`;
          await this.executeWithTranscript('Builder', buildPrompt, worktreePath, builderSnapshot);
        } else {
          await this.saveState('BUILDING');
        }
        
        await this.saveState('VERIFYING');
        const runner = new SafeRunner(worktreePath);
        if (inspection.availableScripts.includes('lint')) {
          const res = await runner.runVerification('npm run lint');
          this.record.verificationResults.push(res);
        }
        if (inspection.availableScripts.includes('test')) {
          const res = await runner.runVerification('npm test');
          this.record.verificationResults.push(res);
        }
        
        if (this.executor && validatorSnapshot) {
          const valOutput = await this.executeWithTranscript('Validator', 'Verify the implementation meets the requirements.', worktreePath, validatorSnapshot);
          this.record.verificationResults.push({ command: 'Validator Agent', passed: !valOutput.includes('FAILED'), output: valOutput });
        }
        await this.store.save(this.record);

        const diffSummary = await runner.captureDiff();
        await this.saveState('DIFFING', { diffSummary });

        // Enforce safety rules
        let safetyViolations: string[] = [];
        if (diffSummary.submodulesChanged?.length > 0) {
          for (const sm of diffSummary.submodulesChanged) {
            if (!this.record.expectedFiles?.includes(sm)) {
              safetyViolations.push(`Undeclared submodule change: ${sm}`);
            }
          }
        }
        
        for (const f of diffSummary.filesChanged) {
          if (f.includes('.hivemind/coder/') || f.includes('.env') || f.includes('.git/')) {
            safetyViolations.push(`Blocked file changed: ${f}`);
          }
          if (this.record.expectedFiles && this.record.expectedFiles.length > 0 && !this.record.expectedFiles.includes(f)) {
            safetyViolations.push(`Out-of-allowlist change: ${f}`);
          }
        }

        if (safetyViolations.length > 0) {
          feedback = `SAFETY VIOLATION REJECT:\n${safetyViolations.join('\n')}`;
          retryCount++;
          continue;
        }

        if (this.executor && reviewerSnapshot) {
          const reviewOutput = await this.executeWithTranscript('Reviewer', `Review this diff:\n${diffSummary.patch}`, worktreePath, reviewerSnapshot);
          if (reviewOutput.includes('REJECT')) {
            feedback = reviewOutput;
            retryCount++;
            continue;
          }
          await this.saveState('REVIEWING', { reviewerVerdict: reviewOutput });
        } else {
          await this.saveState('REVIEWING', { reviewerVerdict: 'Needs human approval' });
        }

        await this.saveState('AWAITING_APPROVAL');
        return this.record; // Success or awaiting approval
      }
      
      await this.saveState('FAILED', { reviewerVerdict: `Exhausted retries. Last feedback: ${feedback}` });
    } catch (err: any) {
      await this.saveState('FAILED', { reviewerVerdict: err.message });
    }

    return this.record;
  }

  public async approve(message: string): Promise<void> {
    if (this.record.state !== 'AWAITING_APPROVAL') {
      throw new Error('Task is not awaiting approval');
    }
    
    await this.saveState('COMMITTING');
    const wm = new WorktreeManager(this.repoPath);
    // Use the expectedFiles if present, else fallback to filesChanged that passed safety checks
    let filesToCommit = this.record.diffSummary?.filesChanged || [];
    if (this.record.expectedFiles && this.record.expectedFiles.length > 0) {
      filesToCommit = this.record.expectedFiles.filter((f: string) => filesToCommit.includes(f));
    }
    await wm.commitWorktree(this.taskId, message, filesToCommit);
    await this.saveState('COMPLETED');
  }

  public async push(forge: any): Promise<void> {
    if (this.record.state !== 'COMPLETED') {
      throw new Error(`Cannot push in state ${this.record.state}. Task must be COMPLETED (approved).`);
    }

    const wm = new WorktreeManager(this.repoPath);
    const worktreePath = wm.getWorktreePath(this.taskId);

    await forge.push(worktreePath, this.record.branchName);
    await this.saveState('PUSHED');
  }

  public generatePRBody(): string {
    const r = this.record;
    
    let verifications = 'None';
    if (r.verificationResults && r.verificationResults.length > 0) {
      verifications = r.verificationResults.map((v: VerificationResult) => `- **${v.command}**: ${v.passed ? '✅ Passed' : '❌ Failed'}`).join('\n');
    }

    return `## HIVE Task Report: ${r.taskId}

### Plan
${r.plan || 'No plan provided.'}

### Verification Results
${verifications}

### Diff Summary
- Files changed: ${r.diffSummary?.filesChanged?.length || 0}
- Submodules changed: ${r.diffSummary?.submodulesChanged?.length || 0}
- Insertions: ${r.diffSummary?.insertions || 0}
- Deletions: ${r.diffSummary?.deletions || 0}

### Reviewer Verdict
${r.reviewerVerdict || 'None'}

### Guardrail Checklist
- [x] Pathspec-scoped staging used
- [x] Denylist verified
- [x] Submodule changes verified
- [x] Explicit user approval recorded
`;
  }

  public async createPR(forge: any, baseBranch: string = 'main'): Promise<string> {
    if (this.record.state !== 'PUSHED') {
      throw new Error(`Cannot create PR in state ${this.record.state}. Task must be PUSHED first.`);
    }

    const title = `HIVE Task: ${this.taskId}`;
    const body = this.generatePRBody();

    const prUrl = await forge.createPR(title, body, this.record.branchName, baseBranch);
    await this.saveState('PR_CREATED');
    return prUrl;
  }

  public async discard(): Promise<void> {
    const wm = new WorktreeManager(this.repoPath);
    await wm.discardWorktree(this.taskId);
    await this.saveState('DISCARDED');
  }
}
