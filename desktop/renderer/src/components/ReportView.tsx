import type { CodingFinalReport } from "../../../../src/coding/types";
import { formatTime } from "../utils";
import { EmptyState } from "./EmptyState";

export interface ReportViewProps {
  report: CodingFinalReport | null;
  hasRun: boolean;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <EmptyState>None recorded.</EmptyState>
      )}
    </section>
  );
}

export function ReportView({ report, hasRun }: ReportViewProps) {
  if (!hasRun) {
    return (
      <EmptyState>
        <strong>No run report yet.</strong>
        <span>Reports appear after a coding turn reaches a terminal state.</span>
      </EmptyState>
    );
  }
  if (!report) {
    return (
      <EmptyState>
        <strong>Report unavailable.</strong>
        <span>The selected session has not produced a final report.</span>
      </EmptyState>
    );
  }

  return (
    <article className="report-view">
      <header>
        <span className="eyebrow">Verified session report</span>
        <h2>{report.result}</h2>
        <time dateTime={report.completedAt}>{formatTime(report.completedAt)}</time>
      </header>
      <div className="report-metrics">
        <Metric label="Files" value={report.filesChanged.length} />
        <Metric label="Passed" value={report.validation.filter((item) => item.status === "passed").length} />
        <Metric label="Agents" value={report.subagents.total} />
      </div>
      <ReportList title="Validation" items={report.validation.map((item) => `${item.label}: ${item.status}`)} />
      <ReportList title="Review" items={report.review} />
      <ReportList title="Outstanding" items={report.outstanding} />
    </article>
  );
}
