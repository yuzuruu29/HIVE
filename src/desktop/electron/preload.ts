import { contextBridge, ipcRenderer } from "electron";
import { createHiveDesktopApi, DESKTOP_EVENT_CHANNEL } from "./preload-api.js";

const api = createHiveDesktopApi({
  invoke: (channel, command) => ipcRenderer.invoke(channel, command),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => listener(payload);
    ipcRenderer.on(DESKTOP_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DESKTOP_EVENT_CHANNEL, handler);
  },
});

contextBridge.exposeInMainWorld("hiveDesktop", api);

declare global {
  interface Window { hiveDesktop: typeof api }
}
