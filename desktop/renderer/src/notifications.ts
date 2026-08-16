import { loadPrefs } from "./prefs";

export interface RunNotificationOptions {
  threadTitle: string;
  result?: string;
  status?: string;
}

export function notifyRunCompleted(title: string, options: RunNotificationOptions): void {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;

  const prefs = loadPrefs();
  if (prefs.notifications === false) return;

  // Only notify when window/document is hidden in background
  if (typeof document !== "undefined" && !document.hidden) return;

  if (Notification.permission === "granted") {
    sendNotification(title, options);
  } else if (Notification.permission === "default") {
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        sendNotification(title, options);
      }
    });
  }
}

function sendNotification(title: string, options: RunNotificationOptions) {
  try {
    const body = `${options.threadTitle}: ${options.result ?? options.status ?? "Turn finished."}`;
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      window.focus();
    };
  } catch {
    // ignore
  }
}
