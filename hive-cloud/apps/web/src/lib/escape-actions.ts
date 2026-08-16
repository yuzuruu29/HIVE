"use client";

import { useEffect, useRef } from "react";

interface EscapeAction { id: symbol; priority: number; run: () => void }
const actions = new Map<symbol, EscapeAction>();
let listening = false;

function handleEscape(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const action = [...actions.values()].sort((a, b) => b.priority - a.priority)[0];
  if (!action) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  action.run();
}

function syncListener() {
  if (actions.size > 0 && !listening) {
    window.addEventListener("keydown", handleEscape, { capture: true });
    listening = true;
  } else if (actions.size === 0 && listening) {
    window.removeEventListener("keydown", handleEscape, { capture: true });
    listening = false;
  }
}

export function useEscapeAction(run: () => void, enabled: boolean, priority = 0) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    const id = Symbol("escape-action");
    actions.set(id, { id, priority, run: () => runRef.current() });
    syncListener();
    return () => {
      actions.delete(id);
      syncListener();
    };
  }, [enabled, priority]);
}
