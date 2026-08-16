"use client";

import { useEffect, useState } from "react";
import { CrownSimple, FloppyDisk } from "@phosphor-icons/react";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Spinner } from "@astryxdesign/core/Spinner";

interface Settings { systemPrompt: string | null; defaultModel: string | null; temperature: number | null; }

export function GeneralSettingsSurface() {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [systemPrompt, setSystemPrompt] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [temperature, setTemperature] = useState("");

  useEffect(() => {
    fetch("/api/cloud/settings", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Settings are unavailable.");
        const data = (await response.json() as { data: Settings }).data;
        setSettings(data);
        setSystemPrompt(data.systemPrompt || "");
        setDefaultModel(data.defaultModel || "");
        setTemperature(data.temperature !== null ? String(data.temperature) : "");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Settings are unavailable."));
  }, []);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/cloud/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemPrompt: systemPrompt || null,
          defaultModel: defaultModel || null,
          temperature: temperature ? parseFloat(temperature) : null,
        }),
      });
      if (!response.ok) throw new Error("Failed to save settings");
      const data = (await response.json() as { data: Settings }).data;
      setSettings(data);
      setSaved(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="workspace-page">
      <div className="page-heading">
        <div>
          <h2>General settings</h2>
          <p>Configure defaults for new conversations. These settings will automatically apply when you start a new chat.</p>
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}

      {!settings ? (
        error ? null : <div className="panel settings-panel" aria-busy="true"><div className="skeleton settings-skeleton" /></div>
      ) : (
        <form className="panel settings-panel" onSubmit={saveSettings} onChange={() => setSaved(false)}>
          <span className="router-pill settings-route"><CrownSimple size={14} weight="fill" aria-hidden="true" /> Conversation defaults</span>

          <TextArea
            label="System prompt"
            description="Prepended to new requests. Maximum 4,000 characters."
            value={systemPrompt}
            onChange={(value: string) => setSystemPrompt(value)}
            maxLength={4_000}
            rows={5}
            placeholder="e.g. You are a helpful AI assistant..."
          />

          <TextInput
            label="Default model"
            description="Model ID used when no override is selected."
            value={defaultModel}
            onChange={(value: string) => setDefaultModel(value)}
            placeholder="e.g. gpt-4o"
          />

          <NumberInput
            label="Temperature"
            description="Optional value from 0 to 2."
            value={temperature ? parseFloat(temperature) : undefined}
            onChange={(value: number | undefined) => setTemperature(value !== undefined ? String(value) : "")}
            min={0}
            max={2}
          />

          <div className="settings-actions">
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? <Spinner size="sm" /> : <FloppyDisk size={16} aria-hidden="true" />}
              {saving ? "Saving..." : "Save settings"}
            </button>
            <span className="form-message" data-state={saved ? "success" : undefined} aria-live="polite">{saved ? "Settings saved." : ""}</span>
          </div>
        </form>
      )}
    </div>
  );
}
