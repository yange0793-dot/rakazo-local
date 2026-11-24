import { createHash } from "node:crypto";
import type { AdapterContext, ArtifactPut, ArtifactStore } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RunConfigurationManifestInput } from "./run-configuration-manifest.js";
import {
  buildRunConfigurationManifest,
  RUN_CONFIGURATION_MANIFEST_FORMAT,
  RUN_CONFIGURATION_MANIFEST_VERSION,
  storeRunConfigurationManifest,
} from "./run-configuration-manifest.js";

const context: AdapterContext = {
  operationId: "manifest-op",
  traceId: "manifest-trace",
  spaceId: "space-a",
  userId: "user-a",
  botId: "bot-a",
  signal: new AbortController().signal,
};

const input: RunConfigurationManifestInput = {
  runId: "run-a",
  attemptId: "attempt-a",
  deploymentRevision: "  abc123  ",
  model: {
    requested: { provider: "provider-a", modelId: "model-a", reasoningLevel: "high" },
    deliveredAtStart: { provider: "provider-b", modelId: "model-b", reasoningLevel: "low" },
    computerModel: null,
    effectiveReasoningLevel: null,
    allowedFallbacks: [{ provider: "provider-b", modelId: "model-b", reasoningLevel: "low" }],
    actualFallbacks: [
      {
        provider: "provider-b",
        modelId: "model-b",
        reasoningLevel: "low",
        source: "startup-selection",
      },
    ],
  },
  runtime: {
    id: "runtime-a",
    contractVersion: "2",
    adapterVersion: "3",
    capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
  },
  contextPolicy: {
    requestedStrategy: "retrieval",
    deliveredStrategy: "retrieval",
    effectiveStrategy: null,
    revision: null,
    recallRevision: null,
  },
  pinnedTaughtSkills: [{ skillId: "skill-a", revisionId: "skill-revision-a" }],
  shownLessons: [{ lessonId: "lesson-a", revision: 4 }],
};

function artifactStore() {
  const put = vi.fn(async (_artifact: ArtifactPut, _context: AdapterContext) => ({
    id: "stored-manifest-a",
    hash: "backend-size-hash",
  }));
  return { put, store: { put } as unknown as ArtifactStore };
}

describe("run configuration manifest", () => {
  it("writes a versioned snapshot with a stable content hash and the run's artifact scope", async () => {
    const fixture = artifactStore();
    const result = await storeRunConfigurationManifest(fixture.store, context, input);
    const [artifact, storedContext] = fixture.put.mock.calls[0]!;
    const saved = new TextDecoder().decode(artifact.bytes);
    const parsed = JSON.parse(saved);

    expect(parsed).toMatchObject({
      format: RUN_CONFIGURATION_MANIFEST_FORMAT,
      version: RUN_CONFIGURATION_MANIFEST_VERSION,
      runId: "run-a",
      attemptId: "attempt-a",
      deploymentRevision: "abc123",
      model: {
        requested: {
          provider: "provider-a",
          modelId: "model-a",
          reasoningLevel: "high",
        },
        deliveredAtStart: {
          provider: "provider-b",
          modelId: "model-b",
          reasoningLevel: "low",
        },
        effectiveReasoningLevel: null,
        allowedFallbacks: [{ provider: "provider-b", modelId: "model-b", reasoningLevel: "low" }],
        actualFallbacks: [
          {
            provider: "provider-b",
            modelId: "model-b",
            reasoningLevel: "low",
            source: "startup-selection",
          },
        ],
      },
      runtime: {
        id: "runtime-a",
        contractVersion: "2",
        adapterVersion: "3",
      },
      contextPolicy: {
        requestedStrategy: "retrieval",
        deliveredStrategy: "retrieval",
        effectiveStrategy: null,
        revision: null,
        recallRevision: null,
      },
      pinnedTaughtSkills: [{ skillId: "skill-a", revisionId: "skill-revision-a" }],
      shownLessons: [{ lessonId: "lesson-a", revision: 4 }],
    });
    expect(artifact).toMatchObject({
      name: "run-configuration-manifest.v1.json",
      mimeType: "application/json",
    });
    expect(storedContext).toMatchObject({
      operationId: "manifest-op",
      traceId: "manifest-trace",
      spaceId: "space-a",
      userId: "user-a",
      botId: "bot-a",
      runId: "run-a",
    });
    expect(result).toEqual({
      storageKey: "stored-manifest-a",
      sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
      size: artifact.bytes.byteLength,
    });
    expect(result.sha256).not.toBe("backend-size-hash");
  });

  it("keeps unknown evidence distinct from a known empty selection", () => {
    const manifest = buildRunConfigurationManifest({
      ...input,
      deploymentRevision: "unknown",
      model: {
        requested: null,
        deliveredAtStart: null,
        computerModel: null,
        effectiveReasoningLevel: null,
        allowedFallbacks: [],
        actualFallbacks: [],
      },
      runtime: null,
      contextPolicy: {
        requestedStrategy: null,
        deliveredStrategy: null,
        effectiveStrategy: null,
        revision: null,
        recallRevision: null,
      },
      pinnedTaughtSkills: null,
      shownLessons: [],
    });

    expect(manifest.deploymentRevision).toBeNull();
    expect(manifest.model).toMatchObject({
      requested: null,
      deliveredAtStart: null,
      allowedFallbacks: [],
      actualFallbacks: [],
    });
    expect(manifest.runtime).toBeNull();
    expect(manifest.pinnedTaughtSkills).toBeNull();
    expect(manifest.shownLessons).toEqual([]);
  });

  it("projects only approved fields and does not serialize secrets, prompts, or paths", () => {
    const unsafe = {
      ...input,
      model: {
        ...input.model,
        requested: {
          ...input.model.requested!,
          apiKey: "fixture-secret",
          headers: { authorization: "fixture-auth" },
          connectionId: "credential-record",
        },
      },
      runtime: {
        ...input.runtime!,
        headers: { authorization: "runtime-secret" },
        prompt: "private prompt",
      },
      contextPolicy: {
        ...input.contextPolicy,
        sourcePath: "/private/source",
      },
      pinnedTaughtSkills: [{ ...input.pinnedTaughtSkills![0]!, content: "private skill content" }],
    };

    const serialized = JSON.stringify(buildRunConfigurationManifest(unsafe));
    for (const value of [
      "fixture-secret",
      "fixture-auth",
      "credential-record",
      "runtime-secret",
      "private prompt",
      "/private/source",
      "private skill content",
    ]) {
      expect(serialized).not.toContain(value);
    }
  });
});
