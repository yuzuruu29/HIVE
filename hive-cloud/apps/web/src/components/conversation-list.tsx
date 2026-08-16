"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, CaretDown, Check, Link as LinkIcon, MagnifyingGlass, NotePencil, Plus, PushPin, Trash, X } from "@phosphor-icons/react";
import { fetchConversations, patchConversation, searchConversations, type ConversationSummary } from "../lib/conversations-api";
import { ShareDialog } from "./share-dialog";

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function renderSnippet(snippet: string): ReactNode {
  if (!snippet.includes("<mark>")) return snippet;
  // Split on literal <mark> / </mark> boundaries emitted by the API.
  // Tags are balanced and non-nested, so alternating segments are safe.
  const parts = snippet.split(/(<\/?mark>)/);
  return parts.map((part, i) => {
    if (part === "<mark>") return undefined;
    if (part === "</mark>") return undefined;
    if (i > 0 && parts[i - 1] === "<mark>") return <mark key={i}>{part}</mark>;
    return part || undefined;
  });
}

export function ConversationList({
  selectedId,
  onSelect,
  historyOpen,
  onClose,
  refreshKey,
}: {
  selectedId?: string;
  onSelect: (id: string) => void;
  historyOpen: boolean;
  onClose: () => void;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationSummary[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string>();
  const [renameTitle, setRenameTitle] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [shareDialogId, setShareDialogId] = useState<string>();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);

  const loadPage = useCallback(async (cursor?: string) => {
    const result = await fetchConversations({ cursor, limit: 30, archived: showArchived || undefined });
    return result;
  }, [showArchived]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loadPage();
      setItems(result.items);
      setNextCursor(result.nextCursor);
    } catch {
      // Error handled by parent
    } finally {
      setLoading(false);
    }
  }, [loadPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const result = await loadPage(nextCursor);
      setItems((prev) => [...prev, ...result.items]);
      setNextCursor(result.nextCursor);
    } finally {
      loadingMore.current = false;
    }
  }, [nextCursor, loadPage]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial, refreshKey]);

  useEffect(() => {
    if (!sentinelRef.current || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [nextCursor, loadMore]);

  async function createConversation() {
    const response = await fetch("/api/cloud/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chat", title: "New conversation" }),
    });
    if (!response.ok) throw new Error("Unable to create a conversation.");
    const { data } = await response.json() as { data: ConversationSummary };
    setItems((current) => [data, ...current]);
    onSelect(data.id);
    onClose();
  }

  async function updateConversation(id: string, patch: Record<string, unknown>) {
    await patchConversation(id, patch);
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item };
      if (patch.title) next.title = patch.title as string;
      if (patch.archived !== undefined) next.archived = patch.archived as boolean;
      if (patch.pinned !== undefined) next.pinnedAt = patch.pinned ? new Date().toISOString() : null;
      if (patch.deleted) return { ...next, updatedAt: new Date(0).toISOString() };
      return next;
    }));
  }

  async function confirmDelete(id: string) {
    try {
      await updateConversation(id, { deleted: true });
      setItems((current) => current.filter((item) => item.id !== id));
    } finally {
      setPendingDeleteId(null);
    }
  }

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await searchConversations(query.trim(), 50);
        setSearchResults(result.items);
      } catch (error) {
        // Error handled by parent or silently
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const visible = useMemo(() => {
    if (searchResults !== null) return searchResults;
    let filtered = items;
    if (showArchived) {
      filtered = filtered.filter((item) => item.archived);
    } else {
      filtered = filtered.filter((item) => !item.archived);
    }
    return filtered;
  }, [items, showArchived, searchResults]);

  const pinned = useMemo(() => visible.filter((item) => item.pinnedAt), [visible]);
  const unpinned = useMemo(() => {
    const ids = new Set(pinned.map((p) => p.id));
    return visible.filter((item) => !ids.has(item.id));
  }, [visible, pinned]);

  return (
    <>
      <div className="conversation-list-head">
        <div>
          <strong>Conversations</strong>
          <span>{visible.length} active</span>
        </div>
        <div className="history-head-actions">
          <button className="icon-button" aria-label="Close conversation history" onClick={onClose}><X size={17} /></button>
          <button className="icon-button" aria-label="New conversation" onClick={() => void createConversation()}><Plus size={17} /></button>
        </div>
      </div>
      <label className="history-search">
        <MagnifyingGlass size={15} aria-hidden="true" />
        <span className="sr-only">Search conversations</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search conversations" />
      </label>
      <div className="conversation-scroll">
        {loading || searchLoading ? (
          <div className="history-skeletons" aria-label="Loading conversations">
            <div className="skeleton" /><div className="skeleton" /><div className="skeleton" />
          </div>
        ) : visible.length === 0 ? (
          <p className="history-empty">
            {query ? "No conversations match this search." : showArchived ? "No archived conversations." : "Start a conversation to build your workspace history."}
          </p>
        ) : (
          <>
            {pinned.length > 0 && (
              <div className="conversation-pinned-section">
                <div className="conversation-section-label"><PushPin size={12} weight="fill" /> Pinned</div>
                {pinned.map((conversation) => renderItem(conversation))}
                <div className="conversation-section-divider" />
              </div>
            )}
            {unpinned.map((conversation) => renderItem(conversation))}
            <div ref={sentinelRef} className="conversation-sentinel" data-has-more={Boolean(nextCursor)}>
              {nextCursor && <div className="history-skeletons" aria-label="Loading more"><div className="skeleton" /></div>}
            </div>
          </>
        )}
      </div>
      <div className="conversation-list-foot">
        <button
          className="conversation-archive-toggle"
          type="button"
          data-active={showArchived}
          onClick={() => { setShowArchived((v) => !v); setQuery(""); }}
        >
          <Archive size={14} />
          <span>{showArchived ? "Active conversations" : "Archived conversations"}</span>
          <CaretDown size={12} className="conversation-archive-arrow" data-open={showArchived} />
        </button>
      </div>
      {shareDialogId && (() => {
        const conversation = items.find((c) => c.id === shareDialogId);
        return conversation ? <ShareDialog open={true} conversationId={conversation.id} conversationTitle={conversation.title} onClose={() => setShareDialogId(undefined)} /> : null;
      })()}
    </>
  );

  function renderItem(conversation: ConversationSummary) {
    return (
      <div className="conversation-item" data-active={conversation.id === selectedId} key={conversation.id}>
        {renamingId === conversation.id ? (
          <form className="conversation-rename" onSubmit={(event) => {
            event.preventDefault();
            const title = renameTitle.trim();
            if (title) void updateConversation(conversation.id, { title });
            setRenamingId(undefined);
          }}>
            <input autoFocus aria-label={`Rename ${conversation.title}`} value={renameTitle} maxLength={120}
              onChange={(event) => setRenameTitle(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setRenamingId(undefined); }} />
            <button type="submit" aria-label={`Save ${conversation.title}`}><Check size={15} /></button>
          </form>
        ) : (
          <button className="conversation-select" onClick={() => {
            const focusParam = conversation.matchedMessageId ? `?focus=${encodeURIComponent(conversation.matchedMessageId)}` : "";
            onSelect(`${conversation.id}${focusParam}`);
            onClose();
          }}>
            <span className="conversation-item-title">{conversation.title}</span>
            {conversation.snippet && (
              <span className="search-snippet">{renderSnippet(conversation.snippet)}</span>
            )}
            <span className="conversation-item-time">{relativeTime(conversation.updatedAt)}</span>
          </button>
        )}
        <span className="conversation-actions">
          <button aria-label={`Share ${conversation.title}`} onClick={() => setShareDialogId(conversation.id)}><LinkIcon size={14} /></button>
          <button aria-label={`Pin ${conversation.title}`} data-active={Boolean(conversation.pinnedAt)}
            onClick={() => void updateConversation(conversation.id, { pinned: !conversation.pinnedAt })}>
            <PushPin size={14} weight={conversation.pinnedAt ? "fill" : "regular"} />
          </button>
          <button aria-label={`Rename ${conversation.title}`}
            onClick={() => { setRenamingId(conversation.id); setRenameTitle(conversation.title); }}>
            <NotePencil size={15} />
          </button>
          <button aria-label={`Archive ${conversation.title}`}
            onClick={() => void updateConversation(conversation.id, { archived: !showArchived })}>
            <Archive size={15} />
          </button>
          {pendingDeleteId === conversation.id ? (
            <button type="button" className="conversation-action-danger"
              aria-label={`Confirm delete ${conversation.title}`}
              onClick={() => void confirmDelete(conversation.id)}
              onBlur={() => setPendingDeleteId(null)} autoFocus>Confirm?</button>
          ) : (
            <button type="button" aria-label={`Delete ${conversation.title}`}
              onClick={() => setPendingDeleteId(conversation.id)}><Trash size={15} /></button>
          )}
        </span>
      </div>
    );
  }
}
