import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DesktopEvent } from "../../../../src/desktop/types";
import type { SharedRun } from "../../../../src/projects/types";
import type { DesktopCommandInput } from "../bridge";
import { ChangesDialog } from "./RunEvidence";

const now = "2026-10-18T12:00:00.000Z";
const run: SharedRun = { id: "shared-run", requestId: "accepted", sessionId: "session-one", workspaceId: "workspace-one", workspace: "C:\\Alpha", status: "completed", settings: { mode: "code", permissions: "guarded" }, effectivePolicy: "safe", startedAt: now, endedAt: now, summary: "Completed result", events: [], patches: [], checks: [], engine: "live", engineSessionId: "coding-one", approvals: [] };

function requests(failConfirm = false) {
  return vi.fn(async (command: DesktopCommandInput): Promise<DesktopEvent> => {
    if (command.type === "repository.open") return { type: "desktop.ready", timestamp: now, repositoryRoot: command.repositoryRoot };
    if (command.type === "changes.diff") return { type: "changes.diffed", timestamp: now, diff: { repositoryRoot: "C:\\Alpha", codingSessionId: "coding-one", patch: "-old\n+new", recordedFiles: ["src/owned.ts", "unreviewed.txt"], reviewedFiles: ["src/owned.ts"], commitEligibility: "eligible", truncated: false } };
    if (command.type === "git.commit.preview") return { type: "git.previewed", timestamp: now, preview: { confirmationToken: "one-use", proposal: command.input, observedHead: "verified-head", summary: "Commit one reviewed file", createdAt: now, expiresAt: "2026-10-18T12:05:00.000Z", oneUse: true } };
    if (command.type === "git.commit.confirm") return failConfirm ? { type: "request.failed", requestId: command.requestId ?? "confirm-fixture", timestamp: now, message: "Repository changed after preview.", recoverable: true } : { type: "git.action-completed", timestamp: now, action: "commit", summary: "Committed the exact reviewed file" };
    throw new Error(`Unexpected request: ${command.type}`);
  });
}

describe("shared run guarded Git", () => {
  it("previews the authoritative reviewed-file scope and confirms only the explicit one-use proposal", async () => {
    const request = requests(); const review = vi.fn(); const user = userEvent.setup();
    render(<ChangesDialog run={run} repositoryRoot={"C:\\Alpha"} sessionTitle="Fix session navigation" request={request} busy={false} onClose={vi.fn()} onReview={review} />);
    await user.click(screen.getByRole("button", { name: "Preview commit" }));
    const confirmation = await screen.findByRole("dialog", { name: "Confirm commit" });
    expect(within(confirmation).getByText("src/owned.ts")).toBeVisible();
    expect(within(confirmation).queryByText("unreviewed.txt")).not.toBeInTheDocument();
    expect(request.mock.calls.some(([command]) => command.type === "git.commit.confirm")).toBe(false);
    expect(review).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Confirm commit" }));
    await waitFor(() => expect(request.mock.calls.map(([command]) => command)).toContainEqual({ type: "git.commit.confirm", input: { confirmationToken: "one-use", proposal: { action: "commit", repositoryRoot: "C:\\Alpha", codingSessionId: "coding-one", message: "HIVE: Fix session navigation", paths: ["src/owned.ts"] } } }));
    expect(await screen.findByText("Committed the exact reviewed file")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Confirm commit" })).not.toBeInTheDocument();
  });

  it("keeps a rejected confirmation and existing draft intact, requiring a fresh preview", async () => {
    const request = requests(true); const user = userEvent.setup(); const close = vi.fn();
    render(<><textarea aria-label="Draft" defaultValue="An unsent message" /><ChangesDialog run={run} repositoryRoot={"C:\\Alpha"} sessionTitle="Fix session navigation" request={request} busy={false} onClose={close} onReview={vi.fn()} /></>);
    await user.click(screen.getByRole("button", { name: "Preview commit" }));
    const confirmation = await screen.findByRole("dialog", { name: "Confirm commit" });
    await user.click(within(confirmation).getByRole("button", { name: "Confirm commit" }));
    expect(await within(confirmation).findByRole("alert")).toHaveTextContent("Repository changed after preview");
    expect(within(confirmation).getByRole("button", { name: "Confirm commit" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("An unsent message");
    expect(close).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Changes and checks" })).toBeVisible();
    expect(close).not.toHaveBeenCalled();
  });
});
