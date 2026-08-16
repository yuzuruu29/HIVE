"use client";

import { useCallback, useState } from "react";
import { Check, CopySimple, Link as LinkIcon, Spinner } from "@phosphor-icons/react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { DialogHeader } from "@astryxdesign/core/Dialog";
import { useCopyFeedback } from "../lib/copy-feedback";

interface ShareDialogProps {
  conversationId: string;
  conversationTitle: string;
  open: boolean;
  onClose: () => void;
}

async function createShare(conversationId: string): Promise<{ token: string; url: string }> {
  const response = await fetch(`/api/cloud/conversations/${conversationId}/share`, { method: "POST" });
  if (!response.ok) throw new Error("Failed to create share link.");
  const { data } = await response.json();
  return data as { token: string; url: string };
}

async function revokeShare(conversationId: string): Promise<void> {
  const response = await fetch(`/api/cloud/conversations/${conversationId}/share`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error("Failed to revoke share link.");
}

function buildShareUrl(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/shared/${token}`;
}

export function ShareDialog({ conversationId, conversationTitle, open, onClose }: ShareDialogProps) {
  const [shareUrl, setShareUrl] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string>();
  const { copy, status: copyStatus } = useCopyFeedback();
  const copied = copyStatus === "copied";

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const { token } = await createShare(conversationId);
      setShareUrl(buildShareUrl(token));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create share link.");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  const handleRevoke = useCallback(async () => {
    setRevoking(true);
    setError(undefined);
    try {
      await revokeShare(conversationId);
      setShareUrl(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke share link.");
    } finally {
      setRevoking(false);
    }
  }, [conversationId]);

  const handleCopy = useCallback(async () => {
    if (!shareUrl) return;
    await copy(shareUrl);
  }, [copy, shareUrl]);

  return (
    <Dialog
      isOpen={open}
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      purpose="form"
      width={420}
      data-testid="share-dialog"
    >
      <DialogHeader title="Share conversation" onOpenChange={() => onClose()} />
      <p style={{ color: "var(--muted)", lineHeight: 1.5, margin: 0, padding: "var(--spacing-3) 0" }}>
        Create a public link to share <strong>{conversationTitle}</strong> with anyone.
      </p>

      {error && <div className="error-banner" role="alert" data-testid="share-error" style={{ marginBottom: "var(--spacing-3)" }}>{error}</div>}

      {shareUrl ? (
        <div>
          <div style={{ display: "flex", gap: "var(--spacing-1)", marginBottom: "var(--spacing-3)" }}>
            <input
              className="input"
              readOnly
              value={shareUrl}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              data-testid="share-url-input"
              style={{ flex: 1 }}
            />
            <button
              className="button button-secondary"
              aria-label={copied ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy share link"}
              onClick={handleCopy}
              data-testid="share-copy-button"
            >
              {copied ? <Check size={16} /> : <CopySimple size={16} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <span className="sr-only" aria-live="polite">
            {copied ? "Share link copied to clipboard" : copyStatus === "failed" ? "Share link could not be copied" : ""}
          </span>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="router-pill" style={{ fontSize: "var(--font-size-xs)" }}>Public</span>
            <button className="button button-secondary" disabled={revoking} onClick={handleRevoke} data-testid="share-revoke-button">
              {revoking ? <Spinner size={14} /> : null}
              Revoke link
            </button>
          </div>
        </div>
      ) : (
        <button className="button button-primary" disabled={loading} onClick={handleCreate} style={{ width: "100%" }} data-testid="share-create-button">
          {loading ? <Spinner size={14} /> : <LinkIcon size={16} />}
          {loading ? "Creating..." : "Create share link"}
        </button>
      )}
    </Dialog>
  );
}
