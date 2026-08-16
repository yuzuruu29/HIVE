import type { CodingFinalReport, RuntimeEvent } from "../../../../src/coding/types";
import { formatTime } from "../utils";
import { EmptyState } from "./EmptyState";

export interface ValidationSummaryProps {
  events: RuntimeEvent[];
  report: CodingFinalReport | null;
}

export function ValidationSummary({ events, report }: ValidationSummaryProps) {
  const validation = [...events].reverse().find((event) => event.type === "validation.completed");
  if (report) {
    return (
      <span>
        {report.validation.filter((item) => item.status === "passed").length} passed / {report.validation.length} recorded
      </span>
    );
  }
  if (!validation) return <EmptyState>No validation results.</EmptyState>;
  return <span>Validation event received at {formatTime(validation.timestamp)}.</span>;
}
