import { KeyboardEvent, useEffect, useRef, useState } from "react";
import type { DesktopChatConversation, DesktopEvent, DesktopProviderMetadata } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import { usePrefs } from "../../prefs";
import type { ChatRouteInfo } from "../../state";
import { RolePicker } from "./RolePicker";

const MAX_CHARS = 24_000;
const MAX_ROWS = 8;

export interface ChatComposerProps {
  conversation: DesktopChatConversation;
  draft: string;
  setDraft: (value: string) => void;
  streaming: boolean;
  providers: DesktopProviderMetadata[];
  routes: Record<string, ChatRouteInfo>;
  role: string;
  onRoleChange: (role: string) => void;
  ground: boolean;
  onGroundChange: (ground: boolean) => void;
  council: boolean;
  onCouncilChange: (council: boolean) => void;
  councilPreset: string;
  onCouncilPresetChange: (preset: string) => void;
  override: { providerId?: string; model?: string } | undefined;
  onOverrideChange: (override: { providerId?: string; model?: string } | undefined) => void;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  onSend: () => void;
  onStop: () => void;
  failed: boolean;
}

/** Bottom-anchored composer: auto-growing textarea, role/ground/council chips, Send/Stop. */
export function ChatComposer(props: ChatComposerProps) {
  const { conversation, draft, setDraft, streaming, providers, routes, role, onRoleChange, ground, onGroundChange, council, onCouncilChange, councilPreset, onCouncilPresetChange, override, onOverrideChange, send, onSend, onStop, failed } = props;
  const { prefs, updatePrefs } = usePrefs();
  const sendWithEnter = prefs.composerSendWithEnter ?? true;
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const lastSentRef = useRef<string | null>(null);

  // A failed turn restores the draft so the user can edit and resend.
  useEffect(() => {
    if (failed && lastSentRef.current !== null) {
      setDraft(lastSentRef.current);
      lastSentRef.current = null;
    }
  }, [failed]);

  const rows = Math.min(MAX_ROWS, Math.max(1, draft.split("\n").length));
  const canSend = !streaming && draft.trim().length > 0;

  function submit(): void {
    if (!canSend) return;
    lastSentRef.current = draft;
    setDraft("");
    onSend();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const enterSends = sendWithEnter ? event.key === "Enter" && !event.shiftKey : event.key === "Enter" && (event.ctrlKey || event.metaKey);
    if (enterSends) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="composer-chips" aria-label="Composer options">
        <RolePicker role={role} routes={routes} send={send} onSelect={onRoleChange} />
        <button
          type="button"
          className={`composer-chip toggle${ground ? " on" : ""}`}
          aria-pressed={ground}
          aria-label="Toggle Scout grounding"
          title="Prepend a Scout context pack from this repository"
          onClick={() => onGroundChange(!ground)}
        >
          [/ground{ground ? ": on" : ""}]
        </button>
        <div className="chip-popover">
          <button
            type="button"
            className="composer-chip"
            aria-haspopup="listbox"
            aria-expanded={providerMenuOpen}
            aria-label="Provider override"
            onClick={() => setProviderMenuOpen((value) => !value)}
          >
            [{override ? `${override.providerId}/${override.model ?? "default"}` : "provider: role default"} v]
          </button>
          {providerMenuOpen && (
            <ul className="chip-menu" role="listbox" aria-label="Providers">
              <li role="option" aria-selected={!override}>
                <button
                  type="button"
                  className="chip-option"
                  onClick={() => {
                    onOverrideChange(undefined);
                    setProviderMenuOpen(false);
                  }}
                >
                  <span>role default</span>
                </button>
              </li>
              {providers.map((provider) => (
                <li key={provider.id} role="option" aria-selected={override?.providerId === provider.id}>
                  <button
                    type="button"
                    className="chip-option"
                    onClick={() => {
                      onOverrideChange({ providerId: provider.id, model: provider.defaultModel });
                      setProviderMenuOpen(false);
                    }}
                  >
                    <span>{provider.name}</span>
                    <span className="route-chip">{provider.defaultModel ? `${provider.id}/${provider.defaultModel}` : provider.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className={`composer-chip toggle${council ? " on" : ""}`}
          aria-pressed={council}
          aria-label="Toggle council mode"
          title="Route the next message through the six-role hivebot council"
          onClick={() => onCouncilChange(!council)}
        >
          [/council{council ? ": on" : ""}]
        </button>
        {council && (
          <label className="composer-chip preset">
            preset:
            <select
              aria-label="Council preset"
              value={councilPreset}
              onChange={(event) => onCouncilPresetChange(event.target.value)}
            >
              <option value="quick">quick</option>
              <option value="standard">standard</option>
              <option value="deep">deep</option>
              <option value="audit">audit</option>
            </select>
          </label>
        )}
        <button
          type="button"
          className="composer-chip toggle"
          aria-pressed={sendWithEnter}
          aria-label="Toggle Enter to send"
          title={sendWithEnter ? "Enter sends; Shift+Enter inserts a newline" : "Ctrl+Enter sends; Enter inserts a newline"}
          onClick={() => updatePrefs({ composerSendWithEnter: !sendWithEnter })}
        >
          [{sendWithEnter ? "enter: send" : "ctrl-enter: send"}]
        </button>
      </div>

      <div className="composer-main">
        <textarea
          value={draft}
          rows={rows}
          maxLength={MAX_CHARS}
          aria-label={`Message HIVE (${conversation.role})`}
          placeholder={council ? "Describe the task for the council..." : "Message HIVE..."}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="char-counter" aria-label="Character count">
          {draft.length} / {MAX_CHARS.toLocaleString()}
        </span>
        {streaming ? (
          <button type="button" className="stop-btn" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="send-btn" disabled={!canSend}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}
