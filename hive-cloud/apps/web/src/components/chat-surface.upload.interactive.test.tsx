/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  completeAttachment: vi.fn(),
  fetchMessages: vi.fn(),
  presignAttachment: vi.fn(),
  waitForAttachmentApproval: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../lib/conversations-api", () => api);
vi.mock("@/lib/shortcuts", () => ({ useShortcuts: vi.fn() }));
vi.mock("@/lib/escape-actions", () => ({ useEscapeAction: vi.fn() }));
vi.mock("./conversation-list", () => ({ ConversationList: () => null }));
vi.mock("./share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("./hive-wave-background", () => ({ HiveWaveBackground: () => null }));
vi.mock("./hive-welcome-state", () => ({
  HiveWelcomeState: ({ composer }: { composer: React.ReactNode }) => <>{composer}</>,
}));
vi.mock("./chat-interface", () => ({
  ChatMessage: () => null,
  PromptComposer: (props: {
    attachmentStatus?: string;
    attachments: Array<{ name: string }>;
    onFiles: (files: File[]) => Promise<void>;
  }) => (
    <div>
      <button
        data-testid="upload-fixture"
        type="button"
        onClick={() => void props.onFiles([new File(["trusted context"], "context.txt", { type: "text/plain" })])}
      >
        Upload fixture
      </button>
      {props.attachmentStatus && <p>{props.attachmentStatus}</p>}
      {props.attachments.map((attachment) => <p key={attachment.name}>{attachment.name}</p>)}
    </div>
  ),
}));

import { ChatSurface } from "./chat-surface";

describe("ChatSurface attachment approval", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    api.fetchMessages.mockResolvedValue({ items: [], nextCursor: undefined });
    api.presignAttachment.mockResolvedValue({
      id: "attachment-1",
      objectKey: "tenant/attachment-1",
      status: "quarantined",
      uploadHeaders: { "content-type": "text/plain" },
      uploadUrl: "https://uploads.example.test/attachment-1",
    });
    api.completeAttachment.mockResolvedValue({ id: "attachment-1", status: "scanning" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/cloud/models") {
        return { ok: true, json: async () => ({ data: [] }) } as Response;
      }
      return { ok: true } as Response;
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uploads complete metadata and exposes the file only after scan approval", async () => {
    let approve!: () => void;
    api.waitForAttachmentApproval.mockReturnValue(new Promise((resolve) => {
      approve = () => resolve({
        id: "attachment-1",
        mimeType: "text/plain",
        name: "context.txt",
        sizeBytes: 15,
        status: "approved",
      });
    }));

    await act(async () => root.render(<ChatSurface />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="upload-fixture"]')!.click());

    expect(api.presignAttachment).toHaveBeenCalledWith("context.txt", "text/plain", 15);
    expect(fetch).toHaveBeenCalledWith("https://uploads.example.test/attachment-1", expect.objectContaining({
      body: expect.any(File),
      headers: { "content-type": "text/plain" },
      method: "PUT",
    }));
    expect(api.completeAttachment).toHaveBeenCalledWith("attachment-1", {
      mimeType: "text/plain",
      name: "context.txt",
      objectKey: "tenant/attachment-1",
      sizeBytes: 15,
    });
    expect(api.waitForAttachmentApproval).toHaveBeenCalledWith("attachment-1");
    expect(container.textContent).toContain("Scanning context.txt");
    expect(container.textContent).not.toMatch(/context\.txt.*context\.txt/s);

    await act(async () => approve());

    expect(container.textContent).toContain("context.txt");
    expect(container.textContent).not.toContain("Scanning context.txt");
  });
});
