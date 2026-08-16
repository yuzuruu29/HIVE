import { useState } from "react";
import type { DesktopChatMessage } from "../../../../../src/desktop/types";
import type { ChatReceipt } from "../../../../../src/chat/types";
import { copyTextToClipboard } from "../../markdown";

export interface MessageActionsProps {
  message: DesktopChatMessage;
  disabled: boolean;
  onRetry: () => void;
  retryAvailable: boolean;
}

function receiptLine(receipt: ChatReceipt): string {
  const tokens = receipt.totalTokens ?? (receipt.promptTokens ?? 0) + (receipt.completionTokens ?? 0);
  const latency = receipt.latencyMs !== undefined ? `${(receipt.latencyMs / 1000).toFixed(1)}s` : "?";
  const degraded = receipt.degraded ? " (degraded)" : "";
  return `${receipt.role} -> ${receipt.providerId}/${receipt.model} - ${tokens.toLocaleString()} tok - ${latency}${degraded}`;
}

/** Hover/focus action row for assistant messages: copy, retry, truthful receipt chip. */
export function MessageActions({ message, disabled, onRetry, retryAvailable }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const receipt = message.receipt;

  return (
    <div className="message-actions">
      <button
        type="button"
        className="link-btn"
        disabled={disabled}
        onClick={() => {
          void copyTextToClipboard(message.content).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          });
        }}
      >
        {copied ? "copied!" : "copy"}
      </button>
      {retryAvailable && (
        <button type="button" className="link-btn" disabled={disabled} onClick={onRetry}>
          retry
        </button>
      )}
      {receipt && <span className="receipt-chip">{receiptLine(receipt)}</span>}
    </div>
  );
}
