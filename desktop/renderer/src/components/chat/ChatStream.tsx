import { useEffect, useRef } from "react";
import type { DesktopChatConversation } from "../../../../../src/desktop/types";
import { renderMarkdown } from "../../markdown";
import type { ChatRouteInfo } from "../../state";
import { MessageList } from "./MessageList";
import { TypingLoader } from "./TypingLoader";

export interface ChatStreamProps {
  conversation: DesktopChatConversation;
  streaming: { turnId: string; text: string } | undefined;
  route?: ChatRouteInfo;
  disabled: boolean;
  onRetry: (content: string) => void;
}

const NEAR_BOTTOM_PX = 80;

/** Streaming conversation surface: log role, live markdown, caret, stick-to-bottom scroll. */
export function ChatStream({ conversation, streaming, route, disabled, onRetry }: ChatStreamProps) {
  const scrollRef = useRef<HTMLOListElement>(null);

  // Stick to bottom only while the reader is already near the bottom.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom) element.scrollTop = element.scrollHeight;
  }, [conversation.messages, streaming?.text]);

  return (
    <ol className="chat-messages" role="log" aria-live="polite" aria-label="Conversation messages" ref={scrollRef}>
      <MessageList messages={conversation.messages} disabled={disabled} onRetry={onRetry} />
      {streaming && (
        <li className="message message-assistant message-streaming anim-in">
          <header>
            <strong>HIVE</strong>
          </header>
          <div className="message-body">
            {streaming.text ? (
              <>
                {renderMarkdown(streaming.text)}
                <span className="stream-caret" aria-hidden="true" />
              </>
            ) : (
              <TypingLoader role={conversation.role} route={route} />
            )}
          </div>
        </li>
      )}
    </ol>
  );
}
