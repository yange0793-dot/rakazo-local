import { randomUUID } from "node:crypto";
import {
  asSystem,
  claimSpaceDeletionForMember,
  createDb,
  createSpaceForMember,
  listMemberOrganizations,
  provisionMessagingIdentity,
  requireMembership,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actorFromMembership } from "../app.js";
import { HEARTBEAT, HEARTBEAT_MS, withHeartbeats } from "./shared.js";

const url = process.env.DATABASE_URL;
describe.skipIf(process.env.VERIFY_DATABASE !== "1" || !url)("Space deletion and streams", () => {
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    if (!new URL(url!).pathname.startsWith("/rkz_"))
      throw new Error("Space deletion tests require an isolated rkz_ database");
    db = createDb(url!);
  });

  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("revokes an explicit session and its open stream after a deletion claim", async () => {
    const system = asSystem(db.prisma);
    const { userId, spaceId: currentSpaceId } = await provisionMessagingIdentity(system, {
      provider: "test",
      address: `stream-deletion-${randomUUID()}`,
    });
    const { id: spaceId } = await createSpaceForMember(system, {
      userId,
      currentSpaceId,
      name: "Deleting Space",
    });
    const session = () => actorFromMembership(requireMembership(system, userId, spaceId));
    await expect(session()).resolves.toMatchObject({ userId, spaceId });
    let streamSignal: AbortSignal | undefined;
    const rechecked = vi.fn(async () => (await session())?.spaceId === spaceId);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const stream = withHeartbeats({ stillAuthorized: rechecked }, async function* (signal) {
        streamSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const first = stream.next();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await expect(first).resolves.toEqual({ done: false, value: HEARTBEAT });

      await claimSpaceDeletionForMember(system, { userId, currentSpaceId, spaceId });
      await expect(session()).resolves.toBeNull();
      await expect(requireMembership(system, userId)).resolves.toMatchObject({
        spaceId: currentSpaceId,
      });
      const recoveredActor = await actorFromMembership(requireMembership(system, userId, null));
      expect(recoveredActor?.spaceId).toBe(currentSpaceId);
      const navigation = await listMemberOrganizations(system, recoveredActor!);
      expect(navigation.organizations.flatMap((org) => org.spaceIds)).toContain(currentSpaceId);
      expect(navigation.organizations.flatMap((org) => org.spaceIds)).not.toContain(spaceId);
      const denied = expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await denied;
      expect(streamSignal?.aborted).toBe(true);

      vi.setSystemTime(Date.now() + SPACE_DELETION_CLAIM_TIMEOUT_MS + 1);
      await expect(
        claimSpaceDeletionForMember(system, { userId, currentSpaceId, spaceId }),
      ).resolves.toMatchObject({ recovered: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
