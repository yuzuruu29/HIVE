import { FormEvent, useEffect, useRef, useState } from "react";
import type { DesktopCredentialKind, DesktopProviderConfigurationInput, DesktopProviderMetadata } from "../../../../src/desktop/types";
import { Dialog } from "../Dialog";
import { providerConfiguration } from "../utils";
import { StatusPill } from "./StatusPill";

export interface ProviderDialogProps {
  provider?: DesktopProviderMetadata;
  credential: string;
  busy?: boolean;
  error?: string | null;
  onCredential: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent, kind: DesktopCredentialKind, configuration: DesktopProviderConfigurationInput) => Promise<void>;
  onApprove: (provider: DesktopProviderMetadata) => Promise<void>;
}

export function ProviderDialog({ provider, credential, busy = false, error = null, onCredential, onClose, onSubmit, onApprove }: ProviderDialogProps) {
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? "");
  const [pending, setPending] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const pendingRef = useRef(false);
  const isBusy = busy || pending;

  function close(): void {
    if (!busy && !pendingRef.current) onClose();
  }

  async function save(action: () => Promise<void>): Promise<void> {
    if (busy || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setSaveFailed(false);
    try {
      await action();
    } catch {
      setSaveFailed(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  // Provider failures may contain authorization data; never echo their raw text.
  const feedback = (
    <>
      {isBusy && <p role="status">Saving provider setup. Keep this dialog open until it finishes.</p>}
      {!isBusy && (error || saveFailed) && (
        <p className="composer-send-error" role="alert">
          Provider setup could not be saved. Check the configuration and try again. Your entries have been kept.
        </p>
      )}
    </>
  );

  useEffect(() => {
    setBaseUrl(provider?.baseUrl ?? "");
    setDefaultModel(provider?.defaultModel ?? "");
    setSaveFailed(false);
  }, [provider?.id, provider?.baseUrl, provider?.defaultModel]);

  if (!provider) {
    return (
      <Dialog title="Configure provider" onClose={close}>
        <p>No provider is selected.</p>
        {feedback}
        <div className="dialog-actions">
          <button disabled={isBusy} onClick={close}>Close</button>
        </div>
      </Dialog>
    );
  }

  if (provider.authType === "none") {
    return (
      <Dialog title="Configure provider" onClose={close}>
        <p><strong>{provider.name}</strong> uses local or environment configuration and requires no desktop secret.</p>
        <StatusPill tone={provider.configured ? "success" : "warning"}>
          {provider.configured ? "Configured" : "Approval required"}
        </StatusPill>
        {feedback}
        <div className="dialog-actions" aria-busy={isBusy}>
          <button className="secondary" disabled={isBusy} onClick={close}>Cancel provider setup</button>
          {!provider.configured && (
            <button disabled={isBusy} onClick={() => void save(() => onApprove(provider))}>
              {isBusy ? "Approving local provider…" : "Approve local provider"}
            </button>
          )}
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
    <Dialog title="Configure provider" onClose={close}>
      <p>Credentials are encrypted by Windows and never returned to this window.</p>
      {feedback}
      <form aria-busy={isBusy} onSubmit={(event) => {
        event.preventDefault();
        if (!credential || (configurableEndpoint && (!baseUrl.trim() || !defaultModel.trim()))) return;
        void save(() => onSubmit(event, kind, providerConfiguration(configuredProvider)));
      }}>
        {configurableEndpoint && (
          <>
            <label htmlFor="provider-base-url">HIVE Cloud /v1 base URL</label>
            <input
              id="provider-base-url"
              type="url"
              disabled={isBusy}
              required
              value={baseUrl}
              placeholder="https://your-api.up.railway.app/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <label htmlFor="provider-model">Model</label>
            <input
              id="provider-model"
              disabled={isBusy}
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
          disabled={isBusy}
          value={credential}
          onChange={(event) => onCredential(event.target.value)}
        />
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={isBusy} onClick={close}>Cancel provider setup</button>
          <button type="submit" disabled={isBusy || !credential || (configurableEndpoint && (!baseUrl.trim() || !defaultModel.trim()))}>
            {isBusy ? "Saving encrypted credential…" : "Store encrypted credential"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
