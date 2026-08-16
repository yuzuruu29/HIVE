import { useEffect, useState } from "react";

export interface DesktopUiPrefs {
  v: 1;
  onboardingDismissed?: string[];
  turnPanelCollapsed?: boolean;
  notifications?: boolean;
  density?: "comfortable" | "compact";
  accent?: "vivid" | "contrast";
  rails?: { left: boolean; right: boolean };
  /** Top-level surface: conversational Chat or the coder cockpit. */
  mode?: "chat" | "coder";
  /** Enter sends the chat composer message (default true; Ctrl+Enter sends when false). */
  composerSendWithEnter?: boolean;
}

const STORAGE_KEY = "hive.desktop.ui.v1";

const listeners = new Set<(prefs: DesktopUiPrefs) => void>();

export function defaultPrefs(): DesktopUiPrefs {
  return {
    v: 1,
    onboardingDismissed: [],
    turnPanelCollapsed: false,
    notifications: true,
    density: "comfortable",
    accent: "vivid",
    rails: { left: true, right: true },
  };
}

export function loadPrefs(): DesktopUiPrefs {
  try {
    if (typeof localStorage === "undefined") return defaultPrefs();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.v === 1) {
      return { ...defaultPrefs(), ...parsed };
    }
  } catch {
    // ignore
  }
  return defaultPrefs();
}

export function savePrefs(patch: Partial<DesktopUiPrefs>): DesktopUiPrefs {
  const current = loadPrefs();
  const next: DesktopUiPrefs = { ...current, ...patch, v: 1 };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // ignore
  }
  listeners.forEach((listener) => listener(next));
  return next;
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<DesktopUiPrefs>(loadPrefs);
  useEffect(() => {
    const handler = (next: DesktopUiPrefs) => setPrefs(next);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  return {
    prefs,
    updatePrefs: savePrefs,
  };
}
