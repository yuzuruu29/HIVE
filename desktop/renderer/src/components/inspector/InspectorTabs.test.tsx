import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadRecordV1 } from "../../../../../src/desktop/types";
import { initialDesktopState } from "../../state";
import { InspectorTabs } from "./InspectorTabs";

describe("InspectorTabs run readout", () => {
  it("moves focus and the visible panel with Arrow, Home and End keys", () => {
    render(<InspectorTabs state={initialDesktopState()} />);
    const changes = screen.getByRole("tab", { name: "Changes" });
    const files = screen.getByRole("tab", { name: "Files" });
    expect(changes).toHaveAttribute("tabindex", "0");
    expect(files).toHaveAttribute("tabindex", "-1");
    changes.focus();
    fireEvent.keyDown(changes, { key: "ArrowRight" });
    expect(files).toHaveFocus();
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Files" })).toHaveAttribute("id", files.getAttribute("aria-controls"));
    fireEvent.keyDown(files, { key: "End" });
    expect(screen.getByRole("tab", { name: "Run" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Run" })).toHaveTextContent("No repository");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Run" }), { key: "Home" });
    expect(changes).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Changes" })).toHaveTextContent("No changes yet");
  });

  it("accepts controlled selection and keeps guarded actions behind their preview callback", () => {
    const onSelectTab = vi.fn();
    const onPreviewGit = vi.fn();
    const props = { state: initialDesktopState(), sessionId: "session-reviewed", onSelectTab, onPreviewGit };
    const { rerender } = render(<InspectorTabs {...props} selectedTab="files" />);
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(onSelectTab).toHaveBeenCalledWith("changes");
    expect(screen.getByRole("tabpanel", { name: "Files" })).toBeInTheDocument();
    rerender(<InspectorTabs {...props} selectedTab="changes" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview commit" }));
    expect(onPreviewGit).toHaveBeenCalledExactlyOnceWith("commit");
  });

  it("does not invent a session id, branch, or repository", () => {
    render(<InspectorTabs state={initialDesktopState()} defaultTab="run" />);
    expect(screen.getByText("no run")).toBeInTheDocument();
    expect(screen.getByText("No repository")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("sess-live")).not.toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("shows the active run's recorded session and branch", () => {
    const state = initialDesktopState();
    const thread: ThreadRecordV1 = {
      schemaVersion: 1,
      id: "th-1",
      title: "Preview",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      archived: false,
      messages: [],
      runs: [{
        userMessageId: "m1",
        codingSessionId: "ses-9",
        status: "running",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      }],
    };
    state.threads = [thread];
    state.activeThreadId = thread.id;
    state.repositoryRoot = "C:\\HIVE";
    state.gitStatus = {
      repositoryRoot: "C:\\HIVE",
      branch: "feat/truth",
      head: "abc",
      dirty: false,
      changedFiles: [],
      ahead: 0,
      behind: 0,
    };

    render(<InspectorTabs state={state} defaultTab="run" />);
    expect(screen.getByText("ses-9")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("HIVE")).toBeInTheDocument();
    expect(screen.getByText("feat/truth")).toBeInTheDocument();
  });
});
