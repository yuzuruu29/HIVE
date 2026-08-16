import type { ThreadMessage } from "../../../../src/desktop/types";
import { renderMarkdown } from "../markdown";
import { formatTime } from "../utils";

export interface MessageProps {
  message: ThreadMessage;
  disabled: boolean;
  saving: boolean;
  isRetryTarget: boolean;
  onRetry?: (messageId: string) => Promise<void>;
}

interface ForwardReceipt {
  role?: string;
  provider?: string;
  model?: string;
  tokens?: number;
  latencyMs?: number;
}

export function Message({ message, disabled, saving, isRetryTarget, onRetry }: MessageProps) {
  const isUser = message.role === "user";
  const author = isUser ? "You" : message.role === "assistant" ? "HIVE" : "System";

  const receipt = (message as unknown as { receipt?: ForwardReceipt }).receipt;

  return (
    <li className={`message message-${message.role} anim-in`}>
      <header>
        <strong>{author}</strong>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
      </header>

      <div className="message-body">
        {isUser ? <p>{message.content}</p> : renderMarkdown(message.content)}
      </div>

      {receipt && (
        <div className="receipt-chip">
          {receipt.role ? `${receipt.role} → ` : ""}
          {receipt.provider ?? "provider"}/{receipt.model ?? "model"}
          {typeof receipt.tokens === "number" ? ` · ${receipt.tokens.toLocaleString()} tokens` : ""}
          {typeof receipt.latencyMs === "number" ? ` · ${(receipt.latencyMs / 1000).toFixed(2)}s` : ""}
        </div>
      )}

      {isRetryTarget && onRetry && (
        <div className="message-retry">
          <span>Saved, but the run did not start.</span>
          <button type="button" disabled={disabled || saving} onClick={() => void onRetry(message.id)}>
            Retry run
          </button>
        </div>
      )}
    </li>
  );
}
