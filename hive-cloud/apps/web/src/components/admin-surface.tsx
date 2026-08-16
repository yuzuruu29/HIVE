"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, EnvelopeSimple, Plus } from "@phosphor-icons/react";
import { Table, proportional, pixel } from "@astryxdesign/core/Table";
import { Badge } from "@astryxdesign/core/Badge";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { TextInput } from "@astryxdesign/core/TextInput";
import { NumberInput } from "@astryxdesign/core/NumberInput";

interface Entry extends Record<string, unknown> { id: string; email: string; useCase?: string; approved: boolean; createdAt: string; }

export function AdminSurface() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [tenantId, setTenantId] = useState("");
  const [creditAmount, setCreditAmount] = useState<number>();
  const [creditReason, setCreditReason] = useState("");

  async function load() { const response = await fetch("/api/cloud/admin/waitlist", { cache: "no-store" }); if (!response.ok) throw new Error("This account is not configured as a platform owner."); setEntries((await response.json() as { data: Entry[] }).data); }
  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Admin surface is unavailable.")); }, []);

  async function approve(id: string) { const response = await fetch(`/api/cloud/admin/waitlist/${id}/approve`, { method: "POST" }); const payload = await response.json().catch(() => null) as { data?: { delivered?: boolean; invite_token?: string }; error?: { message?: string } } | null; if (!response.ok) { setError(payload?.error?.message || "Approval failed."); return; } setMessage(payload?.data?.delivered ? "Invite delivered through Resend." : `Invite approved. Manual token: ${payload?.data?.invite_token || "not returned"}`); await load(); }

  async function credits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/cloud/admin/credits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant_id: tenantId,
        amount: creditAmount,
        reason: creditReason,
        idempotency_key: crypto.randomUUID(),
      }),
    });
    if (!response.ok) { setError("Credit grant failed."); return; }
    setMessage("Credit ledger entry applied.");
    setTenantId("");
    setCreditAmount(undefined);
    setCreditReason("");
  }

  return (
    <div className="workspace-page">
      <div className="page-heading">
        <div>
          <h2>Beta operations</h2>
          <p>Approve invite requests, deliver single-use links, and apply audited credit-ledger changes without opening user content.</p>
        </div>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 18 }} role="alert">{error}</div>}
      {message && <div className="notice" style={{ marginBottom: 18 }} role="status">{message}</div>}

      <div className="settings-grid">
        <section className="panel">
          <h3>Waitlist</h3>
          {entries.length === 0 ? (
            <EmptyState title="No waitlist entries" description="Approved beta signups will appear here." />
          ) : (
            <Table
              data={entries}
              idKey="id"
              density="compact"
              hasHover
              columns={[
                { key: "email", header: "Email", width: proportional(2) },
                {
                  key: "status",
                  header: "Status",
                  width: pixel(120),
                  renderCell: (item: Entry) => (
                    <Badge label={item.approved ? "approved" : "pending"} variant={item.approved ? "success" : "neutral"} />
                  ),
                },
                {
                  key: "useCase",
                  header: "Use case",
                  width: proportional(2),
                  renderCell: (item: Entry) => (
                    <span style={{ color: "var(--muted)", fontSize: "var(--font-size-sm)" }}>
                      {item.useCase || "—"}
                    </span>
                  ),
                },
                {
                  key: "actions",
                  header: "",
                  width: pixel(120),
                  renderCell: (item: Entry) =>
                    item.approved ? (
                      <Check size={17} color="var(--success)" />
                    ) : (
                      <button className="button button-secondary" onClick={() => void approve(item.id)}>
                        <EnvelopeSimple size={16} /> Approve
                      </button>
                    ),
                },
              ]}
            />
          )}
        </section>

        <form className="panel" onSubmit={(event) => void credits(event)}>
          <h3>Grant or revoke credits</h3>

          <TextInput
            label="Tenant UUID"
            value={tenantId}
            onChange={setTenantId}
            placeholder="00000000-0000-0000-0000-000000000000"
          />

          <NumberInput
            label="Credit amount"
            value={creditAmount}
            onChange={setCreditAmount}
            min={-100000}
            max={100000}
          />

          <TextInput
            label="Audit reason"
            value={creditReason}
            onChange={setCreditReason}
            placeholder="e.g. Invite bonus credit grant"
          />

          <button className="button button-primary" style={{ marginTop: 16 }} type="submit">
            <Plus size={16} /> Apply ledger entry
          </button>
        </form>
      </div>
    </div>
  );
}
