import type { DesktopCommand, DesktopEvent } from "../../../src/desktop/types";

export interface HiveDesktopBridge {
  request(command: DesktopCommand): Promise<DesktopEvent>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}

declare global {
  interface Window { hiveDesktop: HiveDesktopBridge }
}

export function installedBridge(): HiveDesktopBridge {
  if (!window.hiveDesktop) throw new Error("The secure HIVE desktop bridge is unavailable.");
  return window.hiveDesktop;
}
