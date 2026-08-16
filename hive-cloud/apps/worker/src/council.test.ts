import { afterEach, describe, expect, it, vi } from "vitest";

const bullmqMocks = vi.hoisted(() => ({
  fromId: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Job: { fromId: bullmqMocks.fromId },
}));

import { createCouncilProcessor } from "./council.js";

describe("Council orchestration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("runs independent checks in parallel before Queen synthesis", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;
    const routedPhases: string[] = [];

    bullmqMocks.fromId.mockResolvedValue({ data: { cancelled: false } });
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const phase = (headers["idempotency-key"] ?? "build:unknown").split(":")[1] || "unknown";
      routedPhases.push(phase);
      activeCalls += 1;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);

      await new Promise((resolve) => setTimeout(resolve, phase === "validator" || phase === "reviewer" ? 12 : 1));
      activeCalls -= 1;

      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: `${phase} output` } }],
          hive: {
            requestId: `request-${phase}`,
            router: "hive-0.1",
            policy: "free-first-balanced",
            provider: `provider-${phase}`,
            model: `model-${phase}`,
            managed: false,
            costClass: "byok",
            fallbackCount: 0,
            latencyMs: 12,
            attempts: [],
          },
        }),
      } as Response;
    }));

    const updateProgress = vi.fn();
    const processor = createCouncilProcessor(
      "http://api.local",
      "test-internal-secret-with-32-characters",
      {} as never,
    );
    const result = await processor({
      id: "council-test",
      data: {
        objective: "Produce one verified orchestration result.",
        files: [],
        subject: {
          userId: "user-1",
          tenantId: "tenant-1",
          email: "owner@example.com",
          role: "owner",
        },
      },
      updateProgress,
    } as never);

    expect(routedPhases).toEqual([
      "queen",
      "scout",
      "planner",
      "builder",
      "validator",
      "reviewer",
      "synthesizer",
    ]);
    expect(maxConcurrentCalls).toBe(2);
    expect(updateProgress).toHaveBeenCalledWith(expect.objectContaining({
      active: ["validator", "reviewer"],
      completed: 4,
      total: 7,
    }));
    expect(result).toMatchObject({
      status: "complete",
      phases: [
        { name: "queen" },
        { name: "scout" },
        { name: "planner" },
        { name: "builder" },
        { name: "validator" },
        { name: "reviewer" },
        { name: "synthesizer" },
      ],
    });
    expect(result.artifacts[0]).toMatchObject({
      kind: "result",
      title: "Queen synthesis",
      content: "synthesizer output",
    });
  });
});
