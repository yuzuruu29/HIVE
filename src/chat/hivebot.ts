import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { ChatReceipt } from "./types.js";
import { createChatEngine, type ChatEngine, type ChatEngineRole } from "./engine.js";
import type { ChatOptions } from "./chat-cli.js";
import { locateSkillRoot } from "./skill-locate.js";
import {
  COUNCIL_PRESETS,
  loadAgentPrompt,
  loadProtocolDigest,
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

export interface HivebotOptions extends ChatOptions {
  /** Force a preset; otherwise the Queen classifies and selects one. */
  preset?: HivebotPresetName;
  providerId?: string;
  model?: string;
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

export interface HivebotRunSummary {
  status: HivebotStatus;
  reason: string;
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
const AGENT_LABEL: Record<string, string> = {
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

/** Bounded summary length of prior stages included in any stage prompt. */
const MAX_HANDOFF_CONTEXT_CHARS = 4_000;

/** Parses a `PRESET: <name>` marker emitted by the Queen. */
function parsePreset(text: string): HivebotPresetName | null {
  const m = text.match(/PRESET\s*:\s*(quick|standard|deep|audit)/i);
  if (!m) return null;
  return m[1].toLowerCase() as HivebotPresetName;
}

type Verdict = "PASS" | "FAIL" | "BLOCKED";

/** Extracts the first line matching `VERDICT: PASS|FAIL|BLOCKED`. */
function parseVerdict(text: string): Verdict | null {
  for (const line of text.split("\n")) {
    const m = line.match(/VERDICT\s*:\s*(PASS|FAIL|BLOCKED)/i);
    if (m) return m[1].toUpperCase() as Verdict;
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
  extraContext?: string,
): string {
  const parts: string[] = [
    `[HIVE] role: ${agent}`,
    `Phase: ${AGENT_LABEL[agent] ?? agent}`,
    "",
    `Task: ${task}`,
  ];
  if (extraContext) parts.push("\n" + extraContext);
  const summary = summarizeStages(stages);
  if (summary) parts.push("\n## Prior handoffs\n" + summary);
  return parts.join("\n");
}

/** Joins prior stage outputs, bounded to `MAX_HANDOFF_CONTEXT_CHARS` total. */
function summarizeStages(stages: readonly StageResult[]): string {
  const out: string[] = [];
  let remaining = MAX_HANDOFF_CONTEXT_CHARS;
  for (const s of stages) {
    const block = `## ${s.agent}\n${s.output.trim()}`;
    if (block.length >= remaining) {
      if (remaining > 0) out.push(block.slice(0, remaining));
      break;
    }
    out.push(block);
    remaining -= block.length;
  }
  return out.join("\n\n");
}

/** Truncates a raw string to `MAX_HANDOFF_CONTEXT_CHARS` so a stage prompt never
 * carries an unbounded transcript (e.g. Sentinel findings on a repair round). */
function boundContext(text: string): string {
  return text.length > MAX_HANDOFF_CONTEXT_CHARS
    ? text.slice(0, MAX_HANDOFF_CONTEXT_CHARS)
    : text;
}

/** Appends the shared protocol digest to the agent's own persona prompt. */
async function buildSystemPrompt(
  skillRoot: string | null,
  agent: string,
  preset: HivebotPreset,
): Promise<string> {
  const persona = await loadAgentPrompt(skillRoot, agent, preset.maxOutputCharsPerStage);
  const digest = await loadProtocolDigest(skillRoot);
  return `${persona}\n\n# Protocol Digest\n${digest}`;
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

function buildReport(summary: HivebotRunSummary, task: string): string {
  const L: string[] = [];
  L.push(`# HIVE Run Report — ${summary.runId}`);
  L.push(`Status: ${summary.status}`);
  L.push(`Reason: ${summary.reason}`);
  L.push(`Preset: ${summary.preset}`);
  L.push(`Total tokens: ${summary.totalTokens}`);
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
      preset: options.preset ?? "standard",
      runId: makeRunId(),
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
  const runId = makeRunId();

  const streamLines: string[] = [];
  const emitStageStart = (agent: string, attempt: number): void => {
    const line = `──────── ${agent} · attempt ${attempt} ────────`;
    streamLines.push(line);
    if (process.stdout.isTTY) console.log(line);
  };
  const emitReceipt = (agent: string, receipt: ChatReceipt): void => {
    const line = `[${agent} → ${receipt.providerId}/${receipt.model} · ${receiptTokens(receipt)} tok]`;
    streamLines.push(line);
    if (process.stdout.isTTY) console.log(line);
  };

  const stages: StageResult[] = [];
  const records: StageRecord[] = [];
  let totalTokens = 0;

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
    ].join("\n");
    return {
      exitCode: status === "COMPLETE" ? 0 : 1,
      output,
      ...summary,
    };
  }

  try {
    // ---- a. Queen classifies and (unless forced) selects the preset ----
    const queenSystem = await buildSystemPrompt(skillRoot, "Queen", preset);
    const queen = await completeStage(
      "Queen",
      buildPrompt(task, stages, "Queen"),
      queenSystem,
      1,
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
    // the plan — independent concerns. Neither consumes the other's output;
    // each only needs the Queen's handoff.
    if (hasScout || hasArchitect) {
      if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
      if (hasScout && hasArchitect && preset.parallel) {
        const scoutSystem = await buildSystemPrompt(skillRoot, "Scout", preset);
        const archSystem = await buildSystemPrompt(skillRoot, "Architect", preset);
        const [scout, architect] = await Promise.all([
          completeStage("Scout", buildPrompt(task, stages, "Scout"), scoutSystem, 1),
          completeStage("Architect", buildPrompt(task, stages, "Architect"), archSystem, 1),
        ]);
        pushStage(scout, 1);
        pushStage(architect, 1);
      } else {
        if (hasScout) {
          if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
          pushStage(
            await completeStage(
              "Scout",
              buildPrompt(task, stages, "Scout"),
              await buildSystemPrompt(skillRoot, "Scout", preset),
              1,
            ),
            1,
          );
        }
        if (hasArchitect) {
          if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
          pushStage(
            await completeStage(
              "Architect",
              buildPrompt(task, stages, "Architect"),
              await buildSystemPrompt(skillRoot, "Architect", preset),
              1,
            ),
            1,
          );
        }
      }
    }

    // ---- c. Forger receives the plan + context map ----
    if (hasForger) {
      if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
      pushStage(
        await completeStage(
          "Forger",
          buildPrompt(task, stages, "Forger"),
          await buildSystemPrompt(skillRoot, "Forger", preset),
          1,
        ),
        1,
      );
    }

    // ---- Sentinel verdict + bounded repair ----
    if (hasSentinel) {
      if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
      let sentinel = await completeStage(
        "Sentinel",
        buildPrompt(task, stages, "Sentinel"),
        await buildSystemPrompt(skillRoot, "Sentinel", preset),
        1,
      );
      pushStage(sentinel, 1);

      let verdict = parseVerdict(sentinel.output);
      let verdictLabel: Verdict = verdict ?? "FAIL";

      if (verdictLabel === "BLOCKED") {
        return await finalize("BLOCKED", "Sentinel reported BLOCKED; validation could not complete.");
      }

      let repairCount = 0;
      while (verdictLabel === "FAIL" && hasForger && repairCount < preset.repairRounds) {
        if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
        repairCount += 1;
        const findings = boundContext(
          `# Repair directive\nSentinel returned FAIL. Address these findings:\n${sentinel.output.trim()}`,
        );
        const forgerRepair = await completeStage(
          "Forger",
          buildPrompt(task, stages, "Forger", findings),
          await buildSystemPrompt(skillRoot, "Forger", preset),
          repairCount + 1,
        );
        pushStage(forgerRepair, repairCount + 1);

        if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
        sentinel = await completeStage(
          "Sentinel",
          buildPrompt(task, stages, "Sentinel"),
          await buildSystemPrompt(skillRoot, "Sentinel", preset),
          repairCount + 1,
        );
        pushStage(sentinel, repairCount + 1);

        verdict = parseVerdict(sentinel.output);
        verdictLabel = verdict ?? "FAIL";
      }

      if (verdictLabel === "FAIL") {
        const reason =
          verdict === null
            ? "verdict marker missing; run terminated with FAIL"
            : `Sentinel FAIL after ${repairCount} repair round(s); repair budget exhausted`;
        return await finalize("FAILED", reason);
      }
      if (verdictLabel === "BLOCKED") {
        return await finalize("BLOCKED", "Sentinel reported BLOCKED; validation could not complete.");
      }
    }

    // ---- Scribe runs last, only on completion ----
    if (hasScribe) {
      if (budgetHit()) return await finalize("BUDGET_EXCEEDED", budgetReason());
      pushStage(
        await completeStage(
          "Scribe",
          buildPrompt(task, stages, "Scribe"),
          await buildSystemPrompt(skillRoot, "Scribe", preset),
          1,
        ),
        1,
      );
    }

    return await finalize("COMPLETE", "All criteria satisfied; Sentinel PASS.");
  } catch (error) {
    return await finalize(
      "FAILED",
      error instanceof Error ? `run error: ${error.message}` : `run error: ${String(error)}`,
    );
  }
}
