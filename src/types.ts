export type TaskId = string;

export type ProviderRole = 
  | 'Planner' 
  | 'Builder' 
  | 'Validator' 
  | 'Reviewer' 
  | 'Synthesis' 
  | 'Fallback';

export interface ProviderSnapshot {
  role: ProviderRole;
  providerType: string;
  modelId: string;
  baseUrl?: string;
  // Intentionally excludes secrets/API keys
}

export type CoderState = 
  | 'IDLE'
  | 'INSPECTING'
  | 'PLANNING'
  | 'WORKTREE_CREATING'
  | 'BUILDING'
  | 'VERIFYING'
  | 'DIFFING'
  | 'REVIEWING'
  | 'AWAITING_APPROVAL'
  | 'COMMITTING'
  | 'COMPLETED'
  | 'PUSHED'
  | 'PR_CREATED'
  | 'FAILED'
  | 'DISCARDED';

export interface VerificationResult {
  command: string;
  passed: boolean;
  output: string;
}

export interface DiffSummary {
  filesChanged: string[];
  submodulesChanged: string[];
  insertions: number;
  deletions: number;
  patch: string;
}

export interface TaskRecord {
  taskId: TaskId;
  state: CoderState;
  branchName: string;
  plan?: string;
  expectedFiles?: string[];
  verificationResults: VerificationResult[];
  diffSummary?: DiffSummary;
  reviewerVerdict?: string;
  providers: ProviderSnapshot[];
  transcripts?: Record<string, string[]>;
}

export interface RepoInspectionResult {
  projectRoot: string;
  availableScripts: string[];
  isValidRepo: boolean;
  errors?: string[];
  scoutContext?: string;
}

export interface CoderAgentExecutor {
  execute(role: ProviderRole, prompt: string, cwd: string, snapshot: ProviderSnapshot): Promise<{ output: string }>;
}
