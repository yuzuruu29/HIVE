"use client";

import Link from "next/link";
import { Theme } from "@astryxdesign/core/theme";
import { LinkProvider } from "@astryxdesign/core/Link";
import { hiveTheme } from "@/theme/hive-theme";
import { useCallback, useEffect, useState } from "react";

type ResolvedMode = "light" | "dark";

function readInitialMode(): ResolvedMode {
  if (typeof document !== "undefined" && document.documentElement.dataset.theme === "light") {
    return "light";
  }
  return "dark";
}

function ThemeSyncProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ResolvedMode>(readInitialMode);

  const handleThemeChange = useCallback((e: Event) => {
    const next = (e as CustomEvent<string>).detail as ResolvedMode;
    setMode(next);
  }, []);

  useEffect(() => {
    window.addEventListener("hive-theme-change", handleThemeChange);
    return () => window.removeEventListener("hive-theme-change", handleThemeChange);
  }, [handleThemeChange]);

  return (
    <Theme theme={hiveTheme} mode={mode}>
      {children}
    </Theme>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeSyncProvider>
      <LinkProvider component={Link}>{children}</LinkProvider>
    </ThemeSyncProvider>
  );
}
