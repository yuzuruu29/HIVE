"use client";

import { useEffect, useState, useRef } from "react";
import { Check, X, WarningCircle, CaretDown, CaretRight, Stop, SpinnerGap, DotsThree, Warning } from "@phosphor-icons/react";
import { HiveCoreMark } from "./chat-interface";

export type CouncilPhaseStatus = "pending" | "queued" | "active" | "streaming" | "completed" | "warning" | "failed" | "cancelled" | "not-run";

export interface CouncilPhaseDetail {
  id: string;
  role?: string;
  name: string;
  action: string;
  status: CouncilPhaseStatus;
  parallel?: boolean;
  duration?: string;
  providerModel?: string;
  activeDetails?: React.ReactNode;
  artifacts?: React.ReactNode;
  issues?: React.ReactNode[];
  attempts?: { status: string; providerModel: string; latencyMs?: number }[];
}

export interface CouncilExecutionPanelProps {
  overallState: string;
  completedCount: number;
  totalCount: number;
  elapsedTime?: string;
  routeSummary?: string;
  isBusy: boolean;
  phases: CouncilPhaseDetail[];
  onCancel?: () => void;
  compact?: boolean;
}

function PhaseIcon({ status }: { status: CouncilPhaseStatus }) {
  switch (status) {
    case "completed":
      return <Check size={14} weight="bold" />;
    case "active":
    case "streaming":
      return (
        <div className="ai-pulse-ring" aria-hidden="true" style={{ width: 14, height: 14 }}>
          <div className="ai-pulse-ring-core" />
          <div className="ai-pulse-ring-orbit" />
        </div>
      );
    case "queued":
      return (
        <div className="ai-bouncing-dots" aria-hidden="true">
          <span className="ai-bouncing-dot" />
          <span className="ai-bouncing-dot" />
          <span className="ai-bouncing-dot" />
        </div>
      );
    case "warning":
      return <Warning size={14} weight="bold" />;
    case "failed":
    case "cancelled":
      return <X size={14} weight="bold" />;
    case "not-run":
    case "pending":
    default:
      return null;
  }
}

export function CouncilExecutionPanel({
  overallState,
  completedCount,
  totalCount,
  elapsedTime,
  routeSummary,
  isBusy,
  phases,
  onCancel,
  compact = false,
}: CouncilExecutionPanelProps) {
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());

  // Auto-expand active, warning, and failed phases
  useEffect(() => {
    const next = new Set(expandedPhases);
    let changed = false;
    phases.forEach((phase) => {
      if (
        (phase.status === "active" || phase.status === "streaming" || phase.status === "warning" || phase.status === "failed") &&
        !next.has(phase.id)
      ) {
        next.add(phase.id);
        changed = true;
      }
    });
    if (changed) setExpandedPhases(next);
  }, [phases, expandedPhases]);

  function toggleExpand(id: string) {
    const next = new Set(expandedPhases);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedPhases(next);
  }

  // Calculate timeline progress height
  const activeIndex = phases.findIndex(p => p.status === "active" || p.status === "streaming");
  const lastCompletedIndex = [...phases].reverse().findIndex(p => p.status === "completed" || p.status === "warning" || p.status === "failed");
  const trueLastCompletedIndex = lastCompletedIndex >= 0 ? phases.length - 1 - lastCompletedIndex : -1;
  const progressIndex = activeIndex >= 0 ? activeIndex : trueLastCompletedIndex;
  
  return (
    <section className={`council-execution-panel ${compact ? "compact-panel" : ""}`} aria-live="polite">
      <div className="council-execution-header">
        <div className="header-title-row">
          <div className="header-status">
            <span className="header-mark-wrap">
              {isBusy ? <SpinnerGap size={16} className="phase-icon-spin" /> : <HiveCoreMark compact />}
            </span>
            <h3>{overallState}</h3>
          </div>
          <div className="header-meta">
            {elapsedTime && <span className="elapsed-time">{elapsedTime}</span>}
            {isBusy && onCancel && (
              <button className="button button-danger cancel-button" type="button" onClick={onCancel}>
                <Stop size={14} weight="fill" /> Cancel
              </button>
            )}
          </div>
        </div>
        <p className="header-subtitle">
          {routeSummary || `${completedCount} of ${totalCount} phases complete`}
        </p>
      </div>

      <div className="council-timeline">
        <div 
          className="timeline-track"
          style={{ '--progress-count': Math.max(0, progressIndex + 0.5), '--total-count': Math.max(1, phases.length) } as React.CSSProperties}
        >
          <div className="timeline-progress" />
        </div>
        
        <div className="timeline-phases">
          {phases.map((phase, index) => {
            const isExpanded = expandedPhases.has(phase.id);
            return (
              <div 
                key={phase.id} 
                className={`timeline-phase phase-${phase.status}`} 
                data-status={phase.status}
                data-expanded={isExpanded}
                style={{ '--phase-index': index } as React.CSSProperties}
              >
                <button 
                  className="phase-header" 
                  onClick={() => toggleExpand(phase.id)}
                  aria-expanded={isExpanded}
                  disabled={phase.status === "pending" || phase.status === "not-run"}
                >
                  <div className="phase-icon-container">
                    <PhaseIcon status={phase.status} />
                  </div>
                  <div className="phase-info">
                    <div className="phase-role-action">
                      {phase.role && <strong className="phase-role">{phase.role}</strong>}
                      <span className={`phase-action ${(phase.status === "active" || phase.status === "streaming") ? "ai-shimmer-text" : ""}`}>
                        {phase.action || phase.name}
                      </span>
                    </div>
                    <div className="phase-meta">
                      {phase.parallel && <span className="phase-lane">parallel check</span>}
                      {phase.providerModel && <span className="phase-provider">{phase.providerModel}</span>}
                      {phase.duration && <span className="phase-duration">{phase.duration}</span>}
                      {(phase.status !== "pending" && phase.status !== "not-run") && (
                        <span className="phase-expand-icon">
                          {isExpanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                <div className="phase-body-wrapper" aria-hidden={!isExpanded}>
                  <div className="phase-body">
                    {phase.status === "streaming" && (
                      <div className="phase-streaming-indicator">
                        {phase.activeDetails || "Routing now..."}
                      </div>
                    )}

                    {(phase.status !== "streaming" && phase.activeDetails) && (
                      <div className="phase-active-details">
                        {phase.activeDetails}
                      </div>
                    )}

                    {phase.artifacts && (
                      <div className="phase-artifacts-preview">
                        {phase.artifacts}
                      </div>
                    )}

                    {phase.issues && phase.issues.length > 0 && (
                      <div className="phase-issues">
                        {phase.issues.map((issue, i) => (
                          <div key={i} className="phase-issue-item">
                            <WarningCircle size={14} />
                            <span>{issue}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {phase.attempts && phase.attempts.length > 0 && (
                      <div className="phase-attempts">
                        {phase.attempts.map((attempt, i) => (
                          <div key={i} className="phase-attempt-item" data-status={attempt.status}>
                            <span className="attempt-tree-line">├─</span>
                            <span className="attempt-label">Attempt {i + 1}</span>
                            <span className="attempt-status">· {attempt.status === 'failed' ? 'failed validation' : attempt.status}</span>
                            <span className="attempt-provider">({attempt.providerModel})</span>
                            {attempt.latencyMs && <span className="attempt-latency">{attempt.latencyMs}ms</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
