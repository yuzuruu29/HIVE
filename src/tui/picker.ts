/**
 * picker.ts
 * Slash-command and workspace-file pickers for the interactive session.
 * File search returns paths only. It does not read file contents.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { isIgnoredPath } from "../scout/ignore.js";

export const PICKER_RESULT_LIMIT = 8;
const WALK_LIMIT = 4_000;

const EXTRA_IGNORE = new Set([
  "dist-web",
  "dist-binaries",
  "coverage",
  "out",
  ".vite",
  "tmp",
]);

export interface SlashCommandSpec {
  name: string;
  summary: string;
  acceptsArgs: boolean;
  aliases?: readonly string[];
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: "help", summary: "Show commands", acceptsArgs: false },
  { name: "mode", summary: "Show or set the session mode", acceptsArgs: true },
  { name: "plan", summary: "Plan without applying edits", acceptsArgs: true },
  { name: "rewind", summary: "Rewind transcript, or preview and restore files", acceptsArgs: true },
  { name: "checkpoints", summary: "List file checkpoints in this workspace", acceptsArgs: false },
  { name: "shell", summary: "Run an approved local command", acceptsArgs: true },
  { name: "clear", summary: "Clear the transcript", acceptsArgs: false },
  { name: "sessions", summary: "List saved coding sessions", acceptsArgs: false, aliases: ["session"] },
  { name: "exit", summary: "Leave the session", acceptsArgs: false, aliases: ["quit", "q"] },
  { name: "run", summary: "Start a turn", acceptsArgs: true },
  { name: "status", summary: "Show provider and runtime status", acceptsArgs: false },
  { name: "model", summary: "Choose an approved provider/model", acceptsArgs: true, aliases: ["m"] },
  { name: "new", summary: "Start a new saved conversation", acceptsArgs: false },
  { name: "resume", summary: "Choose or resume a saved conversation", acceptsArgs: true },
  { name: "continue", summary: "Restore the most recent conversation", acceptsArgs: false },
  { name: "rename", summary: "Rename this conversation", acceptsArgs: true },
  { name: "fork", summary: "Fork conversation and current coding worktree", acceptsArgs: true },
  { name: "compact", summary: "Summarize earlier context locally", acceptsArgs: true },
  { name: "context", summary: "Inspect context and estimates", acceptsArgs: false },
  { name: "export", summary: "Export conversation as Markdown", acceptsArgs: true },
  { name: "copy", summary: "Copy the last response, or all messages", acceptsArgs: true },
  { name: "find", summary: "Search this transcript", acceptsArgs: true },
  { name: "diff", summary: "Inspect actual workspace changes", acceptsArgs: false },
  { name: "review", summary: "Run a read-only review", acceptsArgs: true },
  { name: "permissions", summary: "Inspect or change the safety mode", acceptsArgs: true },
  { name: "mcp", summary: "Manage trusted MCP servers and attach tools", acceptsArgs: true },
  { name: "skills", summary: "Discover and trust local skills", acceptsArgs: true },
  { name: "skill", summary: "Select trusted skill instructions", acceptsArgs: true },
  { name: "plugins", summary: "Manage local plugin bundles", acceptsArgs: true },
  { name: "hooks", summary: "Inspect and enable trusted lifecycle hooks", acceptsArgs: true },
  { name: "image", summary: "Attach an actual local image", acceptsArgs: true },
  { name: "providers", summary: "Configure BYOK or local providers", acceptsArgs: true },
  { name: "connect", summary: "Choose BYOK, local models or ChatGPT sign-in", acceptsArgs: false },
  { name: "agents", summary: "Show or inspect subagents", acceptsArgs: true, aliases: ["subagents"] },
  { name: "projects", summary: "Choose or attach a project", acceptsArgs: false },
  { name: "archive", summary: "Archive the selected idle session", acceptsArgs: false },
  { name: "restore", summary: "Restore an archived session", acceptsArgs: true },
  { name: "activity", summary: "Toggle role and tool activity", acceptsArgs: false },
  { name: "stop", summary: "Cancel the active run", acceptsArgs: false },
  { name: "import", summary: "Preview and explicitly import legacy histories", acceptsArgs: true },
];

export interface PickerItem {
  label: string;
  detail: string;
  insert: string;
  submit: boolean;
}

export interface ComposerPicker {
  kind: "command" | "file" | "session" | "model" | "project";
  query: string;
  selected: number;
  items: PickerItem[];
  loading?: boolean;
}

export interface PickerAcceptance {
  input: string;
  submit: boolean;
}

export function slashQuery(input: string): string | null {
  if (!input.startsWith("/")) return null;
  if (/\s/.test(input)) return null;
  return input.slice(1).toLowerCase();
}

export function fileQuery(input: string): { start: number; query: string } | null {
  const match = input.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return { start: input.lastIndexOf("@"), query: match[2] ?? "" };
}

export function filterSlashCommands(query: string): PickerItem[] {
  const needle = query.toLowerCase();
  const ranked = SLASH_COMMANDS
    .map((command, index) => ({ command, index, score: commandScore(command, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked.slice(0, PICKER_RESULT_LIMIT).map(({ command }) => ({
    label: `/${command.name}`,
    detail: command.summary,
    insert: command.acceptsArgs ? `/${command.name} ` : `/${command.name}`,
    submit: !command.acceptsArgs,
  }));
}

export function commandPicker(input: string, selected = 0): ComposerPicker | undefined {
  const query = slashQuery(input);
  if (query === null) return undefined;
  const items = filterSlashCommands(query);
  return {
    kind: "command",
    query,
    selected: clampSelection(selected, items.length),
    items,
  };
}

export function rankFilePaths(paths: readonly string[], query: string, limit = PICKER_RESULT_LIMIT): string[] {
  const needle = query.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const ranked = paths
    .map((raw) => raw.replace(/\\/g, "/"))
    .filter((candidate) => candidate && !candidate.split("/").some((part) => part === "." || part === ".."))
    .map((candidate) => ({ candidate, score: pathScore(candidate, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.candidate.length - right.candidate.length ||
      left.candidate.localeCompare(right.candidate));
  const unique: string[] = [];
  for (const entry of ranked) {
    if (unique.includes(entry.candidate)) continue;
    unique.push(entry.candidate);
    if (unique.length >= limit) break;
  }
  return unique;
}

export function filePicker(input: string, paths: readonly string[], selected = 0): ComposerPicker | undefined {
  const query = fileQuery(input);
  if (!query) return undefined;
  const items = rankFilePaths(paths, query.query).map((file) => ({
    label: file,
    detail: "path",
    insert: file,
    submit: false,
  }));
  return {
    kind: "file",
    query: query.query,
    selected: clampSelection(selected, items.length),
    items,
  };
}

export function insertFileMention(input: string, filePath: string): string {
  const query = fileQuery(input);
  if (!query) return input;
  const safe = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!safe || safe.split("/").some((part) => part === "." || part === "..")) return input;
  const mention = /\s/.test(safe) ? `"${safe}"` : safe;
  return `${input.slice(0, query.start)}@${mention} `;
}

export function acceptPicker(input: string, picker: ComposerPicker): PickerAcceptance | undefined {
  const item = picker.items[picker.selected] ?? picker.items[0];
  if (!item) return undefined;
  if (picker.kind === "file") return { input: insertFileMention(input, item.insert), submit: false };
  if (input.trim().toLowerCase() === item.label.toLowerCase()) return { input: item.label, submit: true };
  return { input: item.insert, submit: item.submit };
}

export async function listWorkspaceFiles(root: string, walkLimit = WALK_LIMIT): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  const seen = new Set<string>();
  while (pending.length > 0 && files.length < walkLimit) {
    const current = pending.pop();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!relative || relative.startsWith("..") || seen.has(relative)) continue;
      if (isIgnoredPath(relative) || EXTRA_IGNORE.has(entry.name)) continue;
      seen.add(relative);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(relative);
      if (files.length >= walkLimit) break;
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function commandScore(command: SlashCommandSpec, query: string): number {
  if (!query) return 1;
  const names = [command.name, ...(command.aliases ?? [])];
  if (names.some((name) => name === query)) return 4;
  if (names.some((name) => name.startsWith(query))) return 3;
  if (names.some((name) => name.includes(query))) return 2;
  if (command.summary.toLowerCase().includes(query)) return 1;
  return 0;
}

function pathScore(candidate: string, query: string): number {
  const lower = candidate.toLowerCase();
  const name = lower.split("/").pop() ?? lower;
  if (!query) return name.startsWith(".") ? 0 : lower.split("/").length === 1 ? 2 : 1;
  if (name === query || lower === query) return 5;
  if (name.startsWith(query)) return 4;
  if (lower.startsWith(query)) return 3;
  if (name.includes(query)) return 2;
  if (lower.includes(query)) return 1;
  return 0;
}

function clampSelection(selected: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(selected, count - 1));
}
