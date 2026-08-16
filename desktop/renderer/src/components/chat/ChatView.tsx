import { useEffect, useState } from "react";
import type { DesktopEvent } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopViewState } from "../../state";
import { ChatComposer } from "./ChatComposer";
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
  const active = chat.active;
  const streaming = active ? chat.streaming[active.id] : undefined;
  const failed = Boolean(active && chat.lastFailed?.conversationId === active.id);

  const [draft, setDraft] = useState("");
  const [roleChoice, setRoleChoice] = useState<string | undefined>(undefined);
  const [ground, setGround] = useState(false);
  const [council, setCouncil] = useState(false);
  const [councilPreset, setCouncilPreset] = useState("standard");
  const [override, setOverride] = useState<{ providerId?: string; model?: string } | undefined>(undefined);

  // Conversation switches reset per-conversation composer state.
  useEffect(() => {
    setDraft("");
    setRoleChoice(undefined);
    setGround(active?.ground ?? false);
    setOverride(undefined);
  }, [active?.id]);

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
    if (!active) return;
    await send({ type: "chat.send", input: { conversationId: active.id, content } });
  }

  async function sendMessage(): Promise<void> {
    if (!active || !draft.trim()) return;
    const content = draft.trim();
    setDraft("");
    await send({
      type: "chat.send",
      input: {
        conversationId: active.id,
        content,
        ...(roleChoice ? { role: roleChoice } : {}),
        ...(override?.providerId || override?.model ? { providerId: override.providerId, model: override.model } : {}),
        ground,
      },
    });
  }

  async function stopStreaming(): Promise<void> {
    if (!active) return;
    await send({ type: "chat.cancel", conversationId: active.id });
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
        {!active ? (
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
              <strong>{chat.conversations.find((entry) => entry.id === active.id)?.title ?? "Conversation"}</strong>
              <span className="role-chip">[{roleChoice ?? active.role}]</span>
              <button type="button" className="link-btn" onClick={() => void archiveConversation(active.id)}>
                archive
              </button>
            </header>
            <ChatStream
              conversation={active}
              streaming={streaming}
              route={chat.routes[roleChoice ?? active.role] ?? chat.routes.auto}
              disabled={Boolean(streaming)}
              onRetry={(content) => void retryMessage(content)}
            />
            <ChatComposer
              conversation={active}
              draft={draft}
              setDraft={setDraft}
              streaming={Boolean(streaming)}
              providers={state.providers}
              routes={chat.routes}
              role={roleChoice ?? active.role}
              onRoleChange={setRoleChoice}
              ground={ground}
              onGroundChange={setGround}
              council={council}
              onCouncilChange={setCouncil}
              councilPreset={councilPreset}
              onCouncilPresetChange={setCouncilPreset}
              override={override}
              onOverrideChange={setOverride}
              send={send}
              onSend={() => void sendMessage()}
              onStop={() => void stopStreaming()}
              failed={failed}
            />
          </div>
        )}
      </section>
    </div>
  );
}
