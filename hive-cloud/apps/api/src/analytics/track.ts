import { AnalyticsStore, AnalyticsEvent } from "./analytics-store.js";

let instance: AnalyticsStore | null = null;

export function setAnalyticsStore(store: AnalyticsStore): void {
  instance = store;
}

export function track(eventName: string, properties: Record<string, unknown> = {}, tenantId?: string, userId?: string): void {
  if (!instance) return;
  const event: AnalyticsEvent = { eventName, properties };
  if (tenantId !== undefined) event.tenantId = tenantId;
  if (userId !== undefined) event.userId = userId;
  instance.track(event);
}

// Convenience trackers for key funnel events
export const AnalyticsEvents = {
  landingVisit(source?: string) {
    track("landing_visit", source ? { source } : {});
  },
  signUp(tenantId: string, userId: string, method: string) {
    track("sign_up", { method }, tenantId, userId);
  },
  firstRoute(tenantId: string, userId: string, provider: string, model: string) {
    track("first_route", { provider, model }, tenantId, userId);
  },
  firstSavedResult(tenantId: string, userId: string) {
    track("first_saved_result", {}, tenantId, userId);
  },
  byokConnected(tenantId: string, userId: string, provider: string) {
    track("byok_connected", { provider }, tenantId, userId);
  },
  checkoutStarted(tenantId: string, userId: string, planId: string) {
    track("checkout_started", { planId }, tenantId, userId);
  },
  subscriptionActivated(tenantId: string, userId: string, planId: string) {
    track("subscription_activated", { planId }, tenantId, userId);
  },
  subscriptionCancelled(tenantId: string, userId: string) {
    track("subscription_cancelled", {}, tenantId, userId);
  },
  topUpPurchased(tenantId: string, userId: string, sku: string, credits: number) {
    track("top_up_purchased", { sku, credits }, tenantId, userId);
  },
};
