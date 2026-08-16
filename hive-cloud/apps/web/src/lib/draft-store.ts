export const DRAFT_PREFIX = "hive-draft:";

function key(conversationId: string): string {
  return `${DRAFT_PREFIX}${conversationId}`;
}

export function saveDraft(conversationId: string, text: string): void {
  try {
    localStorage.setItem(key(conversationId), text);
  } catch {
    // Safari private mode, quota exceeded — silently ignore.
  }
}

export function loadDraft(conversationId: string): string {
  try {
    return localStorage.getItem(key(conversationId)) ?? "";
  } catch {
    return "";
  }
}

export function clearDraft(conversationId: string): void {
  try {
    localStorage.removeItem(key(conversationId));
  } catch {
    // Safari private mode — silently ignore.
  }
}
