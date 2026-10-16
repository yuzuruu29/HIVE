import { useMemo } from "react";
import type { DesktopChatSummary, ThreadRecordV1 } from "../../../../../src/desktop/types";

export interface UsageSurfaceProps {
  threads?: ThreadRecordV1[];
  conversations?: DesktopChatSummary[];
  /** Fixed clock for tests. */
  now?: number;
}

const DAY_MS = 86_400_000;
const CHART_DAYS = 14;

function dayKey(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Counts only what the desktop actually records; token and cost totals are not persisted yet. */
export function UsageSurface({ threads = [], conversations = [], now = Date.now() }: UsageSurfaceProps) {
  const stats = useMemo(() => {
    const liveChats = conversations.filter((conversation) => !conversation.archived);
    const messages = liveChats.reduce((sum, conversation) => sum + conversation.messageCount, 0);
    const runs = threads.flatMap((thread) => thread.runs);
    const completed = runs.filter((run) => run.status === "completed").length;

    const stamps = [
      ...liveChats.map((conversation) => Date.parse(conversation.updatedAt)),
      ...runs.map((run) => Date.parse(run.createdAt)),
    ].filter((time) => Number.isFinite(time));
    const monthAgo = now - 30 * DAY_MS;
    const activeDays = new Set(stamps.filter((time) => time >= monthAgo && time <= now).map(dayKey)).size;

    const perDay = Array.from({ length: CHART_DAYS }, (_, index) => {
      const time = now - (CHART_DAYS - 1 - index) * DAY_MS;
      const key = dayKey(time);
      return { key, label: new Date(time).toLocaleDateString([], { weekday: "narrow" }), count: stamps.filter((stamp) => dayKey(stamp) === key).length };
    });

    return {
      chats: liveChats.length,
      messages,
      tasks: threads.filter((thread) => !thread.archived).length,
      runs: runs.length,
      completionRate: runs.length > 0 ? Math.round((completed / runs.length) * 100) : null,
      activeDays,
      perDay,
      peak: Math.max(1, ...perDay.map((day) => day.count)),
    };
  }, [threads, conversations, now]);

  return (
    <div className="hive-usage" data-testid="usage-surface">
      <div className="hive-usage-inner">
        <header className="hive-usage-header">
          <h2 className="hive-usage-title">Usage</h2>
          <p className="hive-usage-subtitle">Counted from the chats and Hive Code sessions stored on this PC.</p>
        </header>

        <div className="hive-kpi-grid">
          <div className="hive-kpi-card is-lead">
            <div className="hive-kpi-label">Active days</div>
            <div className="hive-kpi-val">{stats.activeDays} / 30</div>
            <div className="hive-usage-chart" role="img" aria-label={`Activity over the last ${CHART_DAYS} days`}>
              {stats.perDay.map((day) => (
                <span key={day.key} className="hive-usage-bar" title={`${day.key}: ${day.count}`}>
                  <span className="hive-usage-bar-fill" style={{ height: `${Math.max(day.count ? 10 : 3, (day.count / stats.peak) * 100)}%` }} data-empty={day.count === 0 || undefined} />
                  <span className="hive-usage-bar-label">{day.label}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="hive-kpi-card">
            <div className="hive-kpi-label">Chats</div>
            <div className="hive-kpi-val">{stats.chats}</div>
            <div className="hive-kpi-sub">{stats.messages.toLocaleString()} messages</div>
          </div>
          <div className="hive-kpi-card">
            <div className="hive-kpi-label">Code runs</div>
            <div className="hive-kpi-val">{stats.runs}</div>
            <div className="hive-kpi-sub">{stats.completionRate === null ? "No completed runs" : `${stats.completionRate}% completed · ${stats.tasks} tasks`}</div>
          </div>
          <div className="hive-kpi-card is-wide">
            <div className="hive-kpi-label">Tokens</div>
            <div className="hive-kpi-val is-muted">Unavailable</div>
            <div className="hive-kpi-sub">Model-level usage is not persisted</div>
          </div>
        </div>

        <p className="hive-truthful-notice">
          Token and cost totals stay blank until HIVE records them per run. Nothing here is estimated.
        </p>
      </div>
    </div>
  );
}
