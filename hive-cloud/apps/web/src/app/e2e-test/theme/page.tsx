"use client";

import { useState, useEffect } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { LinkProvider } from "@astryxdesign/core/Link";
import { hiveTheme } from "@/theme/hive-theme";

/**
 * E2E test page for theme synchronization between HIVE and Astryx.
 *
 * The page is hydrated from the server-rendered markup which includes
 * an inline themeBootScript that sets html[data-theme] from localStorage.
 * The ThemeSyncProvider in Providers reads the attribute and passes
 * mode to Astryx Theme. The toggle dispatches hive-theme-change.
 */
export default function ThemeE2EPage() {
  const [theme, setTheme] = useState<string>("");

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme ?? "dark");
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    localStorage.setItem("hive-theme", next);
    document.documentElement.dataset.theme = next;
    window.dispatchEvent(new CustomEvent("hive-theme-change", { detail: next }));
    setTheme(next);
  }

  return (
    <Theme theme={hiveTheme} mode={(theme || undefined) as "light" | "dark" | undefined}>
      <LinkProvider
        component={({
          href,
          children,
          ...rest
        }: {
          href: string;
          children?: React.ReactNode;
        }) => (
          <a href={href} {...rest}>
            {children}
          </a>
        )}
      >
        <div id="e2e-test-theme">
          <span data-testid="theme-hive-value">{theme}</span>
          <span data-testid="theme-data-attr-value">
            {typeof document !== "undefined"
              ? document.documentElement.dataset.theme ?? ""
              : ""}
          </span>
          <span data-testid="theme-astryx-class">
            {typeof document !== "undefined"
              ? document.documentElement.className
              : ""}
          </span>
          <span data-testid="theme-localstorage-value">
            {typeof localStorage !== "undefined"
              ? localStorage.getItem("hive-theme") ?? ""
              : ""}
          </span>
          <button
            data-testid="theme-toggle-btn"
            onClick={toggle}
            type="button"
          >
            Toggle theme
          </button>
        </div>
      </LinkProvider>
    </Theme>
  );
}
