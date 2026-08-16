"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckoutDialog } from "./checkout-dialog";
import { CreditBalance } from "./credit-balance";
import type { SubscriptionStatus, PlanVersion } from "@hive-cloud/contracts";

export function BillingSurface() {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [plans, setPlans] = useState<PlanVersion[]>([]);
  const [checkoutPlan, setCheckoutPlan] = useState<PlanVersion | null>(null);
  const [checkoutInterval, setCheckoutInterval] = useState<"monthly" | "annual">("monthly");
  const [loading, setLoading] = useState(true);
  const [topUpLoading, setTopUpLoading] = useState<string | null>(null);
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [returnLoading, setReturnLoading] = useState(false);
  const [billingReady, setBillingReady] = useState(false);
  const returnHandled = useRef(false);

  const fetchStatus = useCallback(async () => {
    try {
      const [statusRes, plansRes] = await Promise.all([
        fetch("/api/cloud/billing/status"),
        fetch("/api/cloud/billing/plans"),
      ]);
      if (!statusRes.ok || !plansRes.ok) {
        throw new Error("Billing information is temporarily unavailable. Purchases are disabled until the billing service recovers.");
      }

      const [nextStatus, plansData] = await Promise.all([
        statusRes.json() as Promise<SubscriptionStatus>,
        plansRes.json() as Promise<{ plans?: PlanVersion[] }>,
      ]);
      setStatus(nextStatus);
      setPlans(plansData.plans ?? []);
      setBillingReady(true);
    } catch (cause) {
      setBillingReady(false);
      setStatus(null);
      setPlans([]);
      setBillingError((current) => current ?? (cause instanceof Error
        ? cause.message
        : "Billing information is temporarily unavailable. Purchases are disabled."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (returnHandled.current) return;
    returnHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    const returnType = params.get("billing_return");
    const cancelled = params.get("billing_cancelled");
    if (!returnType && !cancelled) return;
    if (cancelled) {
      setBillingNotice("PayPal checkout was cancelled. No charge was made.");
      window.history.replaceState(null, "", "/billing");
      return;
    }
    setReturnLoading(true);
    setBillingError(null);
    void (async () => {
      if (returnType === "subscription") {
        const subscriptionId = params.get("subscription_id");
        const checkoutId = params.get("checkout_id");
        const state = params.get("state");
        if (!subscriptionId || !checkoutId || !state) throw new Error("PayPal returned an incomplete subscription approval.");
        const response = await fetch("/api/cloud/billing/paypal/subscriptions/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscriptionId, checkoutId, state }),
        });
        const payload = await response.json() as { error?: string | { message?: string } };
        if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message ?? "Subscription confirmation failed.");
        setBillingNotice("Subscription approved. Credits appear after PayPal confirms the settled payment.");
      } else if (returnType === "topup") {
        const orderId = params.get("token");
        if (!orderId) throw new Error("PayPal returned an incomplete credit order.");
        const response = await fetch(`/api/cloud/billing/paypal/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST" });
        const payload = await response.json() as { error?: string | { message?: string } };
        if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message ?? "Credit purchase capture failed.");
        setBillingNotice("Payment captured and credits added to your balance.");
      }
      await fetchStatus();
    })().catch((cause: unknown) => {
      setBillingError(cause instanceof Error ? cause.message : "Billing return could not be processed.");
    }).finally(() => {
      setReturnLoading(false);
      window.history.replaceState(null, "", "/billing");
    });
  }, [fetchStatus]);

  const handleCancel = async () => {
    if (!confirm("Cancel your subscription? You'll keep access until the end of the billing period.")) return;
    setBillingError(null);
    try {
      const res = await fetch("/api/cloud/billing/subscription/cancel", { method: "POST" });
      const data = await res.json() as { success?: boolean; error?: string | { message?: string } };
      if (!res.ok || !data.success) {
        throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? "Subscription cancellation failed.");
      }
      setBillingNotice("Cancellation scheduled. Access remains available through the paid period.");
      await fetchStatus();
    } catch (cause) {
      setBillingError(cause instanceof Error ? cause.message : "Subscription cancellation failed.");
    }
  };

  const purchaseTopUp = async (sku: string) => {
    setTopUpLoading(sku);
    try {
      const res = await fetch("/api/cloud/billing/paypal/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku }),
      });
      const data = await res.json() as { approvalUrl?: string; error?: string | { message?: string } };
      if (!res.ok || !data.approvalUrl) throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? "Credit checkout could not be started.");
      window.location.assign(data.approvalUrl);
    } catch (cause) {
      setBillingError(cause instanceof Error ? cause.message : "Credit checkout could not be started.");
    } finally {
      setTopUpLoading(null);
    }
  };

  if (loading) return <div className="billing-loading">Loading billing information...</div>;

  return (
    <div className="billing-surface">
      <h1>Billing & Plan</h1>
      {returnLoading && <div className="billing-notice" role="status">Verifying your PayPal return…</div>}
      {billingNotice && <div className="billing-notice" role="status">{billingNotice}</div>}
      {billingError && <div className="billing-error" role="alert">{billingError}</div>}

      {status && (
        <section className="current-plan">
          <h2>Current Plan</h2>
          <p className="plan-name">{status.planId === "builder" ? "Builder" : status.planId === "pro" ? "Pro" : "Community"}</p>
          <p>Status: {status.status === "none" ? "free" : status.status}</p>
          {status.paidThrough && <p>Paid through: {new Date(status.paidThrough).toLocaleDateString()}</p>}
          {status.currentPeriodEnd && <p>Renews: {new Date(status.currentPeriodEnd).toLocaleDateString()}</p>}
          {status.cancelAtPeriodEnd && <p className="cancel-notice">Cancels at period end</p>}
          <CreditBalance />
          {status.status === "active" && !status.cancelAtPeriodEnd && (
            <button onClick={handleCancel} className="danger" type="button">Cancel Subscription</button>
          )}
        </section>
      )}

      <section className="available-plans">
        <h2>Available Plans</h2>
        {!billingReady && (
          <p className="billing-empty" role="status">
            Plan data is unavailable. Subscription checkout is disabled until the billing service reconnects.
          </p>
        )}
        <div className="plan-grid">
          {plans.map((plan) => (
            <div key={plan.id} className={`plan-card ${status?.planId === plan.id ? "current" : ""}`}>
              <h3>{plan.name}</h3>
              <p className="price">
                {plan.monthlyPriceCents === 0 ? "Free" : `$${(plan.monthlyPriceCents / 100).toFixed(2)}/mo`}
              </p>
              <ul>
                <li>{plan.id === "community" ? "50 one-time starter credits" : `${plan.monthlyManagedCredits} managed credits/month`}</li>
                <li>{plan.dailyJobLimit} jobs/day</li>
                <li>{plan.councilRunLimit} Council runs/month</li>
                <li>BYOK & open-source routes: always free</li>
              </ul>
              {plan.monthlyPriceCents > 0 && status?.planId !== plan.id && (
                <div className="plan-actions">
                  <button onClick={() => { setCheckoutPlan(plan); setCheckoutInterval("monthly"); }} type="button">
                    Subscribe Monthly
                  </button>
                  <button onClick={() => { setCheckoutPlan(plan); setCheckoutInterval("annual"); }} type="button">
                    Subscribe Annually (save ~17%)
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="top-up-section">
        <h2>Buy More Credits</h2>
        <div className="top-up-options">
          <div className="top-up-card">
            <h3>Boost Pack</h3>
            <p>1,000 credits</p>
            <p className="price">$10.00</p>
            <button onClick={() => purchaseTopUp("boost")} disabled={!billingReady || topUpLoading === "boost"} type="button">
              {topUpLoading === "boost" ? "Processing..." : "Buy Boost"}
            </button>
          </div>
          <div className="top-up-card">
            <h3>Power Pack</h3>
            <p>3,000 credits</p>
            <p className="price">$30.00</p>
            <button onClick={() => purchaseTopUp("power")} disabled={!billingReady || topUpLoading === "power"} type="button">
              {topUpLoading === "power" ? "Processing..." : "Buy Power"}
            </button>
          </div>
        </div>
      </section>

      {checkoutPlan && (
        <CheckoutDialog
          plan={checkoutPlan}
          interval={checkoutInterval}
          open={!!checkoutPlan}
          onClose={() => setCheckoutPlan(null)}
        />
      )}
    </div>
  );
}
