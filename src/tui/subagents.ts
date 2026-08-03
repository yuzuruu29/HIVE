/**
 * subagents.ts
 * Pure, terminal-safe rendering helpers for the persistent Subagents panel.
 */

import {
  aggregateSubagentCounts as aggregateRuntimeSubagentCounts,
  type RuntimeEvent,
  type SubagentCounts,
  type SubagentTask,
} from "../coding/types.js";
import type { TuiState } from "./state.js";
import { applyColor, BRAND_COLORS, stripAnsi } from "../ui/colors.js";

type CountKind = "working" | "waiting" | "done" | "blocked" | "failed" | "cancelled" | "skipped";

interface CountSegment {
  kind: CountKind;
  text: string;
}

const ROLE_BADGES: Record<SubagentTask["role"], string> = {
  planner: "[PL]",
  scout: "[SC]",
  builder: "[BU]",
  validator: "[VA]",
  reviewer: "[RV]",
  fixer: "[FX]",
};

const STATUS_GLYPHS: Record<SubagentTask["status"], string> = {
  created: "+",
  queued: ".",
  waiting_for_dependencies: ":",
  starting: ">",
  working: "*",
  blocked: "!",
  retrying: "~",
  validating: "=",
  completed: "x",
  failed: "X",
  cancelled: "-",
  skipped: "/",
};

const ACTIVE_STATUSES = new Set<SubagentTask["status"]>([
  "starting",
  "working",
  "retrying",
  "validating",
]);

const QUEUED_STATUSES = new Set<SubagentTask["status"]>([
  "created",
  "queued",
  "waiting_for_dependencies",
]);

const ACTIVE_AVATAR_VARIANTS = ["o", "O", "@", "*"] as const;
const MOTION_FRAMES = [".", "o", "O", "o"] as const;

function repeat(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : "";
}

function ascii(value: unknown, fallback = "none"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value)
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\s+/g, " ")
    .trim() || fallback;
}

function truncatePlain(value: unknown, width: number): string {
  const text = ascii(value, "");
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return text.slice(0, width - 3) + "...";
}

function padPlain(value: unknown, width: number): string {
  const text = truncatePlain(value, width);
  return text + repeat(" ", width - text.length);
}

function fitLine(value: string, width: number): string {
  if (width <= 0) return "";
  const bare = stripAnsi(value);
  if (bare.length <= width) return value;
  return truncatePlain(bare, width);
}

function paint(text: string, colorEnabled: boolean, color: { r: number; g: number; b: number }): string {
  return colorEnabled ? applyColor(text, color.r, color.g, color.b) : text;
}

function hashId(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function roleBadge(role: SubagentTask["role"]): string {
  return ROLE_BADGES[role] ?? "[??]";
}

export function roleLabel(role: SubagentTask["role"]): string {
  const raw = ascii(role, "unknown");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function statusGlyph(status: SubagentTask["status"]): string {
  return STATUS_GLYPHS[status] ?? "?";
}

export function statusLabel(status: SubagentTask["status"]): string {
  return ascii(status, "unknown").replace(/_/g, " ");
}

export function isWorkingStatus(status: SubagentTask["status"]): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function avatarVariant(id: string): string {
  return ACTIVE_AVATAR_VARIANTS[hashId(id) % ACTIVE_AVATAR_VARIANTS.length];
}

export function renderSubagentAvatar(
  task: SubagentTask,
  motionEnabled = false,
  frame = 0
): string {
  let marker = statusGlyph(task.status);
  if (isWorkingStatus(task.status)) {
    marker = motionEnabled
      ? MOTION_FRAMES[(Math.max(0, Math.floor(frame)) + hashId(task.id)) % MOTION_FRAMES.length]
      : avatarVariant(task.id);
  }
  return marker + roleBadge(task.role);
}

export function aggregateSubagentCounts(tasks: readonly SubagentTask[]): SubagentCounts {
  return aggregateRuntimeSubagentCounts(tasks);
}

function countSegments(counts: SubagentCounts): CountSegment[] {
  const segments: CountSegment[] = [
    { kind: "working", text: `${counts.working} working` },
    { kind: "done", text: `${counts.done} done` },
  ];
  if (counts.waiting > 0) segments.push({ kind: "waiting", text: `${counts.waiting} waiting` });
  if (counts.blocked > 0) segments.push({ kind: "blocked", text: `${counts.blocked} blocked` });
  if (counts.failed > 0) segments.push({ kind: "failed", text: `${counts.failed} failed` });
  if (counts.cancelled > 0) segments.push({ kind: "cancelled", text: `${counts.cancelled} cancelled` });
  if (counts.skipped > 0) segments.push({ kind: "skipped", text: `${counts.skipped} skipped` });
  return segments;
}

function styleCount(segment: CountSegment, colorEnabled: boolean): string {
  if (!colorEnabled) return segment.text;
  if (segment.kind === "working") return paint(segment.text, true, BRAND_COLORS.text);
  if (segment.kind === "done" || segment.kind === "cancelled" || segment.kind === "skipped") {
    return paint(segment.text, true, BRAND_COLORS.dim);
  }
  if (segment.kind === "blocked" || segment.kind === "waiting") {
    return paint(segment.text, true, { r: 245, g: 158, b: 11 });
  }
  return paint(segment.text, true, { r: 248, g: 113, b: 113 });
}

function wrapCountSegments(segments: CountSegment[], width: number, colorEnabled: boolean): string[] {
  const rows: CountSegment[][] = [];
  let row: CountSegment[] = [];
  let rowLength = 0;

  for (const segment of segments) {
    const extra = (row.length > 0 ? 2 : 0) + segment.text.length;
    if (row.length > 0 && rowLength + extra > width) {
      rows.push(row);
      row = [segment];
      rowLength = segment.text.length;
    } else {
      row.push(segment);
      rowLength += extra;
    }
  }
  if (row.length > 0) rows.push(row);

  return rows.map((items) => fitLine(items.map((item) => styleCount(item, colorEnabled)).join("  "), width));
}

function styleAvatar(task: SubagentTask, avatar: string, colorEnabled: boolean): string {
  if (!colorEnabled) return avatar;
  if (task.status === "failed") return paint(avatar, true, { r: 248, g: 113, b: 113 });
  if (task.status === "blocked") return paint(avatar, true, { r: 245, g: 158, b: 11 });
  if (task.status === "completed" || task.status === "cancelled" || task.status === "skipped") {
    return paint(avatar, true, BRAND_COLORS.dim);
  }
  if (isWorkingStatus(task.status)) return paint(avatar, true, BRAND_COLORS.primary_bright);
  return paint(avatar, true, BRAND_COLORS.muted);
}

function avatarSummary(
  tasks: readonly SubagentTask[],
  width: number,
  colorEnabled: boolean,
  motionEnabled: boolean,
  frame: number
): string {
  if (width <= 0 || tasks.length === 0) return "";

  const rendered = tasks.map((task) => ({
    task,
    plain: renderSubagentAvatar(task, motionEnabled, frame),
  }));

  for (let shown = rendered.length; shown >= 0; shown -= 1) {
    const hidden = rendered.length - shown;
    const visiblePlain = rendered.slice(0, shown).map((item) => item.plain);
    if (hidden > 0) visiblePlain.push(`+${hidden}`);
    const plain = visiblePlain.join(" ");
    if (plain.length <= width) {
      const styled = rendered
        .slice(0, shown)
        .map((item) => styleAvatar(item.task, item.plain, colorEnabled));
      if (hidden > 0) styled.push(paint(`+${hidden}`, colorEnabled, BRAND_COLORS.muted));
      return styled.join(" ");
    }
  }
  return "";
}

function taskRank(task: SubagentTask): number {
  if (isWorkingStatus(task.status)) return 0;
  if (task.status === "blocked" || task.status === "failed") return 1;
  if (QUEUED_STATUSES.has(task.status)) return 2;
  return 3;
}

function orderedTasks(tasks: readonly SubagentTask[]): SubagentTask[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => taskRank(a.task) - taskRank(b.task) || a.index - b.index)
    .map(({ task }) => task);
}

export function formatElapsed(start?: string, end?: string, now = Date.now()): string {
  if (!start) return "--:--";
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : now;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "--:--";
  const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderWideTaskRow(task: SubagentTask, selected: boolean, width: number, now: number): string {
  const idWidth = 9;
  const roleWidth = 10;
  const statusWidth = 24;
  const providerWidth = 24;
  const elapsedWidth = 8;
  const taskWidth = Math.max(8, width - 2 - idWidth - roleWidth - statusWidth - providerWidth - elapsedWidth - 5);
  const providerModel = task.model ? `${ascii(task.providerId)}/${ascii(task.model)}` : ascii(task.providerId);
  const elapsed = formatElapsed(task.startedAt ?? task.createdAt, task.completedAt, now);
  return (
    (selected ? "> " : "  ") +
    padPlain(task.id, idWidth) + " " +
    padPlain(roleLabel(task.role), roleWidth) + " " +
    padPlain(`${statusGlyph(task.status)} ${statusLabel(task.status)}`, statusWidth) + " " +
    padPlain(task.title, taskWidth) + " " +
    padPlain(providerModel, providerWidth) + " " +
    padPlain(elapsed, elapsedWidth)
  );
}

function renderWideHeader(width: number): string {
  const idWidth = 9;
  const roleWidth = 10;
  const statusWidth = 24;
  const providerWidth = 24;
  const elapsedWidth = 8;
  const taskWidth = Math.max(8, width - 2 - idWidth - roleWidth - statusWidth - providerWidth - elapsedWidth - 5);
  return (
    "  " + padPlain("ID", idWidth) + " " +
    padPlain("ROLE", roleWidth) + " " +
    padPlain("STATUS", statusWidth) + " " +
    padPlain("TASK", taskWidth) + " " +
    padPlain("PROVIDER/MODEL", providerWidth) + " " +
    padPlain("ELAPSED", elapsedWidth)
  );
}

function renderMediumTaskRow(task: SubagentTask, selected: boolean, width: number): string {
  const idWidth = 9;
  const roleWidth = 10;
  const statusWidth = 24;
  const taskWidth = Math.max(5, width - 2 - idWidth - roleWidth - statusWidth - 3);
  return (
    (selected ? "> " : "  ") +
    padPlain(task.id, idWidth) + " " +
    padPlain(roleLabel(task.role), roleWidth) + " " +
    padPlain(`${statusGlyph(task.status)} ${statusLabel(task.status)}`, statusWidth) + " " +
    padPlain(task.title, taskWidth)
  );
}

function renderMediumHeader(width: number): string {
  const idWidth = 9;
  const roleWidth = 10;
  const statusWidth = 24;
  const taskWidth = Math.max(5, width - 2 - idWidth - roleWidth - statusWidth - 3);
  return (
    "  " + padPlain("ID", idWidth) + " " +
    padPlain("ROLE", roleWidth) + " " +
    padPlain("STATUS", statusWidth) + " " +
    padPlain("TASK", taskWidth)
  );
}

function renderNarrowTaskRow(task: SubagentTask, selected: boolean, width: number): string {
  const prefix = selected ? "> " : "  ";
  const core = `${statusGlyph(task.status)}${roleBadge(task.role)} ${ascii(task.id)} ${statusLabel(task.status)} `;
  return prefix + core + truncatePlain(task.title, Math.max(0, width - prefix.length - core.length));
}

function eventActivity(event: RuntimeEvent | undefined): string {
  if (!event) return "No activity recorded";
  const payload = event.payload as unknown as Record<string, unknown>;
  const explicit = payload.activity ?? payload.message ?? payload.summary ?? payload.reason ?? payload.error ?? payload.path ?? payload.file ?? payload.tool;
  if (typeof explicit === "string" && explicit.trim() !== "") return ascii(explicit);
  return ascii(event.type, "activity").replace(/^subagent\./, "").replace(/[._]/g, " ");
}

function runtimeEventSubagentId(event: RuntimeEvent): string | undefined {
  const topLevel = (event as unknown as { subagentId?: unknown }).subagentId;
  if (typeof topLevel === "string") return topLevel;
  const payload = event.payload as unknown as Record<string, unknown>;
  return typeof payload.subagentId === "string" ? payload.subagentId : undefined;
}

function renderSelectedDetail(state: TuiState, selected: SubagentTask, width: number): string[] {
  const lines: string[] = [];
  lines.push(repeat("-", width));
  lines.push(`${roleLabel(selected.role)} ${roleBadge(selected.role)} - ${ascii(selected.id)}`);
  lines.push(`Status: ${statusGlyph(selected.status)} ${statusLabel(selected.status)}`);
  lines.push(`Provider: ${ascii(selected.providerId)}  Model: ${ascii(selected.model)}`);
  lines.push(`Task: ${ascii(selected.title)}`);
  lines.push("Files:");
  if (selected.fileScope.length === 0) {
    lines.push("  (none declared)");
  } else {
    const shownFiles = selected.fileScope.slice(0, 4);
    for (const file of shownFiles) lines.push(`  ${ascii(file)}`);
    if (selected.fileScope.length > shownFiles.length) {
      lines.push(`  +${selected.fileScope.length - shownFiles.length} more`);
    }
  }
  const latest = [...(state.recentRuntimeEvents ?? [])]
    .reverse()
    .find((event) => runtimeEventSubagentId(event) === selected.id);
  lines.push("Latest activity:");
  lines.push(`  ${eventActivity(latest)}`);
  if (selected.error) lines.push(`Error: ${ascii(selected.error)}`);
  else if (selected.summary) lines.push(`Summary: ${ascii(selected.summary)}`);
  return lines.map((line) => fitLine(line, width));
}

export function renderSubagentsPanel(state: TuiState, requestedWidth: number, now = state.updatedAt ?? Date.now()): string[] {
  const width = Number.isFinite(requestedWidth)
    ? Math.max(1, Math.floor(requestedWidth))
    : 1;
  const subagents = state.subagents ?? [];
  const divider = paint(repeat("-", width), state.colorEnabled, BRAND_COLORS.dim);
  const heading = paint("Subagents", state.colorEnabled, BRAND_COLORS.muted);
  const counts = aggregateSubagentCounts(subagents);
  const segments = countSegments(counts);
  const lines: string[] = [divider];
  const frame = Math.floor(now / 700);
  const activeTasks = orderedTasks(subagents).filter((task) => isWorkingStatus(task.status));

  if (!state.subagentsExpanded) {
    lines.push(heading);
    const countPlainLength = segments.map((segment) => segment.text).join("  ").length;
    if (width >= 70 && countPlainLength < width) {
      const availableForAvatars = Math.max(0, width - countPlainLength - 3);
      const avatars = avatarSummary(activeTasks, availableForAvatars, state.colorEnabled, state.motionEnabled ?? false, frame);
      const countText = segments.map((segment) => styleCount(segment, state.colorEnabled)).join("  ");
      lines.push(fitLine(avatars ? `${avatars}   ${countText}` : countText, width));
    } else {
      const avatars = avatarSummary(activeTasks, width, state.colorEnabled, state.motionEnabled ?? false, frame);
      if (avatars) lines.push(fitLine(avatars, width));
      lines.push(...wrapCountSegments(segments, width, state.colorEnabled));
    }
    lines.push(divider);
    return lines.map((line) => fitLine(line, width));
  }

  const countRows = wrapCountSegments(segments, Math.max(1, width - 12), state.colorEnabled);
  if (width >= 54 && countRows.length === 1) lines.push(fitLine(`${heading} - ${countRows[0]}`, width));
  else {
    lines.push(heading);
    lines.push(...wrapCountSegments(segments, width, state.colorEnabled));
  }

  const tasks = orderedTasks(subagents);
  const maxRows = width >= 110 ? 8 : width >= 70 ? 6 : 4;
  const visibleTasks = tasks.slice(0, maxRows);
  if (tasks.length === 0) {
    lines.push(paint("No subagents yet", state.colorEnabled, BRAND_COLORS.dim));
  } else if (width >= 110) {
    lines.push(paint(renderWideHeader(width), state.colorEnabled, BRAND_COLORS.muted));
    for (const task of visibleTasks) {
      const row = renderWideTaskRow(task, task.id === state.selectedSubagentId, width, now);
      lines.push(styleAvatar(task, row, state.colorEnabled));
    }
  } else if (width >= 70) {
    lines.push(paint(renderMediumHeader(width), state.colorEnabled, BRAND_COLORS.muted));
    for (const task of visibleTasks) {
      const row = renderMediumTaskRow(task, task.id === state.selectedSubagentId, width);
      lines.push(styleAvatar(task, row, state.colorEnabled));
    }
  } else {
    for (const task of visibleTasks) {
      const row = renderNarrowTaskRow(task, task.id === state.selectedSubagentId, width);
      lines.push(styleAvatar(task, row, state.colorEnabled));
    }
  }

  if (tasks.length > visibleTasks.length) {
    lines.push(paint(`+${tasks.length - visibleTasks.length} more`, state.colorEnabled, BRAND_COLORS.muted));
  }

  const selected = subagents.find((task) => task.id === state.selectedSubagentId);
  if (selected) lines.push(...renderSelectedDetail(state, selected, width));
  lines.push(divider);
  return lines.map((line) => fitLine(line, width));
}
