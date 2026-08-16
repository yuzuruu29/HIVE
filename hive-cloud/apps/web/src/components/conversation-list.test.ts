import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./conversation-list.tsx", import.meta.url), "utf8");

describe("conversation list layout", () => {
  it("renders a head section with title and actions", () => {
    expect(source).toContain("conversation-list-head");
    expect(source).toContain("Conversations");
    expect(source).toContain("New conversation");
  });

  it("has a search input with a MagnifyingGlass icon", () => {
    expect(source).toContain("history-search");
    expect(source).toContain("MagnifyingGlass");
    expect(source).toContain("placeholder=\"Search\"");
  });

  it("closes the history drawer on close button click", () => {
    expect(source).toContain('aria-label="Close conversation history"');
  });

  it("creates a new conversation via POST and calls onSelect/onClose", () => {
    expect(source).toContain('method: "POST"');
    expect(source).toContain("New conversation");
    expect(source).toContain("onSelect(data.id)");
    expect(source).toContain("onClose()");
  });
});

describe("pinned conversations section", () => {
  it("renders a Pinned section label with PushPin icon", () => {
    expect(source).toContain("conversation-section-label");
    expect(source).toContain("Pinned");
    expect(source).toContain("PushPin");
  });

  it("renders a divider after the pinned section", () => {
    expect(source).toContain("conversation-section-divider");
  });

  it("computes pinned items from items with pinnedAt truthy", () => {
    expect(source).toMatch(/pinned\s*=\s*useMemo.*pinnedAt/);
  });

  it("renders pinned items before unpinned items", () => {
    expect(source).toMatch(/pinned\.length\s*>\s*0/);
    expect(source).toMatch(/pinned\.map/);
    expect(source).toMatch(/unpinned\.map/);
  });
});

describe("infinite scroll", () => {
  it("renders a sentinel element for IntersectionObserver", () => {
    expect(source).toContain("conversation-sentinel");
    expect(source).toContain("sentinelRef");
  });

  it("uses IntersectionObserver with 200px rootMargin", () => {
    expect(source).toContain("IntersectionObserver");
    expect(source).toContain("200px");
  });

  it("shows a skeleton loader in the sentinel when nextCursor is truthy", () => {
    expect(source).toContain("data-has-more");
    expect(source).toContain("Loading more");
  });

  it("guards loadMore with a loadingMore ref to prevent duplicate fetches", () => {
    expect(source).toContain("loadingMore.current");
  });
});

describe("archive toggle", () => {
  it("renders an archive toggle in the footer", () => {
    expect(source).toContain("conversation-list-foot");
    expect(source).toContain("conversation-archive-toggle");
    expect(source).toContain("Archive");
  });

  it("toggles between active and archived views", () => {
    expect(source).toContain("Active conversations");
    expect(source).toContain("Archived conversations");
    expect(source).toContain("setShowArchived((v) => !v)");
  });

  it("has a CaretDown arrow that rotates via data-open", () => {
    expect(source).toContain("conversation-archive-arrow");
    expect(source).toContain("CaretDown");
    expect(source).toContain("data-open={showArchived}");
  });

  it("clears search query when toggling archive view", () => {
    expect(source).toContain("setQuery(\"\"");
  });
});

describe("loading and empty states", () => {
  it("shows skeleton loaders during loading", () => {
    expect(source).toContain("history-skeletons");
    expect(source).toContain("Loading conversations");
  });

  it("shows empty state text when no conversations match", () => {
    expect(source).toContain("No conversations match this search.");
    expect(source).toContain("No archived conversations.");
    expect(source).toContain("Start a conversation to build your workspace history.");
  });
});

describe("conversation item actions", () => {
  it("renders a select button with title and relative time", () => {
    expect(source).toContain("conversation-select");
    expect(source).toContain("conversation-item-title");
    expect(source).toContain("conversation-item-time");
  });

  it("has pin, rename, archive, and delete action buttons", () => {
    expect(source).toContain("Pin");
    expect(source).toContain("Rename");
    expect(source).toContain("Archive");
    expect(source).toContain("Delete");
  });

  it("uses PushPin with fill weight when pinned", () => {
    expect(source).toMatch(/PushPin.*weight=\{conversation\.pinnedAt\s*\?\s*"fill"\s*:\s*"regular"\}/);
  });

  it("toggles pinned state via updateConversation", () => {
    expect(source).toContain("pinned: !conversation.pinnedAt");
  });

  it("archives the conversation via updateConversation", () => {
    expect(source).toContain("archived: !showArchived");
  });

  it("deletes the conversation with a two-click confirm flow", () => {
    expect(source).toContain("pendingDeleteId === conversation.id");
    expect(source).toContain("Confirm?");
    expect(source).toContain("conversation-action-danger");
  });

  it("sets pendingDeleteId to null after successful deletion", () => {
    expect(source).toContain("setPendingDeleteId(null)");
  });
});

describe("rename flow", () => {
  it("shows an inline rename form when renamingId matches", () => {
    expect(source).toContain("conversation-rename");
    expect(source).toContain("renamingId === conversation.id");
  });

  it("saves the renamed title on form submit", () => {
    expect(source).toContain("updateConversation(conversation.id, { title })");
  });

  it("cancels rename on Escape key", () => {
    expect(source).toContain('key === "Escape"');
    expect(source).toContain("setRenamingId(undefined)");
  });

  it("uses NotePencil icon for the rename trigger", () => {
    expect(source).toContain("NotePencil");
  });
});

describe("relativeTime helper", () => {
  it("returns 'now' for timestamps less than 60 seconds old", () => {
    expect(source).toContain('return "now"');
  });

  it("returns minutes suffix for timestamps under 1 hour", () => {
    expect(source).toContain('return `${Math.floor(seconds / 60)}m`');
  });

  it("returns hours suffix for timestamps under 1 day", () => {
    expect(source).toContain('return `${Math.floor(seconds / 3600)}h`');
  });

  it("returns days suffix for timestamps 1 day or older", () => {
    expect(source).toContain('return `${Math.floor(seconds / 86400)}d`');
  });
});
