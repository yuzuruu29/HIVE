import type { ChatMessageData } from "../components/chat-interface";

export interface ConversationSummary {
  id: string;
  title: string;
  mode: string;
  updatedAt: string;
  archived: boolean;
  pinnedAt: string | null;
  snippet?: string;
  matchedMessageId?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor?: string;
}

export type AttachmentStatus = "quarantined" | "scanning" | "approved" | "rejected" | "deleted";

export interface AttachmentStatusResponse {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
}

export async function fetchConversations(params?: {
  cursor?: string;
  limit?: number;
  archived?: boolean;
}): Promise<PaginatedResponse<ConversationSummary>> {
  const sp = new URLSearchParams();
  if (params?.cursor) sp.set("cursor", params.cursor);
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.archived) sp.set("archived", "true");
  const response = await fetch(`/api/cloud/conversations?${sp}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Failed to fetch conversations.");
  const json = await response.json() as { data: PaginatedResponse<ConversationSummary> };
  return json.data;
}

export async function createConversation(title: string): Promise<ConversationSummary> {
  const response = await fetch("/api/cloud/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "chat", title }),
  });
  if (!response.ok) throw new Error("Unable to create a conversation.");
  const json = await response.json() as { data: ConversationSummary };
  return json.data;
}

export async function patchConversation(id: string, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`/api/cloud/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error("Unable to update the conversation.");
}

export async function fetchMessages(
  conversationId: string,
  params?: { cursor?: string; limit?: number },
): Promise<PaginatedResponse<ChatMessageData>> {
  const sp = new URLSearchParams();
  if (params?.cursor) sp.set("cursor", params.cursor);
  if (params?.limit) sp.set("limit", String(params.limit));
  const response = await fetch(`/api/cloud/conversations/${conversationId}/messages?${sp}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Failed to fetch messages.");
  const json = await response.json() as { data: PaginatedResponse<ChatMessageData> };
  return json.data;
}

export async function searchConversations(query: string, limit?: number): Promise<PaginatedResponse<ConversationSummary>> {
  const sp = new URLSearchParams({ q: query });
  if (limit) sp.set("limit", String(limit));
  const response = await fetch(`/api/cloud/search/conversations?${sp}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Failed to search conversations.");
  const json = await response.json() as { data: PaginatedResponse<ConversationSummary> };
  return json.data;
}

export async function presignAttachment(name: string, mimeType: string, sizeBytes: number): Promise<{ id: string; uploadUrl: string; uploadHeaders: Record<string, string>; objectKey: string; status: string }> {
  const response = await fetch("/api/cloud/files/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mime_type: mimeType, size_bytes: sizeBytes }),
  });
  if (!response.ok) throw new Error("Failed to presign attachment.");
  const json = await response.json() as { data: { id: string; upload_url: string; upload_headers: Record<string, string>; object_key: string; status: string } };
  return { id: json.data.id, uploadUrl: json.data.upload_url, uploadHeaders: json.data.upload_headers, objectKey: json.data.object_key, status: json.data.status };
}

export async function completeAttachment(id: string, payload: { objectKey: string; name: string; mimeType: string; sizeBytes: number }): Promise<{ id: string; status: AttachmentStatus }> {
  const response = await fetch(`/api/cloud/files/${id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ object_key: payload.objectKey, name: payload.name, mime_type: payload.mimeType, size_bytes: payload.sizeBytes }),
  });
  if (!response.ok) throw new Error("Failed to complete attachment.");
  const json = await response.json() as { data: { id: string; status: AttachmentStatus } };
  return json.data;
}

export async function fetchAttachmentStatus(id: string): Promise<AttachmentStatusResponse> {
  const response = await fetch(`/api/cloud/files/${id}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Unable to check the attachment scan.");
  const json = await response.json() as { data: { id: string; name: string; mime_type: string; size_bytes: number; status: AttachmentStatus } };
  return {
    id: json.data.id,
    name: json.data.name,
    mimeType: json.data.mime_type,
    sizeBytes: json.data.size_bytes,
    status: json.data.status,
  };
}

export async function waitForAttachmentApproval(id: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<AttachmentStatusResponse> {
  const timeoutMs = options?.timeoutMs ?? 90_000;
  const intervalMs = options?.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const attachment = await fetchAttachmentStatus(id);
    if (attachment.status === "approved") return attachment;
    if (attachment.status === "rejected" || attachment.status === "deleted") {
      throw new Error(`Attachment scan ${attachment.status}. Remove the file and try again.`);
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs));
  }
  throw new Error("Attachment scanning is taking longer than expected. Try again shortly.");
}
