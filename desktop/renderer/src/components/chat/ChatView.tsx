import type { DesktopEvent } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopViewState } from "../../state";
import { ChatStream } from "./ChatStream";
import { SessionRail } from "./SessionRail";
import { Welcome } from "./Welcome";

export interface ChatViewProps {
  state: DesktopViewState;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
}

/** Primary conversational surface: sessions rail + welcome or live conversation. */
export function ChatView({ state, send }: ChatViewProps) {
  const { chat } = state;
  const streaming = chat.active ? chat.streaming[chat.active.id] : undefined;

  async function createConversation(role?: string): Promise<void> {
    await send({ type: "chat.create", input: role ? { role } : {} });
  }

  async function loadConversation(conversationId: string): Promise<void> {
    await send({ type: "chat.load", conversationId });
  }

  async function archiveConversation(conversationId: string): Promise<void> {
    await send({ type: "chat.archive", conversationId });
  }

  async function pickRole(role: string): Promise<void> {
    await createConversation(role);
  }

  async function pickSuggestion(text: string): Promise<void> {
    const created = await send({ type: "chat.create", input: {} });
    if (created.type !== "chat.changed") return;
    await send({ type: "chat.send", input: { conversationId: created.conversation.id, content: text } });
  }

  async function retryMessage(content: string): Promise<void> {
    if (!chat.active) return;
    await send({ type: "chat.send", input: { conversationId: chat.active.id, content } });
  }

  return (
    <div className={`chat-grid${!state.rails.left ? " hide-left" : ""}`}>
      <aside className="chat-rail" aria-label="Conversations" hidden={!state.rails.left}>
        <SessionRail
          conversations={chat.conversations}
          activeId={chat.activeId}
          onLoad={(id) => void loadConversation(id)}
          onCreate={() => void createConversation()}
          onArchive={(id) => void archiveConversation(id)}
        />
      </aside>

      <section className="chat-center" aria-label="Conversation">
        {!chat.active ? (
          <Welcome
            repositoryRoot={state.repositoryRoot}
            routes={chat.routes}
            send={send}
            onPickRole={(role) => void pickRole(role)}
            onPickSuggestion={(text) => void pickSuggestion(text)}
          />
        ) : (
          <div className="chat-conversation">
            <header className="chat-conversation-header">
              <strong>{chat.conversations.find((entry) => entry.id === chat.active!.id)?.title ?? "Conversation"}</strong>
              <span className="role-chip">[{chat.active.role}]</span>
              <button type="button" className="link-btn" onClick={() => void archiveConversation(chat.active!.id)}>
                archive
              </button>
            </header>
            <ChatStream
              conversation={chat.active}
              streaming={streaming}
              route={chat.routes[chat.active.role] ?? chat.routes.auto}
              disabled={Boolean(streaming)}
              onRetry={(content) => void retryMessage(content)}
            />
          </div>
        )}
      </section>
    </div>
  );
}
