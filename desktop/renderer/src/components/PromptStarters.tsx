export interface PromptStartersProps {
  repositoryRoot: string | null;
  onInsert: (text: string) => void;
}

export function PromptStarters({ repositoryRoot, onInsert }: PromptStartersProps) {
  const repoName = repositoryRoot ? repositoryRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? "project" : "project";

  const suggestions = [
    `Fix the failing test in ${repoName}`,
    `Add dark mode support to ${repoName}`,
    `Refactor the auth module in ${repoName}`,
  ];

  return (
    <div className="prompt-starters" aria-label="Suggested starter tasks">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          className="prompt-starter-chip"
          onClick={() => onInsert(suggestion)}
        >
          <span>&gt; {suggestion}</span>
        </button>
      ))}
    </div>
  );
}
