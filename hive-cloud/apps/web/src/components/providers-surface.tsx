"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowClockwise, CheckCircle, CloudArrowUp, Eye, EyeSlash, PlugsConnected } from "@phosphor-icons/react";
import type { FreeProviderCatalogEntry } from "@hive-cloud/contracts";

interface ProviderRecord {
  id: string;
  kind: string;
  name: string;
  base_url?: string;
  default_model: string;
  status: string;
  has_secret: boolean;
}

interface ProviderTemplateView {
  kind: string;
  name: string;
  model: string;
  url?: string;
  freeMode: FreeProviderCatalogEntry["freeMode"];
  quotaNote: string;
  privacyNote?: string;
  freeModels: string[];
  runtimeConfigured: boolean;
  capabilities: { vision: boolean; tools: boolean; contextWindow: number };
}

const fallbackTemplates: ProviderTemplateView[] = [
  { kind: "groq", name: "Groq", model: "llama-3.3-70b-versatile", freeMode: "free-account-tier", quotaNote: "Free-plan model quotas reset on the provider schedule.", freeModels: ["llama-3.3-70b-versatile"], runtimeConfigured: false, capabilities: { vision: false, tools: true, contextWindow: 128000 } },
  { kind: "nvidia", name: "NVIDIA NIM", model: "meta/llama-3.3-70b-instruct", freeMode: "free-account-tier", quotaNote: "Free hosted endpoints are intended for development and prototyping.", freeModels: ["meta/llama-3.3-70b-instruct"], runtimeConfigured: false, capabilities: { vision: false, tools: false, contextWindow: 128000 } },
  { kind: "openrouter", name: "OpenRouter Free", model: "openrouter/free", freeMode: "free-model", quotaNote: "The free router dynamically selects a zero-price model.", freeModels: ["openrouter/free"], runtimeConfigured: false, capabilities: { vision: true, tools: true, contextWindow: 128000 } },
  { kind: "gemini", name: "Google Gemini", model: "gemini-2.5-flash", freeMode: "free-account-tier", quotaNote: "Eligible Gemini models have project-level daily free quotas.", freeModels: ["gemini-2.5-flash"], runtimeConfigured: false, capabilities: { vision: true, tools: true, contextWindow: 1000000 } },
  { kind: "opencode", name: "OpenCode Zen Free", model: "deepseek-v4-flash-free", freeMode: "free-model", quotaNote: "Only documented free chat models are used.", privacyNote: "Free model traffic may be retained or used for model improvement. Do not send personal or confidential data.", freeModels: ["deepseek-v4-flash-free", "mimo-v2.5-free", "north-mini-code-free", "nemotron-3-ultra-free", "big-pickle"], runtimeConfigured: false, capabilities: { vision: false, tools: true, contextWindow: 128000 } },
  { kind: "nous", name: "Nous Portal Free", model: "tencent/hy3:free", freeMode: "free-model", quotaNote: "The current free recommendation list is refreshed daily.", freeModels: ["tencent/hy3:free", "stepfun/step-3.7-flash:free"], runtimeConfigured: false, capabilities: { vision: true, tools: true, contextWindow: 262144 } },
  { kind: "cerebras", name: "Cerebras Inference", model: "gpt-oss-120b", freeMode: "free-account-tier", quotaNote: "Free trial accounts have daily request and token limits.", freeModels: ["gpt-oss-120b"], runtimeConfigured: false, capabilities: { vision: false, tools: true, contextWindow: 128000 } },
  { kind: "sambanova", name: "SambaNova Cloud", model: "Meta-Llama-3.3-70B-Instruct", freeMode: "free-account-tier", quotaNote: "Accounts without a payment method receive daily free quotas.", freeModels: ["Meta-Llama-3.3-70B-Instruct"], runtimeConfigured: false, capabilities: { vision: false, tools: true, contextWindow: 128000 } },
  { kind: "huggingface", name: "Hugging Face Inference", model: "openai/gpt-oss-120b:fastest", freeMode: "monthly-credit", quotaNote: "Free accounts receive a small monthly inference credit.", freeModels: ["openai/gpt-oss-120b:fastest"], runtimeConfigured: false, capabilities: { vision: false, tools: false, contextWindow: 128000 } },
  { kind: "github", name: "GitHub Models", model: "openai/gpt-4.1-mini", freeMode: "free-account-tier", quotaNote: "GitHub accounts receive model-specific free inference limits.", freeModels: ["openai/gpt-4.1-mini"], runtimeConfigured: false, capabilities: { vision: true, tools: true, contextWindow: 128000 } },
  { kind: "mistral", name: "Mistral Free Mode", model: "mistral-small-latest", freeMode: "free-account-tier", quotaNote: "Free mode blocks at its account rate limits.", freeModels: ["mistral-small-latest"], runtimeConfigured: false, capabilities: { vision: false, tools: true, contextWindow: 32768 } },
  { kind: "custom", name: "Custom provider", model: "model-id", url: "https://models.example.com/v1", freeMode: "custom", quotaNote: "Pricing and quota behavior are controlled by the custom provider.", freeModels: [], runtimeConfigured: false, capabilities: { vision: false, tools: false, contextWindow: 32768 } },
];

export function ProvidersSurface() {
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [templates, setTemplates] = useState<ProviderTemplateView[]>(fallbackTemplates);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [kind, setKind] = useState("groq");
  const [name, setName] = useState(fallbackTemplates[0]!.name);
  const [model, setModel] = useState(fallbackTemplates[0]!.model);
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [vision, setVision] = useState(false);
  const [tools, setTools] = useState(true);
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("Secrets are encrypted and cannot be read back.");

  async function load() {
    const [response, catalogResponse] = await Promise.all([
      fetch("/api/cloud/providers", { cache: "no-store" }),
      fetch("/api/cloud/provider-catalog", { cache: "no-store" }),
    ]);
    if (!response.ok) throw new Error("Provider connections are unavailable.");
    setProviders((await response.json() as { data: ProviderRecord[] }).data);
    if (catalogResponse.ok) {
      const entries = (await catalogResponse.json() as { data: FreeProviderCatalogEntry[] }).data;
      setTemplates(entries.map((entry) => ({
        kind: entry.kind,
        name: entry.displayName,
        model: entry.defaultModel,
        ...(entry.baseUrl ? { url: entry.baseUrl } : {}),
        freeMode: entry.freeMode,
        quotaNote: entry.quotaNote,
        ...(entry.privacyNote ? { privacyNote: entry.privacyNote } : {}),
        freeModels: entry.freeModels,
        runtimeConfigured: entry.runtimeConfigured,
        capabilities: entry.capabilities,
      })));
    }
  }

  useEffect(() => { void load().catch((cause) => { setState("error"); setMessage(cause.message); }).finally(() => setLoadingProviders(false)); }, []);

  function changeKind(next: string) {
    const template = templates.find((entry) => entry.kind === next) ?? fallbackTemplates.find((entry) => entry.kind === next);
    setKind(next);
    setName(template?.name || "Provider");
    setModel(template?.model || "model-id");
    setBaseUrl(next === "custom" ? template?.url || "" : "");
    setVision(template?.capabilities.vision ?? false);
    setTools(template?.capabilities.tools ?? false);
  }

  async function refreshCatalog() {
    setState("loading");
    setMessage("Refreshing the public OpenCode and Nous free-model catalogs...");
    const response = await fetch("/api/cloud/provider-catalog/refresh", { method: "POST" }).catch(() => null);
    if (!response?.ok) {
      setState("error");
      setMessage("The live free-model catalogs could not be refreshed; HIVE kept its last known safe list.");
      return;
    }
    await load();
    setState("success");
    setMessage("Free-model catalogs refreshed. Credentials were not sent to catalog endpoints.");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("loading");
    setMessage("Testing the public endpoint before saving...");
    const response = await fetch("/api/cloud/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, name, default_model: model, api_key: key, ...(kind === "custom" ? { base_url: baseUrl } : {}), capabilities: { vision, tools, context_window: 128000 } }),
    }).catch(() => null);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => null) as { error?: { message?: string } } | null : null;
      setState("error");
      setMessage(payload?.error?.message || "The provider could not be saved.");
      return;
    }
    setKey("");
    setState("success");
    setMessage("Provider connected. The secret was encrypted and removed from this form.");
    await load();
  }

  const selectedTemplate = templates.find((entry) => entry.kind === kind) ?? fallbackTemplates.find((entry) => entry.kind === kind)!;

  return (
    <div className="workspace-page">
      <div className="page-heading"><div><h2>Provider control</h2><p>Connect free-tier credentials or a public OpenAI-compatible endpoint. HIVE cools down exhausted routes and continues with the next eligible provider.</p></div><span className="router-pill"><PlugsConnected size={15} /> Free-first BYOK</span></div>
      <div className="settings-grid">
        <section className="panel">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}><h3>Connected providers</h3><button className="button button-secondary" type="button" disabled={state === "loading"} onClick={() => void refreshCatalog()}><ArrowClockwise size={16} /> Refresh free models</button></div>
          <div className="settings-list">
            {loadingProviders ? <><div className="skeleton" /><div className="skeleton" /></> : providers.length === 0 ? <p className="receipt-empty">No provider is connected. Managed routes appear only when the beta owner has granted credits and configured an upstream pool.</p> : providers.map((provider) => <div className="setting-record" key={provider.id}><strong>{provider.name}</strong><span>{provider.status}</span><code>{provider.kind} / {provider.default_model}</code><span><CheckCircle size={15} color="var(--success)" /> encrypted</span></div>)}
          </div>
        </section>
        <form className="panel" onSubmit={(event) => void submit(event)}>
          <h3>Add a provider</h3>
          <div className="field"><label htmlFor="provider-kind">Provider family</label><select className="select" id="provider-kind" value={kind} onChange={(event) => changeKind(event.target.value)}>{templates.map((template) => <option value={template.kind} key={template.kind}>{template.name}{template.runtimeConfigured ? " · runtime connected" : ""}</option>)}</select><small>{selectedTemplate.quotaNote}</small>{selectedTemplate.privacyNote && <small style={{ color: "var(--warning)" }}>{selectedTemplate.privacyNote}</small>}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}><div className="field"><label htmlFor="provider-name">Connection name</label><input className="input" id="provider-name" value={name} onChange={(event) => setName(event.target.value)} required /></div><div className="field"><label htmlFor="provider-model">Default model</label><input className="input" id="provider-model" list="provider-free-models" value={model} onChange={(event) => setModel(event.target.value)} required /><datalist id="provider-free-models">{selectedTemplate.freeModels.map((freeModel) => <option value={freeModel} key={freeModel} />)}</datalist></div></div>
          {kind === "custom" && <div className="field" style={{ marginTop: 12 }}><label htmlFor="provider-url">Public HTTPS base URL</label><input className="input" id="provider-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /><small>Private networks, redirects, embedded credentials, and local endpoints are blocked.</small></div>}
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="provider-key">Provider API key</label><div style={{ display: "grid", gridTemplateColumns: "1fr 44px", gap: 8 }}><input className="input" id="provider-key" type={showKey ? "text" : "password"} value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" required /><button className="icon-button" type="button" aria-label={showKey ? "Hide API key" : "Show API key"} onClick={() => setShowKey((current) => !current)}>{showKey ? <EyeSlash size={18} /> : <Eye size={18} />}</button></div></div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, margin: "16px 0" }}><label className="tool-toggle" data-active={vision}><input type="checkbox" checked={vision} onChange={(event) => setVision(event.target.checked)} /> Vision</label><label className="tool-toggle" data-active={tools}><input type="checkbox" checked={tools} onChange={(event) => setTools(event.target.checked)} /> Tools</label></div>
          <button className="button button-primary" type="submit" disabled={state === "loading"}><CloudArrowUp size={17} /> {state === "loading" ? "Testing..." : "Test and save"}</button>
          <p className="form-message" data-state={state} style={{ marginTop: 12 }}>{message}</p>
        </form>
      </div>
    </div>
  );
}
