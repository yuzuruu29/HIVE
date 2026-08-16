import type { KeyboardEvent } from "react";
import type { DesktopMode } from "../state";

export interface ModeSwitchProps {
  mode: DesktopMode;
  onModeChange: (mode: DesktopMode) => void;
}

const CELLS: { id: DesktopMode; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Ctrl+Shift+1" },
  { id: "coder", label: "Coder", hint: "Ctrl+Shift+2" },
];

/** Topbar segmented control switching the Chat / Coder surfaces. */
export function ModeSwitch({ mode, onModeChange }: ModeSwitchProps) {
  const move = (event: KeyboardEvent<HTMLDivElement>, direction: 1 | -1 | "first" | "last"): void => {
    const index = CELLS.findIndex((cell) => cell.id === mode);
    const next = direction === "first" ? 0 : direction === "last" ? CELLS.length - 1 : Math.min(CELLS.length - 1, Math.max(0, index + direction));
    if (next === index) return;
    event.preventDefault();
    onModeChange(CELLS[next].id);
  };

  return (
    <div
      className="mode-switch"
      role="tablist"
      aria-label="Workspace mode"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") move(event, 1);
        else if (event.key === "ArrowLeft") move(event, -1);
        else if (event.key === "Home") move(event, "first");
        else if (event.key === "End") move(event, "last");
      }}
    >
      {CELLS.map((cell) => (
        <button
          key={cell.id}
          type="button"
          role="tab"
          title={`${cell.label} [${cell.hint}]`}
          aria-selected={mode === cell.id}
          aria-current={mode === cell.id ? "true" : undefined}
          tabIndex={mode === cell.id ? 0 : -1}
          className={`mode-cell${mode === cell.id ? " active" : ""}`}
          onClick={() => onModeChange(cell.id)}
        >
          {cell.label}
        </button>
      ))}
    </div>
  );
}
