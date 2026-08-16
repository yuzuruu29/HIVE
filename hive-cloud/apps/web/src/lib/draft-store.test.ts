import { describe, expect, it, beforeEach, vi } from "vitest";
import { saveDraft, loadDraft, clearDraft, DRAFT_PREFIX } from "./draft-store";

// Mock localStorage
const store: Record<string, string> = {};

const localStorageMock: Storage = {
  get length() {
    return Object.keys(store).length;
  },
  clear() {
    for (const key of Object.keys(store)) delete store[key];
  },
  getItem(key: string) {
    return store[key] ?? null;
  },
  key(index: number) {
    return Object.keys(store)[index] ?? null;
  },
  removeItem(key: string) {
    delete store[key];
  },
  setItem(key: string, value: string) {
    store[key] = value;
  },
};

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.stubGlobal("localStorage", localStorageMock);
});

describe("draft-store", () => {
  describe("DRAFT_PREFIX", () => {
    it("is 'hive-draft:'", () => {
      expect(DRAFT_PREFIX).toBe("hive-draft:");
    });
  });

  describe("saveDraft / loadDraft round-trip", () => {
    it("round-trips a draft for a conversation id", () => {
      saveDraft("conv-123", "hello world");
      expect(loadDraft("conv-123")).toBe("hello world");
    });

    it("round-trips a draft for the 'new' key", () => {
      saveDraft("new", "untitled draft");
      expect(loadDraft("new")).toBe("untitled draft");
    });

    it("stores under the correct namespaced key", () => {
      saveDraft("conv-abc", "test");
      expect(store[`${DRAFT_PREFIX}conv-abc`]).toBe("test");
    });

    it("overwrites a previous draft for the same key", () => {
      saveDraft("conv-1", "first");
      saveDraft("conv-1", "second");
      expect(loadDraft("conv-1")).toBe("second");
    });

    it("keeps drafts independent per conversation", () => {
      saveDraft("conv-a", "alpha");
      saveDraft("conv-b", "beta");
      expect(loadDraft("conv-a")).toBe("alpha");
      expect(loadDraft("conv-b")).toBe("beta");
    });
  });

  describe("loadDraft", () => {
    it("returns empty string for a key that was never saved", () => {
      expect(loadDraft("nonexistent")).toBe("");
    });

    it("returns empty string after clearDraft", () => {
      saveDraft("conv-x", "draft text");
      clearDraft("conv-x");
      expect(loadDraft("conv-x")).toBe("");
    });
  });

  describe("clearDraft", () => {
    it("removes the draft from storage", () => {
      saveDraft("conv-1", "to be cleared");
      clearDraft("conv-1");
      expect(store[`${DRAFT_PREFIX}conv-1`]).toBeUndefined();
    });

    it("does not throw when clearing a key that does not exist", () => {
      expect(() => clearDraft("nonexistent")).not.toThrow();
    });

    it("does not affect other drafts", () => {
      saveDraft("conv-a", "alpha");
      saveDraft("conv-b", "beta");
      clearDraft("conv-a");
      expect(loadDraft("conv-b")).toBe("beta");
    });
  });

  describe("error handling", () => {
    it("returns empty string when localStorage.getItem throws (private mode)", () => {
      vi.stubGlobal("localStorage", {
        ...localStorageMock,
        getItem: () => {
          throw new DOMException("The operation is not allowed.", "SecurityError");
        },
      });
      expect(loadDraft("conv-1")).toBe("");
    });

    it("does not throw when localStorage.setItem throws (quota exceeded)", () => {
      vi.stubGlobal("localStorage", {
        ...localStorageMock,
        setItem: () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        },
      });
      expect(() => saveDraft("conv-1", "big draft")).not.toThrow();
    });

    it("does not throw when localStorage.removeItem throws (private mode)", () => {
      vi.stubGlobal("localStorage", {
        ...localStorageMock,
        removeItem: () => {
          throw new DOMException("The operation is not allowed.", "SecurityError");
        },
      });
      expect(() => clearDraft("conv-1")).not.toThrow();
    });
  });
});
