"use client";

import { useCallback, useEffect, useState } from "react";

interface CreditBalanceData {
  promotional: number;
  subscription: number;
  purchased: number;
  total: number;
}

export function CreditBalance() {
  const [balance, setBalance] = useState<CreditBalanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await fetch("/api/cloud/billing/status");
      if (!res.ok) { setUnavailable(true); return; }
      const data = await res.json();
      setBalance({
        promotional: data.promotionalBalance ?? 0,
        subscription: Math.max(0, (data.managedCreditsBalance ?? 0) - (data.promotionalBalance ?? 0)),
        purchased: data.purchasedBalance ?? 0,
        total: data.totalBalance ?? 0,
      });
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  if (loading) return <span className="text-muted">-- credits</span>;
  if (unavailable) return <span className="text-muted" title="Credit balance is temporarily unavailable">Credits unavailable</span>;
  if (!balance) return null;

  return (
    <span className="credit-balance" title={`Promo: ${balance.promotional} | Sub: ${balance.subscription} | Purchased: ${balance.purchased}`}>
      {balance.total} credits
    </span>
  );
}
