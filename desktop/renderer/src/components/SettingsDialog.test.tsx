import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";

describe("SettingsDialog component", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("updates density and accent settings in localStorage", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<SettingsDialog onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: /preferences & accessibility/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^general$/i })).toBeInTheDocument();

    const compactRadio = screen.getByLabelText(/compact/i);
    await user.click(compactRadio);

    let stored = JSON.parse(localStorage.getItem("hive.desktop.ui.v1") || "{}");
    expect(stored.density).toBe("compact");

    const contrastRadio = screen.getByLabelText(/high contrast/i);
    await user.click(contrastRadio);

    stored = JSON.parse(localStorage.getItem("hive.desktop.ui.v1") || "{}");
    expect(stored.accent).toBe("contrast");

    const doneBtn = screen.getByRole("button", { name: /done/i });
    await user.click(doneBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("toggles notification preference", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<SettingsDialog onClose={onClose} />);

    const notifCheckbox = screen.getByLabelText(/background notifications/i);
    expect(notifCheckbox).toBeChecked();

    await user.click(notifCheckbox);
    expect(notifCheckbox).not.toBeChecked();

    const stored = JSON.parse(localStorage.getItem("hive.desktop.ui.v1") || "{}");
    expect(stored.notifications).toBe(false);
  });

  it("opens the Providers tab directly when requested", () => {
    render(
      <SettingsDialog
        onClose={vi.fn()}
        initialTab="models"
        providers={[{ id: "local", name: "Local model", kind: "local", authType: "none", approved: true, configured: true, defaultModel: "hive-local" }]}
      />,
    );
    expect(screen.getByRole("tab", { name: /providers/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/local model/i)).toBeInTheDocument();
    expect(screen.getByText(/ · configured$/i)).toBeInTheDocument();
    expect(screen.queryByText(/connected/i)).not.toBeInTheDocument();
  });

  it("lists providers on the Providers tab and can add an OpenAI-compatible channel", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SettingsDialog
        onClose={vi.fn()}
        providers={[{ id: "local", name: "Local model", kind: "local", authType: "none", approved: true, configured: true, defaultModel: "hive-local" }]}
        onAddCompatibleProvider={onAdd}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /providers/i }));
    expect(screen.getByText(/local model/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /add openai-compatible provider/i }));
    await user.type(screen.getByLabelText(/provider name/i), "DeepSeek");
    await user.type(screen.getByLabelText(/base url/i), "https://api.deepseek.com/v1");
    await user.type(screen.getByLabelText(/default model/i), "deepseek-chat");
    await user.click(screen.getByRole("button", { name: /save provider/i }));
    expect(onAdd).toHaveBeenCalledWith({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat",
    });
  });

  it.each(["retry", "cancel"])("preserves failed provider entries and clears the safe inline failure on %s", async (action) => {
    let finishRetry!: () => void;
    const retry = new Promise<void>((resolve) => { finishRetry = resolve; });
    const onAdd = vi.fn()
      .mockRejectedValueOnce(new Error("Request failed with private diagnostic details"))
      .mockReturnValueOnce(retry);
    const user = userEvent.setup();
    render(<SettingsDialog onClose={vi.fn()} initialTab="models" onAddCompatibleProvider={onAdd} />);
    await user.click(screen.getByRole("button", { name: /add openai-compatible provider/i }));
    await user.type(screen.getByLabelText("Provider name"), "Local endpoint");
    await user.type(screen.getByLabelText("OpenAI-compatible base URL"), "http://127.0.0.1:1234/v1");
    await user.type(screen.getByLabelText("Default model"), "fixture-model");
    await user.click(screen.getByRole("button", { name: "Save provider" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/provider could not be added.*try again.*entries have been kept/i);
    expect(screen.queryByText(/private diagnostic details/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Provider name")).toHaveValue("Local endpoint");
    expect(screen.getByLabelText("OpenAI-compatible base URL")).toHaveValue("http://127.0.0.1:1234/v1");
    expect(screen.getByLabelText("Default model")).toHaveValue("fixture-model");
    expect(screen.getByRole("button", { name: "Save provider" })).toBeEnabled();
    expect(onAdd).toHaveBeenCalledExactlyOnceWith({ id: "local-endpoint", name: "Local endpoint", baseUrl: "http://127.0.0.1:1234/v1", defaultModel: "fixture-model" });

    if (action === "retry") {
      await user.click(screen.getByRole("button", { name: "Save provider" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save provider" })).toBeDisabled();
      expect(onAdd).toHaveBeenCalledTimes(2);
      await act(async () => finishRetry());
      expect(screen.queryByRole("button", { name: "Save provider" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /add openai-compatible provider/i }));
      expect(screen.getByLabelText("Provider name")).toHaveValue("");
      expect(screen.getByLabelText("OpenAI-compatible base URL")).toHaveValue("");
      expect(screen.getByLabelText("Default model")).toHaveValue("");
    } else {
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /add openai-compatible provider/i }));
      expect(screen.getByLabelText("Provider name")).toHaveValue("Local endpoint");
      expect(onAdd).toHaveBeenCalledTimes(1);
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("adds a separate provider when its name matches an existing credential owner", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SettingsDialog onClose={vi.fn()} initialTab="models" onAddCompatibleProvider={onAdd} providers={[
      { id: "openai", name: "OpenAI", kind: "openai", authType: "api-key", approved: true, configured: true },
      { id: "openai-2", name: "OpenAI proxy", kind: "openai-compatible", authType: "api-key", approved: false, configured: false },
    ]} />);
    await user.click(screen.getByRole("button", { name: /add openai-compatible provider/i }));
    await user.type(screen.getByLabelText("Provider name"), "OpenAI");
    await user.type(screen.getByLabelText("OpenAI-compatible base URL"), "https://proxy.invalid/v1");
    await user.type(screen.getByLabelText("Default model"), "fixture-model");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith({ id: "openai-3", name: "OpenAI", baseUrl: "https://proxy.invalid/v1", defaultModel: "fixture-model" });
  });

  it("ignores duplicate add submissions while the provider is being saved", async () => {
    let finish!: () => void;
    const onAdd = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<SettingsDialog onClose={vi.fn()} initialTab="models" onAddCompatibleProvider={onAdd} />);
    await user.click(screen.getByRole("button", { name: /add openai-compatible provider/i }));
    await user.type(screen.getByLabelText("Provider name"), "Proxy");
    await user.type(screen.getByLabelText("OpenAI-compatible base URL"), "https://proxy.invalid/v1");
    await user.type(screen.getByLabelText("Default model"), "fixture-model");
    const form = screen.getByLabelText("Provider name").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onAdd).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("lists discovered models on the Models tab, filters with search, and toggles enabled state", async () => {
    const onFetchModels = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsDialog
        onClose={vi.fn()}
        initialTab="catalog"
        providers={[{ id: "openai", name: "OpenAI", kind: "openai", authType: "api-key", approved: true, configured: true }]}
        modelsByProvider={{
          openai: [
            { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000 },
            { id: "o3-mini", name: "o3-mini", contextWindow: 200000 },
          ],
        }}
        onFetchModels={onFetchModels}
      />,
    );

    expect(screen.getByRole("tab", { name: /models/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByText("o3-mini")).toBeInTheDocument();
    expect(screen.getByText("128K")).toBeInTheDocument();

    // Toggle switch for gpt-4o
    const toggleGpt4o = screen.getByRole("switch", { name: /enable gpt-4o/i });
    expect(toggleGpt4o).toHaveAttribute("aria-checked", "true");
    await user.click(toggleGpt4o);

    let stored = JSON.parse(localStorage.getItem("hive.desktop.ui.v1") || "{}");
    expect(stored.enabledModels?.["gpt-4o"]).toBe(false);

    // Search filter
    const searchInput = screen.getByLabelText(/search models/i);
    await user.type(searchInput, "o3");
    expect(screen.getByText("o3-mini")).toBeInTheDocument();
    expect(screen.queryByText("gpt-4o")).not.toBeInTheDocument();
  });

  it("fetches models when the Models tab opens for a configured provider", async () => {
    const onFetchModels = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsDialog
        onClose={vi.fn()}
        providers={[{ id: "openai", name: "OpenAI", kind: "openai", authType: "api-key", approved: true, configured: true }]}
        onFetchModels={onFetchModels}
      />,
    );

    expect(onFetchModels).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /models/i }));
    expect(onFetchModels).toHaveBeenCalledWith("openai");
  });

  it("offers to open Providers when a model source is not configured", async () => {
    const user = userEvent.setup();
    render(
      <SettingsDialog
        onClose={vi.fn()}
        initialTab="catalog"
        providers={[{ id: "anthropic", name: "Anthropic", kind: "anthropic", authType: "api-key", approved: false, configured: false }]}
      />,
    );

    expect(screen.getByText(/configure an api or local provider to see available models/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /open providers/i }));
    expect(screen.getByRole("tab", { name: /providers/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
  });

  it("labels configuration state without claiming a provider is connected or healthy", async () => {
    const onConfigureProvider = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsDialog
        onClose={vi.fn()}
        initialTab="models"
        providers={[
          { id: "local", name: "Local model", kind: "local", authType: "none", approved: true, configured: true },
          { id: "cloud", name: "Cloud model", kind: "openai", authType: "api-key", approved: false, configured: false },
        ]}
        onConfigureProvider={onConfigureProvider}
      />,
    );
    const local = screen.getByText("Local model").closest("li")!;
    const cloud = screen.getByText("Cloud model").closest("li")!;
    expect(within(local).getByText(/ · configured$/)).toBeInTheDocument();
    expect(within(cloud).getByText(/ · not configured$/)).toBeInTheDocument();
    expect(screen.queryByText(/connected|healthy/i)).not.toBeInTheDocument();
    await user.click(within(cloud).getByRole("button", { name: "Configure" }));
    expect(onConfigureProvider).toHaveBeenCalledExactlyOnceWith("cloud");
  });

  it("offers provider setup rather than an unavailable refresh when there are no provider rows", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={vi.fn()} initialTab="catalog" providers={[]} />);
    expect(screen.getByText(/configure an api or local provider/i)).toBeInTheDocument();
    expect(screen.queryByText(/no models returned/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Providers" }));
    expect(screen.getByRole("tab", { name: "Providers" })).toHaveAttribute("aria-selected", "true");
  });
});
