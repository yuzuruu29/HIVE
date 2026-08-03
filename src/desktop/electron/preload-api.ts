import type { DesktopCommand, DesktopEvent } from "../types.js";
import { validateDesktopCommand, validateDesktopEvent } from "./contracts.js";

export const DESKTOP_REQUEST_CHANNEL = "hive-desktop:request";
export const DESKTOP_EVENT_CHANNEL = "hive-desktop:event";

export interface HiveDesktopApi {
  request(command: DesktopCommand): Promise<DesktopEvent>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}

export interface HiveDesktopTransport {
  invoke(channel: typeof DESKTOP_REQUEST_CHANNEL, command: DesktopCommand): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
}

export function createHiveDesktopApi(transport: HiveDesktopTransport): Readonly<HiveDesktopApi> {
  return Object.freeze({
    request: async (command: DesktopCommand): Promise<DesktopEvent> => {
      const valid = validateDesktopCommand(command);
      return validateDesktopEvent(await transport.invoke(DESKTOP_REQUEST_CHANNEL, valid));
    },
    subscribe: (listener: (event: DesktopEvent) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("Desktop event listener must be a function.");
      return transport.onEvent((event) => listener(validateDesktopEvent(event)));
    },
  });
}
