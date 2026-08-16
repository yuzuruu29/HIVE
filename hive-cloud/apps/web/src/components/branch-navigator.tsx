"use client";

import { CaretLeft, CaretRight } from "@phosphor-icons/react";

interface BranchNavigatorProps {
  current: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}

export function BranchNavigator({
  current,
  total,
  onPrevious,
  onNext,
}: BranchNavigatorProps) {
  return (
    <div className="branch-navigator" aria-label="Message version navigation">
      <button
        className="branch-nav-button"
        type="button"
        onClick={onPrevious}
        disabled={current <= 1}
        aria-label="Previous version"
      >
        <CaretLeft size={12} weight="bold" />
      </button>
      <span className="branch-nav-info" aria-hidden="true">
        {current} / {total}
      </span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">Version {current} of {total}</span>
      <button
        className="branch-nav-button"
        type="button"
        onClick={onNext}
        disabled={current >= total}
        aria-label="Next version"
      >
        <CaretRight size={12} weight="bold" />
      </button>
    </div>
  );
}
