"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { BracketsCurly, Check, FileCode, Stop, UploadSimple, X } from "@phosphor-icons/react";
import { buildPhaseNames, type BuildPhaseName } from "@hive-cloud/contracts";
import { HiveCoreMark } from "./chat-interface";
import { CouncilExecutionPanel, type CouncilPhaseDetail, type CouncilPhaseStatus } from "./council-execution-panel";

interface SourceFile { path: string; content: string; language?: string; }
interface PhaseResult { name: BuildPhaseName; status: "complete"; summary: string; receipt?: { provider: string; model: string; fallbackCount: number; attempts?: { status: string; provider: string; model: string; latencyMs?: number }[] } }
interface Artifact { kind: string; title: string; content: string; execution_status: string; }
interface BuildResult { status: string; phases: PhaseResult[]; artifacts: Artifact[]; }
interface BuildState {
  id?: string;
  status: "idle" | "queued" | "waiting" | "active" | "completed" | "failed" | "cancelled" | "cancelling";
  progress?: { active?: BuildPhaseName | BuildPhaseName[] | null; completed?: number; total?: number; phases?: PhaseResult[] };
  result?: BuildResult;
  failedReason?: string;
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", rs: "rust", go: "go", java: "java", cs: "csharp", css: "css", html: "html", md: "markdown", json: "json", toml: "toml", yml: "yaml", yaml: "yaml", sql: "sql",
};

const COUNCIL_ROLE_SUMMARY: Record<BuildPhaseName, string> = {
  queen: "Routes the objective",
  scout: "Maps the repository",
  planner: "Defines the change",
  builder: "Proposes the patch",
  validator: "Checks static evidence",
  reviewer: "Reviews risk independently",
  synthesizer: "Returns one final result",
};

function language(path: string): string | undefined {
  return EXTENSION_LANGUAGE[path.split(".").pop()?.toLowerCase() || ""];
}

function stateForPhase(name: BuildPhaseName, build: BuildState): "queued" | "active" | "complete" | "failed" | "cancelled" {
  const activePhases = Array.isArray(build.progress?.active) ? build.progress.active : build.progress?.active ? [build.progress.active] : [];
  if (build.status === "cancelled") return "cancelled";
  if (build.status === "failed" && activePhases.includes(name)) return "failed";
  if (build.result?.phases.some((phase) => phase.name === name) || build.progress?.phases?.some((phase) => phase.name === name)) return "complete";
  if (activePhases.includes(name)) return "active";
  return "queued";
}

export function BuildSurface({ initialObjective = "" }: { initialObjective?: string }) {
  const [objective, setObjective] = useState(initialObjective);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [build, setBuild] = useState<BuildState>({ status: "idle" });
  const [error, setError] = useState<string>();
  const [activeArtifact, setActiveArtifact] = useState(0);
  const totalBytes = useMemo(() => files.reduce((total, file) => total + new TextEncoder().encode(file.content).byteLength, 0), [files]);

  useEffect(() => {
    if (!build.id || !["queued", "waiting", "active", "cancelling"].includes(build.status)) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/cloud/builds/${build.id}`, { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const { data } = await response.json() as { data: { id: string; status: BuildState["status"]; progress?: BuildState["progress"] | number; result?: BuildResult; failed_reason?: string } };
      setBuild({ id: data.id, status: data.status, progress: typeof data.progress === "object" ? data.progress : undefined, result: data.result, failedReason: data.failed_reason });
      if (["completed", "failed", "cancelled"].includes(data.status)) window.clearInterval(timer);
    }, 1_400);
    return () => window.clearInterval(timer);
  }, [build.id, build.status]);

  async function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.target.files || [])].slice(0, 50);
    setError(undefined);
    try {
      if (selected.some((file) => /\.(zip|rar|7z|exe|dll|bin|dmg|apk)$/i.test(file.name))) throw new Error("Archives and executable files are not accepted in cloud Build mode.");
      const next = await Promise.all(selected.map(async (file) => ({ path: file.webkitRelativePath || file.name, content: await file.text(), language: language(file.name) })));
      const size = next.reduce((total, file) => total + new TextEncoder().encode(file.content).byteLength, 0);
      if (size > 20 * 1024 * 1024) throw new Error("Build context must not exceed 20MB.");
      setFiles(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read the selected files.");
    } finally {
      event.target.value = "";
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setActiveArtifact(0);
    const response = await fetch("/api/cloud/builds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective, files }),
    }).catch(() => null);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => null) as { error?: { message?: string } } | null : null;
      setError(payload?.error?.message || "The Build Council could not be queued.");
      return;
    }
    const { data } = await response.json() as { data: { id: string; status: BuildState["status"] } };
    setBuild({ id: data.id, status: data.status });
  }

  async function cancel() {
    if (!build.id) return;
    const response = await fetch(`/api/cloud/builds/${build.id}`, { method: "DELETE" });
    if (response.ok) setBuild((current) => ({ ...current, status: "cancelling" }));
  }

  const artifacts = build.result?.artifacts || [];
  const selectedArtifact = artifacts[activeArtifact];
  const councilBusy = ["queued", "waiting", "active", "cancelling"].includes(build.status);
  const councilLabel = build.status === "idle" ? "Council ready" : build.status === "completed" ? "Queen synthesis ready" : build.status === "failed" ? "Council failed" : build.status === "cancelled" ? "Run cancelled" : build.status === "cancelling" ? "Cancelling" : "Council active";

  const completedPhases = build.result?.phases || build.progress?.phases || [];
  const routedModels = new Set(completedPhases.flatMap((phase) => phase.receipt ? [`${phase.receipt.provider}/${phase.receipt.model}`] : []));
  const fallbackCount = completedPhases.reduce((total, phase) => total + (phase.receipt?.fallbackCount || 0), 0);
  const routeSummary = completedPhases.length > 0
    ? `${routedModels.size} routed model${routedModels.size === 1 ? "" : "s"} · ${fallbackCount} fallback${fallbackCount === 1 ? "" : "s"} · independent validation`
    : "Queen routes each specialist after the run starts";

  const mappedPhases: CouncilPhaseDetail[] = buildPhaseNames.map((phase) => {
    const state = stateForPhase(phase, build);
    const result = build.result?.phases.find((item) => item.name === phase) || build.progress?.phases?.find((item) => item.name === phase);
    let mappedStatus: CouncilPhaseStatus = "pending";
    if (state === "queued") mappedStatus = "queued";
    if (state === "active") mappedStatus = "active";
    if (state === "complete") mappedStatus = "completed";
    if (state === "failed") mappedStatus = "failed";
    if (state === "cancelled") mappedStatus = "cancelled";

    return {
      id: phase,
      role: phase === "synthesizer" ? "queen" : phase,
      name: phase,
      action: COUNCIL_ROLE_SUMMARY[phase],
      status: mappedStatus,
      parallel: phase === "validator" || phase === "reviewer",
      providerModel: result?.receipt ? `${result.receipt.provider} / ${result.receipt.model}` : undefined,
      activeDetails: state === "active" ? "Routing now..." : undefined,
      issues: build.failedReason && state === "failed" ? [build.failedReason] : undefined,
      attempts: result?.receipt?.attempts?.map((attempt) => ({ status: attempt.status, providerModel: `${attempt.provider} / ${attempt.model}`, latencyMs: attempt.latencyMs })),
    };
  });

  const councilPanel = <CouncilExecutionPanel
    overallState={councilLabel}
    completedCount={build.progress?.completed ?? 0}
    totalCount={build.progress?.total ?? buildPhaseNames.length}
    routeSummary={routeSummary}
    isBusy={councilBusy}
    phases={mappedPhases}
    onCancel={() => void cancel()}
  />;

  return (
    <div className="workspace-page build-workspace" data-state={build.status}>
      {error && <div className="error-banner" role="alert" style={{ marginBottom: 18 }}>{error}</div>}
      {build.status === "idle" ? <section className="build-welcome" aria-labelledby="build-welcome-title">
        <div className="build-welcome-copy"><HiveCoreMark /><span className="hive-eyebrow">Default orchestration</span><h2 id="build-welcome-title">One brief in. One verified result out.</h2><p>The Queen coordinates specialist routes, runs two independent checks in parallel, and reconciles the final delivery.</p></div>
        <form className="build-launch-panel" onSubmit={(event) => void submit(event)}>
          <div className="field"><label htmlFor="build-objective">What outcome should the Council deliver?</label><textarea className="textarea" id="build-objective" required minLength={10} maxLength={20000} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Describe the bounded engineering outcome and its acceptance criteria." /></div>
          <label className="file-drop">
            <input type="file" multiple onChange={(event) => void chooseFiles(event)} />
            <span><UploadSimple size={23} aria-hidden="true" /><strong>{files.length ? `${files.length} project file${files.length === 1 ? "" : "s"} ready` : "Add project files"}</strong><small>Up to 50 text or code files, 20MB total</small></span>
          </label>
          {files.length > 0 && <div className="build-file-row"><span>{(totalBytes / 1024).toFixed(1)}KB context</span><div>{files.slice(0, 5).map((file) => <span className="attachment-chip" key={file.path}><FileCode size={12} /> {file.path}</span>)}{files.length > 5 && <span className="attachment-chip">+{files.length - 5} more</span>}</div></div>}
          <div className="build-launch-footer"><span className="router-pill">7 routed calls · 2 checks in parallel</span><button className="button button-primary" type="submit" disabled={objective.trim().length < 10}><BracketsCurly size={17} /> Start Council</button></div>
        </form>
        <div className="council-role-grid" aria-label="Queen Council roles">{buildPhaseNames.map((phase, index) => <div className="council-role" data-parallel={phase === "validator" || phase === "reviewer"} key={phase}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{phase === "synthesizer" ? "Queen synthesis" : phase}</strong><small>{COUNCIL_ROLE_SUMMARY[phase]}</small></div></div>)}</div>
        <p className="build-credit-note">Managed completions use invite credits. BYOK completions do not.</p>
      </section> : <>
        <div className="page-heading"><div><span className="hive-eyebrow">Queen Council</span><h2>{councilLabel}</h2><p>{objective}</p></div><div className="build-status-actions"><span className="router-pill council-status" data-state={build.status}><i aria-hidden="true" /> {build.progress?.completed ?? 0} / {build.progress?.total ?? buildPhaseNames.length}</span>{councilBusy && <button className="button button-danger" type="button" onClick={() => void cancel()}><Stop size={16} weight="fill" /> Cancel</button>}</div></div>
        <div className="build-grid build-progress-grid">
          <section className="panel build-context-panel"><h3>Run context</h3><p>{files.length} files, {(totalBytes / 1024).toFixed(1)}KB</p><div className="build-context-files">{files.slice(0, 8).map((file) => <span key={file.path}><FileCode size={13} />{file.path}</span>)}</div><div className="notice">HIVE proposes changes and performs static checks. Runtime execution remains explicitly not run.</div></section>
          <div className="build-result-stack">{councilPanel}<section className="panel council-output"><h3>Council output</h3>{artifacts.length === 0 ? <p className="receipt-empty">The Queen synthesis and supporting artifacts appear after the Council completes. Runtime checks remain marked as not run.</p> : <><div className="artifact-tabs">{artifacts.map((artifact, index) => <button className={`button ${index === activeArtifact ? "button-primary" : "button-secondary"}`} type="button" onClick={() => setActiveArtifact(index)} key={artifact.kind}>{artifact.title}</button>)}</div><pre className="artifact-content">{selectedArtifact?.content}</pre><div className="not-run">Execution status: {selectedArtifact?.execution_status.replace("_", " ")}</div></>}</section></div>
        </div>
      </>}
    </div>
  );
}
