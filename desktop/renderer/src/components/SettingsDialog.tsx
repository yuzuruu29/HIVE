import { FormEvent, useEffect, useId, useRef, useState } from "react";
import type { DesktopModelInfo, DesktopProviderMetadata } from "../../../../src/desktop/types";
import { Dialog } from "../Dialog";
import { CubeIcon, HiveMark, KeyIcon, SlidersIcon } from "../shell/icons";
import { usePrefs } from "../prefs";

export interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: "general" | "models" | "catalog";
  providers?: DesktopProviderMetadata[];
  modelsByProvider?: Record<string, DesktopModelInfo[]>;
  modelsLoading?: Record<string, boolean>;
  onFetchModels?: (providerId: string) => void;
  onConfigureProvider?: (providerId: string) => void;
  onAddCompatibleProvider?: (input: { id: string; name: string; baseUrl: string; defaultModel: string }) => Promise<void>;
}

function formatContext(tokens?: number): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${tokens / 1_000_000 >= 1 ? (tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1) : 1}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
}

export function SettingsDialog({
  onClose,
  initialTab = "general",
  providers = [],
  modelsByProvider = {},
  modelsLoading = {},
  onFetchModels,
  onConfigureProvider,
  onAddCompatibleProvider,
}: SettingsDialogProps) {
  const { prefs, updatePrefs } = usePrefs();
  const [tab, setTab] = useState<"general" | "models" | "catalog">(initialTab);
  const tabId = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const [horizontalTabs, setHorizontalTabs] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [busy, setBusy] = useState(false);
  const addingProviderRef = useRef(false);
  const [addProviderFailed, setAddProviderFailed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const density = prefs.density ?? "comfortable";
  const accent = prefs.accent ?? "vivid";
  const notifications = prefs.notifications ?? true;
  const enabledModels = prefs.enabledModels ?? {};

  useEffect(() => {
    const compact = window.matchMedia?.("(max-width: 800px)");
    if (!compact) return;
    const syncOrientation = () => setHorizontalTabs(compact.matches);
    syncOrientation();
    compact.addEventListener("change", syncOrientation);
    return () => compact.removeEventListener("change", syncOrientation);
  }, []);

  useEffect(() => {
    if (tab !== "catalog" || !onFetchModels) return;
    providers.forEach((provider) => {
      if (provider.configured && !modelsByProvider[provider.id] && !modelsLoading[provider.id]) {
        void Promise.resolve(onFetchModels(provider.id)).catch(() => undefined);
      }
    });
  }, [providers, tab]);

  async function addProvider(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (addingProviderRef.current) return;
    setAddProviderFailed(false);
    if (!onAddCompatibleProvider || !name.trim() || !baseUrl.trim() || !defaultModel.trim()) return;
    addingProviderRef.current = true;
    setBusy(true);
    try {
      const baseId = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "custom";
      let id = baseId;
      let suffix = 2;
      while (providers.some((provider) => provider.id === id)) id = `${baseId}-${suffix++}`;
      await onAddCompatibleProvider({
        id,
        name: name.trim(),
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        defaultModel: defaultModel.trim(),
      });
      setName("");
      setBaseUrl("");
      setDefaultModel("");
      setAdding(false);
    } catch {
      setAddProviderFailed(true);
    } finally {
      addingProviderRef.current = false;
      setBusy(false);
    }
  }

  function toggleModel(modelId: string): void {
    const isCurrentlyEnabled = enabledModels[modelId] !== false; // defaults to true
    const next = { ...enabledModels, [modelId]: !isCurrentlyEnabled };
    updatePrefs({ enabledModels: next });
  }

  const pageTitle = tab === "general" ? "General" : tab === "models" ? "Providers" : "Models";
  const sendWithEnter = prefs.composerSendWithEnter !== false;

  const configuredProviders = providers.filter((p) => p.configured);
  const unconfiguredProviders = providers.filter((p) => !p.configured);
  const isAnyLoading = configuredProviders.some((p) => modelsLoading[p.id]);

  const allModelItems: Array<{ model: DesktopModelInfo; provider: DesktopProviderMetadata }> = [];
  for (const provider of configuredProviders) {
    const providerModels = modelsByProvider[provider.id] || [];
    for (const model of providerModels) {
      allModelItems.push({ model, provider });
    }
  }

  const query = searchQuery.trim().toLowerCase();
  const filteredItems = allModelItems.filter(({ model, provider }) => {
    if (!query) return true;
    return (
      model.id.toLowerCase().includes(query) ||
      (model.name && model.name.toLowerCase().includes(query)) ||
      provider.name.toLowerCase().includes(query)
    );
  });

  return (
    <Dialog title="Preferences & Accessibility" onClose={onClose} className="settings-modal">
      <div className="settings-shell">
        <aside className="settings-sidebar">
          <button type="button" className="settings-back-btn" onClick={onClose}>
            <span aria-hidden="true">←</span>
            Back to workspace
          </button>

          <div className="settings-sidebar-scroll">
            <div className="settings-sidebar-group" role="tablist" aria-label="Settings sections" aria-orientation={horizontalTabs ? "horizontal" : "vertical"} ref={tabsRef} onKeyDown={(event) => {
              const tabs = ["general", "models", "catalog"] as const;
              const index = tabs.indexOf(tab);
              const next = event.key === (horizontalTabs ? "ArrowRight" : "ArrowDown") ? tabs[(index + 1) % tabs.length]
                : event.key === (horizontalTabs ? "ArrowLeft" : "ArrowUp") ? tabs[(index + tabs.length - 1) % tabs.length]
                : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
              if (!next) return;
              event.preventDefault();
              setTab(next);
              tabsRef.current?.querySelector<HTMLButtonElement>(`[data-settings-tab="${next}"]`)?.focus();
            }}>
              <span className="settings-sidebar-heading">Settings</span>
              <button
                type="button"
                role="tab"
                className={`settings-nav-item ${tab === "general" ? "is-active" : ""}`}
                aria-selected={tab === "general"}
                id={`${tabId}-general`} data-settings-tab="general" aria-controls={`${tabId}-panel`} tabIndex={tab === "general" ? 0 : -1}
                onClick={() => setTab("general")}
              >
                <span className="settings-nav-icon" aria-hidden="true"><SlidersIcon /></span>
                <span>General</span>
              </button>
              <button
                type="button"
                role="tab"
                className={`settings-nav-item ${tab === "models" ? "is-active" : ""}`}
                aria-selected={tab === "models"}
                id={`${tabId}-models`} data-settings-tab="models" aria-controls={`${tabId}-panel`} tabIndex={tab === "models" ? 0 : -1}
                onClick={() => setTab("models")}
              >
                <span className="settings-nav-icon" aria-hidden="true"><KeyIcon /></span>
                <span>Providers</span>
              </button>
              <button
                type="button"
                role="tab"
                className={`settings-nav-item ${tab === "catalog" ? "is-active" : ""}`}
                aria-selected={tab === "catalog"}
                id={`${tabId}-catalog`} data-settings-tab="catalog" aria-controls={`${tabId}-panel`} tabIndex={tab === "catalog" ? 0 : -1}
                onClick={() => setTab("catalog")}
              >
                <span className="settings-nav-icon" aria-hidden="true"><CubeIcon /></span>
                <span>Models</span>
              </button>
            </div>

          </div>

          <div className="settings-sidebar-footer">
            <span className="settings-operator-mark" aria-hidden="true"><HiveMark size={16} /></span>
            <div>
              <strong>Local Mode</strong>
              <span>No account · keys stay on this PC</span>
            </div>
          </div>
        </aside>

        <section className="settings-content-pane" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
          <header className="settings-page-header">
            <div>
              <h2 className="settings-page-title">{pageTitle}</h2>
            </div>
          </header>

          {tab === "general" && (
            <div className="settings-pane-body">
              <article className="settings-card">
                <div className="settings-card-copy">
                  <h3>Theme</h3>
                  <p>Follow Windows, or pin HIVE to light or dark.</p>
                </div>
                <fieldset className="settings-card-control">
                  <legend className="sr-only">Theme</legend>
                  <div className="settings-segment">
                    {(["system", "light", "dark"] as const).map((value) => (
                      <label className="settings-label" key={value}>
                        <input
                          type="radio"
                          name="theme"
                          value={value}
                          checked={(prefs.theme ?? "system") === value}
                          onChange={() => updatePrefs({ theme: value })}
                        />
                        <span>{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </article>

              <article className="settings-card">
                <div className="settings-card-copy">
                  <h3>Layout density</h3>
                  <p>Comfortable or compact spacing for rails, chat, and the file tree.</p>
                </div>
                <fieldset className="settings-card-control">
                  <legend className="sr-only">Layout Density</legend>
                  <div className="settings-segment">
                    <label className="settings-label">
                      <input
                        type="radio"
                        name="density"
                        value="comfortable"
                        checked={density === "comfortable"}
                        onChange={() => updatePrefs({ density: "comfortable" })}
                      />
                      <span>Comfortable (default)</span>
                    </label>
                    <label className="settings-label">
                      <input
                        type="radio"
                        name="density"
                        value="compact"
                        checked={density === "compact"}
                        onChange={() => updatePrefs({ density: "compact" })}
                      />
                      <span>Compact</span>
                    </label>
                  </div>
                </fieldset>
              </article>

              <article className="settings-card">
                <div className="settings-card-copy">
                  <h3>Color accent</h3>
                  <p>Vivid violet chrome, or high contrast when you need stronger edges.</p>
                </div>
                <fieldset className="settings-card-control">
                  <legend className="sr-only">Color Accent</legend>
                  <div className="settings-segment">
                    <label className="settings-label">
                      <input
                        type="radio"
                        name="accent"
                        value="vivid"
                        checked={accent === "vivid"}
                        onChange={() => updatePrefs({ accent: "vivid" })}
                      />
                      <span>Vivid</span>
                    </label>
                    <label className="settings-label">
                      <input
                        type="radio"
                        name="accent"
                        value="contrast"
                        checked={accent === "contrast"}
                        onChange={() => updatePrefs({ accent: "contrast" })}
                      />
                      <span>High contrast</span>
                    </label>
                  </div>
                </fieldset>
              </article>

              <article className="settings-card">
                <div className="settings-card-copy">
                  <label className="settings-card-title-label" htmlFor="settings-notifications">
                    Background Notifications (when window is inactive)
                  </label>
                  <p>Show a system notification when a run finishes and HIVE is in the background.</p>
                </div>
                <div className="settings-card-control">
                  <input
                    id="settings-notifications"
                    type="checkbox"
                    checked={notifications}
                    onChange={(e) => updatePrefs({ notifications: e.target.checked })}
                  />
                </div>
              </article>

              <article className="settings-card">
                <div className="settings-card-copy">
                  <label className="settings-card-title-label" htmlFor="settings-enter-send">
                    Enter sends the message
                  </label>
                  <p>When off, Enter inserts a newline and Ctrl+Enter sends.</p>
                </div>
                <div className="settings-card-control">
                  <input
                    id="settings-enter-send"
                    type="checkbox"
                    checked={sendWithEnter}
                    onChange={(e) => updatePrefs({ composerSendWithEnter: e.target.checked })}
                  />
                </div>
              </article>
            </div>
          )}

          {tab === "models" && (
            <div className="settings-pane-body">
              <h3 className="sr-only">Model providers</h3>
              <p className="settings-lead">
                Add an API key or an OpenAI-compatible endpoint. Secrets are encrypted by Windows and never shown again.
              </p>
              <ul className="provider-settings-list">
                {providers.length === 0 && <li className="settings-empty">No providers registered yet.</li>}
                {providers.map((provider) => (
                  <li key={provider.id} className="provider-settings-row">
                    <div className="provider-info-cell">
                      <span className={`provider-status-dot ${provider.configured ? "is-connected" : ""}`} />
                      <div>
                        <strong>{provider.name}</strong>
                        <span className="provider-settings-meta">
                          {provider.defaultModel ?? provider.kind}
                          {provider.configured ? " · configured" : " · not configured"}
                        </span>
                      </div>
                    </div>
                    <div className="provider-actions-cell">
                      {provider.configured && onFetchModels && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => { void Promise.resolve(onFetchModels(provider.id)).catch(() => undefined); }}
                          title="Refresh available models"
                        >
                          Refresh models
                        </button>
                      )}
                      {onConfigureProvider && (
                        <button type="button" className="secondary" onClick={() => onConfigureProvider(provider.id)}>
                          Configure
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {onAddCompatibleProvider && (
                adding ? (
                  <form className="stack compact add-provider-form" onSubmit={(event) => void addProvider(event)}>
                    <label htmlFor="custom-provider-name">Provider name</label>
                    <input id="custom-provider-name" disabled={busy} value={name} onChange={(event) => setName(event.target.value)} required placeholder="DeepSeek" />
                    <label htmlFor="custom-provider-url">OpenAI-compatible base URL</label>
                    <input id="custom-provider-url" disabled={busy} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required placeholder="https://api.example.com/v1" />
                    <label htmlFor="custom-provider-model">Default model</label>
                    <input id="custom-provider-model" disabled={busy} value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} required placeholder="model-id" />
                    {addProviderFailed && (
                      <p className="composer-send-error" role="alert">
                        Provider could not be added. Check the details and try again. Your entries have been kept.
                      </p>
                    )}
                    <div className="settings-inline-actions">
                      <button type="button" className="secondary" disabled={busy} onClick={() => { setAddProviderFailed(false); setAdding(false); }}>Cancel</button>
                      <button type="submit" disabled={busy}>Save provider</button>
                    </div>
                  </form>
                ) : (
                  <button type="button" className="secondary add-provider-toggle-btn" onClick={() => setAdding(true)}>
                    + Add OpenAI-compatible provider
                  </button>
                )
              )}
            </div>
          )}

          {tab === "catalog" && (
            <div className="settings-pane-body">
              <div className="model-search-bar">
                <input
                  type="search"
                  className="model-search-input"
                  placeholder="Search models"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Search models"
                />
              </div>

              {isAnyLoading && (
                <div className="model-loading-shimmer" aria-busy="true">
                  <span>Discovering available models from endpoint...</span>
                </div>
              )}

              {allModelItems.length === 0 && !isAnyLoading ? (
                configuredProviders.length === 0 ? (
                  <div className="unconfigured-provider-hint">
                    <span>Configure an API or local provider to see available models</span>
                    <div className="unconfigured-provider-actions">
                      <button
                        type="button"
                        className="secondary connect-btn"
                        onClick={() => setTab("models")}
                      >
                        Open Providers
                      </button>
                      {onConfigureProvider && unconfiguredProviders[0] && (
                        <button
                          type="button"
                          className="secondary connect-btn"
                          onClick={() => onConfigureProvider(unconfiguredProviders[0].id)}
                        >
                          Configure
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="no-models-hint">
                    No models returned. Click Refresh to query endpoint.
                  </div>
                )
              ) : filteredItems.length === 0 && query ? (
                <div className="no-models-hint">
                  No models match your search.
                </div>
              ) : (
                <div className="model-flat-container">
                  <ul className="model-rows-list">
                    {filteredItems.map(({ model, provider }) => {
                      const isEnabled = enabledModels[model.id] !== false;
                      const displayName = model.name && model.name !== model.id ? model.name : model.id;
                      return (
                        <li key={`${provider.id}-${model.id}`} className="model-item-row">
                          <div className="model-info-block">
                            <div className="model-title-line">
                              <span className="model-display-name">{displayName}</span>
                              <span className="model-provider-badge">{provider.name}</span>
                            </div>
                            <div className="model-sub-line">
                              {displayName !== model.id ? <span className="model-id-label">{model.id}</span> : null}
                              {model.contextWindow && (
                                <span className="model-context-badge">
                                  {formatContext(model.contextWindow)}
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={isEnabled}
                            aria-label={`Enable ${model.id}`}
                            className={`model-toggle-switch ${isEnabled ? "is-on" : "is-off"}`}
                            onClick={() => toggleModel(model.id)}
                          >
                            <span className="toggle-thumb" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="settings-hint">
                    Models come from configured providers. Turned-off models are hidden from the model picker.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
