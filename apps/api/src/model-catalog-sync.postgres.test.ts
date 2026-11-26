import { randomUUID } from "node:crypto";
import type { CatalogChannel, ModelCatalogSourceAdapter } from "@rakazo/adapters";
import {
  EncryptedSecretStore,
  modelCredentialDto,
  parseModelSecret,
  serializeModelSecret,
  validateConnectedModelChoice,
} from "@rakazo/adapters";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelCatalogSync } from "./model-catalog-sync.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const stamp = randomUUID();
const actor = { userId: `catalog-user-${stamp}`, spaceId: `catalog-space-${stamp}` };
const orgId = `catalog-org-${stamp}`;
const credentialId = `catalog-credential-${stamp}`;
const secondSpaceId = `catalog-second-space-${stamp}`;
const secondBotId = `catalog-second-bot-${stamp}`;
const baseUrl = "http://127.0.0.1:9000/v1";

postgres("managed model catalog (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const secrets = new EncryptedSecretStore("catalog-test-secret");
  let sync: ModelCatalogSync;
  let fail = false;
  let channels: CatalogChannel[] = [
    {
      id: "provider-id",
      label: "Channel",
      enabled: true,
      models: [
        { id: "provider-id/model-a", label: "model-a", capabilities: { source: "unknown" } },
      ],
    },
  ];
  const adapter: ModelCatalogSourceAdapter = {
    key: "gateway:messages",
    label: "Gateway",
    group: "messages",
    baseUrl,
    apiProtocol: "anthropic-messages",
    async read() {
      if (fail) throw new Error("Source unavailable");
      return channels;
    },
  };

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.startsWith("/rkz_"))
      throw new Error("Catalog tests require an isolated rkz_ database");
    db = createDb(databaseUrl!);
    sync = new ModelCatalogSync(db.prisma, secrets, [adapter]);
    await runAsSystem("synthetic catalog fixture", async () => {
      await db.prisma.user.create({
        data: { id: actor.userId, name: "Catalog fixture", email: `${stamp}@example.test` },
      });
      await db.prisma.organization.create({
        data: { id: orgId, name: "Fixture", slug: orgId, createdAt: new Date() },
      });
      await db.prisma.member.create({
        data: {
          id: `catalog-org-member-${stamp}`,
          organizationId: orgId,
          userId: actor.userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await db.prisma.space.create({
        data: { id: actor.spaceId, organizationId: orgId, name: "Fixture" },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: `catalog-member-${stamp}`,
          ...actor,
          organizationId: orgId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await db.prisma.space.create({
        data: { id: secondSpaceId, organizationId: orgId, name: "Second fixture space" },
      });
      await db.prisma.bot.create({
        data: {
          id: secondBotId,
          spaceId: secondSpaceId,
          userId: actor.userId,
          name: "Second fixture bot",
          color: "primary",
          modelProvider: "openai-compatible",
          modelId: "Channel/model-a",
        },
      });
      const stored = await secrets.put(
        serializeModelSecret({
          kind: "openai_compatible",
          baseUrl,
          apiProtocol: "anthropic-messages",
          enabledModelIds: ["Channel/model-a", "Channel/removed"],
          contextWindow: 1000000,
          thinkingLevel: "high",
          reasoning: true,
        }),
        {
          ...actor,
          operationId: "fixture",
          traceId: "fixture",
          signal: new AbortController().signal,
        },
      );
      await db.prisma.secret.create({
        data: {
          id: stored.id,
          userId: actor.userId,
          spaceId: null,
          kind: "model",
          ciphertext: stored.ciphertext,
        },
      });
      await db.prisma.userModelCredential.create({
        data: {
          id: credentialId,
          userId: actor.userId,
          provider: "openai-compatible",
          label: "Channel",
          secretId: stored.id,
        },
      });
      await db.prisma.userModelPreference.create({
        data: {
          userId: actor.userId,
          credentialId,
          modelId: "Channel/model-a",
          thinkingLevel: "high",
        },
      });
      await db.prisma.userModelRoleChoice.create({
        data: {
          userId: actor.userId,
          credentialId,
          role: "main",
          position: 0,
          provider: "openai-compatible",
          modelId: "Channel/model-a",
        },
      });
    });
  });

  afterAll(async () => {
    await secrets.close();
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("adopts the existing connection and references, preserves overrides, and does not duplicate", async () => {
    await runAsTenant(actor, async () => {
      const [status] = await sync.sync(actor);
      expect(status).toMatchObject({ connectionCount: 1, unavailableCount: 1, error: null });
      const row = await db.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: credentialId },
      });
      const before = row.secretId;
      const stored = await db.prisma.secret.findUniqueOrThrow({ where: { id: row.secretId } });
      const secret = parseModelSecret(await secrets.load(stored.ciphertext, stored.id));
      expect(secret).toMatchObject({
        contextWindow: 1000000,
        thinkingLevel: "high",
        enabledModelIds: ["provider-id/model-a"],
      });
      expect(secret.maxTokens).toBeUndefined();
      expect(
        (await db.prisma.userModelRoleChoice.findFirstOrThrow({ where: { userId: actor.userId } }))
          .modelId,
      ).toBe("provider-id/model-a");
      await expect(
        runAsSystem("read the fixture bot in the other space", () =>
          db.prisma.bot.findUniqueOrThrow({
            where: { id: secondBotId },
            select: { modelId: true },
          }),
        ),
      ).resolves.toEqual({ modelId: "provider-id/model-a" });
      await sync.sync(actor);
      expect(await db.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(
        1,
      );
      expect(
        (await db.prisma.userModelCredential.findUniqueOrThrow({ where: { id: credentialId } }))
          .secretId,
      ).toBe(before);
    });
  });

  it("keeps a source outage separate from removal", async () => {
    fail = true;
    await runAsTenant(actor, async () => {
      const [status] = await sync.sync(actor);
      expect(status).toMatchObject({ connectionCount: 1, error: "Source unavailable" });
      expect(status?.lastSyncedAt).not.toBeNull();
      expect(
        await validateConnectedModelChoice(
          db.prisma,
          secrets,
          actor,
          "openai-compatible",
          "provider-id/model-a",
          { credentialId },
        ),
      ).toBeUndefined();
    });
    fail = false;
  });

  it("renames a channel without changing its connection or model identity", async () => {
    channels = [{ ...channels[0]!, label: "Renamed" }];
    await runAsTenant(actor, async () => {
      await sync.sync(actor);
      const row = await db.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: credentialId },
      });
      expect(row.label).toBe("Renamed");
      expect(
        await validateConnectedModelChoice(
          db.prisma,
          secrets,
          actor,
          "openai-compatible",
          "Channel/model-a",
          { credentialId },
        ),
      ).toBeUndefined();
    });
  });

  it("rejects a disabled model even when it is still saved as the main model", async () => {
    channels = [{ ...channels[0]!, enabled: false }];
    await runAsTenant(actor, async () => {
      await sync.sync(actor);
      expect(
        await validateConnectedModelChoice(
          db.prisma,
          secrets,
          actor,
          "openai-compatible",
          "provider-id/model-a",
          { credentialId },
        ),
      ).toContain("no longer available");
      const row = await db.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: credentialId },
      });
      const saved = await db.prisma.secret.findUniqueOrThrow({ where: { id: row.secretId } });
      expect(
        modelCredentialDto(
          { ...row, defaultModel: "provider-id/model-a" },
          await secrets.load(saved.ciphertext, saved.id),
        ),
      ).toMatchObject({ enabledModelIds: [], catalogSource: { available: false } });
      expect(
        (await db.prisma.userModelRoleChoice.findFirstOrThrow({ where: { userId: actor.userId } }))
          .modelId,
      ).toBe("provider-id/model-a");
    });
  });

  it("adds a new channel once and does not pick it as an arbitrary replacement", async () => {
    channels = [
      ...channels,
      {
        id: "new-id",
        label: "New",
        enabled: true,
        models: [{ id: "new-id/model-b", label: "model-b", capabilities: { source: "unknown" } }],
      },
    ];
    await runAsTenant(actor, async () => {
      await sync.sync(actor);
      await sync.sync(actor);
      expect(await db.prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(
        2,
      );
      expect(
        (await db.prisma.userModelRoleChoice.findFirstOrThrow({ where: { userId: actor.userId } }))
          .credentialId,
      ).toBe(credentialId);
      expect(await sync.models(actor, { baseUrl, apiProtocol: "anthropic-messages" })).toEqual([
        "new-id/model-b",
      ]);
    });
  });

  it("does not expose another account's source", async () => {
    const other = { ...actor, userId: "another-user" };
    await runAsTenant(other, async () => {
      expect(await sync.list(actor.userId)).toEqual([]);
      expect(
        await sync.models(other, { baseUrl, apiProtocol: "anthropic-messages" }),
      ).toBeUndefined();
    });
  });

  it("keeps the connection and its saved choices when a channel returns under a new ID", async () => {
    await runAsTenant(actor, async () => {
      const before = await db.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: credentialId },
      });
      channels = [
        {
          id: "replacement-id",
          label: before.label,
          enabled: true,
          models: [
            { id: "replacement-id/model-a", label: "model-a", capabilities: { source: "unknown" } },
          ],
        },
      ];
      await sync.sync(actor);
      expect(
        await db.prisma.userModelCredential.findUniqueOrThrow({ where: { id: credentialId } }),
      ).toMatchObject({ catalogProviderId: "replacement-id" });
      expect(
        await db.prisma.userModelRoleChoice.findFirstOrThrow({ where: { userId: actor.userId } }),
      ).toMatchObject({ credentialId, modelId: "replacement-id/model-a" });
    });
  });

  it("adds a new channel whose label matches a channel still present in the response", async () => {
    await runAsTenant(actor, async () => {
      const existing = channels[0]!;
      channels = [
        {
          ...existing,
          id: "same-label-id",
          models: [
            { id: "same-label-id/model-a", label: "model-a", capabilities: { source: "unknown" } },
          ],
        },
        ...channels,
      ];
      await sync.sync(actor);
      expect(
        await db.prisma.userModelCredential.findUniqueOrThrow({ where: { id: credentialId } }),
      ).toMatchObject({ catalogProviderId: existing.id });
      expect(await sync.models(actor, { baseUrl, apiProtocol: "anthropic-messages" })).toContain(
        "same-label-id/model-a",
      );
    });
  });
});
