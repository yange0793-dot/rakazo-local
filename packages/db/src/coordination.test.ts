import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { getManagedWorkCompletionBlockers } from "./coordination.js";

describe("managed work completion blockers", () => {
  it("blocks completion on a stopped child even when its prior receipt was accepted", async () => {
    const accepted = {
      requirementsVersion: 1,
      acceptedRequirementsVersion: 1,
      acceptedReceiptVersion: 1,
    };
    const tx = {
      ticket: {
        findMany: vi.fn(async () => [
          { ...accepted, id: "active-child", stopRequestedAt: null },
          { ...accepted, id: "stopped-child", stopRequestedAt: new Date() },
        ]),
      },
      externalAgentExecution: { findMany: vi.fn(async () => []) },
    } as unknown as Pick<PrismaClient, "ticket" | "externalAgentExecution">;

    await expect(
      getManagedWorkCompletionBlockers(tx, { spaceId: "space", ticketId: "parent" }),
    ).resolves.toEqual({ ticketIds: ["stopped-child"], executionIds: [] });
  });
});
