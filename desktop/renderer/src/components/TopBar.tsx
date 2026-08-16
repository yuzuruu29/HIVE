import { StatusPill } from "./StatusPill";

export interface TopBarProps {
  worker: string;
  modalOpen: boolean;
  activeRun?: boolean;
  onToggleLeftRail?: () => void;
  onToggleRightRail?: () => void;
  onOpenSettings?: () => void;
}

export function TopBar({
  worker,
  modalOpen,
  activeRun = false,
  onToggleLeftRail,
  onToggleRightRail,
  onOpenSettings,
}: TopBarProps) {
  const tone = worker === "failed" ? "error" : worker === "running" ? "success" : "neutral";

  return (
    <header className="topbar" role="banner" aria-hidden={modalOpen || undefined}>
      <div>
        <span className={`wordmark ${activeRun ? "anim-running" : ""}`} aria-label="HIVE">
          HIVE
        </span>
        <span className="tagline">Hyper Intelligence for Verified Engineering</span>
      </div>
      <div className="topbar-actions">
        {onToggleLeftRail && (
          <button
            type="button"
            className="topbar-btn secondary"
            aria-label="Toggle left rail"
            title="Toggle repository rail [/]"
            onClick={onToggleLeftRail}
          >
            [/]
          </button>
        )}
        {onToggleRightRail && (
          <button
            type="button"
            className="topbar-btn secondary"
            aria-label="Toggle right rail"
            title="Toggle inspector rail [\]"
            onClick={onToggleRightRail}
          >
            [\]
          </button>
        )}
        {onOpenSettings && (
          <button
            type="button"
            className="topbar-btn secondary"
            aria-label="Open settings"
            title="Preferences & Accessibility [*]"
            onClick={onOpenSettings}
          >
            [*]
          </button>
        )}
        <StatusPill tone={tone}>{worker}</StatusPill>
      </div>
    </header>
  );
}
