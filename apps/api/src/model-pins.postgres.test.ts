import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import {
  EncryptedSecretStore,
  findConnectedModelCredential,
  parseModelSecret,
  resolveMemberMainModel,
  runModelChoice,
} from "@rakazo/adapters";
import { OPENAI_COMPATIBLE_PROVIDER_ID as provider } from "@rakazo/contracts";
import { connectedModelChoices } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  createSpaceForMember,
  provisionMessagingIdentity,
  requireMembership,
  runAsTenant,
  setSpaceSettingOverride,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { ModelCatalogSync } from "./model-catalog-sync.js";
import { botsRoutes } from "./routes/bots.js";
import { createRouterContext } from "./routes/context.js";
import { modelsRoutes } from "./routes/models.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const url = process.env.DATABASE_URL;
describe.skipIf(process.env.VERIFY_DATABASE !== "1" || !url)("model pin races (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const secrets = new EncryptedSecretStore("fake-model-pin-race-key");
  const baseUrl = "https://endpoint.example.test/v1";

  beforeAll(() => {
    if (!new URL(url!).pathname.startsWith("/rkz_"))
      throw new Error("Model pin races require an isolated rkz_ database");
    db = createDb(url!);
  });

  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it.each(["pin", "connection"] as const)(
    "serializes a connection edit and a pin when the %s validates first",
    async (first) => {
      const system = asSystem(db.prisma);
      const identity = await provisionMessagingIdentity(system, {
        provider: "test",
        address: `model-pin-${randomUUID()}`,
      });
      const other = await createSpaceForMember(system, {
        userId: identity.userId,
        currentSpaceId: identity.spaceId,
        name: "Other Space",
      });
      const editor = await requireMembership(system, identity.userId, identity.spaceId);
      const pinner = await requireMembership(system, identity.userId, other.id);
      const client = (prisma: PrismaClient, actor: typeof editor) =>
        createRouterClient(
          modelsRoutes(
            createRouterContext({
              prisma,
              secrets,
              env: { agentRuntime: "pi", webOrigin: "http://127.0.0.1:5173" },
            } as unknown as RouterDeps),
          ),
          { context: { actor } },
        ).models;
      const models = client(db.prisma, editor);
      const connection = await models.connect({
        provider,
        credentialId: null,
        baseUrl,
        modelId: "keep",
        enabledModelIds: ["keep", "remove"],
        makeDefault: false,
      });
      const entered = deferred();
      const release = deferred();
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const instrumented = db.prisma.$extends({
        query: {
          secret: {
            async create({ args, query }) {
              if (first === "connection") await pause();
              return query(args);
            },
          },
          userModelRoleChoice: {
            async createMany({ args, query }) {
              if (first === "pin") await pause();
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const edit = (prisma: PrismaClient) =>
        client(prisma, editor).connect({
          provider,
          credentialId: connection.id,
          baseUrl,
          modelId: "keep",
          enabledModelIds: ["keep"],
          makeDefault: false,
        });
      const pin = (prisma: PrismaClient) =>
        client(prisma, pinner).setRole({
          role: "approval",
          scope: "account",
          primary: { provider, credentialId: connection.id, modelId: "remove" },
        });
      const winner = first === "pin" ? pin : edit;
      const loser = first === "pin" ? edit : pin;
      const won = winner(instrumented);
      let lost: ReturnType<typeof Promise.allSettled> | undefined;
      try {
        await Promise.race([
          entered.promise,
          won.then(() => {
            throw new Error("First writer completed before reaching the barrier");
          }),
        ]);
        lost = Promise.allSettled([loser(db.prisma)]);
        await vi.waitFor(async () => {
          const { rows } = await db.pool.query<{ waiting: boolean }>(`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE '%AS locked%FOR NO KEY UPDATE%'
            ) AS waiting
          `);
          expect(rows[0]?.waiting).toBe(true);
        });
      } finally {
        release.resolve();
        await Promise.allSettled([won, lost]);
      }

      await expect(won).resolves.toBeDefined();
      expect(await lost).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({
            code: "BAD_REQUEST",
            message:
              first === "pin"
                ? "In use by backup models. Pick another model for them first."
                : "Unknown model for that provider",
          }),
        },
      ]);
      await expect(models.role({ role: "approval" })).resolves.toMatchObject({
        primary: first === "pin" ? { modelId: "remove" } : null,
      });
      const credentials = await models.credentials();
      expect(credentials.find((row) => row.id === connection.id)?.enabledModelIds).toEqual(
        first === "pin" ? ["keep", "remove"] : ["keep"],
      );
    },
  );

  it("saves either endpoint on one Bot without moving another Bot or the main role", async () => {
    const system = asSystem(db.prisma);
    const identity = await provisionMessagingIdentity(system, {
      provider: "test",
      address: `model-route-${randomUUID()}`,
    });
    const actor = (await requireMembership(system, identity.userId, identity.spaceId))!;
    const ctx = createRouterContext({
      prisma: db.prisma,
      secrets,
      events: { notify: vi.fn(async () => undefined) },
      env: { agentRuntime: "pi", webOrigin: "http://127.0.0.1:5173" },
    } as unknown as RouterDeps);
    const { bots, models } = createRouterClient(
      {
        ...botsRoutes(ctx),
        ...modelsRoutes(ctx),
      },
      { context: { actor } },
    );
    const modelId = "shared";
    const endpointA = "https://endpoint-a.example.test/v1";
    const endpointB = "https://endpoint-b.example.test/v1";
    const a = await models.connect({
      provider,
      credentialId: null,
      baseUrl: endpointA,
      modelId,
      makeDefault: true,
      label: "Channel A",
    });
    const b = await models.connect({
      provider,
      credentialId: null,
      baseUrl: endpointB,
      modelId,
      enabledModelIds: [modelId],
      makeDefault: false,
      label: "Channel B",
    });
    const repos = createRepos(system);
    const create = (name: string) =>
      repos.createBot(actor, {
        name,
        description: "",
        instructions: "",
        notifyOnFinish: false,
        modelProvider: provider,
        modelId,
      });
    const target = await create("Target");
    const other = await create("Other");
    const route = async (botId: string) => {
      const stored = await repos.getBot(actor, botId);
      const choice = runModelChoice(stored, stored);
      const credential = await findConnectedModelCredential(
        system,
        secrets,
        actor,
        choice.modelProvider!,
        choice.modelId,
        { credentialId: choice.modelCredentialId },
      );
      if (!credential) return null;
      const material = await system.secret.findUniqueOrThrow({
        where: { id: credential.secretId },
      });
      const secret = parseModelSecret(await secrets.load(material.ciphertext, material.id));
      return secret.kind === "openai_compatible" ? secret.baseUrl : null;
    };
    const choices = connectedModelChoices(await models.credentials(), [], true);
    expect(
      choices.filter((choice) => choice.modelId === modelId).map((choice) => choice.connectionId),
    ).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(
      new Set(choices.filter((choice) => choice.modelId === modelId).map((choice) => choice.key))
        .size,
    ).toBe(2);

    await bots.update({
      botId: other.id,
      modelProvider: provider,
      modelId,
      modelCredentialId: a.id,
    });
    await expect(bots.get({ botId: other.id })).resolves.toMatchObject({
      modelProvider: provider,
      modelId,
      modelCredentialId: a.id,
    });
    const otherRouteBefore = await route(other.id);
    expect(otherRouteBefore).toBe(endpointA);
    const mainRoute = () => resolveMemberMainModel({ prisma: system, secretStore: secrets }, actor);
    const mainBefore = await mainRoute();
    expect(mainBefore).toMatchObject({
      provider,
      modelId,
      credentialId: a.id,
      credential: { id: a.id },
    });

    for (const [connection, endpoint] of [
      [a, endpointA],
      [b, endpointB],
    ] as const) {
      await bots.update({
        botId: target.id,
        modelProvider: provider,
        modelId,
        modelCredentialId: connection.id,
      });
      await expect(bots.get({ botId: target.id })).resolves.toMatchObject({
        modelProvider: provider,
        modelId,
        modelCredentialId: connection.id,
      });
      await expect(route(target.id)).resolves.toBe(endpoint);
      await expect(route(other.id)).resolves.toBe(otherRouteBefore);
      await expect(mainRoute()).resolves.toEqual(mainBefore);
    }
    await expect(
      models.connect({
        provider,
        credentialId: b.id,
        baseUrl: endpointB,
        modelId: "other",
        enabledModelIds: ["other"],
        makeDefault: false,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("In use by Target"),
    });
    await system.userModelCredential.delete({ where: { id: b.id } });
    await expect(bots.get({ botId: target.id })).resolves.toMatchObject({
      modelCredentialId: b.id,
    });
    await expect(route(target.id)).resolves.toBeNull();
    await expect(route(other.id)).resolves.toBe(otherRouteBefore);
    await expect(mainRoute()).resolves.toEqual(mainBefore);
  });

  it("copies the account role and rewrites both copies when the catalog renames its model", async () => {
    const system = asSystem(db.prisma);
    const identity = await provisionMessagingIdentity(system, {
      provider: "test",
      address: `model-catalog-copy-${randomUUID()}`,
    });
    const actor = (await requireMembership(system, identity.userId, identity.spaceId))!;
    const space = await createSpaceForMember(system, {
      userId: actor.userId,
      currentSpaceId: actor.spaceId,
      name: "Copy target",
    });
    const models = createRouterClient(
      modelsRoutes(
        createRouterContext({
          prisma: db.prisma,
          secrets,
          env: { agentRuntime: "pi", webOrigin: "http://127.0.0.1:5173" },
        } as unknown as RouterDeps),
      ),
      { context: { actor } },
    ).models;
    const connection = await models.connect({
      provider,
      credentialId: null,
      baseUrl,
      modelId: "Channel/model",
      enabledModelIds: ["Channel/model"],
      apiProtocol: "chat-completions",
      label: "Channel",
    });
    const catalog = new ModelCatalogSync(db.prisma, secrets, [
      {
        key: "test:copy",
        label: "Synthetic",
        group: "chat",
        baseUrl,
        apiProtocol: "chat-completions",
        async read() {
          return [
            {
              id: "channel",
              label: "Channel",
              enabled: true,
              models: [
                { id: "channel/model", label: "model", capabilities: { source: "unknown" } },
              ],
            },
          ];
        },
      },
    ]);
    const entered = deferred();
    const release = deferred();
    const instrumented = db.prisma.$extends({
      query: {
        spaceModelRoleChoice: {
          async createMany({ args, query }) {
            entered.resolve();
            await release.promise;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const target = { ...actor, spaceId: space.id };
    const copy = runAsTenant(target, () =>
      setSpaceSettingOverride(instrumented, target, "models", true),
    );
    let sync: ReturnType<typeof catalog.sync> | undefined;
    try {
      await Promise.race([
        entered.promise,
        copy.then(() => {
          throw new Error("Override copied before reaching the barrier");
        }),
      ]);
      sync = runAsTenant(actor, () => catalog.sync(actor));
      await vi.waitFor(async () => {
        const { rows } = await db.pool.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%AS locked%FOR NO KEY UPDATE%'
          ) AS waiting
        `);
        expect(rows[0]?.waiting).toBe(true);
      });
    } finally {
      release.resolve();
      await Promise.allSettled([copy, sync]);
    }
    await expect(copy).resolves.toContain("models");
    await expect(sync).resolves.toEqual([expect.objectContaining({ error: null })]);
    await expect(
      system.userModelRoleChoice.findFirst({ where: { userId: actor.userId, role: "main" } }),
    ).resolves.toMatchObject({ credentialId: connection.id, modelId: "channel/model" });
    await expect(
      system.spaceModelRoleChoice.findFirst({ where: { spaceId: space.id, role: "main" } }),
    ).resolves.toMatchObject({ credentialId: connection.id, modelId: "channel/model" });
  });
});
