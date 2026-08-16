import { FormEvent, useEffect, useState } from "react";
import type { DesktopCredentialKind, DesktopProviderConfigurationInput, DesktopProviderMetadata } from "../../../../src/desktop/types";
import { Dialog } from "../Dialog";
import { providerConfiguration } from "../utils";
import { StatusPill } from "./StatusPill";

export interface ProviderDialogProps {
  provider?: DesktopProviderMetadata;
  credential: string;
  onCredential: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent, kind: DesktopCredentialKind, configuration: DesktopProviderConfigurationInput) => Promise<void>;
  onApprove: (provider: DesktopProviderMetadata) => Promise<void>;
}

export function ProviderDialog({ provider, credential, onCredential, onClose, onSubmit, onApprove }: ProviderDialogProps) {
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? "");

  useEffect(() => {
    setBaseUrl(provider?.baseUrl ?? "");
    setDefaultModel(provider?.defaultModel ?? "");
  }, [provider?.id, provider?.baseUrl, provider?.defaultModel]);

  if (!provider) {
    return (
      <Dialog title="Configure provider" onClose={onClose}>
        <p>No provider is selected.</p>
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </Dialog>
    );
  }

  if (provider.authType === "none") {
    return (
      <Dialog title="Configure provider" onClose={onClose}>
        <p><strong>{provider.name}</strong> uses local or environment configuration and requires no desktop secret.</p>
        <StatusPill tone={provider.configured ? "success" : "warning"}>
          {provider.configured ? "Configured" : "Approval required"}
        </StatusPill>
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>Cancel provider setup</button>
          {!provider.configured && <button onClick={() => void onApprove(provider)}>Approve local provider</button>}
        </div>
      </Dialog>
    );
  }

  const kind: DesktopCredentialKind = provider.authType;
  const configurableEndpoint = provider.id === "hive-cloud";
  const configuredProvider: DesktopProviderMetadata = {
    ...provider,
    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim().replace(/\/+$/, "") } : {}),
    ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
  };

  return (
    <Dialog title="Configure provider" onClose={onClose}>
      <p>Credentials are encrypted by Windows and never returned to this window.</p>
      <form onSubmit={(event) => void onSubmit(event, kind, providerConfiguration(configuredProvider))}>
        {configurableEndpoint && (
          <>
            <label htmlFor="provider-base-url">HIVE Cloud /v1 base URL</label>
            <input
              id="provider-base-url"
              type="url"
              required
              value={baseUrl}
              placeholder="https://your-api.up.railway.app/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <label htmlFor="provider-model">Model</label>
            <input
              id="provider-model"
              required
              value={defaultModel}
              onChange={(event) => setDefaultModel(event.target.value)}
            />
          </>
        )}
        <label htmlFor="credential">
          {provider.id === "hive-cloud" ? "HIVE API key" : kind === "api-key" ? "API key" : kind === "bearer" ? "Bearer token" : "OAuth token"}
        </label>
        <input
          id="credential"
          type="password"
          autoComplete="off"
          value={credential}
          onChange={(event) => onCredential(event.target.value)}
        />
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel provider setup</button>
          <button disabled={!credential || (configurableEndpoint && (!baseUrl.trim() || !defaultModel.trim()))}>
            Store encrypted credential
          </button>
        </div>
      </form>
    </Dialog>
  );
}
