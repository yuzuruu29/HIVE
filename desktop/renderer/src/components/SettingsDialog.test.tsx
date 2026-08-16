import { render, screen } from "@testing-library/react";
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
});
