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
import { ProjectWorkerEngine, type ProjectWorkerChild } from "./project-worker.js";
import { createProductionProjectSessionService } from "../../projects/runtime-adapter.js";
import { DesktopShutdownGate } from "./shutdown.js";

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
  const resolveProjectCredential = async (providerId: string) => {
    const provider = (await stateStore.load()).providers.find((entry) => entry.id === providerId);
    // A shared CLI-selected provider may be stored in HIVE's existing registry.
    if (!provider) return undefined;
    if (!provider.approved) throw new Error("Desktop provider is not configured and approved.");
    if (provider.authType === "none") return { provider };
    const credential = await credentialVault.credentialResolver.resolve(providerId);
    if (!credential) throw new Error("Desktop provider credential is not configured.");
    return { provider, kind: credential.kind, secret: credential.secret };
  };
  const projectEngine = new ProjectWorkerEngine({
    spawn: () => utilityProcess.fork(workerFile, [], { serviceName: "HIVE Shared Session Runtime", env: { ...process.env } }) as unknown as ProjectWorkerChild,
    resolveCredential: resolveProjectCredential,
    terminateTree: async (child) => {
      if (process.platform !== "win32") { if (child.kill() === false) throw new Error("Worker termination was refused."); return; }
      if (!Number.isSafeInteger(child.pid) || !child.pid || child.pid < 1) throw new Error("Cannot verify the owned runtime process for termination.");
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      await new Promise<void>((resolve, reject) => nodeExecFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, (error) => error ? reject(error) : resolve()));
    },
  });
  const testCatalog = !app.isPackaged && process.env.HIVE_DESKTOP_TESTING === "1" ? process.env.HIVE_PROJECT_CATALOG : undefined;
  if (testCatalog && (!path.isAbsolute(testCatalog) || testCatalog.includes("\0"))) throw new Error("HIVE_PROJECT_CATALOG must be an absolute path.");
  const projects = await createProductionProjectSessionService({
    catalogPath: isPackagedSmokeMode() || (!app.isPackaged && process.env.HIVE_DESKTOP_TESTING === "1") ? testCatalog ?? path.join(userData, "interface-v1", "catalog.json") : undefined,
    engine: projectEngine,
    onSnapshot: (snapshot) => shellWindows?.broadcast(validateDesktopEvent({ type: "projects.snapshot", timestamp: new Date().toISOString(), snapshot })),
  });
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
    stateStore, credentialVault, workerSupervisor, projects,
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
    pickDirectory: async () => {
      const focused = BrowserWindow.getFocusedWindow();
      const result = focused
        ? await dialog.showOpenDialog(focused, { properties: ["openDirectory"] })
        : await dialog.showOpenDialog({ properties: ["openDirectory"] });
      if (result.canceled || !result.filePaths[0]) return null;
      return result.filePaths[0];
    },
    onEvent: (event) => shellWindows?.broadcast(event),
  });

  const startupState = await stateStore.load();
  const shutdown = new DesktopShutdownGate({
    hasActiveRuns: () => workerSupervisor.hasActiveRuns() || projectEngine.hasActiveRuns() || projects.hasOwnedRuns(),
    confirmExit: async () => {
      const options = { type: "warning" as const, title: "HIVE is still working", message: "Active repository runs are still in progress.", detail: "Keep HIVE open, or cooperatively cancel the runs before exiting.", buttons: ["Keep HIVE Open", "Cancel Runs and Exit"], defaultId: 0, cancelId: 0, noLink: true };
      const focused = BrowserWindow.getFocusedWindow();
      return (await (focused ? dialog.showMessageBox(focused, options) : dialog.showMessageBox(options))).response === 1;
    },
    close: async () => { await workerSupervisor.cancelAll(); await projects.close(); await projectEngine.close(); },
    quit: () => { quitting = true; app.quit(); },
    onFailure: async (error) => {
      const message = `Exit cancelled because active runs could not be durably cancelled: ${redactDesktopFailure(error)}`;
      shellWindows?.broadcast({ type: "worker.failed", timestamp: new Date().toISOString(), message, recoverable: false });
      if (!BrowserWindow.getAllWindows().length) shellWindows?.open("chat");
      await dialog.showMessageBox({ type: "error", title: "HIVE kept open", message: "HIVE could not safely cancel every active run.", detail: message, buttons: ["Keep HIVE Open"], defaultId: 0, noLink: true });
    },
  });
  app.on("before-quit", (event) => { if (quitting) return; event.preventDefault(); void shutdown.request(); });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedRendererUrl(details.url, locationPolicy)) { callback({ responseHeaders: details.responseHeaders }); return; }
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [desktopContentSecurityPolicy(developmentUrl)] } });
  });

  function createShellWindow(view: ShellView): BrowserWindow {
    const window = new BrowserWindow({
      width: 1440, height: 900, minWidth: 560, minHeight: 480, show: true, backgroundColor: "#171717",
      title: "HIVE",
      webPreferences: { ...DESKTOP_BROWSER_WEB_PREFERENCES, preload: preloadFile },
    });
    window.show();
    window.focus();

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed()) {
        window.show();
        window.focus();
      }
    });
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) {
        window.show();
        window.focus();
      }
    });
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      dialog.showErrorBox("HIVE UI Failed to Load", `Failed to load ${validatedURL}\nError: ${errorDescription} (${errorCode})`);
    });
    window.on("close", (event) => {
      if (quitting || BrowserWindow.getAllWindows().length > 1) return;
      event.preventDefault();
      void shutdown.request();
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

  // Reconcile repository runs only after the first window exists: a hung
  // reconcile must never hold the single-instance lock behind an invisible app.
  for (const recent of startupState.recentRepositories) {
    try { await workerSupervisor.reconcileRepositoryRuns(recent.path); }
    catch (error) { shellWindows.broadcast({ type: "worker.failed", timestamp: new Date().toISOString(), message: `Startup reconciliation failed: ${redactDesktopFailure(error)}`, recoverable: false }); }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    shellWindows?.focusFirstOrCreate("chat");
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.whenReady().then(start).catch((error) => { dialog.showErrorBox("HIVE desktop failed to start", error instanceof Error ? error.message : String(error)); app.exit(1); });
}
