"use client";

import { Dialog as AstryxDialog, type DialogProps } from "@astryxdesign/core/Dialog";
import { DialogHeader } from "@astryxdesign/core/Dialog";
import { X } from "@phosphor-icons/react";

export { DialogHeader };

export function HiveDialog({
  children,
  title,
  ...props
}: DialogProps & { title?: string }) {
  return (
    <AstryxDialog {...props}>
      {title && <DialogHeader title={title} />}
      {children}
    </AstryxDialog>
  );
}

export function HiveConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  open,
  onOpenChange,
  variant,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: "danger" | "default";
}) {
  return (
    <AstryxDialog
      isOpen={open}
      onOpenChange={onOpenChange}
      purpose="form"
    >
      <DialogHeader title={title} />
      <p style={{ color: "var(--muted)", lineHeight: 1.5, margin: 0, padding: "0 0 var(--spacing-4)" }}>
        {message}
      </p>
      <div style={{ display: "flex", gap: "var(--spacing-2)", justifyContent: "flex-end" }}>
        <button
          className="button button-secondary"
          onClick={() => { onCancel(); onOpenChange(false); }}
        >
          {cancelLabel || "Cancel"}
        </button>
        <button
          className={`button ${variant === "danger" ? "button-danger" : "button-primary"}`}
          onClick={() => { onConfirm(); onOpenChange(false); }}
        >
          {confirmLabel || "Confirm"}
        </button>
      </div>
    </AstryxDialog>
  );
}
