import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewExplainedDislike } from "./thread-learning.js";

describe("work receipt feedback", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reviews a written receipt reply without requiring an earlier dislike", async () => {
    vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
    const enqueue = vi.fn();
    const findFirst = vi.fn(async () => ({ id: "research-run", status: "completed" }));
    const deps = {
      prisma: {
        message: {
          findFirst: vi.fn(async () => ({
            runId: "research-run",
            clientNonce: "work-receipt:ticket:1:digest",
            replies: [],
          })),
        },
        run: { findFirst },
      },
      jobs: { enqueue },
    };
    const actor = { spaceId: "space", userId: "owner" } as Actor;
    await reviewExplainedDislike(deps as never, actor, "origin", "receipt", 10);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "research-run", spaceId: "space", userId: "owner" },
      select: { id: true, status: true },
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "harness.reflect",
        payload: { runId: "research-run", auto: true },
      }),
    );
  });

  it.each(["false", "true"])(
    "does not interpret an ordinary reply as a correction (%s)",
    async (flag) => {
      vi.stubEnv("TICKET_WORK_RECEIPTS", flag);
      const enqueue = vi.fn();
      const deps = {
        prisma: {
          message: {
            findFirst: vi.fn(async () => ({
              runId: "run",
              clientNonce: flag === "false" ? "work-receipt:ticket:1:digest" : null,
              replies: [],
            })),
          },
        },
        jobs: { enqueue },
      };
      await reviewExplainedDislike(
        deps as never,
        { spaceId: "space", userId: "owner" } as Actor,
        "origin",
        "message",
        10,
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});
