import type { DesktopViewState } from "../../state";

export interface ChatViewProps {
  state: DesktopViewState;
}

/** Placeholder chat surface shell — Task 4 builds the rail and welcome state. */
export function ChatView(_props: ChatViewProps) {
  return (
    <div className="chat-grid" role="main" aria-label="Chat workspace">
      <section className="chat-rail" aria-label="Conversations" />
      <section className="chat-center" aria-label="Conversation" />
    </div>
  );
}
