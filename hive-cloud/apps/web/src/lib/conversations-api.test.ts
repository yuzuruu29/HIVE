import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchConversations, createConversation, patchConversation, fetchMessages } from "./conversations-api";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchConversations", () => {
  it("calls GET /api/cloud/conversations with no params", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { items: [], nextCursor: undefined } }),
    });
    vi.stubGlobal("fetch", mock);

    const result = await fetchConversations();

    expect(mock).toHaveBeenCalledWith(
      "/api/cloud/conversations?",
      { cache: "no-store" },
    );
    expect(result.items).toEqual([]);
  });

  it("passes cursor, limit, and archived query params", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { items: [], nextCursor: "abc" } }),
    });
    vi.stubGlobal("fetch", mock);

    await fetchConversations({ cursor: "abc", limit: 30, archived: true });

    const url = mock.mock.calls[0]![0] as string;
    expect(url).toContain("cursor=abc");
    expect(url).toContain("limit=30");
    expect(url).toContain("archived=true");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    await expect(fetchConversations()).rejects.toThrow("Failed to fetch conversations.");
  });

  it("does not set archived param when archived is false", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { items: [], nextCursor: undefined } }),
    });
    vi.stubGlobal("fetch", mock);

    await fetchConversations({ archived: false });

    const url = mock.mock.calls[0]![0] as string;
    expect(url).not.toContain("archived");
  });
});

describe("createConversation", () => {
  it("calls POST /api/cloud/conversations with title", async () => {
    const expected = { id: "1", title: "Test", mode: "chat", updatedAt: "", archived: false, pinnedAt: null };
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: expected }),
    });
    vi.stubGlobal("fetch", mock);

    const result = await createConversation("Test");

    expect(mock).toHaveBeenCalledWith("/api/cloud/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chat", title: "Test" }),
    });
    expect(result).toEqual(expected);
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    await expect(createConversation("Test")).rejects.toThrow("Unable to create a conversation.");
  });
});

describe("patchConversation", () => {
  it("calls PATCH /api/cloud/conversations/:id with patch body", async () => {
    const mock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mock);

    await patchConversation("42", { title: "Renamed", pinned: true });

    expect(mock).toHaveBeenCalledWith("/api/cloud/conversations/42", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed", pinned: true }),
    });
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    await expect(patchConversation("42", {})).rejects.toThrow("Unable to update the conversation.");
  });
});

describe("fetchMessages", () => {
  it("calls GET /api/cloud/conversations/:id/messages", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { items: [], nextCursor: undefined } }),
    });
    vi.stubGlobal("fetch", mock);

    const result = await fetchMessages("42");

    expect(mock).toHaveBeenCalledWith(
      "/api/cloud/conversations/42/messages?",
      { cache: "no-store" },
    );
    expect(result.items).toEqual([]);
  });

  it("passes cursor and limit params", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { items: [], nextCursor: undefined } }),
    });
    vi.stubGlobal("fetch", mock);

    await fetchMessages("42", { cursor: "xyz", limit: 20 });

    const url = mock.mock.calls[0]![0] as string;
    expect(url).toContain("cursor=xyz");
    expect(url).toContain("limit=20");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    await expect(fetchMessages("42")).rejects.toThrow("Failed to fetch messages.");
  });
});
