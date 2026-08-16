import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { SubscriptionStatus } from "@hive-cloud/contracts";
import type { PriceSnapshot } from "@hive-cloud/router";
import {
  billingCheckouts,
  billingEvents,
  createDatabase,
  creditLedger,
  creditReservations,
  entitlements,
  modelPriceSnapshots,
  paymentOrders,
  subscriptions,
  withServiceRole,
  withTenant,
  type HiveDatabase,
} from "@hive-cloud/database";

interface InternalSubject {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
}

export interface SubscriptionRecord {
  externalSubscriptionId: string;
  planVersion: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  paidThrough?: string;
  cancelAtPeriodEnd?: boolean;
  cancelledAt?: string;
}

export interface CheckoutRecord {
  id: string;
  tenantId: string;
  userId: string;
  planId: string;
  interval: "monthly" | "annual";
  paypalPlanId: string;
  nonceDigest: string;
  externalSubscriptionId?: string;
  status: "pending" | "approved" | "completed" | "expired";
  createdAt: string;
  expiresAt: string;
}

interface CreditBalanceRecord {
  promotional: number;
  subscription: number;
  purchased: number;
}

export interface PaymentOrderRecord {
  id: string;
  tenantId: string;
  externalOrderId: string;
  externalCaptureId?: string;
  customId: string;
  sku: string;
  amountCents: number;
  currency: string;
  status: string;
  creditsGranted: number;
}

interface BillingStoreOptions {
  databaseUrl?: string;
}

function total(balance: CreditBalanceRecord): number {
  return balance.promotional + balance.subscription + balance.purchased;
}

function subscriptionFromRow(row: typeof subscriptions.$inferSelect): SubscriptionRecord {
  return {
    externalSubscriptionId: row.externalSubscriptionId,
    planVersion: row.planVersion,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    ...(row.paidThrough ? { paidThrough: row.paidThrough.toISOString() } : {}),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    ...(row.cancelledAt ? { cancelledAt: row.cancelledAt.toISOString() } : {}),
  };
}

function checkoutFromRow(row: typeof billingCheckouts.$inferSelect): CheckoutRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    planId: row.planId,
    interval: row.interval as "monthly" | "annual",
    paypalPlanId: row.paypalPlanId,
    nonceDigest: row.nonceDigest,
    ...(row.externalSubscriptionId ? { externalSubscriptionId: row.externalSubscriptionId } : {}),
    status: row.status as CheckoutRecord["status"],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export function digestCheckoutNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

export class BillingStore {
  readonly #db?: HiveDatabase;
  readonly #pool?: ReturnType<typeof createDatabase>["pool"];
  readonly #subscriptions = new Map<string, SubscriptionRecord>();
  readonly #subscriptionTenants = new Map<string, string>();
  readonly #checkouts = new Map<string, CheckoutRecord>();
  readonly #events = new Map<string, { status: "processing" | "processed" | "failed"; payloadHash: string }>();
  readonly #balances = new Map<string, CreditBalanceRecord>();
  readonly #orders = new Map<string, PaymentOrderRecord>();
  readonly #creditGrants = new Set<string>();
  readonly #reservations = new Map<string, { reserved: number; settled: number; status: "reserved" | "settled" | "released"; priceSnapshotId: string; estimatedProviderCostMicrousd: number; providerCostMicrousd?: number }>();

  public constructor(options: BillingStoreOptions = {}) {
    if (options.databaseUrl) {
      const database = createDatabase(options.databaseUrl);
      this.#db = database.db;
      this.#pool = database.pool;
    }
  }

  public get persistent(): boolean { return Boolean(this.#db); }

  public async close(): Promise<void> { await this.#pool?.end(); }

  public async syncPriceSnapshots(snapshots: PriceSnapshot[]): Promise<void> {
    if (!this.#db || snapshots.length === 0) return;
    await withServiceRole(this.#db, (tx) => tx.insert(modelPriceSnapshots).values(snapshots.map((snapshot) => ({
      id: snapshot.id,
      provider: snapshot.provider,
      model: snapshot.model,
      inputMicrousdPerMillionTokens: snapshot.inputMicrousdPerMillionTokens,
      outputMicrousdPerMillionTokens: snapshot.outputMicrousdPerMillionTokens,
      ...(snapshot.cacheReadMicrousdPerMillionTokens !== undefined ? { cacheReadMicrousdPerMillionTokens: snapshot.cacheReadMicrousdPerMillionTokens } : {}),
      sourceUrl: snapshot.sourceUrl,
      effectiveFrom: new Date(snapshot.effectiveFrom ?? Date.now()),
    }))).onConflictDoNothing());
  }

  public async createCheckout(
    subject: InternalSubject,
    planId: string,
    interval: "monthly" | "annual",
    paypalPlanId: string,
    nonceDigest: string,
  ): Promise<CheckoutRecord> {
    const record: CheckoutRecord = {
      id: randomUUID(),
      tenantId: subject.tenantId,
      userId: subject.userId,
      planId,
      interval,
      paypalPlanId,
      nonceDigest,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    if (!this.#db) {
      this.#checkouts.set(record.id, record);
      return record;
    }
    const [row] = await withTenant(this.#db, subject.tenantId, (tx) => tx.insert(billingCheckouts).values({
      id: record.id,
      tenantId: subject.tenantId,
      userId: subject.userId,
      planId,
      interval,
      paypalPlanId,
      nonceDigest,
      expiresAt: new Date(record.expiresAt),
    }).returning());
    if (!row) throw new Error("Checkout could not be created");
    return checkoutFromRow(row);
  }

  public async getCheckout(tenantId: string, id: string): Promise<CheckoutRecord | undefined> {
    if (!this.#db) {
      const checkout = this.#checkouts.get(id);
      return checkout?.tenantId === tenantId ? checkout : undefined;
    }
    const [row] = await withTenant(this.#db, tenantId, (tx) => tx.select().from(billingCheckouts)
      .where(and(eq(billingCheckouts.id, id), eq(billingCheckouts.tenantId, tenantId))).limit(1));
    return row ? checkoutFromRow(row) : undefined;
  }

  public async findCheckoutByExternal(subscriptionId: string): Promise<CheckoutRecord | undefined> {
    if (!this.#db) return [...this.#checkouts.values()].find((checkout) => checkout.externalSubscriptionId === subscriptionId);
    const [row] = await withServiceRole(this.#db, (tx) => tx.select().from(billingCheckouts)
      .where(eq(billingCheckouts.externalSubscriptionId, subscriptionId)).limit(1));
    return row ? checkoutFromRow(row) : undefined;
  }

  public async attachCheckoutSubscription(tenantId: string, id: string, subscriptionId: string): Promise<boolean> {
    const now = new Date();
    if (!this.#db) {
      const checkout = this.#checkouts.get(id);
      if (!checkout || checkout.tenantId !== tenantId || checkout.status !== "pending" || Date.parse(checkout.expiresAt) <= now.getTime()) return false;
      checkout.externalSubscriptionId = subscriptionId;
      return true;
    }
    const rows = await withTenant(this.#db, tenantId, (tx) => tx.update(billingCheckouts).set({
      externalSubscriptionId: subscriptionId,
      updatedAt: now,
    }).where(and(
      eq(billingCheckouts.id, id),
      eq(billingCheckouts.tenantId, tenantId),
      eq(billingCheckouts.status, "pending"),
      gt(billingCheckouts.expiresAt, now),
    )).returning({ id: billingCheckouts.id }));
    return rows.length === 1;
  }

  public async approveCheckout(tenantId: string, id: string, subscriptionId: string): Promise<boolean> {
    const now = new Date();
    if (!this.#db) {
      const checkout = this.#checkouts.get(id);
      if (!checkout || checkout.tenantId !== tenantId || checkout.status !== "pending" || checkout.externalSubscriptionId !== subscriptionId || Date.parse(checkout.expiresAt) <= now.getTime()) return false;
      checkout.status = "approved";
      return true;
    }
    const rows = await withTenant(this.#db, tenantId, (tx) => tx.update(billingCheckouts).set({ status: "approved", updatedAt: now })
      .where(and(
        eq(billingCheckouts.id, id),
        eq(billingCheckouts.tenantId, tenantId),
        eq(billingCheckouts.status, "pending"),
        eq(billingCheckouts.externalSubscriptionId, subscriptionId),
        gt(billingCheckouts.expiresAt, now),
      )).returning({ id: billingCheckouts.id }));
    return rows.length === 1;
  }

  public async completeCheckout(tenantId: string, id: string): Promise<boolean> {
    if (!this.#db) {
      const checkout = this.#checkouts.get(id);
      if (!checkout || checkout.tenantId !== tenantId || checkout.status !== "approved") return false;
      checkout.status = "completed";
      return true;
    }
    const rows = await withTenant(this.#db, tenantId, (tx) => tx.update(billingCheckouts).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(billingCheckouts.id, id), eq(billingCheckouts.tenantId, tenantId), eq(billingCheckouts.status, "approved")))
      .returning({ id: billingCheckouts.id }));
    return rows.length === 1;
  }

  public async upsertSubscription(tenantId: string, sub: SubscriptionRecord): Promise<void> {
    if (!this.#db) {
      this.#subscriptions.set(tenantId, structuredClone(sub));
      this.#subscriptionTenants.set(sub.externalSubscriptionId, tenantId);
      return;
    }
    await withServiceRole(this.#db, (tx) => tx.insert(subscriptions).values({
      tenantId,
      externalSubscriptionId: sub.externalSubscriptionId,
      planVersion: sub.planVersion,
      status: sub.status,
      currentPeriodStart: new Date(sub.currentPeriodStart),
      currentPeriodEnd: new Date(sub.currentPeriodEnd),
      ...(sub.paidThrough ? { paidThrough: new Date(sub.paidThrough) } : {}),
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
      ...(sub.cancelledAt ? { cancelledAt: new Date(sub.cancelledAt) } : {}),
    }).onConflictDoUpdate({
      target: subscriptions.externalSubscriptionId,
      set: {
        tenantId,
        planVersion: sub.planVersion,
        status: sub.status,
        currentPeriodStart: new Date(sub.currentPeriodStart),
        currentPeriodEnd: new Date(sub.currentPeriodEnd),
        paidThrough: sub.paidThrough ? new Date(sub.paidThrough) : null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
        cancelledAt: sub.cancelledAt ? new Date(sub.cancelledAt) : null,
        updatedAt: new Date(),
      },
    }));
  }

  public async getSubscription(tenantId: string): Promise<SubscriptionRecord | undefined> {
    if (!this.#db) return this.#subscriptions.get(tenantId);
    const [row] = await withTenant(this.#db, tenantId, (tx) => tx.select().from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId)).orderBy(desc(subscriptions.updatedAt)).limit(1));
    return row ? subscriptionFromRow(row) : undefined;
  }

  public async findSubscriptionByExternal(subscriptionId: string): Promise<{ tenantId: string; subscription: SubscriptionRecord } | undefined> {
    if (!this.#db) {
      const tenantId = this.#subscriptionTenants.get(subscriptionId);
      const subscription = tenantId ? this.#subscriptions.get(tenantId) : undefined;
      return tenantId && subscription ? { tenantId, subscription } : undefined;
    }
    const [row] = await withServiceRole(this.#db, (tx) => tx.select().from(subscriptions)
      .where(eq(subscriptions.externalSubscriptionId, subscriptionId)).limit(1));
    return row ? { tenantId: row.tenantId, subscription: subscriptionFromRow(row) } : undefined;
  }

  public async markSubscriptionCancellation(tenantId: string): Promise<boolean> {
    const now = new Date();
    if (!this.#db) {
      const sub = this.#subscriptions.get(tenantId);
      if (!sub) return false;
      sub.cancelAtPeriodEnd = true;
      sub.cancelledAt = now.toISOString();
      return true;
    }
    const rows = await withTenant(this.#db, tenantId, (tx) => tx.update(subscriptions).set({ cancelAtPeriodEnd: true, cancelledAt: now, updatedAt: now })
      .where(eq(subscriptions.tenantId, tenantId)).returning({ id: subscriptions.id }));
    return rows.length > 0;
  }

  public async beginEvent(externalEventId: string, eventType: string, payloadHash: string, payload: unknown): Promise<"process" | "duplicate"> {
    if (!this.#db) {
      const existing = this.#events.get(externalEventId);
      if (existing?.status === "processed" || existing?.status === "processing") return "duplicate";
      this.#events.set(externalEventId, { status: "processing", payloadHash });
      return "process";
    }
    return withServiceRole(this.#db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${externalEventId}))`);
      const [existing] = await tx.select().from(billingEvents).where(eq(billingEvents.externalEventId, externalEventId)).limit(1);
      const processingIsFresh = existing?.processingStatus === "processing" && Date.now() - existing.receivedAt.getTime() < 5 * 60_000;
      if (existing?.processingStatus === "processed" || processingIsFresh) return "duplicate" as const;
      if (existing) {
        await tx.update(billingEvents).set({ processingStatus: "processing", attemptCount: sql`${billingEvents.attemptCount} + 1`, errorMessage: null })
          .where(eq(billingEvents.externalEventId, externalEventId));
      } else {
        await tx.insert(billingEvents).values({ externalEventId, eventType, payloadHash, payload, processingStatus: "processing", attemptCount: 1 });
      }
      return "process" as const;
    });
  }

  public async markEventProcessed(externalEventId: string, tenantId?: string): Promise<void> {
    if (!this.#db) {
      const event = this.#events.get(externalEventId);
      if (event) event.status = "processed";
      return;
    }
    await withServiceRole(this.#db, (tx) => tx.update(billingEvents).set({
      processingStatus: "processed",
      processedAt: new Date(),
      errorMessage: null,
      ...(tenantId ? { tenantId } : {}),
    }).where(eq(billingEvents.externalEventId, externalEventId)));
  }

  public async markEventFailed(externalEventId: string, errorMessage: string): Promise<void> {
    if (!this.#db) {
      const event = this.#events.get(externalEventId);
      if (event) event.status = "failed";
      return;
    }
    await withServiceRole(this.#db, (tx) => tx.update(billingEvents).set({ processingStatus: "failed", errorMessage: errorMessage.slice(0, 1_000) })
      .where(eq(billingEvents.externalEventId, externalEventId)));
  }

  #getMemoryBalance(tenantId: string): CreditBalanceRecord {
    let balance = this.#balances.get(tenantId);
    if (!balance) {
      balance = { promotional: 0, subscription: 0, purchased: 0 };
      this.#balances.set(tenantId, balance);
    }
    return balance;
  }

  async #getBalances(tenantId: string): Promise<CreditBalanceRecord> {
    if (!this.#db) return { ...this.#getMemoryBalance(tenantId) };
    const rows = await withTenant(this.#db, tenantId, (tx) => tx.select({
      balanceClass: creditLedger.balanceClass,
      amount: sql<number>`coalesce(sum(${creditLedger.amount}), 0)::int`,
    }).from(creditLedger).where(and(
      eq(creditLedger.tenantId, tenantId),
      or(isNull(creditLedger.expiresAt), gt(creditLedger.expiresAt, new Date())),
    )).groupBy(creditLedger.balanceClass));
    const result: CreditBalanceRecord = { promotional: 0, subscription: 0, purchased: 0 };
    for (const row of rows) {
      if (row.balanceClass === "promotional" || row.balanceClass === "subscription" || row.balanceClass === "purchased") {
        result[row.balanceClass] = Number(row.amount);
      }
    }
    return result;
  }

  async #grant(tenantId: string, amount: number, balanceClass: keyof CreditBalanceRecord, idempotencyKey: string, reason: string, paymentEventId?: string): Promise<number> {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Credit grant must be a positive integer");
    if (!this.#db) {
      if (!this.#creditGrants.has(idempotencyKey)) {
        this.#creditGrants.add(idempotencyKey);
        this.#getMemoryBalance(tenantId)[balanceClass] += amount;
      }
      return total(this.#getMemoryBalance(tenantId));
    }
    await withTenant(this.#db, tenantId, (tx) => tx.insert(creditLedger).values({
      tenantId,
      amount,
      reason,
      idempotencyKey,
      balanceClass,
      ...(paymentEventId ? { paymentEventId } : {}),
    }).onConflictDoNothing());
    return total(await this.#getBalances(tenantId));
  }

  public grantStarterCredits(tenantId: string): Promise<number> {
    return this.#grant(tenantId, 50, "promotional", `starter:${tenantId}`, "starter_grant");
  }

  public grantMonthlyCredits(tenantId: string, amount: number, eventId: string): Promise<number> {
    return this.#grant(tenantId, amount, "subscription", `monthly:${eventId}`, "subscription_payment", eventId);
  }

  public grantPurchasedCredits(tenantId: string, amount: number, orderId: string): Promise<number> {
    return this.#grant(tenantId, amount, "purchased", `purchased:${orderId}`, "credit_purchase", orderId);
  }

  public async reverseMonthlyCredits(tenantId: string, amount: number, eventId: string): Promise<number> {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Credit reversal must be a positive integer");
    const idempotencyKey = `subscription_reversal:${eventId}`;
    if (!this.#db) {
      if (!this.#creditGrants.has(idempotencyKey)) {
        this.#creditGrants.add(idempotencyKey);
        this.#getMemoryBalance(tenantId).subscription -= amount;
      }
      return total(this.#getMemoryBalance(tenantId));
    }
    await withTenant(this.#db, tenantId, (tx) => tx.insert(creditLedger).values({
      tenantId,
      amount: -amount,
      reason: "subscription_payment_reversed",
      idempotencyKey,
      balanceClass: "subscription",
      paymentEventId: eventId,
    }).onConflictDoNothing());
    return total(await this.#getBalances(tenantId));
  }

  public async debitCredits(tenantId: string, amount: number, idempotencyKey = `debit:${randomUUID()}`): Promise<boolean> {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    if (!this.#db) {
      const balance = this.#getMemoryBalance(tenantId);
      if (total(balance) < amount) return false;
      let remaining = amount;
      for (const balanceClass of ["promotional", "subscription", "purchased"] as const) {
        const consumed = Math.min(balance[balanceClass], remaining);
        balance[balanceClass] -= consumed;
        remaining -= consumed;
      }
      return true;
    }
    return withTenant(this.#db, tenantId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}))`);
      const existing = await tx.select({ id: creditLedger.id }).from(creditLedger)
        .where(and(eq(creditLedger.tenantId, tenantId), eq(creditLedger.idempotencyKey, `${idempotencyKey}:complete`))).limit(1);
      if (existing.length > 0) return true;
      const rows = await tx.select({
        balanceClass: creditLedger.balanceClass,
        amount: sql<number>`coalesce(sum(${creditLedger.amount}), 0)::int`,
      }).from(creditLedger).where(and(
        eq(creditLedger.tenantId, tenantId),
        or(isNull(creditLedger.expiresAt), gt(creditLedger.expiresAt, new Date())),
      )).groupBy(creditLedger.balanceClass);
      const balance: CreditBalanceRecord = { promotional: 0, subscription: 0, purchased: 0 };
      for (const row of rows) {
        if (row.balanceClass === "promotional" || row.balanceClass === "subscription" || row.balanceClass === "purchased") balance[row.balanceClass] = Number(row.amount);
      }
      if (total(balance) < amount) return false;
      let remaining = amount;
      const entries: Array<typeof creditLedger.$inferInsert> = [];
      for (const balanceClass of ["promotional", "subscription", "purchased"] as const) {
        const consumed = Math.min(Math.max(0, balance[balanceClass]), remaining);
        if (consumed > 0) entries.push({ tenantId, amount: -consumed, reason: "managed_usage", idempotencyKey: `${idempotencyKey}:${balanceClass}`, balanceClass });
        remaining -= consumed;
      }
      entries.push({ tenantId, amount: 0, reason: "managed_usage_marker", idempotencyKey: `${idempotencyKey}:complete`, balanceClass: "subscription" });
      await tx.insert(creditLedger).values(entries).onConflictDoNothing();
      return true;
    });
  }

  public async reserveCredits(tenantId: string, requestId: string, amount: number, priceSnapshotId: string, estimatedProviderCostMicrousd: number, platformSpendCapMicrousd?: number): Promise<boolean> {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    if (!Number.isSafeInteger(estimatedProviderCostMicrousd) || estimatedProviderCostMicrousd < 0) return false;
    const reservationKey = `${tenantId}:${requestId}`;
    if (!this.#db) {
      const existing = this.#reservations.get(reservationKey);
      if (existing) return existing.status === "reserved" || existing.status === "settled";
      const reserved = [...this.#reservations.entries()]
        .filter(([key, value]) => key.startsWith(`${tenantId}:`) && value.status === "reserved")
        .reduce((sum, [, value]) => sum + value.reserved, 0);
      if (total(this.#getMemoryBalance(tenantId)) - reserved < amount) return false;
      if (platformSpendCapMicrousd !== undefined) {
        const committedSpend = [...this.#reservations.values()].reduce((sum, reservation) => sum + (reservation.status === "settled" ? reservation.providerCostMicrousd ?? 0 : reservation.status === "reserved" ? reservation.estimatedProviderCostMicrousd : 0), 0);
        if (committedSpend + estimatedProviderCostMicrousd > platformSpendCapMicrousd) return false;
      }
      this.#reservations.set(reservationKey, { reserved: amount, settled: 0, status: "reserved", priceSnapshotId, estimatedProviderCostMicrousd });
      return true;
    }
    return withServiceRole(this.#db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}))`);
      await tx.update(creditReservations).set({ status: "expired" }).where(and(
        eq(creditReservations.tenantId, tenantId),
        eq(creditReservations.status, "reserved"),
        lte(creditReservations.expiresAt, new Date()),
      ));
      const [existing] = await tx.select().from(creditReservations).where(and(
        eq(creditReservations.tenantId, tenantId),
        eq(creditReservations.requestId, requestId),
      )).limit(1);
      if (existing) return existing.status === "reserved" || existing.status === "settled";
      const balances = await tx.select({
        balanceClass: creditLedger.balanceClass,
        amount: sql<number>`coalesce(sum(${creditLedger.amount}), 0)::int`,
      }).from(creditLedger).where(and(
        eq(creditLedger.tenantId, tenantId),
        or(isNull(creditLedger.expiresAt), gt(creditLedger.expiresAt, new Date())),
      )).groupBy(creditLedger.balanceClass);
      const balance = balances.reduce((sum, row) => sum + Number(row.amount), 0);
      const [reservedRow] = await tx.select({ amount: sql<number>`coalesce(sum(${creditReservations.reservedCredits}), 0)::int` })
        .from(creditReservations).where(and(eq(creditReservations.tenantId, tenantId), eq(creditReservations.status, "reserved")));
      if (balance - Number(reservedRow?.amount ?? 0) < amount) return false;
      if (platformSpendCapMicrousd !== undefined) {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const [spendRow] = await tx.select({
          settled: sql<number>`coalesce(sum(case when ${creditReservations.status} = 'settled' then ${creditReservations.providerCostMicrousd} else 0 end), 0)::int`,
          reserved: sql<number>`coalesce(sum(case when ${creditReservations.status} = 'reserved' then ${creditReservations.reservedCredits} * 5000 else 0 end), 0)::int`,
        }).from(creditReservations).where(gt(creditReservations.createdAt, monthStart));
        if (Number(spendRow?.settled ?? 0) + Number(spendRow?.reserved ?? 0) + estimatedProviderCostMicrousd > platformSpendCapMicrousd) return false;
      }
      await tx.insert(creditReservations).values({
        tenantId,
        requestId,
        priceSnapshotId,
        reservedCredits: amount,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      return true;
    });
  }

  public async settleReservation(tenantId: string, requestId: string, actualCredits: number, providerCostMicrousd: number): Promise<{ success: boolean; debitedCredits: number }> {
    if (!Number.isInteger(actualCredits) || actualCredits < 0 || !Number.isSafeInteger(providerCostMicrousd) || providerCostMicrousd < 0) return { success: false, debitedCredits: 0 };
    const reservationKey = `${tenantId}:${requestId}`;
    if (!this.#db) {
      const reservation = this.#reservations.get(reservationKey);
      if (!reservation) return { success: false, debitedCredits: 0 };
      if (reservation.status === "settled") return { success: true, debitedCredits: reservation.settled };
      if (reservation.status !== "reserved") return { success: false, debitedCredits: 0 };
      const balance = this.#getMemoryBalance(tenantId);
      let remaining = actualCredits;
      for (const balanceClass of ["promotional", "subscription", "purchased"] as const) {
        const consumed = Math.min(Math.max(0, balance[balanceClass]), remaining);
        balance[balanceClass] -= consumed;
        remaining -= consumed;
      }
      if (remaining > 0) balance.subscription -= remaining;
      reservation.status = "settled";
      reservation.settled = actualCredits;
      reservation.providerCostMicrousd = providerCostMicrousd;
      return { success: true, debitedCredits: actualCredits };
    }
    return withTenant(this.#db, tenantId, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}))`);
      const [reservation] = await tx.select().from(creditReservations).where(and(
        eq(creditReservations.tenantId, tenantId),
        eq(creditReservations.requestId, requestId),
      )).limit(1);
      if (!reservation) return { success: false, debitedCredits: 0 };
      if (reservation.status === "settled") return { success: true, debitedCredits: reservation.settledCredits };
      if (reservation.status !== "reserved") return { success: false, debitedCredits: 0 };
      const rows = await tx.select({
        balanceClass: creditLedger.balanceClass,
        amount: sql<number>`coalesce(sum(${creditLedger.amount}), 0)::int`,
      }).from(creditLedger).where(and(
        eq(creditLedger.tenantId, tenantId),
        or(isNull(creditLedger.expiresAt), gt(creditLedger.expiresAt, new Date())),
      )).groupBy(creditLedger.balanceClass);
      const balance: CreditBalanceRecord = { promotional: 0, subscription: 0, purchased: 0 };
      for (const row of rows) {
        if (row.balanceClass === "promotional" || row.balanceClass === "subscription" || row.balanceClass === "purchased") balance[row.balanceClass] = Number(row.amount);
      }
      let remaining = actualCredits;
      const deductions: CreditBalanceRecord = { promotional: 0, subscription: 0, purchased: 0 };
      for (const balanceClass of ["promotional", "subscription", "purchased"] as const) {
        const consumed = Math.min(Math.max(0, balance[balanceClass]), remaining);
        deductions[balanceClass] += consumed;
        remaining -= consumed;
      }
      if (remaining > 0) deductions.subscription += remaining;
      const entries = (Object.entries(deductions) as Array<[keyof CreditBalanceRecord, number]>).flatMap(([balanceClass, consumed]) => consumed > 0 ? [{
        tenantId,
        amount: -consumed,
        reason: "managed_usage",
        idempotencyKey: `managed:${requestId}:${balanceClass}`,
        balanceClass,
        metadata: { requestId, priceSnapshotId: reservation.priceSnapshotId, providerCostMicrousd },
      }] : []);
      if (entries.length > 0) await tx.insert(creditLedger).values(entries).onConflictDoNothing();
      await tx.update(creditReservations).set({ status: "settled", settledCredits: actualCredits, providerCostMicrousd })
        .where(eq(creditReservations.id, reservation.id));
      return { success: true, debitedCredits: actualCredits };
    });
  }

  public async releaseReservation(tenantId: string, requestId: string): Promise<void> {
    const reservationKey = `${tenantId}:${requestId}`;
    if (!this.#db) {
      const reservation = this.#reservations.get(reservationKey);
      if (reservation?.status === "reserved") reservation.status = "released";
      return;
    }
    await withTenant(this.#db, tenantId, (tx) => tx.update(creditReservations).set({ status: "released" }).where(and(
      eq(creditReservations.tenantId, tenantId),
      eq(creditReservations.requestId, requestId),
      eq(creditReservations.status, "reserved"),
    )));
  }

  public async getTotalBalance(tenantId: string): Promise<number> {
    return total(await this.#getBalances(tenantId));
  }

  public async getSubscriptionStatus(tenantId: string): Promise<SubscriptionStatus> {
    const [sub, balance] = await Promise.all([this.getSubscription(tenantId), this.#getBalances(tenantId)]);
    const allowedStatus: SubscriptionStatus["status"] = sub?.status === "active" || sub?.status === "past_due" || sub?.status === "cancelled" || sub?.status === "expired"
      ? sub.status
      : sub ? "past_due" : "none";
    return {
      planId: sub?.planVersion ?? null,
      status: allowedStatus,
      paidThrough: sub?.paidThrough ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      managedCreditsBalance: balance.subscription + balance.promotional,
      promotionalBalance: balance.promotional,
      purchasedBalance: balance.purchased,
      totalBalance: total(balance),
    };
  }

  public async createPaymentOrder(tenantId: string, orderId: string, customId: string, sku: string, amountCents: number, currency = "USD"): Promise<PaymentOrderRecord> {
    const record: PaymentOrderRecord = { id: randomUUID(), tenantId, externalOrderId: orderId, customId, sku, amountCents, currency, status: "created", creditsGranted: 0 };
    if (!this.#db) {
      this.#orders.set(orderId, record);
      return record;
    }
    const [row] = await withTenant(this.#db, tenantId, (tx) => tx.insert(paymentOrders).values(record).returning());
    if (!row) throw new Error("Payment order could not be stored");
    return { ...record, id: row.id };
  }

  public async getPaymentOrder(tenantId: string, orderId: string): Promise<PaymentOrderRecord | undefined> {
    if (!this.#db) {
      const order = this.#orders.get(orderId);
      return order?.tenantId === tenantId ? order : undefined;
    }
    const [row] = await withTenant(this.#db, tenantId, (tx) => tx.select().from(paymentOrders)
      .where(and(eq(paymentOrders.externalOrderId, orderId), eq(paymentOrders.tenantId, tenantId))).limit(1));
    return row ? {
      id: row.id,
      tenantId: row.tenantId,
      externalOrderId: row.externalOrderId,
      ...(row.externalCaptureId ? { externalCaptureId: row.externalCaptureId } : {}),
      customId: row.customId,
      sku: row.sku,
      amountCents: row.amountCents,
      currency: row.currency,
      status: row.status,
      creditsGranted: row.creditsGranted ?? 0,
    } : undefined;
  }

  public async updatePaymentOrder(tenantId: string, orderId: string, update: Partial<Pick<PaymentOrderRecord, "status" | "externalCaptureId" | "creditsGranted">>): Promise<boolean> {
    if (!this.#db) {
      const order = this.#orders.get(orderId);
      if (!order || order.tenantId !== tenantId) return false;
      Object.assign(order, update);
      return true;
    }
    const rows = await withTenant(this.#db, tenantId, (tx) => tx.update(paymentOrders).set({ ...update, updatedAt: new Date() })
      .where(and(eq(paymentOrders.externalOrderId, orderId), eq(paymentOrders.tenantId, tenantId))).returning({ id: paymentOrders.id }));
    return rows.length === 1;
  }

  public async setEntitlement(tenantId: string, planId: string, limits: Record<string, number>, effectiveUntil?: string): Promise<void> {
    if (!this.#db) return;
    await withTenant(this.#db, tenantId, async (tx) => {
      await tx.update(entitlements).set({ effectiveUntil: new Date() }).where(and(eq(entitlements.tenantId, tenantId), isNull(entitlements.effectiveUntil)));
      await tx.insert(entitlements).values({ tenantId, planId, limitsJson: limits, ...(effectiveUntil ? { effectiveUntil: new Date(effectiveUntil) } : {}) });
    });
  }
}
