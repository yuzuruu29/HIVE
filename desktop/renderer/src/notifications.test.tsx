import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyRunCompleted } from "./notifications";

describe("notifications module", () => {
  let originalNotification: typeof Notification;
  let notificationConstructor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    originalNotification = globalThis.Notification;
    notificationConstructor = vi.fn();
    (notificationConstructor as unknown as { permission: NotificationPermission }).permission = "granted";
    (notificationConstructor as unknown as { requestPermission: () => Promise<NotificationPermission> }).requestPermission = vi
      .fn()
      .mockResolvedValue("granted");

    globalThis.Notification = notificationConstructor as unknown as typeof Notification;
  });

  afterEach(() => {
    globalThis.Notification = originalNotification;
    vi.restoreAllMocks();
  });

  it("suppresses notification when document is visible (not hidden)", () => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    notifyRunCompleted("HIVE", { threadTitle: "Task 1", result: "Completed" });
    expect(notificationConstructor).not.toHaveBeenCalled();
  });

  it("suppresses notification when user preference disables notifications", () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    localStorage.setItem("hive.desktop.ui.v1", JSON.stringify({ v: 1, notifications: false }));

    notifyRunCompleted("HIVE", { threadTitle: "Task 1", result: "Completed" });
    expect(notificationConstructor).not.toHaveBeenCalled();
  });

  it("dispatches notification when document is hidden and notifications are enabled", () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    localStorage.setItem("hive.desktop.ui.v1", JSON.stringify({ v: 1, notifications: true }));

    notifyRunCompleted("HIVE", { threadTitle: "Task 1", result: "Completed" });
    expect(notificationConstructor).toHaveBeenCalledWith("HIVE", {
      body: "Task 1: Completed",
    });
  });
});
