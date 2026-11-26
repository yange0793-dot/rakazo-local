import { ORPCError } from "@orpc/server";
import type { CodexLiveCatalog, parseModelSecret } from "@rakazo/adapters";
import {
  findConnectedModelCredential,
  validateCompatibleModelChoice,
  validateConnectedModelChoice,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID, usableModelId } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import {
  findModelCredentialById,
  lockAccountModels,
  modelRoleTarget,
  runAsSystemInTransaction,
} from "@rakazo/db";
import type { RouterDeps } from "./router.js";

/**
 * The actor's active compatible bot, routine and role pins on `modelId`. Role rows come from the
 * account's models (spaceId null) and from the Spaces that override them.
 */
async function compatibleModelPins(
  tx: Prisma.TransactionClient,
  actor: Actor,
  modelId: string | { notIn: string[] },
) {
  const provider = OPENAI_COMPATIBLE_PROVIDER_ID;
  const where = { userId: actor.userId, modelId };
  const pin = { spaceId: true, modelId: true } as const;
  const role = { modelId: true, role: true, position: true, credentialId: true } as const;
  // A connection is the account's, so its pins are checked in every Space it is used in.
  const [bots, routines, accountRoles, spaceRoles] = await runAsSystemInTransaction(
    tx,
    "model pins across the account's Spaces",
    () =>
      Promise.all([
        tx.bot.findMany({
          where: { ...where, archivedAt: null, modelProvider: provider },
          select: { ...pin, name: true, modelCredentialId: true },
        }),
        tx.routine.findMany({
          where: { ...where, modelProvider: provider, bot: { archivedAt: null } },
          select: { ...pin, name: true },
        }),
        tx.userModelRoleChoice.findMany({ where: { ...where, provider }, select: role }),
        tx.spaceModelRoleChoice.findMany({
          where: {
            ...where,
            provider,
            spaceMember: { settingOverrides: { some: { setting: "models" } } },
          },
          select: { ...role, spaceId: true },
        }),
      ]),
  );
  return {
    named: [
      ...bots.map(({ modelCredentialId, ...bot }) => ({
        ...bot,
        credentialId: modelCredentialId,
      })),
      ...routines,
    ],
    backups: [...accountRoles.map((row) => ({ ...row, spaceId: null })), ...spaceRoles],
  };
}

/** Validate a compatible pin against the connection state in its write transaction. */
export async function assertCompatibleModelPin(
  tx: Prisma.TransactionClient,
  secrets: Pick<RouterDeps["secrets"], "load">,
  actor: Actor,
  modelId: string,
  credentialId?: string | null,
) {
  const message = await validateCompatibleModelChoice(tx, secrets, actor, modelId, {
    credentialId,
  });
  if (message) throw new ORPCError("BAD_REQUEST", { message });
}

/** Recheck the connection after taking the account lock and before writing the Bot. */
export async function assertBotModelPin(
  tx: Prisma.TransactionClient,
  secrets: Pick<RouterDeps["secrets"], "load">,
  actor: Actor,
  provider: string,
  modelId: string,
  credentialId: string | null,
) {
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    await assertCompatibleModelPin(tx, secrets, actor, modelId, credentialId);
  } else if (credentialId && !(await findModelCredentialById(tx, actor, credentialId, provider))) {
    throw new ORPCError("BAD_REQUEST", { message: "Connect that model provider first" });
  }
}

/** Restoring a bot also makes its routines' saved models live again. */
export async function assertRestoredBotPins(
  tx: Prisma.TransactionClient,
  secrets: Pick<RouterDeps["secrets"], "load">,
  actor: Actor,
  bots: readonly { id: string; userId: string }[],
) {
  const ids = bots.map((bot) => bot.id);
  if (!ids.length) return;
  await runAsSystemInTransaction(tx, "validate restored model pins", async () => {
    const routinesWhere = {
      botId: { in: ids },
      spaceId: actor.spaceId,
      modelProvider: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelId: { not: null },
    };
    const routineOwners = await tx.routine.findMany({
      where: routinesWhere,
      select: { userId: true },
      distinct: ["userId"],
    });
    const owners = [...new Set([...bots, ...routineOwners].map((row) => row.userId))].sort();
    for (const userId of owners) await lockAccountModels(tx, userId);
    const [current, routines] = await Promise.all([
      tx.bot.findMany({
        where: { id: { in: ids }, spaceId: actor.spaceId, archivedAt: { not: null } },
        select: { userId: true, modelProvider: true, modelId: true, modelCredentialId: true },
      }),
      tx.routine.findMany({
        where: { ...routinesWhere, userId: { in: owners } },
        select: { userId: true, modelId: true },
      }),
    ]);
    for (const bot of current)
      if (bot.modelProvider && bot.modelId)
        await assertBotModelPin(
          tx,
          secrets,
          { ...actor, userId: bot.userId },
          bot.modelProvider,
          bot.modelId,
          bot.modelCredentialId,
        );
    for (const routine of routines)
      if (routine.modelId)
        await assertCompatibleModelPin(
          tx,
          secrets,
          { ...actor, userId: routine.userId },
          routine.modelId,
        );
  });
}

type ModelPinRow = { spaceId: string | null; modelId: string | null; credentialId?: string | null };

/** Refusal naming the bots and routines (plus "backup models") left on a dropped model. */
function refuseModelPins(
  pins: { named: Array<ModelPinRow & { name: string }>; backups: ModelPinRow[] },
  dangling: (row: ModelPinRow) => boolean,
) {
  const names = pins.named.filter(dangling).map((row) => row.name);
  if (pins.backups.some(dangling)) names.push("backup models");
  if (names.length === 0) return;
  throw new ORPCError("BAD_REQUEST", {
    message: `In use by ${[...new Set(names)].join(", ")}. Pick another model for them first.`,
  });
}

/** Refuse only pins that runtime selection cannot serve after this connection save. */
export async function assertNoDanglingModelPins(
  tx: Prisma.TransactionClient,
  secrets: Pick<RouterDeps["secrets"], "load">,
  actor: Actor,
  connection: { id: string },
  secret: ReturnType<typeof parseModelSecret>,
  actorDefault: string | null,
) {
  const stored = secret.kind === "openai_compatible" ? (secret.enabledModelIds ?? []) : [];
  const pins = await compatibleModelPins(tx, actor, { notIn: stored });
  // The connection's own model is the account's, so it stays enabled in every Space.
  const defaultModel = usableModelId(actorDefault);
  const dangling = new Set<ModelPinRow>();
  for (const row of [...pins.named, ...pins.backups] as ModelPinRow[]) {
    if (!row.modelId || row.modelId === defaultModel) continue;
    // A row pinned to a connection runs only there.
    if (row.credentialId) {
      if (row.credentialId === connection.id) dangling.add(row);
      continue;
    }
    // Which connection serves a model is the account's choice, the same in every Space.
    const selected = await findConnectedModelCredential(
      tx,
      secrets,
      actor,
      OPENAI_COMPATIBLE_PROVIDER_ID,
      row.modelId,
      { replacement: { credentialId: connection.id, secret, defaultModel } },
    );
    if (selected?.id === connection.id || !selected) dangling.add(row);
  }
  refuseModelPins(pins, (row) => dangling.has(row));
}

/**
 * `models.setDefault` on an openai-compatible connection: a listed secret only accepts an
 * effective id. It changes the connection's own model and never the secret, so the only pins
 * it can strand are pins on an outgoing default that is outside the stored list.
 */
export async function assertCompatibleDefaultChange(
  tx: Prisma.TransactionClient,
  actor: Actor,
  modelId: string,
  thinking: { enabledModelIds?: string[]; storedEnabledModelIds?: string[] },
) {
  const requested = modelId.trim();
  const enabled = thinking.enabledModelIds ?? [];
  const stored = thinking.storedEnabledModelIds;
  if (stored && !enabled.includes(requested)) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown model for that provider" });
  }
  const outgoing = enabled.find((id) => id !== requested && !stored?.includes(id));
  if (!outgoing) return;
  const [pins, target] = await Promise.all([
    compatibleModelPins(tx, actor, outgoing),
    modelRoleTarget(tx, actor),
  ]);
  const replacedSpaceId = target.scope === "space" ? actor.spaceId : null;
  // The main model's own row is the choice being replaced, not a pin left behind.
  refuseModelPins(
    {
      ...pins,
      backups: pins.backups.filter(
        (row) => !(row.role === "main" && row.position === 0 && row.spaceId === replacedSpaceId),
      ),
    },
    () => true,
  );
}

/** A routine may only name a model the space has connected. */
export async function assertRoutineModel(
  deps: RouterDeps,
  actor: Actor,
  model: { modelProvider?: string | null; modelId?: string | null },
  codexCatalog: CodexLiveCatalog,
) {
  if (!model.modelProvider || !model.modelId) return;
  const message = await validateConnectedModelChoice(
    deps.prisma,
    deps.secrets,
    actor,
    model.modelProvider,
    model.modelId,
    { codexCatalog },
  );
  if (message) throw new ORPCError("BAD_REQUEST", { message });
}
