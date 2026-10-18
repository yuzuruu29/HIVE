import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSurface, type ChatModelOption } from "./ChatSurface";
import { initialDesktopState, type DesktopViewState } from "../../state";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopChatConversation, DesktopChatSummary, DesktopEvent, DesktopProviderMetadata } from "../../../../../src/desktop/types";

const now = "2026-10-17T12:00:00.000Z";
const repositoryRoot = "C:\\HIVE";
const conversationId = "chat-1789200000000-ab12";
const provider: DesktopProviderMetadata = {
  id: "local",
  name: "Local model",
  kind: "local",
  authType: "none",
  approved: true,
  configured: true,
  defaultModel: "fixture-model",
};
const modelOptions: ChatModelOption[] = [{ providerId: provider.id, providerName: provider.name, model: "fixture-model" }];
const selectedModel = { providerId: provider.id, model: "fixture-model" };
const readyModelProps = { modelOptions, selectedModel };

function readyState(): DesktopViewState {
  const state = initialDesktopState();
  state.repositoryRoot = repositoryRoot;
  state.providers = [provider];
  return state;
}

function conversation(messages: DesktopChatConversation["messages"] = []): DesktopChatConversation {
  return { id: conversationId, cwd: repositoryRoot, role: "auto", ground: false, createdAt: now, updatedAt: now, messages };
}

function activeState(): DesktopViewState {
  const state = readyState();
  state.chat.active = conversation([
    { id: "m1", role: "user", content: "First question", at: now },
    { id: "m2", role: "assistant", content: "First answer", at: now },
    { id: "m3", role: "user", content: "Second question", at: now },
    { id: "m4", role: "assistant", content: "Second answer", at: now },
  ]);
  state.chat.activeId = conversationId;
  return state;
}

function sender() {
  return vi.fn().mockResolvedValue({ type: "request.completed", timestamp: now, requestId: "r1" });
}

describe("ChatSurface", () => {
  beforeEach(() => localStorage.clear());

  it("renders the active conversation and editable composer, then sends with the selected route", () => {
    const send = sender();
    const state = readyState();
    const yesterday = "2026-10-16T12:00:00.000Z";
    const convToday: DesktopChatSummary = { id: conversationId, title: "Explain React Server Components", role: "coding", updatedAt: now, messageCount: 2 };
    const convYesterday: DesktopChatSummary = { id: "chat-1789100000000-cd34", title: "Electron IPC patterns", role: "coding", updatedAt: yesterday, messageCount: 4 };
    state.chat.conversations = [convToday, convYesterday];
    state.chat.active = conversation([
      { id: "m1", role: "user", content: "Explain React Server Components", at: now },
      { id: "m2", role: "assistant", content: "React Server Components let you render components on the server.", at: now,
        receipt: { role: "coding", providerId: "local", model: "fixture-model", totalTokens: 150, latencyMs: 1200 } },
    ]);
    render(<ChatSurface state={state} send={send} {...readyModelProps} activeModelName="Local model / fixture-model" />);
    expect(screen.getAllByText("Explain React Server Components").length).toBeGreaterThan(0);
    expect(screen.getByText(/React Server Components let you render components on the server/i)).toBeInTheDocument();
    const textarea = screen.getByPlaceholderText(/message HIVE/i);
    fireEvent.change(textarea, { target: { value: "How do client components work?" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "chat.send", input: { conversationId, content: "How do client components work?", ...selectedModel },
    }));
  });

  it("empty state is a new chat, not HiveBot or persona cards", () => {
    render(<ChatSurface state={readyState()} send={sender()} {...readyModelProps} />);
    expect(screen.queryByText("HiveBot")).not.toBeInTheDocument();
    expect(screen.queryByText(/specialized personas/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/7 specialists/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-empty-state")).toHaveTextContent(/ask hive about this workspace/i);
    expect(screen.getByTestId("chat-empty-state")).toHaveTextContent(/enter sends/i);
    expect(screen.getByPlaceholderText(/message HIVE/i)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  const missingPrerequisites: Array<{
    name: string;
    state: () => DesktopViewState;
    models?: ChatModelOption[];
    selection?: typeof selectedModel | null;
    label: string;
    guidance: RegExp;
  }> = [
    { name: "a missing workspace takes priority over providers and models", state: () => initialDesktopState(), label: "Open folder", guidance: /open a project folder/i },
    { name: "zero provider rows", state: () => ({ ...readyState(), providers: [] }), label: "Open Settings", guidance: /api provider or approve a local provider/i },
    { name: "unconfigured providers", state: () => ({ ...readyState(), providers: [{ ...provider, approved: false, configured: false }] }), label: "Open Settings", guidance: /api provider or approve a local provider/i },
    { name: "no selected model", state: readyState, selection: null, label: "Choose model", guidance: /choose a model from a configured provider/i },
    { name: "a stale selected model", state: readyState, selection: { providerId: "local", model: "removed-model" }, label: "Choose model", guidance: /choose a model from a configured provider/i },
    { name: "an empty model catalog", state: readyState, models: [], label: "Choose model", guidance: /choose a model from a configured provider/i },
    { name: "a selected model from an unconfigured provider", state: () => ({ ...readyState(), providers: [provider, { ...provider, id: "other", configured: false }] }), models: [{ providerId: "other", providerName: "Other", model: "fixture-model" }], selection: { providerId: "other", model: "fixture-model" }, label: "Choose model", guidance: /choose a model from a configured provider/i },
  ];

  it.each(missingPrerequisites)("makes $name actionable and blocks create/send/regenerate without losing the draft", ({ state: makeState, models = modelOptions, selection = selectedModel, label, guidance }) => {
    const state = makeState();
    const send = sender();
    const callbacks = { onOpenRepositoryPicker: vi.fn(), onOpenSettings: vi.fn(), onOpenModelPicker: vi.fn() };
    const modelProps = { modelOptions: models, selectedModel: selection };
    const { rerender } = render(<ChatSurface state={state} send={send} {...modelProps} {...callbacks} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(guidance);
    expect(status).toHaveTextContent(/draft will stay here/i);
    const action = screen.getByRole("button", { name: label });
    fireEvent.click(action);
    expect(callbacks.onOpenRepositoryPicker).toHaveBeenCalledTimes(label === "Open folder" ? 1 : 0);
    expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(label === "Open Settings" ? 1 : 0);
    expect(callbacks.onOpenModelPicker).toHaveBeenCalledTimes(label === "Choose model" ? 1 : 0);
    const textarea = screen.getByRole("textbox", { name: /message hive/i });
    expect(textarea).toBeEnabled();
    fireEvent.change(textarea, { target: { value: "Keep this draft" } });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    fireEvent.submit(textarea.closest("form")!);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(status).toHaveFocus();
    expect(textarea).toHaveValue("Keep this draft");
    expect(send).not.toHaveBeenCalled();
    rerender(<ChatSurface state={{ ...state, chat: activeState().chat }} send={send} {...modelProps} {...callbacks} />);
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("does not treat a display label or omitted model options as a selected route", () => {
    const send = sender();
    render(<ChatSurface state={readyState()} send={send} activeModelName="CLI default model" selectedModel={selectedModel} />);
    expect(screen.getByRole("status")).toHaveTextContent(/choose a model/i);
    expect(screen.getByRole("button", { name: "Select model" })).toHaveTextContent("No model");
    expect(screen.queryByText("CLI default model")).not.toBeInTheDocument();
    const textarea = screen.getByRole("textbox", { name: /message hive/i });
    fireEvent.change(textarea, { target: { value: "Do not use a fallback" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves a draft through folder, provider and model setup without automatically sending", async () => {
    const send = vi.fn(async (command: DesktopCommandInput): Promise<DesktopEvent> => command.type === "chat.create"
      ? { type: "chat.changed", timestamp: now, conversation: conversation() }
      : { type: "request.completed", timestamp: now, requestId: "r1" });
    const callbacks = { onOpenRepositoryPicker: vi.fn(), onOpenSettings: vi.fn(), onOpenModelPicker: vi.fn() };
    const { rerender } = render(<ChatSurface state={initialDesktopState()} send={send} modelOptions={[]} {...callbacks} />);
    fireEvent.change(screen.getByRole("textbox", { name: /message hive/i }), { target: { value: "My first message" } });
    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(callbacks.onOpenRepositoryPicker).toHaveBeenCalledTimes(1);
    rerender(<ChatSurface state={{ ...readyState(), providers: [] }} send={send} modelOptions={[]} {...callbacks} />);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("My first message");
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1);
    rerender(<ChatSurface state={readyState()} send={send} modelOptions={modelOptions} selectedModel={null} {...callbacks} />);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("My first message");
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    expect(callbacks.onOpenModelPicker).toHaveBeenCalledTimes(1);
    rerender(<ChatSurface state={readyState()} send={send} {...readyModelProps} {...callbacks} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("My first message");
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "chat.send", input: { conversationId, content: "My first message", ...selectedModel } })));
    expect(send).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue(""));
  });

  it("keeps the draft when sending an existing chat fails", async () => {
    const send = vi.fn().mockResolvedValue({ type: "request.failed", timestamp: now, requestId: "r1", message: "Provider unavailable.", recoverable: true });
    render(<ChatSurface state={activeState()} send={send} {...readyModelProps} />);
    const textarea = screen.getByRole("textbox", { name: /message hive/i });
    fireEvent.change(textarea, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(send).toHaveBeenCalled();
    expect(await screen.findByDisplayValue("Keep this draft")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(/provider unavailable/i);
  });

  it("keeps a new-chat draft when creating the chat fails", async () => {
    const send = vi.fn().mockResolvedValue({ type: "request.failed", timestamp: now, requestId: "r1", message: "Could not create a chat.", recoverable: true });
    render(<ChatSurface state={readyState()} send={send} {...readyModelProps} />);
    const textarea = screen.getByRole("textbox", { name: /message hive/i });
    fireEvent.change(textarea, { target: { value: "Keep my new chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not create a chat/i);
    expect(textarea).toHaveValue("Keep my new chat");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("carries a new draft into its created conversation when the first send fails", async () => {
    const send = sender();
    const { rerender } = render(<ChatSurface state={readyState()} send={send} {...readyModelProps} />);
    send.mockImplementationOnce(async () => {
      const state = readyState();
      state.chat.active = conversation();
      state.chat.activeId = conversationId;
      rerender(<ChatSurface state={state} send={send} {...readyModelProps} />);
      return { type: "chat.changed", timestamp: now, conversation: conversation() };
    }).mockResolvedValueOnce({ type: "request.failed", timestamp: now, requestId: "r1", message: "First send failed.", recoverable: true });
    fireEvent.change(screen.getByRole("textbox", { name: /message hive/i }), { target: { value: "Keep this first message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("First send failed.");
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("Keep this first message");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not send after readiness is lost while a new conversation is being created", async () => {
    let finish!: (event: DesktopEvent) => void;
    const send = vi.fn(() => new Promise<DesktopEvent>((resolve) => { finish = resolve; }));
    const { rerender } = render(<ChatSurface state={readyState()} send={send} {...readyModelProps} />);
    fireEvent.change(screen.getByRole("textbox", { name: /message hive/i }), { target: { value: "Keep my pending first message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    rerender(<ChatSurface state={{ ...readyState(), providers: [] }} send={send} {...readyModelProps} />);
    await act(async () => finish({ type: "chat.changed", timestamp: now, conversation: conversation() }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "chat.create", input: {} });
    expect(screen.getByRole("status")).toHaveTextContent(/configure an api provider or approve a local provider/i);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("Keep my pending first message");
  });

  it("does not clear edits made while a send is pending", async () => {
    let finish!: (event: DesktopEvent) => void;
    const send = vi.fn(() => new Promise<DesktopEvent>((resolve) => { finish = resolve; }));
    render(<ChatSurface state={activeState()} send={send} {...readyModelProps} />);
    const textarea = screen.getByRole("textbox", { name: /message hive/i });
    fireEvent.change(textarea, { target: { value: "Send this message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    fireEvent.change(textarea, { target: { value: "Draft the next thought" } });
    await act(async () => finish({ type: "request.completed", timestamp: now, requestId: "r1" }));
    expect(textarea).toHaveValue("Draft the next thought");
  });

  it("keeps a separate draft for each conversation", () => {
    const send = sender();
    const state = activeState();
    const first = state.chat.active!;
    const second = { ...first, id: "chat-1789200000100-cd34", messages: [{ id: "m5", role: "user" as const, content: "Other conversation", at: now }] };
    const { rerender } = render(<ChatSurface state={state} send={send} {...readyModelProps} />);
    fireEvent.change(screen.getByRole("textbox", { name: /message hive/i }), { target: { value: "Draft for first chat" } });
    rerender(<ChatSurface state={{ ...state, chat: { ...state.chat, active: second, activeId: second.id } }} send={send} {...readyModelProps} />);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("");
    rerender(<ChatSurface state={state} send={send} {...readyModelProps} />);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("Draft for first chat");
  });

  it("shows a turn failure from chat.failed on the composer", () => {
    const state = activeState();
    state.chat.lastFailed = { conversationId, turnId: "turn-1", message: "Model timed out." };
    render(<ChatSurface state={state} send={sender()} {...readyModelProps} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/model timed out/i);
  });

  it("does not replace a newer draft with the message from a failed turn", async () => {
    const send = sender();
    const state = activeState();
    const { rerender } = render(<ChatSurface state={state} send={send} {...readyModelProps} />);
    fireEvent.change(screen.getByRole("textbox", { name: /message hive/i }), { target: { value: "Original question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue(""));
    fireEvent.change(screen.getByRole("textbox", { name: /message hive/i }), { target: { value: "My newer draft" } });
    rerender(<ChatSurface state={{ ...state, chat: { ...state.chat, lastFailed: { conversationId, turnId: "turn-1", message: "Turn failed." } } }} send={send} {...readyModelProps} />);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("My newer draft");
    expect(screen.getByRole("alert")).toHaveTextContent("Turn failed.");
  });

  it("keeps a pending send failure out of a different conversation", async () => {
    let finish!: (event: DesktopEvent) => void;
    const send = vi.fn(() => new Promise<DesktopEvent>((resolve) => { finish = resolve; }));
    const state = activeState();
    const second = { ...conversation(), id: "other-chat" };
    const { rerender } = render(<ChatSurface state={state} send={send} {...readyModelProps} />);
    fireEvent.change(screen.getByRole("textbox", { name: /message hive/i }), { target: { value: "First chat question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    rerender(<ChatSurface state={{ ...state, chat: { ...state.chat, active: second, activeId: second.id } }} send={send} {...readyModelProps} />);
    await act(async () => finish({ type: "request.failed", timestamp: now, requestId: "r1", message: "First chat request failed.", recoverable: true }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("");
    rerender(<ChatSurface state={state} send={send} {...readyModelProps} />);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("First chat question");
  });

  it("does not restore another conversation's submitted message into a failed chat", async () => {
    const send = sender();
    const state = activeState();
    const { rerender } = render(<ChatSurface state={state} send={send} {...readyModelProps} />);
    fireEvent.change(screen.getByRole("textbox", { name: /message hive/i }), { target: { value: "Only for the first chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue(""));
    const second = { ...conversation(), id: "other-chat" };
    rerender(<ChatSurface state={{ ...state, chat: {
      ...state.chat, active: second, activeId: second.id,
      lastFailed: { conversationId: second.id, turnId: "other-turn", message: "Other chat failed." },
    } }} send={send} {...readyModelProps} />);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("Other chat failed.");
  });

  it("sends on Enter and keeps Shift+Enter as a newline", () => {
    const send = sender();
    render(<ChatSurface state={activeState()} send={send} {...readyModelProps} />);
    const textarea = screen.getByRole("textbox", { name: /message hive/i });
    fireEvent.change(textarea, { target: { value: "Line one" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: "Send this" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "chat.send", input: { conversationId, content: "Send this", ...selectedModel } }));
  });

  it("uses the same readiness guidance for Ctrl+Enter when that is the send preference", () => {
    localStorage.setItem("hive.desktop.ui.v1", JSON.stringify({ v: 1, composerSendWithEnter: false }));
    const send = sender();
    const state = readyState();
    render(<ChatSurface state={state} send={send} modelOptions={[]} selectedModel={selectedModel} onOpenModelPicker={vi.fn()} />);
    const textarea = screen.getByRole("textbox", { name: /message hive/i });
    fireEvent.change(textarea, { target: { value: "Keep my keyboard draft" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(screen.getByRole("status")).toHaveTextContent(/choose a model/i);
    expect(screen.getByRole("status")).toHaveFocus();
    expect(textarea).toHaveValue("Keep my keyboard draft");
    expect(send).not.toHaveBeenCalled();
  });

  it("shows Stop while streaming and can still cancel if readiness changes", () => {
    const send = sender();
    const state = activeState();
    state.repositoryRoot = null;
    state.chat.streaming = { [conversationId]: { turnId: "turn-1", text: "Partial reply", tools: [] } };
    render(<ChatSurface state={state} send={send} {...readyModelProps} />);
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop generation" }));
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "chat.cancel", conversationId });
    expect(screen.getByText(/partial reply/i)).toBeInTheDocument();
  });

  it("offers Copy and regenerates the last assistant reply with the selected model", () => {
    const send = sender();
    render(<ChatSurface state={activeState()} send={send} {...readyModelProps} />);
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "chat.send", input: { conversationId, content: "Second question", regenerate: true, ...selectedModel } }));
  });

  it("lists only models belonging to configured providers in the picker", () => {
    const send = sender();
    const onSelectModel = vi.fn();
    const state = readyState();
    state.providers = [
      { ...provider, id: "ollama", name: "Ollama" },
      { ...provider, id: "deepseek", name: "DeepSeek", kind: "openai-compatible", authType: "api-key" },
      { ...provider, id: "unconfigured", name: "Unconfigured", configured: false },
    ];
    render(
      <ChatSurface state={state} send={send} activeModelName="No model" modelOptions={[
        { providerId: "ollama", providerName: "Ollama", model: "qwen2.5-coder" },
        { providerId: "deepseek", providerName: "DeepSeek", model: "deepseek-v4-flash" },
        { providerId: "unconfigured", providerName: "Unconfigured", model: "not-ready" },
      ]} onSelectModel={onSelectModel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    expect(screen.getByRole("option", { name: "qwen2.5-coder" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "deepseek-v4-flash" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /hive auto|not-ready/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "deepseek-v4-flash" }));
    expect(onSelectModel).toHaveBeenCalledExactlyOnceWith({ providerId: "deepseek", providerName: "DeepSeek", model: "deepseek-v4-flash" });
  });
});
