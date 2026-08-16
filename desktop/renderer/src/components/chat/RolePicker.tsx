import { useEffect, useRef, useState } from "react";
import type { DesktopEvent } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import { CHAT_ROLE_CARDS } from "../../../../../src/chat/roles";
import type { ChatRouteInfo } from "../../state";

export interface RolePickerProps {
  role: string;
  routes: Record<string, ChatRouteInfo>;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  onSelect: (role: string) => void;
}

const OPTIONS: { id: string; label: string }[] = [
  { id: "auto", label: "Auto" },
  ...CHAT_ROLE_CARDS.map((card) => ({ id: card.slug, label: card.label })),
];

/** Popover listing `auto` plus the six personas with their resolved routes. */
export function RolePicker({ role, routes, send, onSelect }: RolePickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Fill in any missing route chips for the picker rows.
    for (const option of OPTIONS) {
      if (!routes[option.id]) void send({ type: "chat.route", input: { role: option.id } });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const choose = (nextRole: string): void => {
    setOpen(false);
    if (nextRole !== role) onSelect(nextRole);
  };

  return (
    <div className="chip-popover" ref={rootRef}>
      <button
        type="button"
        className="composer-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Role: ${role}`}
        onClick={() => {
          setActiveIndex(Math.max(0, OPTIONS.findIndex((option) => option.id === role)));
          setOpen((value) => !value);
        }}
      >
        [role: {role} v]
      </button>
      {open && (
        <ul
          className="chip-menu"
          role="listbox"
          aria-label="Chat roles"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => Math.min(OPTIONS.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(OPTIONS[activeIndex].id);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        >
          {OPTIONS.map((option, index) => {
            const route = routes[option.id];
            return (
              <li key={option.id} role="option" aria-selected={option.id === role}>
                <button
                  type="button"
                  ref={index === activeIndex ? (element) => element?.focus() : undefined}
                  className={index === activeIndex ? "chip-option focused" : "chip-option"}
                  onClick={() => choose(option.id)}
                >
                  <span>{option.label}</span>
                  <span className="route-chip">{route ? `${route.providerId}/${route.model}` : "..."}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
