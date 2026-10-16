import { useEffect, useState } from "react";
import type { DesktopMode } from "./state";

export interface DesktopUiPrefs {
  v: 1;
  onboardingDismissed?: string[];
  turnPanelCollapsed?: boolean;
  notifications?: boolean;
  density?: "comfortable" | "compact";
  accent?: "vivid" | "contrast";
  /** Colour theme; "system" follows the OS setting. */
  theme?: "system" | "light" | "dark";
  rails?: { left: boolean; right: boolean };
  /** Top-level surface. */
  mode?: DesktopMode;
  /** Split ratio between Chat and Coder panes (e.g. 0.4 = 40% Chat / 60% Coder). */
  splitRatio?: number;
  fileTree?: boolean;
  terminalPanel?: boolean;
  /** Enter sends the chat composer message (default true; Ctrl+Enter sends when false). */
  composerSendWithEnter?: boolean;
  /** Enabled / toggled state for individual model IDs: { [modelId]: boolean }. */
  enabledModels?: Record<string, boolean>;
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
    rails: { left: true, right: false },
    mode: "chat",
    splitRatio: 0.4,
    fileTree: true,
    terminalPanel: true,
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
