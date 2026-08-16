import { ReactNode } from "react";

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "error" }) {
  return (
    <span className={`status-pill status-${tone}`}>
      <span aria-hidden="true" className="status-glyph">
        [{tone === "success" ? "OK" : tone === "error" ? "!!" : tone === "warning" ? ".." : "--"}]
      </span>
      {children}
    </span>
  );
}
