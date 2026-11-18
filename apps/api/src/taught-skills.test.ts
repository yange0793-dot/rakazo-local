import type { Actor, MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService } from "./taught-skills.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const playbook = {
  whenToUse: "Weekly shop",
  inputs: [],
  steps: ["Open the store"],
  howToCheck: "Order placed",
  whatToReturn: "Total",
  approvalBoundaries: "Ask before paying",
  failureHandling: "Stop and report",
};

function setup(messages: Array<{ id: string; blocks: unknown }>) {
  const skill = {
    id: "skill-1",
    spaceId: actor.spaceId,
    botId: "bot-1",
    userId: actor.userId,
    name: "Weekly shop",
    goal: "Order groceries",
    status: "saved",
    playbook,
    // What the teacher typed stays with the recording; deleting the skill must not copy it
    // into the thread or its event.
    recording: {
      events: [{ kind: "key", at: "2026-11-05T12:00:00.000Z", text: "my-password" }],
      snapshots: [],
    },
    startedAt: null,
    expiresAt: null,
    stoppedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const prisma = {
    taughtSkill: {
      findFirst: vi.fn(async () => skill),
      delete: vi.fn(async () => skill),
    },
    bot: {
      findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })),
    },
    message: {
      findMany: vi.fn(async () => messages),
      update: vi.fn(async ({ data }: { data: { blocks: MessageBlock[] } }) => ({
        id: "",
        ...data,
      })),
    },
  };
  const append = vi.fn(async (input: unknown) => input);
  const service = createTaughtSkillsService({
    prisma,
    events: { append },
  } as unknown as TaughtSkillsDeps);
  return { append, prisma, service };
}

describe("removing a taught skill", () => {
  it("marks its thread card deleted, publishes the updated blocks, and keeps the recording out", async () => {
    const card: MessageBlock = {
      kind: "skill_draft",
      skillId: "skill-1",
      name: "Weekly shop",
      goal: "Order groceries",
      playbook,
      status: "draft",
    };
    const blocks: MessageBlock[] = [
      { kind: "text", text: "Here is what I learned." },
      card,
      { kind: "text", text: "Want to save it?" },
    ];
    const nextBlocks: MessageBlock[] = [blocks[0]!, { ...card, status: "deleted" }, blocks[2]!];
    const { append, prisma, service } = setup([
      { id: "message-2", blocks: [{ kind: "text", text: "A later bot message." }] },
      { id: "message-1", blocks },
    ]);

    await expect(service.remove(actor, "skill-1")).resolves.toEqual({ ok: true });

    expect(prisma.message.update).toHaveBeenCalledTimes(1);
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { blocks: nextBlocks },
    });
    expect(append).toHaveBeenCalledWith({
      spaceId: actor.spaceId,
      threadId: "thread-1",
      botId: "bot-1",
      type: "thread.message.updated",
      payload: { messageId: "message-1", role: "bot", blocks: nextBlocks },
    });
    expect(prisma.taughtSkill.delete).toHaveBeenCalledWith({ where: { id: "skill-1" } });
    // The live recording's typed input is not part of anything written back to the thread.
    expect(JSON.stringify(append.mock.calls)).not.toContain("my-password");
    expect(JSON.stringify(prisma.message.update.mock.calls)).not.toContain("my-password");
  });
});
