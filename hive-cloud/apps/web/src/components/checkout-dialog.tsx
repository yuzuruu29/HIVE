"use client";

import { useEffect, useRef, useState } from "react";
import type { PlanVersion } from "@hive-cloud/contracts";

interface CheckoutDialogProps {
  plan: PlanVersion;
  interval: "monthly" | "annual";
  open: boolean;
  onClose: () => void;
}

export function CheckoutDialog({ plan, interval, open, onClose }: CheckoutDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const amount = interval === "monthly" ? plan.monthlyPriceCents : plan.annualPriceCents;
  const amountDisplay = `$${(amount / 100).toFixed(2)}`;

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
    window.requestAnimationFrame(() => focusable().at(-1)?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); previousFocus?.focus(); };
  }, [onClose, open]);

  const handleCheckout = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cloud/billing/checkouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, interval }),
      });
      const data = await res.json() as { approvalUrl?: string; error?: string | { message?: string } };
      if (!res.ok || !data.approvalUrl) throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? "Checkout could not be started.");
      window.location.assign(data.approvalUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Checkout failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="dialog-overlay" role="presentation">
      <div ref={dialogRef} className="dialog-content" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
        <h2 id="checkout-title">Subscribe to {plan.name}</h2>
        <p className="price">
          {amountDisplay}/{interval === "monthly" ? "month" : "year"}
        </p>
        <ul>
          <li>{plan.monthlyManagedCredits} managed credits/month</li>
          <li>Up to {plan.dailyJobLimit} routed jobs/day</li>
          <li>Up to {plan.councilRunLimit} Council runs/month</li>
          <li>BYOK and open-source routes always free</li>
        </ul>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button onClick={onClose} disabled={loading} type="button">Cancel</button>
          <button onClick={handleCheckout} disabled={loading} className="primary" type="button">
            {loading ? "Processing..." : `Pay ${amountDisplay}`}
          </button>
        </div>
      </div>
    </div>
  );
}
