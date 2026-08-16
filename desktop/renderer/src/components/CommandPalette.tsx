import { useEffect, useRef, useState } from "react";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run(): void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  commands: PaletteCommand[];
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setFilter("");
      setSelectedIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const filtered = commands.filter((cmd) => {
    const query = filter.toLowerCase().trim();
    if (!query) return true;
    return cmd.label.toLowerCase().includes(query) || cmd.hint?.toLowerCase().includes(query);
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length) {
        setSelectedIndex((prev) => (prev + 1) % filtered.length);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length) {
        setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = filtered[selectedIndex];
      if (selected) {
        selected.run();
        onClose();
      }
      return;
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} onKeyDown={handleKeyDown}>
      <section
        className="modal palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command or search recent repositories…"
          aria-label="Search commands"
          autoFocus
        />

        <ul className="palette-list" role="listbox" aria-label="Commands">
          {filtered.length ? (
            filtered.map((cmd, idx) => (
              <li key={cmd.id} role="option" aria-selected={idx === selectedIndex}>
                <button
                  type="button"
                  className={`palette-item ${idx === selectedIndex ? "active" : ""}`}
                  onClick={() => {
                    cmd.run();
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <span>{cmd.label}</span>
                  {cmd.hint && <span className="hint">{cmd.hint}</span>}
                </button>
              </li>
            ))
          ) : (
            <li className="palette-item">
              <span>No matching commands</span>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
