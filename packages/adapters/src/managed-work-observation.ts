import type { Prisma, Run, WorkEvent } from "@rakazo/db";
import { localAgentPhoneObservedOutcome } from "./local-agent-phone.js";

export async function observedManagedWorkEventIds(
  prisma: Prisma.TransactionClient,
  input: {
    run: Pick<Run, "id" | "spaceId" | "taskId">;
    events: WorkEvent[];
    before?: Date;
  },
): Promise<Set<string>> {
  if (!input.events.length) return new Set();
  const effects = input.events.some((event) => event.kind.startsWith("external_"))
    ? await prisma.externalEffect.findMany({
        where: {
          spaceId: input.run.spaceId,
          runId: input.run.id,
          status: "completed",
          ...(input.before ? { updatedAt: { lte: input.before } } : {}),
          OR: [{ kind: { endsWith: "phone_read" } }, { kind: { endsWith: "phone_inspect" } }],
        },
        select: { request: true, result: true },
      })
    : [];
  const task = input.events.some((event) => event.wakeRunId === input.run.id)
    ? await prisma.task.findUnique({
        where: { id: input.run.taskId },
        select: { prompt: true },
      })
    : null;
  return new Set(
    input.events
      .filter((event) => {
        // Compare the exact host-generated evidence snapshot. A later payload
        // revision is not observed merely because the event ID was in the task.
        if (
          event.wakeRunId === input.run.id &&
          task?.prompt.includes(`Managed work event ${event.id}: ${event.kind}.`) &&
          task.prompt.includes(JSON.stringify(event.payload))
        )
          return true;
        if (!event.kind.startsWith("external_")) return false;
        const evidence = event.payload;
        return (
          evidence !== null &&
          typeof evidence === "object" &&
          !Array.isArray(evidence) &&
          effects.some((effect) => localAgentPhoneObservedOutcome(effect, evidence))
        );
      })
      .map((event) => event.id),
  );
}
