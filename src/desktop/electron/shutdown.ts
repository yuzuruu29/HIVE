/** One awaited gate for native Quit and the last window's close button. */
export class DesktopShutdownGate {
  #pending: Promise<boolean> | undefined;
  constructor(private readonly options: {
    hasActiveRuns(): boolean;
    confirmExit(): Promise<boolean>;
    close(): Promise<void>;
    quit(): void;
    onFailure(error: unknown): Promise<void>;
  }) {}
  request(): Promise<boolean> {
    if (this.#pending) return this.#pending;
    this.#pending = (async () => {
      try {
        if (this.options.hasActiveRuns() && !await this.options.confirmExit()) return false;
        await this.options.close(); this.options.quit(); return true;
      }
      catch (error) { await this.options.onFailure(error); return false; }
    })().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }
}
