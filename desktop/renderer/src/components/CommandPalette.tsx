import { useEffect, useId, useRef, useState } from "react";

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
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFilter("");
    setSelectedIndex(0);
    inputRef.current?.focus();
    return () => previous?.focus();
  }, [open]);

  const filtered = commands.filter((cmd) => {
    const query = filter.toLowerCase().trim();
    if (!query) return true;
    return cmd.label.toLowerCase().includes(query) || cmd.hint?.toLowerCase().includes(query);
  });

  const activeIndex = Math.min(selectedIndex, filtered.length - 1);
  useEffect(() => {
    if (open && activeIndex >= 0) {
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeIndex, listId, open]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (event.target !== inputRef.current) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length) {
        setSelectedIndex((activeIndex + 1) % filtered.length);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length) {
        setSelectedIndex((activeIndex - 1 + filtered.length) % filtered.length);
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!filtered.length) return;
      event.preventDefault();
      setSelectedIndex(event.key === "Home" ? 0 : filtered.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = filtered[activeIndex];
      if (selected) {
        selected.run();
        onClose();
      }
      return;
    }
  };

  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        className="modal palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setSelectedIndex(0); }}
          placeholder="Type a command or search recent repositories…"
          aria-label="Search commands"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        />

        <ul id={listId} className="palette-list" role="listbox" aria-label="Commands">
          {filtered.length ? (
            filtered.map((cmd, idx) => (
              <li key={cmd.id} role="presentation">
                <button
                  id={`${listId}-${idx}`}
                  type="button"
                  role="option"
                  aria-selected={idx === activeIndex}
                  tabIndex={-1}
                  className={`palette-item ${idx === activeIndex ? "active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
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
            <li className="palette-item" role="presentation">
              <span>No matching commands</span>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
