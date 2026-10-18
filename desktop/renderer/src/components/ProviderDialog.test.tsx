import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DesktopProviderMetadata } from "../../../../src/desktop/types";
import { ProviderDialog, type ProviderDialogProps } from "./ProviderDialog";

const provider: DesktopProviderMetadata = {
  id: "openai",
  name: "OpenAI",
  kind: "openai",
  authType: "api-key",
  approved: false,
  configured: false,
  defaultModel: "fixture-model",
};
const localProvider: DesktopProviderMetadata = {
  id: "local",
  name: "Local model",
  kind: "local",
  authType: "none",
  approved: false,
  configured: false,
  defaultModel: "fixture-local-model",
};
const credential = "fixture-only-private-value";

function props(overrides: Partial<ProviderDialogProps> = {}): ProviderDialogProps {
  return {
    provider,
    credential,
    onCredential: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onApprove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function pendingSave() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ProviderDialog", () => {
  it("keeps credentials masked and submits the existing callback contract", async () => {
    const callbacks = props();
    render(<ProviderDialog {...callbacks} />);
    const input = screen.getByLabelText("API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(screen.getByRole("dialog")).not.toHaveTextContent(credential);
    fireEvent.change(input, { target: { value: "edited-fixture-value" } });
    expect(callbacks.onCredential).toHaveBeenCalledExactlyOnceWith("edited-fixture-value");
    fireEvent.submit(input.closest("form")!);
    expect(callbacks.onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ defaultPrevented: true }),
      "api-key",
      { id: "openai", name: "OpenAI", kind: "openai", authType: "api-key", defaultModel: "fixture-model", approved: true },
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Store encrypted credential" })).toBeEnabled());
    expect(callbacks.onApprove).not.toHaveBeenCalled();
  });

  it("passes edited cloud endpoint/model configuration without changing the submit signature", async () => {
    const callbacks = props({ provider: { ...provider, id: "hive-cloud", name: "HIVE Cloud", baseUrl: "https://fixture.invalid/v1", defaultModel: "original-model" } });
    render(<ProviderDialog {...callbacks} />);
    fireEvent.change(screen.getByLabelText("HIVE Cloud /v1 base URL"), { target: { value: "https://other.invalid/v1///" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "selected-model" } });
    fireEvent.submit(screen.getByLabelText("HIVE API key").closest("form")!);
    expect(callbacks.onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "api-key",
      expect.objectContaining({ id: "hive-cloud", baseUrl: "https://other.invalid/v1", defaultModel: "selected-model", approved: true }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Store encrypted credential" })).toBeEnabled());
  });

  it("disables all fields, duplicate submits, cancellation and Escape while the parent is busy", async () => {
    const callbacks = props({ provider: { ...provider, id: "hive-cloud", baseUrl: "https://fixture.invalid/v1" }, busy: true });
    const { rerender } = render(<ProviderDialog {...callbacks} />);
    for (const label of ["HIVE API key", "HIVE Cloud /v1 base URL", "Model"]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Saving encrypted credential…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel provider setup" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/saving provider setup/i);
    fireEvent.submit(screen.getByLabelText("HIVE API key").closest("form")!);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel provider setup" }));
    expect(callbacks.onSubmit).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    rerender(<ProviderDialog {...callbacks} busy={false} />);
    expect(screen.getByLabelText("HIVE API key")).toHaveValue(credential);
    expect(screen.getByLabelText("HIVE API key")).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel provider setup" }));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it("guards an in-flight save even before the parent supplies a busy prop", async () => {
    const pending = pendingSave();
    const callbacks = props({ onSubmit: vi.fn().mockReturnValue(pending.promise) });
    render(<ProviderDialog {...callbacks} />);
    const form = screen.getByLabelText("API key").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(callbacks.onSubmit).toHaveBeenCalledTimes(1);
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("API key")).toBeDisabled();
    await act(async () => pending.resolve());
    expect(screen.getByRole("button", { name: "Store encrypted credential" })).toBeEnabled();
    fireEvent.keyDown(screen.getByLabelText("API key"), { key: "Escape" });
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows safe inline parent errors without exposing a credential or discarding entries", () => {
    render(<ProviderDialog {...props({ error: `Rejected authorization value: ${credential}` })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved.*try again.*entries have been kept/i);
    expect(screen.getByRole("dialog")).not.toHaveTextContent(credential);
    expect(screen.getByLabelText("API key")).toHaveValue(credential);
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  });

  it("handles a rejected save safely and permits retry without losing the credential", async () => {
    const callbacks = props({ onSubmit: vi.fn().mockRejectedValueOnce(new Error(`Request included ${credential}`)).mockResolvedValueOnce(undefined) });
    render(<ProviderDialog {...callbacks} />);
    const form = screen.getByLabelText("API key").closest("form")!;
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/i);
    expect(screen.getByRole("dialog")).not.toHaveTextContent(credential);
    expect(screen.getByLabelText("API key")).toHaveValue(credential);
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole("button", { name: "Store encrypted credential" })).toBeEnabled());
    expect(callbacks.onSubmit).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("approves local providers without a credential form and guards duplicate approval and close", async () => {
    const pending = pendingSave();
    const callbacks = props({ provider: localProvider, credential: "", onApprove: vi.fn().mockReturnValue(pending.promise) });
    render(<ProviderDialog {...callbacks} />);
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(screen.getByText(/requires no desktop secret/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve local provider" }));
    fireEvent.click(screen.getByRole("button", { name: "Approving local provider…" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(callbacks.onApprove).toHaveBeenCalledExactlyOnceWith(localProvider);
    expect(callbacks.onSubmit).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel provider setup" })).toBeDisabled();
    await act(async () => pending.resolve());
    expect(screen.getByRole("button", { name: "Approve local provider" })).toBeEnabled();
  });

  it("reports failed local approval safely and does not close the dialog", async () => {
    const callbacks = props({ provider: localProvider, credential: "", onApprove: vi.fn().mockRejectedValue(new Error("Local approval failed")) });
    render(<ProviderDialog {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve local provider" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved/i);
    expect(screen.getByRole("button", { name: "Approve local provider" })).toBeEnabled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });

  it("does not submit an empty credential", () => {
    const callbacks = props({ credential: "" });
    render(<ProviderDialog {...callbacks} />);
    expect(screen.getByRole("button", { name: "Store encrypted credential" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
    expect(callbacks.onSubmit).not.toHaveBeenCalled();
  });

  it("leaves cancellation and Escape available when idle", async () => {
    const callbacks = props();
    const user = userEvent.setup();
    render(<ProviderDialog {...callbacks} />);
    await user.click(screen.getByRole("button", { name: "Cancel provider setup" }));
    await user.keyboard("{Escape}");
    expect(callbacks.onClose).toHaveBeenCalledTimes(2);
    expect(callbacks.onSubmit).not.toHaveBeenCalled();
  });

  it("handles an absent provider without presenting a credential form", () => {
    const callbacks = props({ provider: undefined });
    render(<ProviderDialog {...callbacks} />);
    expect(screen.getByText("No provider is selected.")).toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });
});
