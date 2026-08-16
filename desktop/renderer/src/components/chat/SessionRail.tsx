import { useMemo, useState } from "react";
import type { DesktopChatSummary } from "../../../../../src/desktop/types";
import { formatTime } from "../../utils";

export interface SessionRailProps {
  conversations: DesktopChatSummary[];
  activeId: string | null;
  onLoad: (conversationId: string) => void;
  onCreate: () => void;
  onArchive: (conversationId: string) => void;
}

/** Left rail for the chat surface: filter, new chat, active conversations, archived group. */
export function SessionRail({ conversations, activeId, onLoad, onCreate, onArchive }: SessionRailProps) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();

  const { active, archived } = useMemo(() => {
    const matches = conversations.filter((conversation) => !needle || conversation.title.toLowerCase().includes(needle) || conversation.role.toLowerCase().includes(needle));
    return {
      active: matches.filter((conversation) => !conversation.archived),
      archived: matches.filter((conversation) => conversation.archived),
    };
  }, [conversations, needle]);

  return (
    <>
      <button type="button" className="new-chat-btn" onClick={onCreate}>
        [+ ] New chat
      </button>
      <input
        type="search"
        className="chat-filter"
        placeholder="Filter conversations"
        aria-label="Filter conversations"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <ul className="plain-list thread-list chat-conversations" aria-label="Conversations">
        {active.map((conversation) => (
          <li key={conversation.id}>
            <button
              type="button"
              aria-current={conversation.id === activeId ? "page" : undefined}
              className={conversation.id === activeId ? "conversation-row current" : "conversation-row"}
              onClick={() => onLoad(conversation.id)}
            >
              <span className="conversation-title">{conversation.title}</span>
              <span className="conversation-meta">
                <span className="role-chip">[{conversation.role}]</span>
                <span>{conversation.messageCount} msgs</span>
                <span>{formatTime(conversation.updatedAt)}</span>
              </span>
            </button>
          </li>
        ))}
        {active.length === 0 && archived.length === 0 && <li className="rail-empty">No conversations.</li>}
      </ul>
      {archived.length > 0 && (
        <details className="archived-chats">
          <summary>Archived [{archived.length}]</summary>
          <ul className="plain-list thread-list">
            {archived.map((conversation) => (
              <li key={conversation.id}>
                <span className="conversation-row archived">
                  <span className="conversation-title">{conversation.title}</span>
                  <span className="conversation-meta">
                    <span className="role-chip">[{conversation.role}]</span>
                    <span>{conversation.messageCount} msgs</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
