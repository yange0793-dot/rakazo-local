import { createHash } from "node:crypto";
import type { MessageBlock, TicketFileDeliveryRequirements } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import type { FileDeliveryJudge } from "./file-delivery-judge.js";
import * as threadArtifacts from "./thread-artifacts.js";
import { deliverTicketWork } from "./ticket-delivery.js";

const run = {
  id: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "worker-1",
  threadId: "worker-thread",
  ticketId: "ticket-1",
};
const result = {
  previousVersion: 0,
  summary: "Client comparison is ready.",
  findings: [
    {
      outcome: "unknown",
      conclusion: "Server behavior needs evidence.",
      evidence: "Only the client sample is retained.",
    },
  ],
};

function setup() {
  const ticket = {
    id: "ticket-1",
    spaceId: run.spaceId,
    boardId: "board-1",
    number: 1,
    title: "Compare releases",
    createdByBotId: "owner-1",
    createdByUserId: run.userId,
    assigneeBotId: run.botId,
    originMessageId: "request-1",
    originThread: {
      id: "owner-thread",
      botId: "owner-1",
      groupId: null,
      externalConversationId: null,
    },
    board: { ticketPrefix: "RAK" },
    receiptVersion: 0,
    status: "review",
    fileDeliveryRequirements: null as TicketFileDeliveryRequirements | null,
  };
  const prisma = {
    ticket: { findFirst: vi.fn(async () => ticket), updateMany: vi.fn() },
    run: { findFirst: vi.fn(async () => ({ ticketId: run.ticketId, thread: { groupId: null } })) },
    message: {
      findFirst: vi.fn(async () => null as { id: string; blocks?: MessageBlock[] } | null),
    },
    artifact: { findMany: vi.fn(async () => []), findFirst: vi.fn() },
  };
  const artifacts = { get: vi.fn(), put: vi.fn(), remove: vi.fn() };
  const events = { notify: vi.fn() };
  const onTicketChange = vi.fn();
  return {
    ticket,
    prisma,
    artifacts,
    events,
    onTicketChange,
    deps: {
      prisma,
      artifacts,
      events,
      onTicketChange,
      ticketBoardEnabled: true,
    } as unknown as ExecutorDeps,
  };
}

beforeEach(() => vi.stubEnv("TICKET_WORK_RECEIPTS", "true"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ticket delivery boundary", () => {
  it("rejects an empty finding list before accessing persistence", async () => {
    const s = setup();
    const delivered = await deliverTicketWork(s.deps, run, {
      id: "ticket-1",
      result: { ...result, findings: [] },
      ownerAuthored: false,
      secrets: [],
    });
    expect(delivered).toHaveProperty("error", expect.stringContaining("findings"));
    expect(s.prisma.ticket.findFirst).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
  });

  it("requires the durable execution assignment rather than a stale tool snapshot", async () => {
    const s = setup();
    s.prisma.run.findFirst.mockResolvedValue({
      ticketId: "other-ticket",
      thread: { groupId: null },
    });
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result,
        ownerAuthored: false,
        secrets: [],
      }),
    ).toHaveProperty("error");
    expect(s.prisma.message.findFirst).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
  });

  it("rejects a stale revision before copying evidence", async () => {
    const s = setup();
    s.ticket.receiptVersion = 1;
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result: { ...result, artifactIds: ["evidence-1"] },
        ownerAuthored: false,
        secrets: [],
      }),
    ).toHaveProperty("error", expect.stringContaining("Receipt changed"));
    expect(s.prisma.artifact.findMany).not.toHaveBeenCalled();
    expect(s.artifacts.get).not.toHaveBeenCalled();
  });

  it("replays the committed receipt even after a newer revision without copying or notifying again", async () => {
    const s = setup();
    s.ticket.receiptVersion = 2;
    s.prisma.message.findFirst.mockResolvedValue({ id: "receipt-1" });
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result,
        ownerAuthored: false,
        secrets: [],
      }),
    ).toEqual({ ok: true, version: 1, messageId: "receipt-1", status: "review" });
    expect(s.prisma.artifact.findMany).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
    expect(s.events.notify).not.toHaveBeenCalled();
    expect(s.onTicketChange).not.toHaveBeenCalled();
  });

  it.each(["immediate", "newer revision", "newer requirements", "concurrent commit"])(
    "replays the saved file acceptance after %s",
    async (scenario) => {
      const s = setup();
      s.ticket.fileDeliveryRequirements = {
        version: scenario === "newer requirements" ? 2 : 1,
        items: [{ id: "report", kind: "artifact", description: "Deliver the report" }],
      };
      s.ticket.receiptVersion =
        scenario === "concurrent commit" ? 0 : scenario === "immediate" ? 1 : 2;
      s.ticket.status = scenario === "newer revision" ? "done" : "review";
      const acceptance = {
        schemaVersion: 1,
        evaluatorRevision: "file-delivery.v1",
        requirementsVersion: 1,
        status: "unknown",
        results: [
          {
            requirementId: "report",
            status: "unknown",
            reason: "missing_evidence",
            evidenceRefs: [],
          },
        ],
      };
      const bytes = Buffer.from(
        JSON.stringify({ schema: 1, ticketId: s.ticket.id, version: 1, acceptance }),
      );
      s.prisma.message.findFirst.mockResolvedValue({
        id: "receipt-1",
        blocks: [
          {
            kind: "file",
            artifactId: "receipt-file-1",
            name: "work-ticket-1.json",
            mimeType: "application/json",
            size: bytes.byteLength,
          },
        ],
      });
      s.prisma.artifact.findFirst.mockResolvedValue({
        storageKey: "saved-receipt",
        hash: createHash("sha256").update(bytes).digest("hex"),
      });
      s.artifacts.get.mockResolvedValue(bytes);
      if (scenario === "concurrent commit") {
        s.prisma.message.findFirst.mockResolvedValueOnce(null);
        vi.spyOn(threadArtifacts, "attachWorkspaceFileToThread").mockRejectedValueOnce(
          new IsolationError(),
        );
      }
      expect(
        await deliverTicketWork(s.deps, run, {
          id: "ticket-1",
          result: {
            ...result,
            findings: [{ outcome: "pass", conclusion: "Done", evidence: "Claimed completion" }],
          },
          ownerAuthored: false,
          secrets: [],
        }),
      ).toEqual({
        ok: true,
        version: 1,
        requirementsVersion: 1,
        messageId: "receipt-1",
        status: "review",
        acceptance,
      });
      expect(s.artifacts.get).toHaveBeenCalledWith("saved-receipt", expect.any(Object));
      expect(s.artifacts.put).not.toHaveBeenCalled();
      expect(s.events.notify).not.toHaveBeenCalled();
      expect(s.onTicketChange).not.toHaveBeenCalled();
    },
  );

  it("rejects evidence for an obsolete requirement version before reading or copying files", async () => {
    const s = setup();
    s.ticket.fileDeliveryRequirements = {
      version: 2,
      items: [{ id: "report", kind: "artifact", description: "Deliver the revised report" }],
    };
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result: {
          ...result,
          artifactIds: ["old-report"],
          fileDelivery: { requirementsVersion: 1, evidenceRefs: [] },
        },
        ownerAuthored: false,
        secrets: [],
      }),
    ).toHaveProperty("error", expect.stringContaining("Requirements changed"));
    expect(s.prisma.artifact.findMany).not.toHaveBeenCalled();
    expect(s.artifacts.get).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
  });

  it("fences the requirement version in the receipt transaction after observing evidence", async () => {
    const s = setup();
    s.ticket.fileDeliveryRequirements = {
      version: 1,
      items: [{ id: "report", kind: "artifact", description: "Deliver the report" }],
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      message: { findFirst: vi.fn(async () => ({ id: "request-1" })) },
      run: { updateMany: vi.fn(async () => ({ count: 1 })) },
      ticket: { updateMany: vi.fn(async () => ({ count: 0 })) },
      artifact: { create: vi.fn() },
    };
    vi.spyOn(threadArtifacts, "attachWorkspaceFileToThread").mockImplementationOnce(
      async (_deps, input) => {
        s.ticket.fileDeliveryRequirements!.version = 2;
        await input.onAttached!(tx as never, {} as never);
        throw new Error("The stale receipt must not commit.");
      },
    );
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result: { ...result, fileDelivery: { requirementsVersion: 1, evidenceRefs: [] } },
        ownerAuthored: false,
        secrets: [],
      }),
    ).toHaveProperty("error", expect.stringContaining("requirements"));
    expect(tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          receiptVersion: 0,
          fileDeliveryRequirements: { path: ["version"], equals: 1 },
        }),
      }),
    );
    expect(tx.artifact.create).not.toHaveBeenCalled();
    expect(s.events.notify).not.toHaveBeenCalled();
    expect(s.onTicketChange).not.toHaveBeenCalled();
  });

  it("passes observed bytes and the current requirement version to the asynchronous judge before persistence", async () => {
    const s = setup();
    s.ticket.fileDeliveryRequirements = {
      version: 2,
      items: [
        { id: "report", kind: "artifact", description: "Deliver report", name: "report.txt" },
        {
          id: "coverage",
          kind: "semantic",
          description: "Cover the revised request",
          criteria: ["coverage"],
          rubricVersion: "file-delivery.semantic.v1",
        },
      ],
    };
    const bytes = Buffer.from("Observed report content.");
    const file = {
      id: "report-artifact",
      name: "report.txt",
      mimeType: "text/plain",
      botId: "owner-1",
      groupId: null,
      version: 3,
      storageKey: "actual-report",
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
    s.prisma.artifact.findMany.mockResolvedValue([file] as never);
    s.artifacts.get.mockResolvedValue(bytes);
    const judge = Object.assign(
      vi.fn(async () => ({
        status: "verified" as const,
        reason: "semantic_verified" as const,
        judge: {
          rubricVersion: "file-delivery.semantic.v1",
          calibrationRevision: "reviewed.v1",
          operationId: "judge:coverage",
          status: "verified" as const,
          reason: "The reviewed requirement is covered.",
          costUsd: 0.01,
          totalTokens: 100,
        },
      })),
      { calibrate: vi.fn() },
    ) as FileDeliveryJudge;
    const attach = vi
      .spyOn(threadArtifacts, "attachWorkspaceFileToThread")
      .mockRejectedValueOnce(new IsolationError());
    await deliverTicketWork({ ...s.deps, fileDeliveryJudge: judge }, run, {
      id: s.ticket.id,
      ownerAuthored: false,
      secrets: [],
      result: {
        ...result,
        findings: [{ outcome: "pass", conclusion: "Covered", evidence: "Attached report" }],
        artifactIds: [file.id],
        fileDelivery: {
          requirementsVersion: 2,
          evidenceRefs: ["report", "coverage"].map((requirementId) => ({
            kind: "artifact",
            requirementId,
            artifactId: file.id,
            version: file.version,
            hash: file.hash,
          })),
        },
      },
    });
    expect(judge).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementsVersion: 2,
        requirementId: "coverage",
        evidence: [expect.objectContaining({ artifactId: file.id, text: bytes.toString() })],
      }),
      expect.objectContaining({ runId: run.id, spaceId: run.spaceId, userId: run.userId }),
    );
    const receipt = JSON.parse(Buffer.from(attach.mock.calls[0]![1].bytes).toString());
    expect(receipt).toMatchObject({
      requirements: { version: 2 },
      acceptance: {
        evaluatorRevision: "file-delivery.v2",
        requirementsVersion: 2,
        status: "verified",
        results: [
          { requirementId: "report", status: "verified" },
          {
            requirementId: "coverage",
            status: "verified",
            judge: { operationId: "judge:coverage", costUsd: 0.01 },
          },
        ],
      },
    });
  });

  it("replays a v2 receipt with its own judge calibration without invoking the judge again", async () => {
    const s = setup();
    s.ticket.fileDeliveryRequirements = {
      version: 4,
      items: [{ id: "new-report", kind: "artifact", description: "Different report" }],
    };
    s.ticket.receiptVersion = 3;
    const verdict = { coverage: "verified", evidenceSupport: "verified" };
    const acceptance = {
      schemaVersion: 1,
      evaluatorRevision: "file-delivery.v2",
      requirementsVersion: 2,
      status: "verified",
      results: [
        {
          requirementId: "coverage",
          status: "verified",
          reason: "semantic_verified",
          evidenceRefs: [],
          judge: {
            rubricVersion: "file-delivery.semantic.v1",
            calibrationRevision: "reviewed.v1",
            operationId: "judge:coverage",
            status: "verified",
            reason: "Reviewed",
            costUsd: 0.02,
            totalTokens: 100,
            verdict: { ...verdict, reason: "Supported" },
            calibration: {
              rubricVersion: "file-delivery.semantic.v1",
              revision: "reviewed.v1",
              rubricDigest: "rubric-hash",
              fixtureDigest: "fixture-hash",
              modelFingerprint: "model-hash",
              operationId: "judge:calibration",
              status: "verified",
              reason: "Reviewed fixtures matched",
              costUsd: 0.01,
              totalTokens: 80,
              cases: [{ id: "complete", expected: verdict, actual: verdict }],
            },
          },
        },
      ],
    };
    const bytes = Buffer.from(
      JSON.stringify({ schema: 1, ticketId: s.ticket.id, version: 1, acceptance }),
    );
    s.prisma.message.findFirst.mockResolvedValue({
      id: "receipt-1",
      blocks: [
        {
          kind: "file",
          artifactId: "saved-receipt",
          name: "work-ticket-1.json",
          mimeType: "application/json",
          size: bytes.byteLength,
        },
      ],
    });
    s.prisma.artifact.findFirst.mockResolvedValue({
      storageKey: "saved-receipt",
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
    s.artifacts.get.mockResolvedValue(bytes);
    const judge = Object.assign(vi.fn(), { calibrate: vi.fn() }) as unknown as FileDeliveryJudge;
    expect(
      await deliverTicketWork({ ...s.deps, fileDeliveryJudge: judge }, run, {
        id: s.ticket.id,
        ownerAuthored: false,
        secrets: [],
        result: {
          ...result,
          findings: [{ outcome: "pass", conclusion: "Done", evidence: "Original receipt" }],
          fileDelivery: { requirementsVersion: 2, evidenceRefs: [] },
        },
      }),
    ).toEqual({
      ok: true,
      version: 1,
      messageId: "receipt-1",
      status: "done",
      requirementsVersion: 2,
      acceptance,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(judge.calibrate).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
  });

  it("rejects unavailable evidence before writing a receipt", async () => {
    const s = setup();
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result: { ...result, artifactIds: ["private-evidence"] },
        ownerAuthored: false,
        secrets: [],
      }),
    ).toHaveProperty("error", expect.stringContaining("evidence file"));
    expect(s.artifacts.get).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
    expect(s.prisma.ticket.updateMany).not.toHaveBeenCalled();
  });

  it("disables receipt delivery without touching work or artifacts", async () => {
    const s = setup();
    vi.stubEnv("TICKET_WORK_RECEIPTS", "false");
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result,
        ownerAuthored: true,
        secrets: [],
      }),
    ).toHaveProperty("error", "Ticket delivery is unavailable.");
    expect(s.prisma.ticket.findFirst).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
  });
});
