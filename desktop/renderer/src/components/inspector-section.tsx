import { ReactNode } from "react";

export function PanelHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="panel-header">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
    </div>
  );
}

export function InspectorSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="inspector-section">
      <h2>{label}</h2>
      <div className="stack compact">{children}</div>
    </section>
  );
}
