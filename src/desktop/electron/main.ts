import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, utilityProcess } from "electron";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { DesktopCredentialVault, JsonCredentialEnvelopeStore } from "../credential-vault.js";
import { DefaultGuardedGitService } from "../guarded-git-service.js";
import { JsonDesktopAppStateStore } from "./app-state.js";
import { DESKTOP_EVENT_CHANNEL, DESKTOP_REQUEST_CHANNEL } from "./preload-api.js";
import { DesktopCliForge, DesktopCommandRouter } from "./router.js";
import { ShellWindowRegistry, type ShellView } from "./shell-windows.js";
import { DESKTOP_BROWSER_WEB_PREFERENCES, desktopContentSecurityPolicy, isTrustedRendererUrl, redactDesktopFailure, validateIpcSender } from "./security.js";
import { validateDesktopCommand, validateDesktopEvent } from "./contracts.js";
import { SafeStorageCredentialCipher } from "./safe-storage.js";
import { WorkerProcessSupervisor, type WorkerChildLike } from "./worker-supervisor.js";
import { DesktopExternalToolService, SystemTrustedExecutableResolver } from "./external-tools.js";
import { execFile as nodeExecFile } from "node:child_process";
import { WorktreeManager } from "../../worktree.js";
import { isPackagedSmokeMode, PACKAGED_SMOKE_PROVIDER_ID } from "./packaged-smoke-runtime.js";

let shellWindows: ShellWindowRegistry | null = null;
let quitting = false;

const preloadFile = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const productionWorkerFile = fileURLToPath(new URL("./worker.mjs", import.meta.url));

if (!app.isPackaged && process.env.HIVE_DESKTOP_TEST_USER_DATA) {
  const testUserData = process.env.HIVE_DESKTOP_TEST_USER_DATA;
  if (!path.isAbsolute(testUserData) || testUserData.includes("\0")) throw new Error("HIVE_DESKTOP_TEST_USER_DATA must be an absolute path.");
  app.setPath("userData", path.resolve(testUserData));
}

if (app.isPackaged && process.env.HIVE_DESKTOP_PACKAGED_SMOKE === "1") {
  const smokeUserData = process.env.HIVE_DESKTOP_SMOKE_USER_DATA;
  if (!smokeUserData || !path.isAbsolute(smokeUserData) || smokeUserData.includes("\0")) {
    throw new Error("HIVE_DESKTOP_SMOKE_USER_DATA must be an absolute temporary path.");
  }
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(smokeUserData);
  const relative = path.relative(temporaryRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Packaged smoke user data must be a child of the system temporary directory.");
  }
  app.setPath("userData", resolved);
}

function configuredWorkerModule(): string {
  const override = process.env.HIVE_DESKTOP_TEST_WORKER_MODULE;
  if (!override) {
    return app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "desktop", "electron", "worker.mjs")
      : productionWorkerFile;
  }
  if (app.isPackaged) throw new Error("Desktop test workers are unavailable in packaged builds.");
  if (process.env.HIVE_DESKTOP_TESTING !== "1" || !path.isAbsolute(override) || override.includes("\0")) throw new Error("Invalid desktop test worker configuration.");
  return path.resolve(override);
}

function configuredDevelopmentUrl(): string | undefined {
  const value = process.env.HIVE_DESKTOP_DEV_URL;
  if (!value) return undefined;
  if (app.isPackaged) throw new Error("The renderer development URL is unavailable in packaged builds.");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("HIVE_DESKTOP_DEV_URL must be an uncredentialed 127.0.0.1 HTTP URL.");
  return parsed.href;
}

async function start(): Promise<void> {
  const developmentUrl = configuredDevelopmentUrl();
  const workerFile = configuredWorkerModule();
  const applicationRoot = app.isPackaged ? app.getAppPath() : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const rendererFile = path.resolve(applicationRoot, "dist-desktop", "renderer", "index.html");
  const locationPolicy = developmentUrl ? { developmentUrl } : { rendererFile };
  const userData = app.getPath("userData");
  const stateStore = new JsonDesktopAppStateStore(userData);  if (isPackagedSmokeMode()) {
    await stateStore.mutate((state) => ({
      ...state,
      providers: [...state.providers.filter((provider) => provider.id !== PACKAGED_SMOKE_PROVIDER_ID), {
        id: PACKAGED_SMOKE_PROVIDER_ID, name: "Internal packaged diagnostic", kind: "local", authType: "none", approved: true, configured: true, defaultModel: "network-free",
      }],
    }));
  }
  const cipher = new SafeStorageCredentialCipher({
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(Buffer.from(value)),
  });
  const credentialVault = new DesktopCredentialVault({ store: new JsonCredentialEnvelopeStore(userData), cipher });
  const gitServices = new Map<string, DefaultGuardedGitService>();
  const executables = new SystemTrustedExecutableResolver();
  const workerSupervisor = new WorkerProcessSupervisor({
    workerModule: workerFile,
    spawn: (module) => utilityProcess.fork(module, [], { serviceName: "HIVE Repository Runtime", env: { ...process.env } }) as unknown as WorkerChildLike,
    canonicalize: (root) => import("node:fs/promises").then(({ realpath }) => realpath(root)),
    resolveCredential: async (providerId) => {
      const provider = (await stateStore.load()).providers.find((entry) => entry.id === providerId);
      if (!provider || !provider.approved) throw new Error("Desktop provider is not configured and approved.");
      if (provider.authType === "none") return { provider };
      const credential = await credentialVault.credentialResolver.resolve(providerId);
      if (!credential) throw new Error("Desktop provider credential is not configured.");
      return { provider, kind: credential.kind, secret: credential.secret };
    },
    onEvent: (event) => shellWindows?.broadcast(event),
  });
  const router = new DesktopCommandRouter({
    stateStore, credentialVault, workerSupervisor,
    guardedGitFactory: (root) => {
      const key = path.resolve(root).toLowerCase();
      let service = gitServices.get(key);
      if (!service) {
        service = new DefaultGuardedGitService({
          forge: new DesktopCliForge(root, executables),
          worktreeManagerFactory: (repositoryRoot) => ({
            getWorktreePath: (sessionId) => new WorktreeManager(repositoryRoot).getWorktreePath(sessionId),
            commitWorktree: async (sessionId, message, files) => new WorktreeManager(repositoryRoot, await executables.resolve("git", repositoryRoot)).commitWorktree(sessionId, message, files),
            discardWorktree: async (sessionId) => new WorktreeManager(repositoryRoot, await executables.resolve("git", repositoryRoot)).discardWorktree(sessionId),
          }),
          execFile: async (_file, args, options) => {
            const git = await executables.resolve("git", root);
            return new Promise((resolve, reject) => nodeExecFile(git, [...args], { ...options, windowsHide: true }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout: String(stdout), stderr: String(stderr) })));
          },
        });
        gitServices.set(key, service);
      }
      return service;
    },
    externalTools: new DesktopExternalToolService("vscode", undefined, executables),
    onEvent: (event) => shellWindows?.broadcast(event),
  });

  const startupState = await stateStore.load();
  const startupFailures: string[] = [];
  for (const recent of startupState.recentRepositories) {
    try { await workerSupervisor.reconcileRepositoryRuns(recent.path); }
    catch (error) { startupFailures.push(redactDesktopFailure(error)); }
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedRendererUrl(details.url, locationPolicy)) { callback({ responseHeaders: details.responseHeaders }); return; }
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [desktopContentSecurityPolicy(developmentUrl)] } });
  });

  function createShellWindow(view: ShellView): BrowserWindow {
    const window = new BrowserWindow({
      width: 1440, height: 900, minWidth: 1060, minHeight: 680, show: false, backgroundColor: "#0b0712",
      title: view === "coder" ? "HIVE Coder" : "HIVE",
      webPreferences: { ...DESKTOP_BROWSER_WEB_PREFERENCES, preload: preloadFile },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.once("did-finish-load", () => {
      for (const failure of startupFailures) window.webContents.send(DESKTOP_EVENT_CHANNEL, { type: "worker.failed", timestamp: new Date().toISOString(), message: `Startup reconciliation failed: ${failure}`, recoverable: false });
    });
    window.once("ready-to-show", () => window.show());
    window.on("close", (event) => {
      if (quitting || !workerSupervisor.hasActiveRuns()) return;
      event.preventDefault();
      void dialog.showMessageBox(window, {
        type: "warning", title: "HIVE is still working", message: "Active repository runs are still in progress.",
        detail: "Keep HIVE open, or cooperatively cancel the runs before exiting.", buttons: ["Keep HIVE Open", "Cancel Runs and Exit"], defaultId: 0, cancelId: 0, noLink: true,
      }).then(async ({ response }) => {
        if (response !== 1) return;
        quitting = true;
        try {
          await workerSupervisor.cancelAll();
          app.exit(0);
        } catch (error) {
          quitting = false;
          const message = `Exit cancelled because active runs could not be durably cancelled: ${redactDesktopFailure(error)}`;
          window.webContents.send(DESKTOP_EVENT_CHANNEL, { type: "worker.failed", timestamp: new Date().toISOString(), message, recoverable: false });
          await dialog.showMessageBox(window, { type: "error", title: "HIVE kept open", message: "HIVE could not safely cancel every active run.", detail: message, buttons: ["Keep HIVE Open"], defaultId: 0, noLink: true });
        }
      });
    });
    const search = `?view=${view}`;
    if (developmentUrl) void window.loadURL(new URL(`${developmentUrl}${search}`).href);
    else void window.loadFile(rendererFile, { search });
    return window;
  }

  shellWindows = new ShellWindowRegistry({
    create: createShellWindow,
    onShellEvent: (event) => shellWindows?.broadcast(event),
    eventChannel: DESKTOP_EVENT_CHANNEL,
  });

  ipcMain.handle(DESKTOP_REQUEST_CHANNEL, async (event, payload) => {
    validateIpcSender({ url: event.senderFrame?.url ?? event.sender.getURL() }, locationPolicy);
    const command = validateDesktopCommand(payload);
    if (command.type === "shell.open-view" || command.type === "shell.close-view") {
      try {
        if (command.type === "shell.open-view") shellWindows?.open(command.view);
        else shellWindows?.close(command.view);
        return validateDesktopEvent({ type: "request.completed", timestamp: new Date().toISOString(), requestId: command.requestId });
      } catch (error) {
        return validateDesktopEvent({ type: "request.failed", timestamp: new Date().toISOString(), requestId: command.requestId, message: redactDesktopFailure(error), recoverable: true });
      }
    }
    return router.handle(payload);
  });

  shellWindows.open("chat");
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.whenReady().then(start).catch((error) => { dialog.showErrorBox("HIVE desktop failed to start", error instanceof Error ? error.message : String(error)); app.exit(1); });
