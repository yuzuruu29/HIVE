import { useMemo } from "react";
import type { DesktopChatMessage } from "../../../../../src/desktop/types";
import { renderMarkdown } from "../../markdown";
import { formatTime } from "../../utils";
import { MessageActions } from "./MessageActions";

export interface MessageListProps {
  messages: DesktopChatMessage[];
  disabled: boolean;
  onRetry: (content: string) => void;
}

/** Completed conversation messages, newest last, with hover actions on replies. */
export function MessageList({ messages, disabled, onRetry }: MessageListProps) {
  const rendered = useMemo(
    () =>
      messages.map((message, index) => {
        const isUser = message.role === "user";
        const precedingUser = !isUser ? [...messages.slice(0, index)].reverse().find((entry) => entry.role === "user") : undefined;
        return (
          <li key={message.id} className={`message message-${message.role} anim-in`}>
            <header>
              <strong>{isUser ? "You" : "HIVE"}</strong>
              <time dateTime={message.at}>{formatTime(message.at)}</time>
            </header>
            <div className="message-body">{isUser ? <p>{message.content}</p> : renderMarkdown(message.content)}</div>
            {!isUser && (
              <MessageActions message={message} disabled={disabled} onRetry={() => precedingUser && onRetry(precedingUser.content)} retryAvailable={Boolean(precedingUser)} />
            )}
          </li>
        );
      }),
    [messages, disabled, onRetry],
  );
  return <>{rendered}</>;
}
