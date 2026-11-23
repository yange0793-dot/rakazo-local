import { createHash } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type {
  CatalogChannel,
  ModelCatalogSourceAdapter,
  StoredModelSecret,
} from "@rakazo/adapters";
import { holdSecretNotifications, parseModelSecret, serializeModelSecret } from "@rakazo/adapters";
import type { Actor, ManagedModelCatalog, ModelCatalogSourceStatus } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  deleteUnreferencedCredentialSecret,
  Prisma,
  runAsSystem,
  withTransactionRetry,
} from "@rakazo/db";

type CompatibleSecret = Extract<StoredModelSecret, { kind: "openai_compatible" }>;
type SourceRow = Awaited<ReturnType<PrismaClient["modelCatalogSource"]["findMany"]>>[number];

export function projectCatalogChannel(
  source: { id: string; label: string; group: string },
  channel: CatalogChannel | undefined,
  previous: CompatibleSecret,
  label: string,
  providerId: string,
): CompatibleSecret {
  const availableModelIds = channel?.enabled ? channel.models.map((model) => model.id) : [];
  const aliases = { ...previous.managedCatalog?.aliases };
  for (const model of channel?.models ?? []) {
    aliases[`${channel!.label}/${model.label}`] = model.id;
    aliases[`${label}/${model.label}`] = model.id;
  }
  // A channel deleted and recreated upstream keeps its selections: the old
  // `<providerId>/<model>` ids still route to the same models under the new id.
  const previousProviderId = previous.managedCatalog?.providerId;
  const replacedProviderId =
    previousProviderId !== undefined && previousProviderId !== providerId
      ? previousProviderId
      : undefined;
  if (replacedProviderId !== undefined)
    for (const model of channel?.models ?? []) {
      aliases[`${replacedProviderId}/${model.label}`] = model.id;
    }
  const previousCapabilities = (model: { id: string; label: string }) =>
    previous.managedCatalog?.capabilities[model.id] ??
    (replacedProviderId !== undefined
      ? previous.managedCatalog?.capabilities[`${replacedProviderId}/${model.label}`]
      : undefined);
  const unavailableModelIds = [
    ...new Set([
      ...(previous.managedCatalog?.unavailableModelIds ?? []),
      ...(previous.enabledModelIds ?? []),
    ]),
  ].filter((id) => !availableModelIds.includes(aliases[id] ?? id));
  const managedCatalog: ManagedModelCatalog = {
    sourceId: source.id,
    sourceLabel: source.label,
    group: source.group,
    providerId,
    providerLabel: channel?.label ?? previous.managedCatalog?.providerLabel ?? label,
    availableModelIds,
    unavailableModelIds,
    ...(previous.managedCatalog?.disabledModelIds
      ? {
          disabledModelIds: previous.managedCatalog.disabledModelIds.map((id) => aliases[id] ?? id),
        }
      : {}),
    aliases,
    capabilities: Object.fromEntries(
      (channel?.models ?? []).map((model) => {
        // A source that reports no capabilities keeps the last declared ones instead
        // of silently dropping a known context window or thinking levels.
        const kept = previousCapabilities(model);
        return [
          model.id,
          model.capabilities.source === "unknown" && kept ? kept : model.capabilities,
        ];
      }),
    ),
  };
  return {
    ...previous,
    enabledModelIds: availableModelIds.filter(
      (id) => !managedCatalog.disabledModelIds?.includes(id),
    ),
    ...(previous.visionModelIds
      ? { visionModelIds: previous.visionModelIds.map((id) => aliases[id] ?? id) }
      : {}),
    managedCatalog,
  };
}

/** Rewrites saved choices only when their former route still names this exact channel/model. */
async function updateModelReferences(
  tx: Prisma.TransactionClient,
  userId: string,
  credentialId: string,
  catalog: ManagedModelCatalog,
) {
  for (const [before, after] of Object.entries(catalog.aliases)) {
    if (before === after || !catalog.availableModelIds.includes(after)) continue;
    const roleWhere = {
      userId,
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelId: before,
      OR: [{ credentialId }, { credentialId: null }],
    };
    await tx.userModelPreference.updateMany({
      where: { userId, credentialId, modelId: before },
      data: { modelId: after },
    });
    await tx.spaceModelPreference.updateMany({
      where: { userId, credentialId, modelId: before },
      data: { modelId: after },
    });
    await tx.userModelRoleChoice.updateMany({ where: roleWhere, data: { modelId: after } });
    await tx.spaceModelRoleChoice.updateMany({ where: roleWhere, data: { modelId: after } });
    const where = { userId, modelProvider: OPENAI_COMPATIBLE_PROVIDER_ID, modelId: before };
    await tx.bot.updateMany({ where, data: { modelId: after } });
    await tx.routine.updateMany({ where, data: { modelId: after } });
    await tx.steeringMessage.updateMany({
      where: { ...where, claimedAt: null },
      data: { modelId: after },
    });
  }
}

export class ModelCatalogSync {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly adapters: ModelCatalogSourceAdapter[],
  ) {}

  async list(userId: string): Promise<ModelCatalogSourceStatus[]> {
    const sources = await this.prisma.modelCatalogSource.findMany({
      where: { userId },
      include: { credentials: true },
      orderBy: { label: "asc" },
    });
    return Promise.all(
      sources.map(async ({ credentials, ...source }) => {
        let unavailableCount = 0;
        for (const credential of credentials) {
          const saved = await this.readSecret(userId, credential.secretId);
          if (saved?.kind === "openai_compatible")
            unavailableCount += saved.managedCatalog?.unavailableModelIds.length ?? 0;
        }
        return {
          id: source.id,
          label: source.label,
          group: source.group,
          apiProtocol: source.apiProtocol as ModelCatalogSourceStatus["apiProtocol"],
          lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
          lastAttemptAt: source.lastAttemptAt?.toISOString() ?? null,
          error: source.error,
          connectionCount: credentials.length,
          unavailableCount,
        };
      }),
    );
  }

  async models(
    actor: Pick<Actor, "userId" | "spaceId">,
    input: { baseUrl: string; apiProtocol?: string; credentialId?: string },
    signal?: AbortSignal,
  ): Promise<string[] | undefined> {
    const adapter = this.adapters.find(
      (item) =>
        item.baseUrl === input.baseUrl.replace(/\/+$/, "") &&
        item.apiProtocol === (input.apiProtocol ?? "chat-completions"),
    );
    if (!adapter) return undefined;
    await this.sync(actor, undefined, signal);
    const source = await this.prisma.modelCatalogSource.findUnique({
      where: { userId_sourceKey: { userId: actor.userId, sourceKey: adapter.key } },
    });
    if (!source) return [];
    if (source.error) throw new Error(source.error);
    const rows = await this.prisma.userModelCredential.findMany({
      where: {
        userId: actor.userId,
        catalogSourceId: source.id,
        ...(input.credentialId ? { id: input.credentialId } : {}),
      },
    });
    const ids: string[] = [];
    for (const row of rows) {
      const secret = await this.readSecret(actor.userId, row.secretId);
      if (secret?.kind === "openai_compatible")
        ids.push(...(secret.managedCatalog?.availableModelIds ?? []));
    }
    return [...new Set(ids)];
  }

  private async readSecret(userId: string, secretId: string) {
    const row = await this.prisma.secret.findFirst({
      where: { id: secretId, userId, spaceId: null },
    });
    return row ? parseModelSecret(await this.secrets.load(row.ciphertext, row.id)) : undefined;
  }

  async sync(actor: Pick<Actor, "userId" | "spaceId">, sourceId?: string, signal?: AbortSignal) {
    for (const adapter of this.adapters) {
      let source = await this.prisma.modelCatalogSource.findUnique({
        where: { userId_sourceKey: { userId: actor.userId, sourceKey: adapter.key } },
      });
      if (sourceId && source?.id !== sourceId) continue;
      // Only adopt an account already connected to this gateway/protocol.
      if (!source) {
        const rows = await this.prisma.userModelCredential.findMany({
          where: { userId: actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
        });
        let matches = false;
        for (const row of rows) {
          const secret = await this.readSecret(actor.userId, row.secretId);
          if (
            secret?.kind === "openai_compatible" &&
            !secret.managedCatalog &&
            secret.baseUrl.replace(/\/+$/, "") === adapter.baseUrl &&
            (secret.apiProtocol ?? "chat-completions") === adapter.apiProtocol
          )
            matches = true;
        }
        if (!matches) continue;
        source = await this.prisma.modelCatalogSource.upsert({
          where: { userId_sourceKey: { userId: actor.userId, sourceKey: adapter.key } },
          create: {
            userId: actor.userId,
            sourceKey: adapter.key,
            label: adapter.label,
            group: adapter.group,
            apiProtocol: adapter.apiProtocol,
          },
          update: {},
        });
      }
      const attemptedAt = new Date();
      await this.prisma.modelCatalogSource.update({
        where: { id: source.id },
        data: { lastAttemptAt: attemptedAt },
      });
      try {
        const channels = await adapter.read(signal);
        const fingerprint = createHash("sha256").update(JSON.stringify(channels)).digest("hex");
        await holdSecretNotifications(() =>
          withTransactionRetry(() =>
            this.prisma.$transaction(
              async (tx) => {
                const [current] = await tx.$queryRaw<SourceRow[]>`
                SELECT * FROM model_catalog_sources WHERE id = ${source.id} FOR UPDATE`;
                if (current?.lastAttemptAt?.getTime() !== attemptedAt.getTime()) return;
                if (current.fingerprint !== fingerprint)
                  await this.apply(tx, actor, source, adapter, channels, signal);
                await tx.modelCatalogSource.update({
                  where: { id: source.id },
                  data: {
                    label: adapter.label,
                    fingerprint,
                    lastSyncedAt: new Date(),
                    error: null,
                  },
                });
              },
              { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            ),
          ),
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        await this.prisma.modelCatalogSource.updateMany({
          where: { id: source.id, lastAttemptAt: attemptedAt },
          data: {
            error: error instanceof Error ? error.message : "Catalog synchronization failed",
          },
        });
      }
    }
    return this.list(actor.userId);
  }

  private async apply(
    tx: Prisma.TransactionClient,
    actor: Pick<Actor, "userId" | "spaceId">,
    source: SourceRow,
    adapter: ModelCatalogSourceAdapter,
    channels: CatalogChannel[],
    signal?: AbortSignal,
  ) {
    const rows = await tx.userModelCredential.findMany({
      where: { userId: actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
    });
    const saved = new Map<string, CompatibleSecret>();
    for (const row of rows) {
      const secretRow = await tx.secret.findFirst({
        where: { id: row.secretId, userId: actor.userId, spaceId: null },
      });
      if (!secretRow) continue;
      const secret = parseModelSecret(await this.secrets.load(secretRow.ciphertext, secretRow.id));
      if (
        secret.kind === "openai_compatible" &&
        (row.catalogSourceId === source.id ||
          (!row.catalogSourceId &&
            secret.baseUrl.replace(/\/+$/, "") === adapter.baseUrl &&
            (secret.apiProtocol ?? "chat-completions") === adapter.apiProtocol))
      )
        saved.set(row.id, secret);
    }
    const consumed = new Set<string>();
    for (const channel of channels) {
      let row = rows.find(
        (item) => item.catalogSourceId === source.id && item.catalogProviderId === channel.id,
      );
      if (!row) {
        // A channel re-created under a new id keeps the connection saved for its previous
        // id when exactly one connection under this source (or an unmanaged one on the same
        // endpoint) carries the same label.
        const matches = rows.filter(
          (item) => !consumed.has(item.id) && saved.has(item.id) && item.label === channel.label,
        );
        if (matches.length === 1) row = matches[0];
      }
      const previous = row ? saved.get(row.id) : undefined;
      if (row && !previous) throw new Error("A managed connection could not be read");
      const next = projectCatalogChannel(
        { ...source, label: adapter.label },
        channel,
        previous ?? {
          kind: "openai_compatible",
          baseUrl: adapter.baseUrl,
          apiProtocol: adapter.apiProtocol,
          reasoning: true,
        },
        row?.label ?? channel.label,
        channel.id,
      );
      const result = await this.writeConnection(
        tx,
        actor,
        source.id,
        row,
        next,
        signal,
        !previous?.managedCatalog || row?.label === previous.managedCatalog.providerLabel,
      );
      consumed.add(result.id);
      await updateModelReferences(tx, actor.userId, result.id, next.managedCatalog!);
      if (!row && next.enabledModelIds?.[0])
        await tx.userModelPreference.create({
          data: { userId: actor.userId, credentialId: result.id, modelId: next.enabledModelIds[0] },
        });
    }
    for (const row of rows) {
      const previous = saved.get(row.id);
      if (!previous || consumed.has(row.id)) continue;
      const next = projectCatalogChannel(
        { ...source, label: adapter.label },
        undefined,
        previous,
        row.label,
        row.catalogProviderId ?? `retired:${row.id}`,
      );
      await this.writeConnection(tx, actor, source.id, row, next, signal);
    }
  }

  private async writeConnection(
    tx: Prisma.TransactionClient,
    actor: Pick<Actor, "userId" | "spaceId">,
    sourceId: string,
    previous: { id: string; secretId: string; label: string } | undefined,
    next: CompatibleSecret,
    signal?: AbortSignal,
    updateLabel = false,
  ) {
    const stored = await this.secrets.put(serializeModelSecret(next), {
      operationId: "model-catalog-sync",
      traceId: sourceId,
      ...actor,
      signal: signal ?? new AbortController().signal,
    });
    await tx.secret.create({
      data: {
        id: stored.id,
        userId: actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext: stored.ciphertext,
      },
    });
    const managed = next.managedCatalog!;
    const data = {
      secretId: stored.id,
      catalogSourceId: sourceId,
      catalogProviderId: managed.providerId,
    };
    if (!previous)
      return tx.userModelCredential.create({
        data: {
          ...data,
          userId: actor.userId,
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          label: managed.providerLabel,
        },
      });
    const result = await tx.userModelCredential.update({
      where: { id: previous.id },
      data: {
        ...data,
        ...(updateLabel ? { label: managed.providerLabel } : {}),
      },
    });
    await deleteUnreferencedCredentialSecret(tx, {
      credentialKind: "model",
      credentialId: previous.id,
      secretId: previous.secretId,
    });
    return result;
  }

  async syncAll(signal?: AbortSignal) {
    return runAsSystem("synchronize configured model catalogs", async () => {
      const users = await this.prisma.userModelCredential.findMany({
        distinct: ["userId"],
        select: { userId: true },
      });
      await Promise.all(
        users.map(async ({ userId }) => {
          const member = await this.prisma.spaceMember.findFirst({ where: { userId } });
          if (member) await this.sync({ userId, spaceId: member.spaceId }, undefined, signal);
        }),
      );
    });
  }
}
