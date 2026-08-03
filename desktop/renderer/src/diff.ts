export type DiffLineKind = "file" | "hunk" | "added" | "removed" | "context" | "metadata" | "truncated";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
  label: string;
}

export interface ParsedDiff { lines: DiffLine[]; truncated: boolean }

const MAX_RENDERED_DIFF_LINES = 5_000;

export function parseUnifiedDiff(patch: string, sourceTruncated = false): ParsedDiff {
  const source = patch.split(/\r?\n/);
  const clipped = source.length > MAX_RENDERED_DIFF_LINES;
  let oldLine = 0;
  let newLine = 0;
  const lines = source.slice(0, MAX_RENDERED_DIFF_LINES).map((text): DiffLine => {
    if (text.startsWith("diff --git ")) return { kind: "file", text, label: "File header" };
    if (text.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      oldLine = Number(match?.[1] ?? 0); newLine = Number(match?.[2] ?? 0);
      return { kind: "hunk", text, label: "Diff hunk" };
    }
    if (text.startsWith("+") && !text.startsWith("+++")) return { kind: "added", text, newLine: newLine++, label: "Added line" };
    if (text.startsWith("-") && !text.startsWith("---")) return { kind: "removed", text, oldLine: oldLine++, label: "Removed line" };
    if (text.startsWith(" ")) return { kind: "context", text, oldLine: oldLine++, newLine: newLine++, label: "Context line" };
    return { kind: "metadata", text, label: "Diff metadata" };
  });
  if (clipped) lines.push({ kind: "truncated", text: `Renderer stopped after ${MAX_RENDERED_DIFF_LINES.toLocaleString()} lines.`, label: "Diff truncated" });
  return { lines, truncated: sourceTruncated || clipped };
}
