"use client";

import { useEffect, useState } from "react";

interface Usage { managed_credits: number; requests_per_minute: number; managed_requests_per_minute: number; concurrent_streams: number; web_searches_per_day: number; }

export function UsageSurface() {
  const [usage, setUsage] = useState<Usage>();
  const [error, setError] = useState<string>();
  useEffect(() => { void fetch("/api/cloud/usage", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error("Usage is unavailable."); setUsage((await response.json() as { data: Usage }).data); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Usage is unavailable.")); }, []);
  const metrics = usage ? [
    [usage.managed_credits, "managed credits remaining"],
    [usage.requests_per_minute, "requests per minute"],
    [usage.managed_requests_per_minute, "managed requests per minute"],
    [usage.concurrent_streams, "concurrent streams"],
    [usage.web_searches_per_day, "web searches per day"],
  ] as const : [];
  return <div className="workspace-page"><div className="page-heading"><div><h2>Usage and limits</h2><p>Managed completions debit invite credits. BYOK traffic is still rate-limited but does not consume managed credits.</p></div></div>{error && <div className="error-banner" role="alert">{error}</div>}<div className="usage-strip" aria-busy={!usage}>{usage ? metrics.map(([value, label]) => <div className="usage-metric" key={label}><strong>{value}</strong><span>{label}</span></div>) : Array.from({ length: 5 }, (_, index) => <div className="usage-metric usage-metric-loading" key={index}><span className="skeleton" /></div>)}</div><div className="notice usage-notice">Failed upstream attempts do not debit credits. A successful managed completion debits once using its idempotency key.</div></div>;
}
