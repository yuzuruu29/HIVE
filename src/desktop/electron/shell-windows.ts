import type { DesktopEvent } from "../types.js";
import { validateDesktopEvent } from "./contracts.js";

export type ShellView = "chat" | "coder";

/** Minimal BrowserWindow surface the registry needs; real windows satisfy it. */
export interface ShellWindowLike {
  readonly webContents: { send(channel: string, payload: unknown): void };
  on(event: "closed", listener: () => void): void;
  focus(): void;
  show(): void;
  close(): void;
  isDestroyed(): boolean;
}

export interface ShellWindowRegistryOptions {
  /** Creates a fully configured window for the view (security, preload, load). */
  create: (view: ShellView) => ShellWindowLike;
  /** Receives validated shell events (e.g. `shell.views`) for broadcast delivery. */
  onShellEvent: (event: DesktopEvent) => void;
  eventChannel: string;
  clock?: () => string;
}

/**
 * Registry of shell windows keyed by view. The desktop runs at most one
 * window per view (the one-active-run invariant assumes one control surface),
 * and every live window receives every desktop event.
 */
export class ShellWindowRegistry {
  readonly #windows = new Map<ShellView, ShellWindowLike>();
  readonly #options: ShellWindowRegistryOptions;
  readonly #clock: () => string;

  public constructor(options: ShellWindowRegistryOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  public open(view: ShellView): ShellWindowLike {
    const existing = this.#windows.get(view);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return existing;
    }
    const window = this.#options.create(view);
    this.#windows.set(view, window);
    window.on("closed", () => {
      if (this.#windows.get(view) === window) this.#windows.delete(view);
      this.#publishViews();
    });
    this.#publishViews();
    return window;
  }

  public close(view: ShellView): void {
    const window = this.#windows.get(view);
    if (!window || window.isDestroyed()) throw new Error(`No shell window is open for view '${view}'.`);
    if (this.#windows.size <= 1) throw new Error("The last shell window must stay open; quitting keeps default semantics.");
    window.close();
  }

  public has(view: ShellView): boolean {
    const window = this.#windows.get(view);
    return Boolean(window && !window.isDestroyed());
  }

  public views(): ShellView[] {
    return [...this.#windows.entries()].filter(([, window]) => !window.isDestroyed()).map(([view]) => view);
  }

  /** Broadcasts an event to every live window's webContents. */
  public broadcast(event: DesktopEvent): void {
    for (const window of this.#windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(this.#options.eventChannel, event);
    }
  }

  #publishViews(): void {
    const views = this.views();
    if (!views.length) return;
    this.#options.onShellEvent(validateDesktopEvent({ type: "shell.views", timestamp: this.#clock(), views }));
  }
}
