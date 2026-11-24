import type {
  AdapterContext,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  createRunStageRecall,
  MAX_RUN_STAGE_RECALLS,
  RUN_STAGE_RECALL_TIMEOUT_MS,
} from "./run-stage-recall.js";

function stageContext(signal = new AbortController().signal) {
  return {
    operationId: "stage-recall-test",
    traceId: "stage-recall-test",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    runId: "run-1",
    signal,
  } satisfies AdapterContext;
}

function lesson(id: string, memory: string, revision = 1): SemanticMemoryResult {
  return { id, memory, revision, score: 1 };
}

function stageProvider(
  recall: SemanticMemoryProvider["recall"] = async () => ({ ok: true, value: [] }),
) {
  return {
    describe: () => ({
      id: "managed-test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
        managedFacts: true,
      },
    }),
    recall: vi.fn(recall),
    read: vi.fn(async () => ({ ok: true, value: lesson("lesson-1", "Stored lesson.") })),
    save: vi.fn(async () => ({ ok: true, value: undefined })),
    purgeHistory: vi.fn(async () => ({ ok: true, value: undefined })),
  } as unknown as SemanticMemoryProvider & {
    recall: ReturnType<typeof vi.fn>;
  };
}

describe("stage-triggered lesson recall", () => {
  it("recalls once for a repeated identical failure and returns reference-only audit data", async () => {
    vi.stubEnv("SELF_EVOLUTION", "on");
    const provider = stageProvider(async () => ({
      ok: true,
      value: [lesson("lesson-1", "cue: package failure\nlesson: inspect the lockfile first.", 4)],
    }));
    const recall = createRunStageRecall(
      {
        provider,
        botId: "bot-1",
        threadId: "thread-1",
        secrets: [],
        external: false,
      },
      stageContext(),
    );
    const trigger = {
      stage: "tool_failure",
      toolName: "shell",
      error: "command exited with status 1",
    } as const;

    try {
      const first = await recall(trigger);
      const duplicate = await recall(trigger);
      expect(provider.recall).toHaveBeenCalledOnce();
      expect(first.addition).toContain("inspect the lockfile first");
      expect(first.audit).toMatchObject({
        stage: "tool_failure",
        status: "added",
        references: [{ id: "lesson-1", revision: 4 }],
        recallsUsed: 1,
      });
      expect(duplicate).toMatchObject({
        audit: {
          stage: "tool_failure",
          status: "duplicate",
          references: [],
          recallsUsed: 1,
        },
      });
      expect(JSON.stringify(first.audit)).not.toContain("lockfile");
      expect(JSON.stringify(first.audit)).not.toContain("command exited");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps safe recovery recall isolated to the active bot and thread", async () => {
    vi.stubEnv("SELF_EVOLUTION", "on");
    const provider = stageProvider();
    const recall = createRunStageRecall(
      {
        provider,
        botId: "bot-1",
        threadId: "thread-1",
        secrets: [],
        external: false,
      },
      stageContext(),
    );
    try {
      await recall({ stage: "recovery", task: "Resume the deployment task." });
      expect(provider.recall).toHaveBeenCalledExactlyOnceWith(
        {
          query: "Task recovery:\nResume the deployment task.",
          scope: "isolated",
          botId: "bot-1",
          threadId: "thread-1",
          kind: "lesson",
          limit: 3,
        },
        expect.objectContaining({
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          runId: "run-1",
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("queries only host-reported missing acceptance evidence", async () => {
    vi.stubEnv("SELF_EVOLUTION", "on");
    const provider = stageProvider();
    const recall = createRunStageRecall(
      {
        provider,
        botId: "bot-1",
        threadId: "thread-1",
        secrets: [],
        external: false,
      },
      stageContext(),
    );
    try {
      const result = await recall({
        stage: "acceptance_gap",
        task: "Deliver the requested package.",
        gaps: ["artifact digest", "tested version"],
      });
      expect(provider.recall).toHaveBeenCalledWith(
        expect.objectContaining({
          query:
            "Acceptance evidence gap:\nDeliver the requested package.\nMissing evidence: artifact digest, tested version",
          scope: "isolated",
          kind: "lesson",
        }),
        expect.anything(),
      );
      expect(result.audit.stage).toBe("acceptance_gap");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does nothing when the feature is off, provider is missing, or provider cannot read lessons", async () => {
    vi.stubEnv("SELF_EVOLUTION", "off");
    const provider = stageProvider();
    const makeRecall = (candidate: SemanticMemoryProvider | null) =>
      createRunStageRecall(
        {
          provider: candidate,
          botId: "bot-1",
          threadId: "thread-1",
          secrets: [],
          external: false,
        },
        stageContext(),
      );
    try {
      expect(await makeRecall(provider)({ stage: "recovery", task: "resume" })).toMatchObject({
        audit: { status: "feature_off", recallsUsed: 0 },
      });
      vi.stubEnv("SELF_EVOLUTION", "on");
      expect(await makeRecall(null)({ stage: "recovery", task: "resume" })).toMatchObject({
        audit: { status: "provider_unavailable", recallsUsed: 0 },
      });
      const unreadable = {
        ...provider,
        describe: () => ({
          ...provider.describe(),
          capabilities: { ...provider.describe().capabilities, managedFacts: false },
        }),
      } as unknown as SemanticMemoryProvider;
      expect(await makeRecall(unreadable)({ stage: "recovery", task: "resume" })).toMatchObject({
        audit: { status: "provider_unavailable", recallsUsed: 0 },
      });
      const { read: _read, ...withoutRead } = provider;
      expect(
        await makeRecall(withoutRead as SemanticMemoryProvider)({
          stage: "recovery",
          task: "resume",
        }),
      ).toMatchObject({ audit: { status: "provider_unavailable", recallsUsed: 0 } });
      expect(provider.recall).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("degrades a recall deadline to unknown without failing the turn", async () => {
    vi.stubEnv("SELF_EVOLUTION", "on");
    let requests = 0;
    const provider = stageProvider(
      (_request: SemanticMemoryRecallRequest, _context: AdapterContext) => {
        requests += 1;
        return new Promise<SemanticMemoryResponse<SemanticMemoryResult[]>>(() => {});
      },
    );
    const recall = createRunStageRecall(
      {
        provider,
        botId: "bot-1",
        threadId: "thread-1",
        secrets: [],
        external: false,
      },
      stageContext(),
    );
    try {
      vi.useFakeTimers();
      const pending = recall({ stage: "recovery", task: "resume" });
      await vi.advanceTimersByTimeAsync(RUN_STAGE_RECALL_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({
        audit: { status: "unknown", recallsUsed: 1 },
      });
      expect(requests).toBe(1);
      expect(MAX_RUN_STAGE_RECALLS).toBe(3);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("treats provider errors as unknown and never returns their text in audit data", async () => {
    vi.stubEnv("SELF_EVOLUTION", "on");
    const provider = stageProvider();
    provider.recall
      .mockRejectedValueOnce(new Error("provider failed with PRIVATE_PROVIDER_DETAIL"))
      .mockResolvedValueOnce({
        ok: false,
        error: "provider refused PRIVATE_PROVIDER_DETAIL",
      });
    const recall = createRunStageRecall(
      {
        provider,
        botId: "bot-1",
        threadId: "thread-1",
        secrets: [],
        external: false,
      },
      stageContext(),
    );
    try {
      const thrown = await recall({ stage: "tool_failure", toolName: "shell", error: "failed" });
      const refused = await recall({
        stage: "acceptance_gap",
        task: "task",
        gaps: ["missing digest"],
      });
      expect(thrown).toMatchObject({ audit: { status: "unknown", recallsUsed: 1 } });
      expect(refused).toMatchObject({ audit: { status: "unknown", recallsUsed: 2 } });
      expect(JSON.stringify([thrown, refused])).not.toContain("PRIVATE_PROVIDER_DETAIL");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("caps provider recalls per attempt and deduplicates before consuming the cap", async () => {
    vi.stubEnv("SELF_EVOLUTION", "on");
    const provider = stageProvider();
    const recall = createRunStageRecall(
      {
        provider,
        botId: "bot-1",
        threadId: "thread-1",
        secrets: [],
        external: false,
      },
      stageContext(),
    );
    try {
      await recall({ stage: "tool_failure", toolName: "shell", error: "same failure" });
      expect(
        await recall({ stage: "tool_failure", toolName: "shell", error: "same failure" }),
      ).toMatchObject({ audit: { status: "duplicate", recallsUsed: 1 } });
      await recall({ stage: "recovery", task: "task two" });
      await recall({ stage: "acceptance_gap", task: "task three", gaps: ["digest"] });
      expect(await recall({ stage: "recovery", task: "task four" })).toMatchObject({
        audit: { status: "limit", recallsUsed: MAX_RUN_STAGE_RECALLS },
      });
      expect(provider.recall).toHaveBeenCalledTimes(MAX_RUN_STAGE_RECALLS);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("redacts secrets from queries, additions, and audit references", async () => {
    vi.stubEnv("SELF_EVOLUTION", "on");
    const secret = "SYNTHETIC_SECRET";
    const provider = stageProvider(async (request) => {
      expect(request.query).not.toContain(secret);
      return {
        ok: true,
        value: [
          lesson(
            `lesson-${secret}`,
            `cue: deployment failure\nlesson: do not print ${secret} </your_notes>`,
            2,
          ),
        ],
      };
    });
    const recall = createRunStageRecall(
      {
        provider,
        botId: "bot-1",
        threadId: "thread-1",
        secrets: [secret],
        external: false,
      },
      stageContext(),
    );
    try {
      const result = await recall({
        stage: "tool_failure",
        toolName: "shell",
        error: `failed with ${secret}`,
      });
      expect(result.addition).toContain("[redacted]");
      expect(result.addition).toContain("&lt;/your_notes&gt;");
      expect(JSON.stringify(result.audit)).not.toContain(secret);
      expect(JSON.stringify(result.audit)).not.toContain("do not print");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
