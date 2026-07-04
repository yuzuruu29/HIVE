export interface ScoutFileSignal {
  path: string;
  reason: string;
  size: number;
  language: string;
  priorityScore: number;
  excerpt?: string;
  truncated?: boolean;
}

export interface ScoutDocSignal {
  path: string;
  excerpt: string;
  truncated?: boolean;
}

export interface ScoutChangeSignal {
  path: string;
  diffExcerpt: string;
}

export interface ScoutTestHint {
  command: string;
  relevantPaths: string[];
}

export interface ScoutContextPack {
  repoRoot: string;
  generatedAt: string;
  summary: string;
  projectName?: string;
  packageManager?: string;
  frameworks: string[];
  languages: string[];
  scripts: Record<string, string>;
  importantFiles: ScoutFileSignal[];
  docs: ScoutDocSignal[];
  recentChanges: ScoutChangeSignal[];
  testHints: ScoutTestHint[];
  riskNotes: string[];
  promptBudget: {
    maxChars: number;
    usedChars: number;
    truncated: boolean;
  };
}
