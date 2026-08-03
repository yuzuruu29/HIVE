import { ProviderRouter } from "./provider-router.js";
import {
  QueenOrchestrator,
  createCodingSessionId,
  type QueenSessionOptions,
  type QueenToolFactory,
} from "./queen.js";
import { findRepositoryRoot } from "./repository.js";
import { CodingSessionStore } from "./session-store.js";
import { RepositoryToolService } from "./tools.js";
import type { RuntimeEvent, RuntimeEventType } from "./types.js";
import { WorktreeManager } from "../worktree.js";

export interface CreateQueenSessionResult {
  orchestrator: QueenOrchestrator;
  store: CodingSessionStore;
  providerRouter: ProviderRouter;
  repositoryRoot: string;
  sessionId: string;
}

export async function createQueenSession(
  options: QueenSessionOptions,
): Promise<CreateQueenSessionResult> {
  const repositoryRoot = await findRepositoryRoot(options.repositoryPath, options.signal);
  const sessionId = options.resumeId ?? options.sessionId ?? createCodingSessionId();
  const store = new CodingSessionStore(repositoryRoot);
  const resumed = options.resumeId ? await store.load(options.resumeId) : null;
  const providerRouter = new ProviderRouter({
    projectRoot: repositoryRoot,
    sessionId,
    sessionBindings: resumed?.providerBindings,
    projectRegistry: options.providerRegistries?.project,
    globalRegistry: options.providerRegistries?.global,
  });
  const tools: QueenToolFactory = {
    create(factoryOptions) {
      const emit = factoryOptions.emit as unknown as (
        type: RuntimeEventType,
        payload: RuntimeEvent["payload"],
      ) => RuntimeEvent;
      return new RepositoryToolService({
        repositoryRoot: factoryOptions.repositoryRoot,
        sessionId: factoryOptions.sessionId,
        approvalPolicy: factoryOptions.approvalPolicy,
        onEvent: (event) => {
          emit(event.type, event.payload);
        },
      });
    },
  };
  const worktrees = {
    async create(root: string, id: string, baseCommit: string): Promise<string> {
      return new WorktreeManager(root).createWorktreeFrom(id, baseCommit);
    },
  };
  const orchestrator = new QueenOrchestrator(
    { ...options, repositoryPath: repositoryRoot, sessionId },
    { store, provider: providerRouter, tools, worktrees },
  );
  return { orchestrator, store, providerRouter, repositoryRoot, sessionId };
}

export async function runQueenSession(
  options: QueenSessionOptions,
): Promise<Awaited<ReturnType<QueenOrchestrator["run"]>>> {
  const { orchestrator } = await createQueenSession(options);
  return orchestrator.run();
}
