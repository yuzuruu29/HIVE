import { ReactNode, useEffect, useRef } from "react";

const focusable = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, children, onClose, initialFocus = "first" }: { title: string; children: ReactNode; onClose: () => void; initialFocus?: "first" | "last" }) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>(focusable) ?? [])];
    (initialFocus === "last" ? controls.at(-1) : controls[0])?.focus();
    return () => previous?.focus();
  }, [initialFocus]);
  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>(focusable) ?? [])];
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0]; const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  const titleId = `dialog-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return <div className="modal-backdrop"><section ref={panelRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}><h2 id={titleId}>{title}</h2>{children}</section></div>;
}
