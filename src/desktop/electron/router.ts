import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { JsonThreadStore } from "../thread-store.js";
import { DesktopChatService, type DesktopChatServiceOptions } from "../chat-service.js";
import { DesktopCouncilService, type DesktopCouncilServiceOptions } from "../council-service.js";
import type { DesktopCredentialVaultService } from "../credential-vault.js";
import type { DesktopCommand, DesktopEvent, DesktopProviderMetadata, GuardedGitService, ThreadStore } from "../types.js";
import { validateDesktopCommand, validateDesktopEvent } from "./contracts.js";
import { assertTrustedExecutablePath, DesktopExternalToolService, SystemTrustedExecutableResolver, type TrustedExecutableResolver } from "./external-tools.js";
import type { JsonDesktopAppStateStore } from "./app-state.js";
import type { WorkerProcessSupervisor } from "./worker-supervisor.js";
import { redactDesktopFailure } from "./security.js";
import { CodingSessionStore } from "../../coding/session-store.js";

export interface DesktopCommandRouterOptions {
  stateStore: JsonDesktopAppStateStore;
  credentialVault: DesktopCredentialVaultService;
  workerSupervisor: WorkerProcessSupervisor;
  guardedGitFactory: (repositoryRoot: string) => GuardedGitService;
  threadStoreFactory?: (repositoryRoot: string) => ThreadStore;
  codingSessionStoreFactory?: (repositoryRoot: string) => Pick<CodingSessionStore, "load">;
  externalTools?: DesktopExternalToolService;
  /** Injectable chat service for tests; defaults to a DesktopChatService bound to the open repository. */
  chatService?: DesktopChatService;
  chatServiceOptions?: DesktopChatServiceOptions;
  /** Injectable council service for tests; defaults to a DesktopCouncilService bound to the open repository. */
  councilService?: DesktopCouncilService;
  councilServiceOptions?: DesktopCouncilServiceOptions;
  onEvent?: (event: DesktopEvent) => void;
  clock?: () => string;
  canonicalize?: (repositoryRoot: string) => Promise<string>;
}

const credentialRouterQueues = new WeakMap<object, Promise<void>>();

export class DesktopCommandRouter {
  readonly #threadStoreFactory: (repositoryRoot: string) => ThreadStore;
  readonly #externalTools: DesktopExternalToolService;
  readonly #clock: () => string;
  readonly #canonicalize: (repositoryRoot: string) => Promise<string>;
  readonly #repositoryMutationTails = new Map<string, Promise<void>>();
  readonly #chatService: DesktopChatService;
  readonly #councilService: DesktopCouncilService;
  #repositoryRoot: string | null = null;
  #repositoryOpenEpoch = 0;

  public constructor(private readonly options: DesktopCommandRouterOptions) {
    this.#threadStoreFactory = options.threadStoreFactory ?? ((root) => new JsonThreadStore(root));
    this.#externalTools = options.externalTools ?? new DesktopExternalToolService();
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#canonicalize = options.canonicalize ?? ((root) => fs.realpath(root));
    this.#chatService = options.chatService ?? new DesktopChatService(
      () => this.#requiredRepository(),
      (event) => this.#emitServiceEvent(event),
      options.chatServiceOptions,
    );
    this.#councilService = options.councilService ?? new DesktopCouncilService(
      () => this.#requiredRepository(),
      (event) => this.#emitServiceEvent(event),
      options.councilServiceOptions,
    );
  }

  #emitServiceEvent(event: DesktopEvent): void {
    this.options.onEvent?.(validateDesktopEvent(event));
  }

  public async handle(untrusted: unknown): Promise<DesktopEvent> {
    let requestId = "unknown";
    let provenanceRoot: string | null = null;
    try {
      const command = validateDesktopCommand(untrusted);
      requestId = command.requestId;
      const repositoryCommands = new Set(["repository.open", "thread.list", "thread.create", "thread.load", "thread.message.append", "thread.archive", "run.start", "run.pause", "run.resume", "run.cancel", "run.report", "git.inspect", "changes.diff", "git.commit.preview", "git.commit.confirm", "git.push.preview", "git.push.confirm", "git.pull-request.preview", "git.pull-request.confirm", "git.discard.preview", "git.discard.confirm", "external.open-editor", "external.open-terminal", "external.open-explorer", "chat.list", "chat.create", "chat.load", "chat.archive", "chat.route", "chat.send", "chat.cancel", "council.start", "council.cancel"]);
      if (repositoryCommands.has(command.type)) provenanceRoot = command.type === "repository.open" ? command.repositoryRoot : this.#repositoryRoot;
      const dispatched = await this.#dispatch(command);
      const repositoryScoped = new Set(["desktop.ready", "thread.changed", "thread.listed", "run.changed", "run.pause-requested", "run.reported", "runtime.event", "worker.starting", "worker.started", "worker.stopped", "git.changed", "git.previewed", "git.action-completed", "changes.diffed", "request.completed"]);
      const repositoryRoot = dispatched.type === "desktop.ready" ? dispatched.repositoryRoot : provenanceRoot;
      const event = validateDesktopEvent({ ...dispatched, requestId: command.requestId, ...(repositoryRoot && repositoryScoped.has(dispatched.type) ? { repositoryRoot } : {}) });
      this.options.onEvent?.(event);
      return event;
    } catch (error) {
      return validateDesktopEvent({ type: "request.failed", timestamp: this.#clock(), requestId, ...(provenanceRoot ? { repositoryRoot: provenanceRoot } : {}), message: redactDesktopFailure(error), recoverable: true });
    }
  }

  async #dispatch(command: DesktopCommand): Promise<DesktopEvent> {
    const timestamp = this.#clock();
    switch (command.type) {
      case "repository.list": {
        const state = await this.options.stateStore.load();
        return { type: "repository.listed", timestamp, repositories: state.recentRepositories };
      }
      case "repository.open": {
        const epoch = ++this.#repositoryOpenEpoch;
        const root = await this.#canonicalize(command.repositoryRoot);
        if (!(await fs.stat(root)).isDirectory()) throw new Error("Repository root must be a directory.");
        await this.options.workerSupervisor.reconcileRepositoryRuns(root);
        if (epoch !== this.#repositoryOpenEpoch) throw new Error("Repository open request was superseded by a newer request.");
        this.#repositoryRoot = root;
        await this.options.stateStore.mutate((state) => ({ ...state, updatedAt: timestamp, recentRepositories: [{ path: root, lastOpenedAt: timestamp }, ...state.recentRepositories.filter((entry) => this.#key(entry.path) !== this.#key(root))].slice(0, 20) }));
        return { type: "desktop.ready", timestamp, repositoryRoot: root };
      }
      case "thread.list": return { type: "thread.listed", timestamp, threads: await this.#threads().list() };
      case "thread.create": return { type: "thread.changed", timestamp, thread: await this.#threads().create(command.input) };
      case "thread.load": { const thread = await this.#threads().load(command.threadId); if (!thread) throw new Error("Desktop thread not found."); return { type: "thread.changed", timestamp, thread }; }
      case "thread.message.append": {
        const root = this.#requiredRepository();
        return this.#withRepositoryMutation(root, async () => {
          if (this.options.workerSupervisor.hasActiveRepository(root)) throw new Error("Wait for the active repository run to stop before changing its thread.");
          const store = this.#threads();
          const thread = await store.load(command.input.threadId);
          if (!thread) throw new Error("Desktop thread not found.");
          if (thread.runs.some((run) => !["completed", "failed", "cancelled"].includes(run.status))) throw new Error("Resume or cancel the paused turn before appending another message.");
          return { type: "thread.changed" as const, timestamp, thread: await store.appendMessage(command.input.threadId, command.input.message) };
        });
      }
      case "thread.archive": {
        const root = this.#requiredRepository();
        return this.#withRepositoryMutation(root, async () => {
          if (this.options.workerSupervisor.hasActiveRepository(root)) throw new Error("Wait for the active repository run to stop before archiving its thread.");
          const store = this.#threads();
          const thread = await store.load(command.threadId);
          if (!thread) throw new Error("Desktop thread not found.");
          if (thread.runs.some((run) => !["completed", "failed", "cancelled"].includes(run.status))) throw new Error("Resume or cancel the paused turn before archiving its thread.");
          return { type: "thread.changed" as const, timestamp, thread: await store.archive(command.threadId) };
        });
      }
      case "run.start": case "run.pause": case "run.resume": case "run.cancel": {
        const root = await this.#selected(command.input.repositoryRoot);
        const dispatch = this.options.workerSupervisor.dispatchAndWait.bind(this.options.workerSupervisor);
        if (command.type === "run.start") await this.#withRepositoryMutation(root, () => dispatch(root, { ...command, input: { ...command.input, repositoryRoot: root } }));
        else if (command.type === "run.pause") {
          this.options.onEvent?.(validateDesktopEvent({ type: "run.pause-requested", timestamp, requestId: command.requestId, repositoryRoot: root, codingSessionId: command.input.codingSessionId }));
          await dispatch(root, { ...command, input: { ...command.input, repositoryRoot: root } });
        }
        else if (command.type === "run.resume") await dispatch(root, { ...command, input: { ...command.input, repositoryRoot: root } });
        else await dispatch(root, { ...command, input: { ...command.input, repositoryRoot: root } });
        return { type: "request.completed", timestamp, requestId: command.requestId };
      }
      case "run.report": {
        const root = await this.#selected(command.input.repositoryRoot);
        const thread = await this.#threads().load(command.input.threadId);
        if (!thread?.runs.some((run) => run.codingSessionId === command.input.codingSessionId)) throw new Error("Coding session is not linked to this thread.");
        const session = await (this.options.codingSessionStoreFactory?.(root) ?? new CodingSessionStore(root)).load(command.input.codingSessionId);
        return { type: "run.reported", timestamp, codingSessionId: command.input.codingSessionId, report: session?.finalReport ?? null };
      }
      case "provider.list": return this.#credentialTransaction(async () => ({ type: "provider.listed", timestamp, providers: (await this.#syncProviderConfigured()).providers }));
      case "provider.metadata": return this.#credentialTransaction(async () => { const provider = (await this.#syncProviderConfigured()).providers.find((entry) => entry.id === command.providerId); if (!provider) throw new Error("Provider metadata not found."); return { type: "provider.changed", timestamp, provider }; });
      case "provider.configure": {
        return this.#credentialTransaction(async () => {
          const credential = await this.options.credentialVault.metadata(command.input.id);
          const provider: DesktopProviderMetadata = { ...command.input, configured: command.input.approved && (command.input.authType === "none" || credential !== null) };
          await this.options.stateStore.mutate((state) => ({ ...state, updatedAt: timestamp, providers: [...state.providers.filter((entry) => entry.id !== provider.id), provider].sort((a, b) => a.id.localeCompare(b.id)) }));
          return { type: "provider.changed", timestamp, provider };
        });
      }
      case "credential.list": return this.#credentialTransaction(async () => { const credentials = await this.options.credentialVault.list(); await this.#syncProviderConfigured(credentials); return { type: "credential.listed", timestamp, credentials }; });
      case "credential.metadata": { const credential = await this.options.credentialVault.metadata(command.providerId); if (!credential) throw new Error("Credential metadata not found."); return { type: "credential.changed", timestamp, credential }; }
      case "credential.set": return this.#credentialTransaction(async () => { const credential = await this.options.credentialVault.set(command.input); await this.#syncProviderConfigured(); return { type: "credential.changed", timestamp, credential }; });
      case "credential.replace": return this.#credentialTransaction(async () => { const credential = await this.options.credentialVault.replace(command.input); await this.#syncProviderConfigured(); return { type: "credential.changed", timestamp, credential }; });
      case "credential.remove": return this.#credentialTransaction(async () => { await this.options.credentialVault.remove(command.input); await this.#syncProviderConfigured(); return { type: "credential.changed", timestamp, credential: { ...command.input, configured: false } }; });
      case "credential.test": return { type: "credential.tested", timestamp, result: await this.options.credentialVault.test(command.input) };
      case "git.inspect": { const root = await this.#selected(command.repositoryRoot); return { type: "git.changed", timestamp, status: await this.options.guardedGitFactory(root).inspect(root) }; }
      case "changes.diff": { const root = await this.#selected(command.input.repositoryRoot); return { type: "changes.diffed", timestamp, diff: await this.options.guardedGitFactory(root).inspectDiff({ ...command.input, repositoryRoot: root }) }; }
      case "git.commit.preview": case "git.push.preview": case "git.pull-request.preview": case "git.discard.preview": { const root = await this.#selected(command.input.repositoryRoot); return { type: "git.previewed", timestamp, preview: await this.options.guardedGitFactory(root).prepareConfirmation({ ...command.input, repositoryRoot: root }) }; }
      case "git.commit.confirm": { const root = await this.#selected(command.input.proposal.repositoryRoot); const input = { ...command.input, proposal: { ...command.input.proposal, repositoryRoot: root } }; const result = await this.options.guardedGitFactory(root).confirmCommit(input); return { type: "git.action-completed", timestamp, action: "commit", ...result }; }
      case "git.push.confirm": { const root = await this.#selected(command.input.proposal.repositoryRoot); const input = { ...command.input, proposal: { ...command.input.proposal, repositoryRoot: root } }; const result = await this.options.guardedGitFactory(root).confirmPush(input); return { type: "git.action-completed", timestamp, action: "push", ...result }; }
      case "git.pull-request.confirm": { const root = await this.#selected(command.input.proposal.repositoryRoot); const input = { ...command.input, proposal: { ...command.input.proposal, repositoryRoot: root } }; const result = await this.options.guardedGitFactory(root).confirmPullRequest(input); return { type: "git.action-completed", timestamp, action: "pull-request", url: result.url }; }
      case "git.discard.confirm": { const root = await this.#selected(command.input.proposal.repositoryRoot); await this.options.guardedGitFactory(root).confirmDiscard({ ...command.input, proposal: { ...command.input.proposal, repositoryRoot: root } }); return { type: "git.action-completed", timestamp, action: "discard" }; }
      case "external.open-editor": { const root = await this.#selected(command.input.repositoryRoot); await this.#externalTools.openEditor({ ...command.input, repositoryRoot: root }); return { type: "request.completed", timestamp, requestId: command.requestId }; }
      case "external.open-terminal": { const root = await this.#selected(command.repositoryRoot); await this.#externalTools.openTerminal(root); return { type: "request.completed", timestamp, requestId: command.requestId }; }
      case "external.open-explorer": { const root = await this.#selected(command.input.repositoryRoot); await this.#externalTools.openExplorer({ ...command.input, repositoryRoot: root }); return { type: "request.completed", timestamp, requestId: command.requestId }; }
      case "chat.list": return { type: "chat.listed", timestamp, conversations: await this.#chatService.list() };
      case "chat.create": return { type: "chat.changed", timestamp, conversation: await this.#chatService.create(command.input) };
      case "chat.load": return { type: "chat.changed", timestamp, conversation: await this.#chatService.load(command.conversationId) };
      case "chat.archive": return { type: "chat.listed", timestamp, conversations: await this.#chatService.archive(command.conversationId) };
      case "chat.route": { void this.#chatService.route(command.input).catch((error) => this.#emitServiceEvent({ type: "request.failed", timestamp: this.#clock(), requestId: command.requestId, message: redactDesktopFailure(error), recoverable: true })); return { type: "request.completed", timestamp, requestId: command.requestId }; }
      case "chat.send": { await this.#chatService.send(command.input); return { type: "request.completed", timestamp, requestId: command.requestId }; }
      case "chat.cancel": { this.#chatService.cancel(command.conversationId); return { type: "request.completed", timestamp, requestId: command.requestId }; }
      case "council.start": { await this.#councilService.start(command.input); return { type: "request.completed", timestamp, requestId: command.requestId }; }
      case "council.cancel": { this.#councilService.cancel(command.runId); return { type: "request.completed", timestamp, requestId: command.requestId }; }
    }
  }

  #threads(): ThreadStore { if (!this.#repositoryRoot) throw new Error("Open a repository before using threads."); return this.#threadStoreFactory(this.#repositoryRoot); }
  #requiredRepository(): string { if (!this.#repositoryRoot) throw new Error("Open a repository before repository-scoped operations."); return this.#repositoryRoot; }
  async #withRepositoryMutation<T>(repositoryRoot: string, operation: () => Promise<T>): Promise<T> {
    const key = this.#key(repositoryRoot);
    const previous = this.#repositoryMutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#repositoryMutationTails.set(key, tail);
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally { release(); if (this.#repositoryMutationTails.get(key) === tail) this.#repositoryMutationTails.delete(key); }
  }
  async #selected(repositoryRoot: string): Promise<string> {
    if (!this.#repositoryRoot) throw new Error("Open a repository before repository-scoped operations.");
    const canonical = await this.#canonicalize(repositoryRoot);
    if (this.#key(canonical) !== this.#key(this.#repositoryRoot)) throw new Error("Desktop command repository does not match the selected repository.");
    return this.#repositoryRoot;
  }
  async #syncProviderConfigured(existing?: Awaited<ReturnType<DesktopCredentialVaultService["list"]>>) {
    const credentials = existing ?? await this.options.credentialVault.list();
    const configuredIds = new Set(credentials.filter((entry) => entry.configured).map((entry) => entry.providerId));
    return this.options.stateStore.mutate((state) => ({
      ...state,
      updatedAt: this.#clock(),
      providers: state.providers.map((provider) => ({ ...provider, configured: provider.approved && (provider.authType === "none" || configuredIds.has(provider.id)) })),
    }));
  }
  async #credentialTransaction<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.options.stateStore as object;
    const previous = credentialRouterQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    credentialRouterQueues.set(key, current);
    await previous;
    try { return await operation(); }
    finally { release(); if (credentialRouterQueues.get(key) === current) credentialRouterQueues.delete(key); }
  }
  #key(value: string): string { const resolved = path.resolve(value); return process.platform === "win32" ? resolved.toLowerCase() : resolved; }
}

export class DesktopCliForge {
  public constructor(private readonly repositoryRoot: string, private readonly executables: TrustedExecutableResolver = new SystemTrustedExecutableResolver(), private readonly executor = exec) {}
  public async push(worktreePath: string, branchName: string): Promise<void> { await this.executor(assertTrustedExecutablePath(this.repositoryRoot, await this.executables.resolve("git", this.repositoryRoot)), ["push", "origin", `HEAD:${branchName}`], worktreePath); }
  public async createPR(title: string, body: string, branchName: string, baseBranch: string, draft = false): Promise<string> {
    const args = ["pr", "create", "--title", title, "--body", body, "--head", branchName, "--base", baseBranch];
    if (draft) args.push("--draft");
    return (await this.executor(assertTrustedExecutablePath(this.repositoryRoot, await this.executables.resolve("gh", this.repositoryRoot)), args, this.repositoryRoot)).trim();
  }
}

function exec(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => nodeExecFile(file, args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));
}
