"use client";

import { type ProcessingAnimation } from "./chat-interface";
import { type HiveProcessingStatus } from "./hive-thinking-block";

export interface AIProcessingIndicatorProps {
  animations?: ProcessingAnimation[];
  label: string;
  stage?: HiveProcessingStatus;
  progress?: number;
  compact?: boolean;
  className?: string;
  announce?: boolean;
}

export function AIProcessingIndicator({
  animations = ["shimmer"],
  label,
  stage,
  progress,
  compact = false,
  className = "",
  announce = true,
}: AIProcessingIndicatorProps) {
  const hasShimmer = animations.includes("shimmer");
  const hasDots = animations.includes("dots");
  const hasLine = animations.includes("line");
  const hasRing = animations.includes("ring");

  return (
    <div
      className={`ai-processing ${compact ? "ai-processing--compact" : ""} ${className}`}
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-atomic={announce ? "true" : undefined}
    >
      <div className="ai-processing-main">
        {hasRing && (
          <div className="ai-pulse-ring" aria-hidden="true">
            <div className="ai-pulse-ring-core" />
            <div className="ai-pulse-ring-orbit" />
          </div>
        )}
        
        <div className={`ai-processing-label ${hasShimmer ? "ai-shimmer-text" : ""}`}>
          {label}
        </div>

        {hasDots && (
          <div className="ai-bouncing-dots" aria-hidden="true">
            <span className="ai-bouncing-dot" />
            <span className="ai-bouncing-dot" />
            <span className="ai-bouncing-dot" />
          </div>
        )}
      </div>

      {hasLine && (
        <div 
          className="ai-loading-track"
          role={progress !== undefined ? "progressbar" : "status"}
          aria-valuenow={progress !== undefined ? Math.min(100, Math.max(0, progress)) : undefined}
          aria-valuemin={progress !== undefined ? 0 : undefined}
          aria-valuemax={progress !== undefined ? 100 : undefined}
        >
          {progress !== undefined ? (
            <div 
              className="ai-loading-fill" 
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} 
            />
          ) : (
            <div className="ai-loading-segment" />
          )}
        </div>
      )}
    </div>
  );
}
