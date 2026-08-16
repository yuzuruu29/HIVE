import { FormEvent, useEffect, useRef } from "react";
import type { RuntimeEvent } from "../../../../src/coding/types";
import type { ThreadRecordV1, ThreadRunRef } from "../../../../src/desktop/types";
import { MAX_THREAD_MESSAGE_CHARS } from "../../../../src/desktop/types";
import { terminalStatuses } from "../utils";
import { EmptyState } from "./EmptyState";
import { Message } from "./Message";
import { PromptStarters } from "./PromptStarters";
import { TurnProgress } from "./TurnProgress";

export interface ConversationProps {
  thread: ThreadRecordV1;
  composer: string;
  setComposer: (value: string) => void;
  saving: boolean;
  disabled: boolean;
  paused: boolean;
  retryMessageId: string | null;
  repositoryRoot?: string | null;
  currentRun?: ThreadRunRef | null;
  runtimeEvents?: RuntimeEvent[];
  isPausing?: boolean;
  onRetry: (messageId: string) => Promise<void>;
  onSubmit: (event: FormEvent) => Promise<void>;
}

export function Conversation({
  thread,
  composer,
  setComposer,
  saving,
  disabled,
  paused,
  retryMessageId,
  repositoryRoot = null,
  currentRun,
  runtimeEvents = [],
  isPausing = false,
  onRetry,
  onSubmit,
}: ConversationProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const isNearBottomRef = useRef(true);

  const activeRun = currentRun && !terminalStatuses.has(currentRun.status) ? currentRun : null;

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    isNearBottomRef.current = scrollHeight - scrollTop - clientHeight <= 80;
  };

  useEffect(() => {
    if (isNearBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [thread.messages.length, activeRun]);

  return (
    <div className="conversation">
      {activeRun && (
        <TurnProgress
          events={runtimeEvents}
          status={activeRun.status}
          startedAt={activeRun.createdAt}
          pausing={isPausing}
        />
      )}

      <ol ref={listRef} onScroll={handleScroll} className="message-list">
        {thread.messages.length ? (
          thread.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              disabled={disabled}
              saving={saving}
              isRetryTarget={message.id === retryMessageId}
              onRetry={onRetry}
            />
          ))
        ) : (
          <EmptyState>
            <strong>No messages yet.</strong>
            <span>Describe the outcome you want HIVE to build.</span>
            <PromptStarters
              repositoryRoot={repositoryRoot}
              onInsert={(text) => setComposer(text)}
            />
          </EmptyState>
        )}
      </ol>

      <form className="composer" onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="composer">Message HIVE</label>
        <textarea
          id="composer"
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          maxLength={MAX_THREAD_MESSAGE_CHARS}
          rows={5}
          disabled={disabled || saving}
          aria-describedby="composer-help"
        />
        <div className="composer-footer">
          <small id="composer-help">
            {paused
              ? "Resume or cancel the paused turn before sending another."
              : disabled
              ? "This repository already has an active run."
              : `${composer.length.toLocaleString()} / ${MAX_THREAD_MESSAGE_CHARS.toLocaleString()} characters`}
          </small>
          <button disabled={disabled || saving || !composer.trim()}>
            {saving ? "Saving..." : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
