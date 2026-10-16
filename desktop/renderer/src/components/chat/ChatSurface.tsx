import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import type { DesktopViewState } from "../../state";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopEvent } from "../../../../../src/desktop/types";
import { copyTextToClipboard, renderMarkdown } from "../../markdown";
import { usePrefs } from "../../prefs";
import { preferredScrollBehavior } from "../../utils";
import { ArrowRightIcon, ArrowUpIcon, BookIcon, CheckIcon, ChevronDownIcon, CopyIcon, DiffIcon, FlaskIcon, HiveMark, ListIcon, RefreshIcon, StopIcon } from "../../shell/icons";

export interface ChatModelOption {
  providerId: string;
  providerName: string;
  model: string;
}

export interface ChatSurfaceProps {
  state: DesktopViewState;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  activeModelName?: string;
  modelOptions?: ChatModelOption[];
  selectedModel?: { providerId: string; model: string } | null;
  onSelectModel?: (choice: ChatModelOption) => void;
  onOpenModelPicker?: () => void;
  onOpenSettings?: () => void;
  onHandoffToCoder?: (threadId?: string) => void;
}

const SUGGESTIONS = [
  { icon: <BookIcon />, label: "Explain this codebase", prompt: "Give me a tour of this codebase: the main modules, how they connect, and where I should start reading." },
  { icon: <ListIcon />, label: "Plan a feature", prompt: "Help me plan a new feature. Ask me what it should do, then outline the steps and the files it will touch." },
  { icon: <DiffIcon />, label: "Review recent changes", prompt: "Review my most recent changes and point out bugs, risks and missing tests." },
  { icon: <FlaskIcon />, label: "Write tests", prompt: "Suggest tests for the module I'm working on, starting with the riskiest paths." },
];

const COMPOSER_MAX_HEIGHT = 240;

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Burning the midnight oil?";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function ChatSurface({
  state,
  send,
  activeModelName = "No model",
  modelOptions = [],
  selectedModel = null,
  onSelectModel,
  onOpenModelPicker,
  onOpenSettings,
  onHandoffToCoder,
}: ChatSurfaceProps) {
  const { chat } = state;
  const active = chat.active;
  const streaming = active ? chat.streaming[active.id] : undefined;
  const { prefs } = usePrefs();
  const sendWithEnter = prefs.composerSendWithEnter !== false;
  const matchedModel = modelOptions.find((option) => option.providerId === selectedModel?.providerId && option.model === selectedModel?.model);
  const displayModel = matchedModel ? matchedModel.model : activeModelName;

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastSentRef = useRef<string | null>(null);
  const draftKey = active?.id ?? "new";
  const inputMessage = drafts[draftKey] ?? "";
  const setInputMessage = (value: string) => {
    setDrafts((prev) => ({ ...prev, [draftKey]: value }));
  };
  const quietStop = chat.lastFailed?.message === "Cancelled.";
  const turnFailed = Boolean(active && chat.lastFailed?.conversationId === active.id && !quietStop);
  const composerError = sendError ?? (turnFailed ? chat.lastFailed?.message ?? null : null);
  const lastAssistantId = [...(active?.messages ?? [])].reverse().find((message) => message.role === "assistant")?.id;
  const lastUserContent = [...(active?.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
  const hasMessages = Boolean(active && active.messages.length > 0) || Boolean(streaming);

  useEffect(() => {
    textareaRef.current?.focus();
    setSendError(null);
    setModelMenuOpen(false);
  }, [active?.id]);

  useEffect(() => {
    if (turnFailed && lastSentRef.current) {
      setInputMessage(lastSentRef.current);
      lastSentRef.current = null;
    }
    if (streaming) lastSentRef.current = null;
  }, [turnFailed, streaming]);

  useEffect(() => {
    try {
      if (messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === "function") {
        messagesEndRef.current.scrollIntoView({ behavior: preferredScrollBehavior() });
      }
    } catch {
      // Ignore jsdom scrollIntoView absence
    }
  }, [active?.messages?.length, streaming?.text]);

  // Grow the composer with its content, up to a cap, like the Claude and ChatGPT inputs.
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [inputMessage, hasMessages]);

  function modelOverride(): { providerId?: string; model?: string } {
    if (!selectedModel) return {};
    return { providerId: selectedModel.providerId, model: selectedModel.model };
  }

  const handleSend = async (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    if (streaming || !inputMessage.trim() || sending) return;
    const text = inputMessage.trim();
    lastSentRef.current = text;
    setSendError(null);
    setSending(true);
    try {
      if (active) {
        const sent = await send({
          type: "chat.send",
          input: { conversationId: active.id, content: text, ...modelOverride() },
        });
        if (sent.type === "request.failed") {
          setSendError(sent.message);
          return;
        }
      } else {
        const created = await send({ type: "chat.create", input: {} });
        if (created.type === "request.failed") {
          setSendError(created.message);
          return;
        }
        if (created.type !== "chat.changed") {
          setSendError("Could not start a chat. Try again.");
          return;
        }
        const sent = await send({
          type: "chat.send",
          input: { conversationId: created.conversation.id, content: text, ...modelOverride() },
        });
        if (sent.type === "request.failed") {
          setSendError(sent.message);
          return;
        }
      }
      setInputMessage("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not send that message.");
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleStop = async () => {
    if (!active || !streaming) return;
    await send({ type: "chat.cancel", conversationId: active.id });
  };

  const handleRegenerate = async () => {
    if (!active || streaming || !lastUserContent) return;
    setSendError(null);
    const sent = await send({
      type: "chat.send",
      input: { conversationId: active.id, content: lastUserContent, regenerate: true, ...modelOverride() },
    });
    if (sent.type === "request.failed") setSendError(sent.message);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (sendWithEnter ? modifier : !modifier) return;
    event.preventDefault();
    if (!streaming) void handleSend();
  };

  const copyMessage = (id: string, content: string) => {
    void copyTextToClipboard(content).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1_500);
    });
  };

  const applySuggestion = (prompt: string) => {
    setInputMessage(prompt);
    window.requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(prompt.length, prompt.length);
    });
  };

  const needsProvider = state.providers.length > 0 && !state.providers.some((provider) => provider.configured);
  const groupedModels = modelOptions.reduce<Array<{ providerId: string; providerName: string; models: ChatModelOption[] }>>((groups, option) => {
    const existing = groups.find((group) => group.providerId === option.providerId);
    if (existing) existing.models.push(option);
    else groups.push({ providerId: option.providerId, providerName: option.providerName, models: [option] });
    return groups;
  }, []);
  const hint = sendWithEnter ? "Enter sends. Shift+Enter adds a line." : "Ctrl+Enter sends. Enter adds a line.";

  const setupBanner = needsProvider && (
    <div className="chat-setup-banner" role="status">
      <p>Add an API key in Settings so HIVE can reply.</p>
      {onOpenSettings && (
        <button type="button" className="chat-setup-btn" onClick={onOpenSettings}>
          Open Settings
        </button>
      )}
    </div>
  );

  const composer = (
    <form className="hive-composer-wrap" onSubmit={(event) => void handleSend(event)}>
      <div className="hive-composer">
        <textarea
          ref={textareaRef}
          rows={1}
          className="hive-composer-input"
          placeholder="Message HIVE..."
          aria-label="Message HIVE"
          aria-describedby="chat-composer-hint"
          value={inputMessage}
          onChange={(event) => setInputMessage(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="hive-composer-bar">
          <div className="hive-composer-left">
            <button
              type="button"
              className="hive-model-btn"
              aria-haspopup="listbox"
              aria-expanded={modelMenuOpen}
              aria-label="Select model"
              title={matchedModel ? `${matchedModel.providerName} / ${matchedModel.model}` : activeModelName}
              onClick={() => {
                if (modelOptions.length === 0) {
                  (onOpenModelPicker ?? onOpenSettings)?.();
                  return;
                }
                setModelMenuOpen((open) => !open);
              }}
            >
              <span className="hive-model-name">{displayModel}</span>
              <ChevronDownIcon size={14} />
            </button>
            {modelMenuOpen && modelOptions.length > 0 && (
              <ul className="hive-model-menu" role="listbox" aria-label="Configured models">
                {groupedModels.map((group) => (
                  <li key={group.providerId}>
                    <div className="hive-model-group">{group.providerName}</div>
                    <ul>
                      {group.models.map((option) => {
                        const selected = option.providerId === selectedModel?.providerId && option.model === selectedModel?.model;
                        return (
                          <li key={`${option.providerId}:${option.model}`}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              className={`hive-model-option${selected ? " is-selected" : ""}`}
                              onClick={() => {
                                onSelectModel?.(option);
                                setModelMenuOpen(false);
                              }}
                            >
                              {option.model}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
                {onOpenSettings && (
                  <li className="hive-model-foot">
                    <button
                      type="button"
                      className="hive-model-option"
                      onClick={() => {
                        setModelMenuOpen(false);
                        onOpenSettings();
                      }}
                    >
                      Configure providers
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
          {streaming ? (
            <button type="button" className="hive-send-btn is-stop" aria-label="Stop generation" onClick={() => void handleStop()}>
              <StopIcon size={14} />
            </button>
          ) : (
            <button
              type="submit"
              className="hive-send-btn"
              disabled={!inputMessage.trim() || sending}
              aria-label="Send message"
            >
              <ArrowUpIcon size={16} />
            </button>
          )}
        </div>
      </div>
      <p id="chat-composer-hint" className="hive-composer-hint">{hint}</p>
      {composerError && (
        <p className="composer-send-error" role="alert">{composerError}</p>
      )}
    </form>
  );

  if (!hasMessages) {
    return (
      <div className="hive-chat-surface is-home" aria-label="HiveChat Surface">
        <div className="chat-home" data-testid="chat-empty-state">
          <div className="chat-hero">
            <span className="chat-hero-mark"><HiveMark size={30} /></span>
            <h2 className="chat-hero-title">{greeting()}</h2>
            <p className="chat-hero-sub">Ask HIVE about this workspace, think a problem through, or hand real work to Hive Code.</p>
          </div>
          {setupBanner}
          {composer}
          <div className="hive-suggestions" aria-label="Suggestions">
            {SUGGESTIONS.map((item) => (
              <button key={item.label} type="button" className="hive-suggestion" onClick={() => applySuggestion(item.prompt)}>
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="hive-chat-surface" aria-label="HiveChat Surface">
      <div className="hive-chat-scroll">
        <div className="hive-chat-column">
          {setupBanner}
          <div className="messages-flow">
            {active?.messages.map((msg) => (
              <div key={msg.id} className={`chat-message-row role-${msg.role}`}>
                {msg.role === "user" ? (
                  <div className="user-message-bubble">
                    <div className="message-content">{msg.content}</div>
                  </div>
                ) : (
                  <div className="assistant-message">
                    <span className="assistant-avatar" aria-hidden="true"><HiveMark size={16} /></span>
                    <div className="assistant-content">
                      {renderMarkdown(msg.content)}
                      <div className="assistant-meta">
                        {msg.id === lastAssistantId && (
                          <div className="hive-message-actions">
                            <button type="button" onClick={() => copyMessage(msg.id, msg.content)}>
                              {copiedId === msg.id ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                              {copiedId === msg.id ? "Copied" : "Copy"}
                            </button>
                            {lastUserContent && (
                              <button type="button" disabled={Boolean(streaming)} onClick={() => void handleRegenerate()}>
                                <RefreshIcon size={14} />
                                Regenerate
                              </button>
                            )}
                          </div>
                        )}
                        {msg.receipt && (
                          <span className="receipt-chip">
                            {msg.receipt.model}
                            {typeof msg.receipt.totalTokens === "number" ? ` · ${msg.receipt.totalTokens.toLocaleString()} tokens` : ""}
                            {typeof msg.receipt.latencyMs === "number" ? ` · ${(msg.receipt.latencyMs / 1000).toFixed(2)}s` : ""}
                          </span>
                        )}
                      </div>
                      {onHandoffToCoder && (msg.content.includes("```") || msg.content.toLowerCase().includes("implement") || msg.content.toLowerCase().includes("phase")) && (
                        <div className="hive-handoff">
                          <span className="hive-handoff-text">Ready to execute in verified runtime?</span>
                          <button type="button" className="hive-handoff-btn" onClick={() => onHandoffToCoder()}>
                            Build in Hive Code
                            <ArrowRightIcon size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {streaming && (
              <div className="chat-message-row role-assistant is-streaming">
                <div className="assistant-message">
                  <span className="assistant-avatar is-live" aria-hidden="true"><HiveMark size={16} /></span>
                  <div className="assistant-content">
                    {streaming.text ? (
                      renderMarkdown(streaming.text)
                    ) : (
                      <span className="hive-typing" aria-label="HIVE is thinking"><span /><span /><span /></span>
                    )}
                    {streaming.tools.length > 0 && (
                      <ul className="hive-tool-trail">
                        {streaming.tools.map((tool, index) => <li key={`${tool.name}-${index}`}>{tool.label}</li>)}
                      </ul>
                    )}
                    {streaming.text && (
                      <div className="hive-message-actions">
                        <button type="button" onClick={() => copyMessage(streaming.turnId, streaming.text)}>
                          {copiedId === streaming.turnId ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                          {copiedId === streaming.turnId ? "Copied" : "Copy"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          <div ref={messagesEndRef} />
        </div>
      </div>
      <div className="hive-chat-dock">{composer}</div>
    </div>
  );
}
