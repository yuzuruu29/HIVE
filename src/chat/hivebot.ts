import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { ChatReceipt } from "./types.js";
import { createChatEngine, type ChatEngine, type ChatEngineRole } from "./engine.js";
import type { ChatOptions } from "./chat-cli.js";
import { buildScoutGrounding } from "./grounding.js";
import { locateSkillRoot } from "./skill-locate.js";
import {
  COUNCIL_PRESETS,
  loadAgentPrompt,
  loadProtocolDigest,
  runtimeContract,
  type HivebotPreset,
  type HivebotPresetName,
} from "./skill-protocol.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HivebotStatus =
  | "COMPLETE"
  | "FAILED"
  | "BLOCKED"
  | "BUDGET_EXCEEDED";

/** Stage lifecycle event surfaced to opt-in observers (desktop council UI). */
export interface HivebotStageEvent {
  type: "stage-started" | "stage-completed";
  agent: string;
  attempt: number;
  receipt?: ChatReceipt;
  /** Stage output; present on stage-completed. */
  output?: string;
}

export interface HivebotOptions extends ChatOptions {
  /** Force a preset; otherwise the Queen classifies and selects one. */
  preset?: HivebotPresetName;
  providerId?: string;
  model?: string;
  /** Explicit run id; defaults to a generated `hivebot-<epoch>-<hex>`. */
  runId?: string;
  /** Optional stage observer; `undefined` keeps CLI behavior byte-identical. */
  onStage?: (event: HivebotStageEvent) => void;
}

/**
 * One completed engine stage. `role` is the engine routing role; it is typed
 * as {@link ChatEngineRole} (a superset of `ChatBindingRole`) because the
 * Queen maps to the `"queen"` role which is not a `ChatBindingRole`.
 */
export interface StageResult {
  agent: string;
  role: ChatEngineRole;
  output: string;
  receipt: ChatReceipt;
}

/** Stage as persisted to the run artifact (adds phase label + attempt). */
export interface StageRecord extends StageResult {
  phase: string;
  attempt: number;
}

/** Sentinel completion-gate verdict, as defined by the skill's verification policy. */
export type HivebotVerdict = "PASS" | "PASS_WITH_LIMITATIONS" | "FAIL" | "BLOCKED";

export interface HivebotRunSummary {
  status: HivebotStatus;
  reason: string;
  /** Last parsed Sentinel verdict; absent when no Sentinel ran or none was parsed. */
  verdict?: HivebotVerdict;
  /** Final HIVE Review in the skill's response format. */
  review: string;
  preset: HivebotPresetName;
  runId: string;
  stages: StageRecord[];
  totalTokens: number;
  artifactDir: string;
  runPath: string;
  reportPath: string;
}

export type HivebotResult = { exitCode: number; output: string } & HivebotRunSummary;

// ---------------------------------------------------------------------------
// Agent metadata
// ---------------------------------------------------------------------------

/** Human phase label per agent, mirroring the previous council definitions. */
export const AGENT_LABEL: Record<string, string> = {
  Queen: "Orchestrate & classify",
  Scout: "Map context & impact",
  Architect: "Design executable plan",
  Forger: "Implement in scope",
  Sentinel: "Validate & verdict",
  Scribe: "Document & review",
};

/**
 * Maps a council agent to the engine routing role. Kept aligned with the
 * previous council so BYOK chatbot role assignments keep working.
 */
function agentRole(agent: string): ChatEngineRole {
  switch (agent) {
    case "Queen":
      return "queen";
    case "Architect":
      return "planning";
    case "Scout":
    case "Forger":
      return "coding";
    case "Sentinel":
      return "heavyReasoning";
    case "Scribe":
      return "projectCoworker";
    default:
      return "coding";
  }
}

// ---------------------------------------------------------------------------
// Markers and parsing
// ---------------------------------------------------------------------------

/** Bounded length of prior handoffs included in any stage prompt. */
const MAX_HANDOFF_CONTEXT_CHARS = 8_000;
/** The Queen's run contract stays pinned in every handoff, at most this long. */
const MAX_RUN_CONTRACT_CHARS = 1_500;
/** Bounded Sentinel findings injected into a repair prompt. */
const MAX_REPAIR_DIRECTIVE_CHARS = 4_000;

/** Parses a `PRESET: <name>` marker emitted by the Queen. */
function parsePreset(text: string): HivebotPresetName | null {
  const m = text.match(/PRESET\s*:\s*(quick|standard|deep|audit)/i);
  if (!m) return null;
  return m[1].toLowerCase() as HivebotPresetName;
}

/**
 * Extracts the first line that starts with `VERDICT:` (markdown emphasis
 * allowed). Lines containing `|` are echoed templates such as
 * `verdict: pass | fail`, never a decision.
 */
export function parseVerdict(text: string): HivebotVerdict | null {
  for (const line of text.split("\n")) {
    if (line.includes("|")) continue;
    const m = line.match(/^[\s>*_`#-]*(?:final\s+)?verdict[\s*_`]*:[\s*_`]*(pass[\s_]+with[\s_]+limitations|pass|fail|blocked)\b/i);
    if (m) return m[1].toUpperCase().replace(/[\s_]+/g, "_") as HivebotVerdict;
  }
  return null;
}

function receiptTokens(r: ChatReceipt): number {
  return r.totalTokens ?? (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
}

function makeRunId(): string {
  return `hivebot-${Date.now()}-${randomBytes(2).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Builds a stage prompt. The first line carries `[HIVE] role: <agent>` so a
 * scripted stub engine (and log readers) can identify the current speaker
 * before the bounded prior-handoff summary (which may mention other agents).
 */
function buildPrompt(
  task: string,
  stages: readonly StageResult[],
  agent: string,
  preset: HivebotPreset,
  extraContext?: string,
): string {
  const parts: string[] = [
    `[HIVE] role: ${agent}`,
    `Phase: ${AGENT_LABEL[agent] ?? agent}`,
    "",
    `Task: ${task}`,
  ];
  if (extraContext) parts.push("\n" + extraContext);
  const summary = summarizeStages(stages, preset.maxOutputCharsPerStage);
  if (summary) parts.push("\n## Prior handoffs\n" + summary);
  return parts.join("\n");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/**
 * Selects prior handoffs within `MAX_HANDOFF_CONTEXT_CHARS`. The Queen's run
 * contract is always kept; the remaining budget goes to the newest stages
 * first, so a Sentinel always sees the Forger proposal it audits and a repair
 * round sees the findings it must address. Output stays chronological.
 */
function summarizeStages(stages: readonly StageResult[], perStage: number): string {
  if (!stages.length) return "";
  const [first, ...rest] = stages;
  const pinned = `## ${first.agent}\n${clip(first.output.trim(), MAX_RUN_CONTRACT_CHARS)}`;
  let remaining = MAX_HANDOFF_CONTEXT_CHARS - pinned.length;
  const kept: string[] = [];
  const omitted: string[] = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const block = `## ${rest[i].agent}\n${clip(rest[i].output.trim(), perStage)}`;
    if (block.length <= remaining) {
      kept.unshift(block);
      remaining -= block.length;
    } else if (remaining > 400) {
      kept.unshift(clip(block, remaining - 20));
      remaining = 0;
    } else {
      omitted.unshift(rest[i].agent);
    }
  }
  const note = omitted.length ? [`[Earlier handoffs omitted for budget: ${omitted.join(", ")}]`] : [];
  return [pinned, ...note, ...kept].join("\n\n");
}

/** Bounds Sentinel findings so a repair prompt never carries an unbounded transcript. */
function boundContext(text: string): string {
  return text.length > MAX_REPAIR_DIRECTIVE_CHARS
    ? text.slice(0, MAX_REPAIR_DIRECTIVE_CHARS)
    : text;
}

/** Persona, then the HIVE runtime contract, then the shared protocol digest. */
async function buildSystemPrompt(skillRoot: string | null, agent: string): Promise<string> {
  const persona = await loadAgentPrompt(skillRoot, agent);
  const digest = await loadProtocolDigest(skillRoot);
  return `${persona}\n\n${runtimeContract(agent)}\n\n# Protocol Digest\n${digest}`;
}

function toRecord(r: StageResult, attempt: number): StageRecord {
  return {
    agent: r.agent,
    role: r.role,
    output: r.output,
    receipt: r.receipt,
    phase: AGENT_LABEL[r.agent] ?? r.agent,
    attempt,
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

const REVIEW_TITLE: Record<HivebotStatus, string> = {
  COMPLETE: "Complete",
  BLOCKED: "Blocked",
  FAILED: "Failed",
  // The skill's PARTIAL stop: work happened but the run stopped before its gate.
  BUDGET_EXCEEDED: "Partial",
};

const NEXT_ACTION: Record<Exclude<HivebotStatus, "COMPLETE">, string> = {
  BLOCKED: "Provide what the Sentinel reported as missing, then rerun the council.",
  FAILED: "Read the Sentinel findings in the run report, then rerun with a narrower task or the deep preset.",
  BUDGET_EXCEEDED: "Rerun with a narrower task, or a preset with a larger token budget.",
};

/**
 * Final response in the skill's HIVE Review format. A completed run uses the
 * Scribe's review when one ran; every other outcome is stated from the run
 * record so a stop never reads as success.
 */
function buildReview(
  task: string,
  status: HivebotStatus,
  reason: string,
  verdict: HivebotVerdict | undefined,
  records: readonly StageRecord[],
  roster: readonly string[],
): string {
  const title = `## HIVE Review — ${REVIEW_TITLE[status]}`;
  const scribe = [...records].reverse().find((s) => s.agent === "Scribe");
  if (status === "COMPLETE" && scribe?.output.trim()) {
    const text = clip(scribe.output.trim(), 8_000);
    return /HIVE Review/i.test(text) ? text : `${title}\n\n${text}`;
  }
  if (status === "COMPLETE") {
    return [
      title,
      "",
      `**Goal:** ${task}`,
      `**Result:** Sentinel ${verdict === "PASS_WITH_LIMITATIONS" ? "passed with limitations" : "passed"} after ${records.length} stage(s).`,
      "**Verification:** Council review only; no commands were executed.",
      `**Limitations:** ${verdict === "PASS_WITH_LIMITATIONS" ? "Listed in the Sentinel handoff." : "None recorded beyond council-only verification."}`,
      "**Final status:** Complete",
    ].join("\n");
  }
  const ran = new Set(records.map((s) => s.agent));
  const remaining = roster.filter((agent) => !ran.has(agent));
  return [
    title,
    "",
    `**Goal:** ${task}`,
    `**Completed:** ${records.length ? records.map((s) => (s.attempt > 1 ? `${s.agent} (attempt ${s.attempt})` : s.agent)).join(", ") : "No stages"}`,
    `**Remaining:** ${remaining.length ? remaining.join(", ") : "Nothing beyond the failed gate"}`,
    `**Blocker:** ${reason}`,
    `**Next action:** ${NEXT_ACTION[status]}`,
    `**Final status:** ${REVIEW_TITLE[status]}`,
  ].join("\n");
}

function buildReport(summary: HivebotRunSummary, task: string): string {
  const L: string[] = [];
  L.push(`# HIVE Run Report — ${summary.runId}`);
  L.push(`Status: ${summary.status}`);
  L.push(`Reason: ${summary.reason}`);
  if (summary.verdict) L.push(`Verdict: ${summary.verdict}`);
  L.push(`Preset: ${summary.preset}`);
  L.push(`Total tokens: ${summary.totalTokens}`);
  L.push("");
  L.push(summary.review);
  L.push("");
  L.push("## Task");
  L.push(task);
  for (const s of summary.stages) {
    L.push("");
    L.push(`## ${s.agent} (attempt ${s.attempt}) — ${s.phase}`);
    L.push(s.output.trim().slice(0, 2_000));
  }
  L.push("");
  L.push(`Total tokens: ${summary.totalTokens}`);
  return L.join("\n");
}

async function writeArtifacts(
  cwd: string,
  runId: string,
  summary: Omit<HivebotRunSummary, "artifactDir" | "runPath" | "reportPath">,
  task: string,
): Promise<{ artifactDir: string; runPath: string; reportPath: string }> {
  const artifactDir = path.join(cwd, ".hivemind", "hivebot-runs", runId);
  await fs.mkdir(artifactDir, { recursive: true });
  const runPath = path.join(artifactDir, "run.json");
  const reportPath = path.join(artifactDir, "report.md");

  const runData = {
    schemaVersion: 1,
    runId,
    task,
    preset: summary.preset,
    status: summary.status,
    reason: summary.reason,
    ...(summary.verdict ? { verdict: summary.verdict } : {}),
    createdAt: new Date().toISOString(),
    totalTokens: summary.totalTokens,
    stages: summary.stages.map((s) => ({
      agent: s.agent,
      role: s.role,
      phase: s.phase,
      attempt: s.attempt,
      output: s.output,
      receipt: s.receipt,
    })),
  };

  await fs.writeFile(runPath, JSON.stringify(runData, null, 2), "utf-8");
  const report = buildReport(
    { ...summary, artifactDir, runPath, reportPath },
    task,
  );
  await fs.writeFile(reportPath, report, "utf-8");
  return { artifactDir, runPath, reportPath };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runHivebot(
  task: string,
  options: HivebotOptions = {},
): Promise<HivebotResult> {
  if (!task || !task.trim()) {
    return {
      exitCode: 1,
      output: 'Usage: hive hivebot "<task>"',
      status: "FAILED",
      reason: "empty task",
      review: "",
      preset: options.preset ?? "standard",
      runId: options.runId ?? makeRunId(),
      stages: [],
      totalTokens: 0,
      artifactDir: "",
      runPath: "",
      reportPath: "",
    };
  }

  const cwd = options.cwd || process.cwd();
  const signal = options.signal;
  const makeEngine =
    options.createEngine ??
    ((projectRoot: string, sid: string, opts?: Parameters<typeof createChatEngine>[2]) =>
      createChatEngine(projectRoot, sid, opts));
  const engine = makeEngine(cwd, `hivebot-${Date.now()}`);

  const skillRoot = await locateSkillRoot(cwd);

  let presetName: HivebotPresetName = options.preset ?? "standard";
  let preset = COUNCIL_PRESETS[presetName];
  const forced = Boolean(options.preset);
  const runId = options.runId ?? makeRunId();
  const onStage = options.onStage;
  // An observer owns rendering (desktop, TUI); writing to a shared TTY would corrupt its screen.
  const echo = process.stdout.isTTY && !onStage;

  const streamLines: string[] = [];
  const emitStageStart = (agent: string, attempt: number): void => {
    const line = `──────── ${agent} · attempt ${attempt} ────────`;
    streamLines.push(line);
    if (echo) console.log(line);
    onStage?.({ type: "stage-started", agent, attempt });
  };
  const emitReceipt = (agent: string, receipt: ChatReceipt): void => {
    const line = `[${agent} → ${receipt.providerId}/${receipt.model} · ${receiptTokens(receipt)} tok]`;
    streamLines.push(line);
    if (echo) console.log(line);
  };

  const stages: StageResult[] = [];
  const records: StageRecord[] = [];
  let totalTokens = 0;
  let lastVerdict: HivebotVerdict | undefined;

  const pushStage = (r: StageResult, attempt: number) => {
    stages.push(r);
    totalTokens += receiptTokens(r.receipt);
    records.push(toRecord(r, attempt));
  };

  const budgetHit = () => totalTokens > preset.tokenBudget;

  const budgetReason = () =>
    `token budget ${preset.tokenBudget} exceeded (${totalTokens} tokens)`;

  async function completeStage(
    agent: string,
    prompt: string,
    systemPrompt: string,
    attempt: number,
  ): Promise<StageResult> {
    emitStageStart(agent, attempt);
    const result = await engine.complete({
      role: agentRole(agent),
      prompt,
      systemPrompt,
      providerId: options.providerId,
      model: options.model,
      signal,
    });
    emitReceipt(agent, result.receipt);
    onStage?.({ type: "stage-completed", agent, attempt, receipt: result.receipt, output: result.output });
    return {
      agent,
      role: agentRole(agent),
      output: result.output,
      receipt: result.receipt,
    };
  }

  async function finalize(status: HivebotStatus, reason: string): Promise<HivebotResult> {
    const base: Omit<HivebotRunSummary, "artifactDir" | "runPath" | "reportPath"> = {
      status,
      reason,
      ...(lastVerdict ? { verdict: lastVerdict } : {}),
      review: buildReview(task, status, reason, lastVerdict, records, preset.agents),
      preset: presetName,
      runId,
      stages: records,
      totalTokens,
    };
    const { artifactDir, runPath, reportPath } = await writeArtifacts(
      cwd,
      runId,
      base,
      task,
    );
    const summary: HivebotRunSummary = {
      ...base,
      artifactDir,
      runPath,
      reportPath,
    };
    const output = [
      ...streamLines,
      "",
      `[hivemind] ${status} · preset ${presetName} · ${records.length} stage(s) · ${totalTokens} tokens · run ${runId}`,
      "",
      summary.review,
    ].join("\n");
    return {
      exitCode: status === "COMPLETE" ? 0 : 1,
      output,
      ...summary,
    };
  }

  try {
    const runStage = async (agent: string, attempt = 1, extraContext?: string): Promise<StageResult> =>
      completeStage(agent, buildPrompt(task, stages, agent, preset, extraContext), await buildSystemPrompt(skillRoot, agent), attempt);

    // ---- a. Queen writes the run contract and (unless forced) selects the preset ----
    const queen = await runStage(
      "Queen",
      1,
      forced ? `Preset fixed by the user: ${presetName}. Still write the run contract; your PRESET line is ignored.` : undefined,
    );
    pushStage(queen, 1);

    if (!forced) {
      const chosen = parsePreset(queen.output);
      if (chosen) {
        presetName = chosen;
        preset = COUNCIL_PRESETS[presetName];
      }
    }

    const roster = preset.agents;
    const hasScout = roster.includes("Scout");
    const hasArchitect = roster.includes("Architect");
    const hasForger = roster.includes("Forger");
    const hasSentinel = roster.includes("Sentinel");
    const hasScribe = roster.includes("Scribe");

    // ---- b. Scout + Architect (concurrently when the roster has both) ----
    // Safe to run concurrently: Scout maps context/impact and Architect designs
    // the plan — independent concerns. Neither consumes the other's output, so
    // both receive the same bounded Scout pack as their repository evidence.
    if (hasScout || hasArchitect) {
      if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
      const grounding = await buildScoutGrounding(cwd, task);
      const repoContext = grounding
        ? `## Repository context (read-only Scout pack)\n${grounding}`
        : "## Repository context\nUnavailable for this run. Mark every repository claim as unverified.";
      if (hasScout && hasArchitect && preset.parallel) {
        const [scout, architect] = await Promise.all([
          runStage("Scout", 1, repoContext),
          runStage("Architect", 1, repoContext),
        ]);
        pushStage(scout, 1);
        pushStage(architect, 1);
      } else {
        if (hasScout) pushStage(await runStage("Scout", 1, repoContext), 1);
        if (hasArchitect) {
          if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
          pushStage(await runStage("Architect", 1, repoContext), 1);
        }
      }
    }

    // ---- c. Forger receives the plan + context map ----
    if (hasForger) {
      if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
      pushStage(await runStage("Forger"), 1);
    }

    // ---- Sentinel verdict + bounded repair ----
    if (hasSentinel) {
      if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
      let sentinel = await runStage("Sentinel");
      pushStage(sentinel, 1);
      let verdict = parseVerdict(sentinel.output);
      lastVerdict = verdict ?? undefined;

      if (verdict === "BLOCKED") {
        return await finalize("BLOCKED", "Sentinel reported BLOCKED; validation could not complete.");
      }

      // A missing marker counts as FAIL: the gate never passes by default.
      let repairCount = 0;
      while ((verdict === null || verdict === "FAIL") && hasForger && repairCount < preset.repairRounds) {
        if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
        repairCount += 1;
        const findings = boundContext(
          `# Repair directive\nSentinel returned FAIL. Address these findings:\n${sentinel.output.trim()}`,
        );
        pushStage(await runStage("Forger", repairCount + 1, findings), repairCount + 1);

        if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
        sentinel = await runStage("Sentinel", repairCount + 1);
        pushStage(sentinel, repairCount + 1);
        verdict = parseVerdict(sentinel.output);
        lastVerdict = verdict ?? undefined;
      }

      if (verdict === null || verdict === "FAIL") {
        const reason =
          verdict === null
            ? "verdict marker missing; run terminated with FAIL"
            : `Sentinel FAIL after ${repairCount} repair round(s); repair budget exhausted`;
        return await finalize("FAILED", reason);
      }
      if (verdict === "BLOCKED") {
        return await finalize("BLOCKED", "Sentinel reported BLOCKED; validation could not complete.");
      }
    }

    // ---- Scribe runs last, only on completion ----
    if (hasScribe) {
      if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
      pushStage(await runStage("Scribe"), 1);
    }

    return await finalize(
      "COMPLETE",
      lastVerdict === "PASS_WITH_LIMITATIONS"
        ? "Sentinel PASS WITH LIMITATIONS; limitations are listed in the HIVE Review."
        : "All criteria satisfied; Sentinel PASS.",
    );
  } catch (error) {
    return await finalize(
      "FAILED",
      error instanceof Error ? `run error: ${error.message}` : `run error: ${String(error)}`,
    );
  }
}
