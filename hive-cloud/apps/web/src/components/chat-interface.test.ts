// @vitest-environment jsdom
import React, { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PromptComposer } from "./chat-interface";

vi.mock("./hive-animated-placeholder", () => ({
  useHiveAnimatedPlaceholder: ({ fallback }: { fallback: string }) => fallback,
}));

vi.mock("./markdown-message", () => ({
  MarkdownMessage: ({ content }: { content: string }) =>
    React.createElement("span", null, content),
}));

vi.mock("./chat-processing-state", () => ({
  ChatProcessingState: () => React.createElement("div"),
}));

vi.mock("./hive-thinking-block", () => ({
  HiveThinkingBlock: () => React.createElement("div"),
  safeProcessingErrorLabel: () => "Error",
}));

vi.mock("./model-picker", () => ({
  ModelPicker: () => React.createElement("div"),
}));

vi.mock("./chat-mode-config", () => ({
  chatModeDetails: {
    chat: { placeholder: "Ask a routed model directly" },
    build: { placeholder: "Describe the outcome" },
    research: { placeholder: "Research with citations" },
  },
}));

interface MockClipboardData {
  files: File[];
  types: string[];
  getData: (type: string) => string;
  items: DataTransferItem[];
}

function createMockClipboardData(files: File[], text = ""): MockClipboardData {
  return {
    files,
    types: files.length > 0 ? ["Files"] : ["text/plain"],
    getData: (type: string) => (type === "text/plain" ? text : ""),
    items: files.map(
      (f) =>
        ({
          kind: "file",
          type: f.type,
          getAsFile: () => f,
        }) as unknown as DataTransferItem,
    ),
  };
}

function dispatchPasteEvent(
  target: Element,
  files: File[],
  text = "",
): ClipboardEvent {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: createMockClipboardData(files, text),
    configurable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("PromptComposer clipboard paste", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function renderComposer(
    overrides: Partial<Parameters<typeof PromptComposer>[0]> = {},
  ) {
    const inputRef = createRef<HTMLTextAreaElement>();
    const onFilesMock = vi.fn<(files: File[]) => Promise<void>>().mockResolvedValue(undefined);
    const props = {
      value: "",
      onChange: () => {},
      mode: "chat" as const,
      search: false,
      onSearchChange: () => {},
      attachments: [],
      streaming: false,
      online: true,
      inputRef,
      onFiles: onFilesMock as unknown as (files: File[]) => Promise<void>,
      onRemoveAttachment: () => {},
      onSubmit: () => {},
      onStop: () => {},
      ...overrides,
    };
    flushSync(() => {
      root.render(React.createElement(PromptComposer, props));
    });
    return { props, inputRef, onFilesMock };
  }

  function createImageFile(name = "pasted.png", type = "image/png") {
    return new File([new Uint8Array([137, 80, 78, 71])], name, { type });
  }

  it("calls onFiles when clipboard contains an image file", () => {
    const { onFilesMock } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    const image = createImageFile();

    dispatchPasteEvent(textarea, [image]);

    expect(onFilesMock).toHaveBeenCalledOnce();
    expect(onFilesMock).toHaveBeenCalledWith([image]);
  });

  it("forwards multiple pasted files to onFiles", () => {
    const { onFilesMock } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    const img1 = createImageFile("a.png");
    const img2 = createImageFile("b.jpg", "image/jpeg");

    dispatchPasteEvent(textarea, [img1, img2]);

    expect(onFilesMock).toHaveBeenCalledOnce();
    expect(onFilesMock.mock.calls[0]![0]).toHaveLength(2);
  });

  it("does not call onFiles when clipboard has no files (text-only paste)", () => {
    const { onFilesMock } = renderComposer();
    const textarea = container.querySelector("textarea")!;

    dispatchPasteEvent(textarea, [], "just text");

    expect(onFilesMock).not.toHaveBeenCalled();
  });

  it("does not call preventDefault on text-only paste", () => {
    renderComposer();
    const textarea = container.querySelector("textarea")!;
    const event = dispatchPasteEvent(textarea, [], "just text");

    expect(event.defaultPrevented).toBe(false);
  });

  it("calls preventDefault when clipboard contains files", () => {
    const { onFilesMock } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    const image = createImageFile();

    const event = dispatchPasteEvent(textarea, [image]);

    expect(event.defaultPrevented).toBe(true);
    expect(onFilesMock).toHaveBeenCalledOnce();
  });

  it("does not call onFiles when mode is build (allowsFiles is false)", () => {
    const { onFilesMock } = renderComposer({ mode: "build" });
    const textarea = container.querySelector("textarea")!;
    const image = createImageFile();

    dispatchPasteEvent(textarea, [image]);

    expect(onFilesMock).not.toHaveBeenCalled();
  });

  it("still calls preventDefault on file paste in build mode (blocks default insertion)", () => {
    renderComposer({ mode: "build" });
    const textarea = container.querySelector("textarea")!;
    const image = createImageFile();

    const event = dispatchPasteEvent(textarea, [image]);

    expect(event.defaultPrevented).toBe(true);
  });
});
