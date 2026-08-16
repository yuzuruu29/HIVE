"use client";

import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShortcutDef {
  id: string;
  label: string;
  keys: string;
  metaKey?: boolean;
  shiftKey?: boolean;
  key: string;
  handler: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Registers a global keydown listener that fires the matching shortcut's
 * handler.  Single non-modifier keys (e.g. `/`, `?`) are ignored when focus
 * is inside an editable element so they don't interfere with typing.
 *
 * `enabled` can be flipped to temporarily suspend the listener (e.g. while a
 * modal is open).
 */
export function useShortcuts(actions: ShortcutDef[], enabled = true): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      const modalOpen = Boolean(document.querySelector('[aria-modal="true"]'));

      for (const action of actionsRef.current) {
        const pressedMeta = event.metaKey || event.ctrlKey;
        const needsMeta = !!action.metaKey;
        const needsShift = !!action.shiftKey;

        // Skip plain (non-modifier) keys when in an input/textarea so typing
        // is never interrupted.
        if ((inEditable || modalOpen) && !needsMeta) continue;

        if (
          pressedMeta === needsMeta &&
          event.shiftKey === needsShift &&
          event.key.toLowerCase() === action.key.toLowerCase()
        ) {
          event.preventDefault();
          event.stopPropagation();
          action.handler();
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [enabled]);
}

// ---------------------------------------------------------------------------
// Help-dialog data
// ---------------------------------------------------------------------------

export const SHORTCUT_HELP_ITEMS: Array<{
  id: string;
  label: string;
  keys: string;
}> = [
  { id: "new-chat", label: "New chat", keys: "⌘+Shift+O" },
  { id: "toggle-palette", label: "Command palette", keys: "⌘+K" },
  { id: "stop-stream", label: "Stop response", keys: "Esc" },
  { id: "focus-composer", label: "Focus composer", keys: "/" },
  { id: "show-help", label: "Keyboard shortcuts", keys: "?" },
];
