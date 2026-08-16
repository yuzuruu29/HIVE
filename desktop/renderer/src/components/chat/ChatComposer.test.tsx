import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopChatConversation, DesktopEvent, DesktopProviderMetadata } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import { savePrefs } from "../../prefs";
import { ChatComposer } from "./ChatComposer";

const now = "2026-08-17T00:00:00.000Z";
const conversation: DesktopChatConversation = {
  id: "chat-1789200000000-ab12",
  cwd: "C:\\HIVE",
  role: "auto",
  ground: false,
  createdAt: now,
  updatedAt: now,
  messages: [],
};
const providers: DesktopProviderMetadata[] = [
  { id: "ollama", name: "Local Ollama", kind: "local", authType: "none", approved: true, configured: true, defaultModel: "qwen3" },
  { id: "cloud", name: "Cloud", kind: "openai-compatible", authType: "api-key", approved: true, configured: false },
];

interface Harness {
  view: ReturnType<typeof render>;
  user: ReturnType<typeof userEvent.setup>;
  base: Parameters<typeof ChatComposer>[0];
  mocks: { setDraft: ReturnType<typeof vi.fn<(value: string) => void>> };
  setText: (text: string) => void;
}

function harness(overrides: Partial<Parameters<typeof ChatComposer>[0]> = {}): Harness {
  const setDraft = vi.fn<(value: string) => void>();
  const send = vi.fn(async (command: DesktopCommandInput): Promise<DesktopEvent> => ({ type: "request.completed", timestamp: now, requestId: command.requestId ?? "request-1" }));
  const base: Parameters<typeof ChatComposer>[0] = {
    conversation,
    draft: "",
    setDraft: undefined as unknown as (value: string) => void,
    streaming: false,
    providers,
    routes: {},
    role: "auto",
    onRoleChange: vi.fn(),
    ground: false,
    onGroundChange: vi.fn(),
    council: false,
    onCouncilChange: vi.fn(),
    councilPreset: "standard",
    onCouncilPresetChange: vi.fn(),
    override: undefined,
    onOverrideChange: vi.fn(),
    send,
    onSend: vi.fn(),
    onStop: vi.fn(),
    failed: false,
    ...overrides,
  };
  let view!: ReturnType<typeof render>;
  base.setDraft = (value: string) => {
    setDraft(value);
    base.draft = value;
    view.rerender(<ChatComposer {...base} />);
  };
  view = render(<ChatComposer {...base} />);
  const user = userEvent.setup();
  return {
    view,
    user,
    base,
    mocks: { setDraft },
    // The composer is controlled: emulate the parent state update, then Enter.
    setText: (text: string) => {
      base.draft = text;
      view.rerender(<ChatComposer {...base} />);
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("ChatComposer", () => {
  it("sends on Enter by default; Shift+Enter keeps a newline in the draft", async () => {
    const { view, user, base, mocks, setText } = harness();
    const textarea = view.getByLabelText(/message hive/i);
    await user.type(textarea, "two{Shift>}{Enter}{/Shift}lines");
    expect(mocks.setDraft.mock.calls.at(-1)?.[0]).toContain("\n");
    expect(base.onSend).not.toHaveBeenCalled();

    setText("ready to send");
    await user.type(view.getByLabelText(/message hive/i), "{Enter}");
    expect(base.onSend).toHaveBeenCalledTimes(1);
  });

  it("honors composerSendWithEnter=false: only Ctrl+Enter sends", async () => {
    savePrefs({ composerSendWithEnter: false });
    const { view, user, base, setText } = harness();
    setText("queued message");
    await user.type(view.getByLabelText(/message hive/i), "{Enter}");
    expect(base.onSend).not.toHaveBeenCalled();
    await user.type(view.getByLabelText(/message hive/i), "{Control>}{Enter}{/Control}");
    expect(base.onSend).toHaveBeenCalledTimes(1);
  });

  it("toggles ground and swaps Send for Stop while streaming", async () => {
    const first = harness();
    await first.user.click(first.view.getByRole("button", { name: /toggle scout grounding/i }));
    expect(first.base.onGroundChange).toHaveBeenCalledWith(true);
    first.view.unmount();

    const second = harness({ streaming: true });
    await second.user.click(second.view.getByRole("button", { name: /stop/i }));
    expect(second.base.onStop).toHaveBeenCalledTimes(1);
    expect(second.view.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument();
  });

  it("selects a provider override and clears back to the role default", async () => {
    const { view, user, base } = harness();
    await user.click(view.getByRole("button", { name: /provider override/i }));
    await user.click(view.getByRole("option", { name: /local ollama/i }).querySelector("button")!);
    expect(base.onOverrideChange).toHaveBeenCalledWith({ providerId: "ollama", model: "qwen3" });

    await user.click(view.getByRole("button", { name: /provider override/i }));
    await user.click(view.getByRole("option", { name: /role default/i }).querySelector("button")!);
    expect(base.onOverrideChange).toHaveBeenCalledWith(undefined);
  });

  it("reveals the council preset selector when council is on", async () => {
    const { view, user, base } = harness();
    expect(view.queryByLabelText(/council preset/i)).not.toBeInTheDocument();
    await user.click(view.getByRole("button", { name: /toggle council mode/i }));
    expect(base.onCouncilChange).toHaveBeenCalledWith(true);

    const councilOn = harness({ council: true });
    await councilOn.user.selectOptions(councilOn.view.getByLabelText(/council preset/i), "quick");
    expect(councilOn.base.onCouncilPresetChange).toHaveBeenCalledWith("quick");
  });

  it("restores the sent draft when the turn fails", async () => {
    const { view, user, base, mocks, setText } = harness();
    setText("precious draft");
    await user.type(view.getByLabelText(/message hive/i), "{Enter}");
    expect(base.onSend).toHaveBeenCalledTimes(1);

    view.rerender(<ChatComposer {...base} failed={true} />);
    expect(mocks.setDraft).toHaveBeenCalledWith("precious draft");
  });

  it("grows the textarea rows with the draft and shows the char counter", () => {
    const { view, setText } = harness();
    expect(view.getByLabelText(/message hive/i)).toHaveAttribute("rows", "1");
    setText("one\ntwo\nthree");
    expect(view.getByLabelText(/message hive/i)).toHaveAttribute("rows", "3");
    expect(view.getByText("13 / 24,000")).toBeInTheDocument();

    const overflow = Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n");
    setText(overflow);
    expect(view.getByLabelText(/message hive/i)).toHaveAttribute("rows", "8");
  });
});
