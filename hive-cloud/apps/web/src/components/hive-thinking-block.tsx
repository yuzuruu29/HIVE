"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  CaretDown,
  CaretRight,
  Check,
  CrownSimple,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { AIProcessingIndicator } from "./ai-processing-indicator";
import { formatProcessingDuration, isActiveProcessingStatus, type HiveExecutionSummary, type HiveProcessingStatus, type HiveProcessingStep, type HiveProcessingStepStatus } from "../lib/processing-stages";
export { formatProcessingDuration, isActiveProcessingStatus, safeProcessingErrorLabel, SAFE_PROCESSING_ERROR_LABELS } from "../lib/processing-stages";
export type { HiveExecutionSummary, HiveProcessingStatus, HiveProcessingStep, HiveProcessingStepStatus } from "../lib/processing-stages";

export interface HiveThinkingBlockProps {
  status: HiveProcessingStatus;
  label: string;
  steps: HiveProcessingStep[];
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  defaultExpanded?: boolean;
  compact?: boolean;
  requestId?: string;
  routeSummary?: React.ReactNode;
  onOpenRoute?: () => void;
  onCancel?: () => void;
}


function StepIcon({ status }: { status: HiveProcessingStepStatus }) {
  if (status === "completed") return <Check size={13} weight="bold" />;
  if (status === "warning") return <WarningCircle size={13} weight="fill" />;
  if (status === "failed") return <X size={13} weight="bold" />;
  if (status === "cancelled") return <Stop size={12} weight="fill" />;
  if (status === "active") return <span className="hive-processing-active-dot" aria-hidden="true" />;
  return <span className="hive-processing-pending-dot" aria-hidden="true" />;
}

function terminalIcon(status: HiveProcessingStatus) {
  if (status === "completed") return <Check size={15} weight="bold" aria-hidden="true" />;
  if (status === "cancelled") return <Stop size={14} weight="fill" aria-hidden="true" />;
  return <WarningCircle size={15} weight="fill" aria-hidden="true" />;
}

function activeAnimations(status: HiveProcessingStatus) {
  if (status === "waiting-first-token" || status === "queued") return ["dots", "ring"] as const;
  if (status === "searching" || status === "reading-files" || status === "retrying") return ["shimmer", "line"] as const;
  return ["shimmer", "ring"] as const;
}

export function HiveThinkingBlock({
  status,
  label,
  steps,
  startedAt,
  completedAt,
  elapsedMs,
  defaultExpanded = false,
  compact = false,
  requestId,
  routeSummary,
  onOpenRoute,
  onCancel,
}: HiveThinkingBlockProps) {
  const bodyId = useId();
  const active = isActiveProcessingStatus(status);
  const terminalAttention = status === "failed";
  const [expanded, setExpanded] = useState(defaultExpanded || terminalAttention);
  const [now, setNow] = useState(() => Date.now());
  const userChoice = useRef(false);
  const previousStatus = useRef(status);
  const [reducedMotion, setReducedMotion] = useState(false);
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const completedAtMs = completedAt ? Date.parse(completedAt) : Number.NaN;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!active || !Number.isFinite(startedAtMs)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [active, startedAtMs]);

  useEffect(() => {
    if (previousStatus.current === status) return;
    previousStatus.current = status;
    if (userChoice.current) return;
    if (status === "failed") {
      setExpanded(true);
      return;
    }
    if (status === "completed" && !reducedMotion) {
      const timer = window.setTimeout(() => setExpanded(false), 900);
      return () => window.clearTimeout(timer);
    }
  }, [reducedMotion, status]);

  useEffect(() => {
    if (reducedMotion || !active || expanded || userChoice.current || defaultExpanded || !Number.isFinite(startedAtMs)) return;
    if (now - startedAtMs >= 1_800) setExpanded(true);
  }, [active, defaultExpanded, expanded, now, reducedMotion, startedAtMs]);

  const duration = elapsedMs ?? (Number.isFinite(startedAtMs)
    ? Math.max(0, (Number.isFinite(completedAtMs) ? completedAtMs : now) - startedAtMs)
    : undefined);
  const durationText = duration === undefined ? undefined : formatProcessingDuration(duration);
  const animations = activeAnimations(status);

  function toggleExpanded() {
    userChoice.current = true;
    setExpanded((current) => !current);
  }

  return (
    <section
      className={`hive-thinking-block${compact ? " hive-thinking-block--compact" : ""}`}
      data-status={status}
      data-expanded={expanded}
    >
      <div className="hive-thinking-header">
        <button
          className="hive-thinking-disclosure"
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={toggleExpanded}
        >
          <span className="hive-thinking-mark" aria-hidden="true"><CrownSimple size={13} weight="fill" /></span>
          <span className="hive-thinking-label">
            {active ? <AIProcessingIndicator animations={[...animations]} label={label} stage={status} compact announce={false} /> : <span>{terminalIcon(status)}<strong>{label}</strong></span>}
          </span>
          {durationText && <span className="hive-thinking-duration" aria-label={`Elapsed time ${durationText}`}>{durationText}</span>}
          <span className="hive-thinking-chevron" aria-hidden="true">{expanded ? <CaretDown size={15} /> : <CaretRight size={15} />}</span>
        </button>
        {active && onCancel && <button className="hive-thinking-cancel" type="button" onClick={onCancel}><Stop size={13} weight="fill" /><span>Stop</span></button>}
      </div>

      <div className="hive-thinking-body-wrap" id={bodyId} hidden={!expanded}>
        <div className="hive-thinking-body">
          <ol className="hive-processing-steps" aria-label="Execution summary">
            {steps.map((step) => (
              <li data-status={step.status} key={step.id}>
                <span className="hive-processing-step-icon" aria-hidden="true"><StepIcon status={step.status} /></span>
                <span className="hive-processing-step-copy">
                  <strong>{step.label}</strong>
                  {step.detail && <small>{step.detail}</small>}
                </span>
                {(step.provider || step.model || step.durationMs !== undefined) && <span className="hive-processing-step-meta">
                  {[step.provider, step.model].filter(Boolean).join(" · ")}
                  {step.durationMs !== undefined ? `${step.provider || step.model ? " · " : ""}${formatProcessingDuration(step.durationMs)}` : ""}
                </span>}
              </li>
            ))}
          </ol>
          {(routeSummary || requestId) && <div className="hive-thinking-route">
            <span><CrownSimple size={12} weight="fill" aria-hidden="true" />{routeSummary || "Route selected"}</span>
            {onOpenRoute && <button type="button" onClick={onOpenRoute}>Route details <CaretRight size={12} /></button>}
          </div>}
        </div>
      </div>

      <span className="sr-only" role={status === "failed" ? "alert" : "status"} aria-live={status === "failed" ? "assertive" : "polite"} aria-atomic="true">{label}</span>
    </section>
  );
}
