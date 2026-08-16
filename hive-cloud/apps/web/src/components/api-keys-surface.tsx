"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Copy, Key, Plus, Trash } from "@phosphor-icons/react";

interface KeyRecord { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt?: string; revokedAt?: string; }

export function ApiKeysSurface() {
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [name, setName] = useState("SDK key");
  const [revealed, setRevealed] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function load() {
    const response = await fetch("/api/cloud/api-keys", { cache: "no-store" });
    if (!response.ok) throw new Error("API keys are unavailable.");
    setKeys((await response.json() as { data: KeyRecord[] }).data);
  }
  useEffect(() => { void load().catch((cause) => setError(cause.message)).finally(() => setLoadingKeys(false)); }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(undefined);
    const response = await fetch("/api/cloud/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, scopes: ["models:read", "chat:write"] }) });
    if (!response.ok) { setError("The HIVE key could not be generated."); setLoading(false); return; }
    const data = (await response.json() as { data: KeyRecord & { raw: string } }).data;
    setRevealed(data.raw);
    setLoading(false);
    await load();
  }

  async function revoke(id: string) {
    const response = await fetch(`/api/cloud/api-keys/${id}`, { method: "DELETE" });
    if (!response.ok) setError("The key could not be revoked.");
    else await load();
  }

  return (
    <div className="workspace-page">
      <div className="page-heading"><div><h2>HIVE API keys</h2><p>Use one reveal-once key with OpenAI-compatible clients, the HIVE CLI, and desktop companion.</p></div><span className="router-pill"><Key size={15} /> hive_live_</span></div>
      {error && <div className="error-banner" style={{ marginBottom: 18 }}>{error}</div>}
      <div className="settings-grid">
        <section className="panel"><h3>Active keys</h3><div className="settings-list">{loadingKeys ? <><div className="skeleton" /><div className="skeleton" /></> : keys.length === 0 ? <p className="receipt-empty">No API keys yet.</p> : keys.map((key) => <div className="setting-record" key={key.id}><strong>{key.name}</strong><span>{key.revokedAt ? "revoked" : "active"}</span><code>{key.prefix}********</code>{!key.revokedAt && <button className="icon-button" aria-label={`Revoke ${key.name}`} onClick={() => void revoke(key.id)}><Trash size={16} /></button>}</div>)}</div></section>
        <section className="panel"><h3>Generate a key</h3>{revealed && <><div className="notice" style={{ marginBottom: 12 }}>Copy this key now. HIVE stores only its digest and cannot reveal it again.</div><div className="key-reveal">{revealed}</div><button className="button button-secondary" style={{ marginTop: 10 }} onClick={() => void navigator.clipboard.writeText(revealed)}><Copy size={16} /> Copy key</button></>}
          <form onSubmit={(event) => void create(event)} style={{ marginTop: 20 }}><div className="field"><label htmlFor="key-name">Key name</label><input className="input" id="key-name" value={name} onChange={(event) => setName(event.target.value)} required /></div><p className="form-message" style={{ margin: "12px 0" }}>Scopes: models:read, chat:write. Default rate limit: 60 requests per minute.</p><button className="button button-primary" disabled={loading} type="submit"><Plus size={16} /> {loading ? "Generating..." : "Generate key"}</button></form>
        </section>
      </div>
    </div>
  );
}
