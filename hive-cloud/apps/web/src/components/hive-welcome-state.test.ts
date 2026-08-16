import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HiveWaveBackground } from "./hive-wave-background";
import { HiveWelcomeState } from "./hive-welcome-state";

describe("HIVE empty Chat experience", () => {
  it("renders an accessible welcome around the real composer slot", () => {
    const composer = React.createElement("textarea", { "aria-label": "Message HIVE" });
    const markup = renderToStaticMarkup(React.createElement(HiveWelcomeState, {
      mode: "chat",
      onModeChange: () => undefined,
      onSuggestion: () => undefined,
      composer,
    }));

    expect(markup).toContain("Give the Hive an outcome.");
    expect(markup).toContain("7 routed calls");
    expect(markup).toContain("Independent checks");
    expect(markup).toContain('aria-label="Message HIVE"');
    expect(markup).toContain('aria-label="Choose how HIVE should help"');
    expect(markup).toContain("Common starting points");
  });

  it("server-renders a decorative static wave fallback without a canvas", () => {
    const markup = renderToStaticMarkup(React.createElement(HiveWaveBackground));

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('data-renderer="fallback"');
    expect(markup).toContain('data-testid="hive-wave-fallback"');
    expect(markup).not.toContain("data-hive-wave-canvas");
  });
});
