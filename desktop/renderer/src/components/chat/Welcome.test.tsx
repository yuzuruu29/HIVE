import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DesktopEvent } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import { Welcome } from "./Welcome";

const now = "2026-08-17T00:00:00.000Z";

function bridgeStub() {
  const commands: DesktopCommandInput[] = [];
  const request = vi.fn(async (command: DesktopCommandInput): Promise<DesktopEvent> => {
    commands.push(command);
    return { type: "request.completed", timestamp: now, requestId: command.requestId ?? "request-1" };
  });
  return { request, commands };
}

describe("Welcome", () => {
  it("renders the wordmark, six personas plus Auto, with resolved route chips", () => {
    const { request } = bridgeStub();
    render(
      <Welcome
        repositoryRoot="C:\\HIVE"
        routes={{ auto: { providerId: "ollama", model: "qwen3", source: "role-assignment", degraded: false } }}
        send={request}
        onPickRole={() => {}}
        onPickSuggestion={() => {}}
      />,
    );
    expect(screen.getByText("HIVE Chat")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.getAllByText(/\[route\] ollama\/qwen3/)).toHaveLength(1);
    expect(screen.getAllByText(/route unresolved/)).toHaveLength(6);
  });

  it("resolves routes for auto and every persona on mount", () => {
    const { request, commands } = bridgeStub();
    render(<Welcome repositoryRoot={null} routes={{}} send={request} onPickRole={() => {}} onPickSuggestion={() => {}} />);
    const routeRoles = commands.filter((command) => command.type === "chat.route").map((command) => (command as { input?: { role?: string } }).input?.role);
    expect(routeRoles).toEqual(["auto", "planning", "coding", "heavy-reasoning", "game-builder", "project-coworker", "study-buddy"]);
  });

  it("persona click creates a conversation with the chosen role; suggestion creates and sends", async () => {
    const request = vi.fn(async (command: DesktopCommandInput): Promise<DesktopEvent> => {
      if (command.type === "chat.create") {
        return { type: "chat.changed", timestamp: now, conversation: { id: "chat-1789200000000-ab12", cwd: "C:\\HIVE", role: command.input.role ?? "auto", ground: false, createdAt: now, updatedAt: now, messages: [] } };
      }
      return { type: "request.completed", timestamp: now, requestId: command.requestId ?? "request-1" };
    });
    const onPickRole = vi.fn();
    const onPickSuggestion = vi.fn();
    const user = userEvent.setup();
    render(<Welcome repositoryRoot="C:\\HIVE" routes={{}} send={request} onPickRole={onPickRole} onPickSuggestion={onPickSuggestion} />);

    await user.click(screen.getByRole("button", { name: /game builder/i }));
    expect(onPickRole).toHaveBeenCalledWith("game-builder");

    await user.click(screen.getByRole("button", { name: /explain the architecture of hive/i }));
    expect(onPickSuggestion).toHaveBeenCalledWith("Explain the architecture of HIVE");
  });
});
