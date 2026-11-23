import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import type { RpcInput, Space, SpaceNavigation } from "@rakazo/contracts";
import {
  claimSpaceDeletionForMember,
  deleteClaimedSpaceForMember,
  listClaimedSpaceComputers,
  releaseSpaceDeletionClaim,
  renewSpaceDeletionClaim,
  runAsSystem,
  runAsTenant,
  setSpaceSettingOverride,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { createTestSpace, testSpaceHeaders } from "./index.js";

import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeWithDatabase("API authorization and resource isolation", () => {
  let handles: AppHandles;
  let db: AppHandles["prisma"];
  const encryptionKey = "offline-authorization-encryption-key";
  let app: App;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-authz-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      encryptionKey,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      // Board procedures answer 404 before the session check while the board is off.
      ticketBoardEnabled: true,
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    botIntroHarness = handles;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps resources inside the selected local workspace", async () => {
    const owner = await testSpace(app, "Authorization Owner");
    const intruder = await testSpace(app, "Authorization Intruder");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const intruderActor = await rpc<Actor>(app, intruder, "me");
    expect(ownerActor.spaceId).not.toBe(intruderActor.spaceId);

    const ownerBot = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot"));
    const intruderBot = await rpc<Bot>(app, intruder, "bots/create", botInput("Intruder Bot"));
    const ownerRoutine = await rpc<{ id: string }>(
      app,
      owner,
      "routines/create",
      routineInput(ownerBot.id),
    );
    const ownerScratchpad = await rpc<{ id: string }>(app, owner, "scratchpad/create", {
      botId: ownerBot.id,
      title: "Owner open work",
      notes: "private",
    });
    const ownerSkill = await db.taughtSkill.create({
      data: {
        spaceId: ownerActor.spaceId,
        botId: ownerBot.id,
        userId: ownerActor.userId,
        name: "Owner Skill",
        goal: "Owner-only skill",
        status: "saved",
        playbook: skillPlaybookInput(),
        recording: { events: [], snapshots: [] },
      },
    });
    const ownerAgentSkill = await rpc<{ id: string }>(app, owner, "agentSkills/create", {
      name: "Owner Recipe",
      description: "Owner-only shared skill",
      body: "1. Do the private thing.",
    });
    const ownerCapability = await rpc<{ id: string }>(
      app,
      owner,
      "capabilities/install",
      capabilityInput("Owner Capability"),
    );
    for (const [kind, id] of [["skill", ownerAgentSkill.id], ["install", ownerCapability.id]]) {
      await rpc(app, owner, "availability/set", {
        kind, id, allSpaces: false, spaceIds: [ownerActor.spaceId],
      });
    }
    const ownerConnection = await rpc<{ connectionId: string }>(
      app,
      owner,
      "connections/begin",
      connectionInput("Owner Connection"),
    );
    const ownerMemory = await db.memoryDocument.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        scope: "bot",
        path: "PRIVATE.md",
        content: "owner-only-memory",
      },
    });
    const ownerArtifact = await db.artifact.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        name: "owner-secret.txt",
        mimeType: "text/plain",
        size: 17,
        hash: "sha256:not-a-real-hash",
        storageKey: "test/owner-secret.txt",
      },
    });
    const ownerThread = await db.thread.findUniqueOrThrow({
      where: { botId: ownerBot.id },
    });
    const ownerTask = await asSystem(handles.prisma).task.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        prompt: "owner prompt",
        status: "waiting_input",
      },
    });
    const ownerRun = await asSystem(handles.prisma).run.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        taskId: ownerTask.id,
        status: "waiting_input",
        trigger: "user",
      },
    });

    const botIdCalls: Array<[string, unknown]> = [
      ["bots/get", { botId: ownerBot.id }],
      ["bots/duplicate", { botId: ownerBot.id }],
      ["bots/update", { botId: ownerBot.id, name: "Stolen Bot" }],
      ["bots/archive", { botId: ownerBot.id }],
      ["bots/restore", { botId: ownerBot.id }],
      ["bots/emailAddress", { botId: ownerBot.id }],
      ["bots/claimEmailAddress", { botId: ownerBot.id, name: "intruder-claim" }],
      ["threads/get", { botId: ownerBot.id }],
      ["threads/messages", { botId: ownerBot.id, before: 1 }],
      ["threads/subscribe", { botId: ownerBot.id, cursor: -1 }],
      ["threads/send", { botId: ownerBot.id, text: "intruder message" }],
      ["threads/send", { botId: ownerBot.id, artifactIds: [ownerArtifact.id] }],
      ["threads/stop", { botId: ownerBot.id }],
      ["threads/stopHelper", { botId: ownerBot.id, messageId: "missing-message" }],
      ["threads/clear", { botId: ownerBot.id }],
      ["threads/followUp", { botId: ownerBot.id, text: "intruder follow-up" }],
      [
        "threads/answer",
        {
          botId: ownerBot.id,
          runId: ownerRun.id,
          messageId: "missing-message",
          answer: "intruder answer",
        },
      ],
      ["threads/markRead", { botId: ownerBot.id }],
      ["threads/markUnread", { botId: ownerBot.id }],
      ["threads/snooze", { botId: ownerBot.id, until: null }],
      ["computer/status", { botId: ownerBot.id }],
      ["computer/boot", { botId: ownerBot.id }],
      ["computer/stop", { botId: ownerBot.id }],
      ["computer/takeover", { botId: ownerBot.id }],
      ["computer/release", { botId: ownerBot.id }],
      ["computer/input", { botId: ownerBot.id, kind: "key", payload: { key: "A" } }],
      ["computer/files", { botId: ownerBot.id, path: "/" }],
      ["computer/readFile", { botId: ownerBot.id, path: "PRIVATE.md" }],
      ["computer/screenUrl", { botId: ownerBot.id }],
      ["computer/preview", { botId: ownerBot.id }],
      ["computer/heartbeat", { botId: ownerBot.id }],
      ["routines/list", { botId: ownerBot.id }],
      ["routines/create", routineInput(ownerBot.id)],
      ["scratchpad/list", { botId: ownerBot.id }],
      ["scratchpad/create", { botId: ownerBot.id, title: "Stolen item" }],
      ["skills/list", { botId: ownerBot.id }],
      ["skills/start", { botId: ownerBot.id, goal: "Intruder demo" }],
      ["artifacts/list", { botId: ownerBot.id }],
      [
        "artifacts/create",
        {
          botId: ownerBot.id,
          name: "intruder.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("nope").toString("base64"),
        },
      ],
      ["artifacts/get", { botId: ownerBot.id, artifactId: ownerArtifact.id }],
      ["export/bot", { botId: ownerBot.id }],
      ["voice/prepare", { text: "stolen speech", botId: ownerBot.id }],
    ];
    await Promise.all(
      botIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    const ownerBot2 = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot Two"));
    const ownerGroup = await rpc<{ id: string }>(app, owner, "groups/create", {
      name: "Owner Group",
      botIds: [ownerBot.id, ownerBot2.id],
    });
    const groupCalls: Array<[string, unknown]> = [
      ["groups/get", { groupId: ownerGroup.id }],
      ["groups/update", { groupId: ownerGroup.id, name: "Stolen Group" }],
      ["groups/remove", { groupId: ownerGroup.id }],
      ["threads/get", { groupId: ownerGroup.id }],
      ["threads/messages", { groupId: ownerGroup.id, before: 1 }],
      ["threads/subscribe", { groupId: ownerGroup.id, cursor: -1 }],
      ["threads/send", { groupId: ownerGroup.id, text: "intruder group message" }],
      ["threads/stop", { groupId: ownerGroup.id }],
      ["threads/followUp", { groupId: ownerGroup.id, text: "intruder follow-up" }],
      ["threads/markRead", { groupId: ownerGroup.id }],
      ["threads/markUnread", { groupId: ownerGroup.id }],
      ["threads/snooze", { groupId: ownerGroup.id, until: null }],
    ];
    await Promise.all(
      groupCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    // A caller cannot pair their own bot with another workspace's run ID.
    await expectDenied(app, intruder, "threads/answer", {
      botId: intruderBot.id,
      runId: ownerRun.id,
      messageId: "missing-message",
      answer: "mixed-resource attack",
    });

    const resourceIdCalls = [
      ["routines/update", { routineId: ownerRoutine.id, name: "Stolen Routine" }],
      ["routines/remove", { routineId: ownerRoutine.id }],
      ["routines/testRun", { routineId: ownerRoutine.id }],
      [
        "threads/sendWithRoutines",
        { botId: intruderBot.id, clientNonce: "stolen", routineIds: [ownerRoutine.id] },
      ],
      [
        "threads/sendWithRoutines",
        {
          botId: intruderBot.id,
          clientNonce: "stolen-text",
          text: "intruder message",
          routineIds: [ownerRoutine.id],
        },
      ],
      ["scratchpad/update", { itemId: ownerScratchpad.id, title: "Stolen item" }],
      ["scratchpad/remove", { itemId: ownerScratchpad.id }],
      ["skills/get", { skillId: ownerSkill.id }],
      [
        "skills/appendEvent",
        { skillId: ownerSkill.id, event: { at: new Date().toISOString(), kind: "key", key: "x" } },
      ],
      ["skills/snapshot", { skillId: ownerSkill.id }],
      ["skills/stop", { skillId: ownerSkill.id }],
      ["skills/updateDraft", { skillId: ownerSkill.id, playbook: skillPlaybookInput() }],
      ["skills/save", { skillId: ownerSkill.id }],
      ["skills/testRun", { skillId: ownerSkill.id }],
      ["skills/remove", { skillId: ownerSkill.id }],
      ["memory/update", { documentId: ownerMemory.id, content: "stolen" }],
      ["connections/complete", { connectionId: ownerConnection.connectionId }],
    ] satisfies Array<[string, unknown]>;
    await Promise.all(
      resourceIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );
    await expectDenied(app, intruder, "agentSkills/get", { skillId: ownerAgentSkill.id });

    expect(await rpc<unknown[]>(app, intruder, "memory/list", { botId: ownerBot.id })).toEqual([]);
    expect(await rpc<string>(app, intruder, "memory/exportMarkdown", { botId: ownerBot.id })).toBe(
      "",
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "capabilities/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerCapability.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "agentSkills/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerAgentSkill.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "connections/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerConnection.connectionId }),
    );
    expect(
      await rpc<{ hits: unknown[] }>(app, intruder, "search/query", { q: ownerBot.name }),
    ).toEqual({ hits: [] });

    // These endpoints are deliberately idempotent for unknown IDs. Success must not mutate
    // a row in a different workspace or disclose whether it exists.
    await rpc(app, intruder, "capabilities/remove", { id: "missing-install" });
    await rpc(app, intruder, "connections/revoke", {
      connectionId: ownerConnection.connectionId,
    });
    expect(
      await db.capabilityInstall.findUnique({ where: { id: ownerCapability.id } }),
    ).not.toBeNull();
    expect(
      await asSystem(handles.prisma).connection.findUniqueOrThrow({
        where: { id: ownerConnection.connectionId },
      }),
    ).toMatchObject({ status: "connected", userId: ownerActor.userId });

    const ownerBotAfter = await asSystem(handles.prisma).bot.findUniqueOrThrow({
      where: { id: ownerBot.id },
    });
    expect(ownerBotAfter.name).toBe("Owner Bot");
    expect(
      await asSystem(handles.prisma).routine.findUniqueOrThrow({ where: { id: ownerRoutine.id } }),
    ).toMatchObject({ name: "Owner Routine" });
    expect(
      await asSystem(handles.prisma).scratchpadItem.findUniqueOrThrow({
        where: { id: ownerScratchpad.id },
      }),
    ).toMatchObject({ title: "Owner open work", notes: "private" });
    expect(
      await db.memoryDocument.findUniqueOrThrow({ where: { id: ownerMemory.id } }),
    ).toMatchObject({ content: "owner-only-memory" });

    // Destructive bot removal is checked last so an authorization regression is unmistakable.
    await expectDenied(app, intruder, "bots/removePreview", { botId: ownerBot.id });
    await expectDenied(app, intruder, "bots/remove", {
      botId: ownerBot.id,
      deleteMemories: true,
    });
    expect(
      await asSystem(handles.prisma).bot.findUnique({ where: { id: ownerBot.id } }),
    ).not.toBeNull();
  });

  // On the wire, the POST older phone apps send without a body arrives as an empty one.
  const _emptyBody = { method: "POST", body: "" };

  it("keeps space data and computers behind the selected space boundary", async () => {
    const scope = await testSpace(app, "Space Owner");
    const original = await rpc<Actor>(app, scope, "me");
    const originalBot = await rpc<Bot>(app, scope, "bots/create", botInput("Open source"));
    const support = await rpc<Space>(app, scope, "spaces/create", {
      name: "Customer support",
    });
    const storedSpaces = await handles.prisma.space.findMany({
      where: { id: { in: [original.spaceId, support.id] } },
      select: { id: true, organizationId: true },
    });
    expect(new Set(storedSpaces.map((space) => space.organizationId))).toEqual(
      new Set([original.spaceId]),
    );
    const otherOrganizationId = `spaces-other-org-${stamp}`;
    const otherWorkspaceId = `spaces-other-workspace-${stamp}`;
    await handles.prisma.$transaction([
      handles.prisma.organization.create({
        data: {
          id: otherOrganizationId,
          name: "Other company",
          slug: otherOrganizationId,
          createdAt: new Date(),
        },
      }),
      handles.prisma.member.create({
        data: {
          id: `spaces-other-member-${stamp}`,
          organizationId: otherOrganizationId,
          userId: original.userId,
          role: "owner",
          createdAt: new Date(),
        },
      }),
      handles.prisma.space.create({
        data: {
          id: otherWorkspaceId,
          organizationId: otherOrganizationId,
          name: "Other company space",
        },
      }),
      handles.prisma.spaceMember.create({
        data: {
          id: `spaces-other-space-member-${stamp}`,
          spaceId: otherWorkspaceId,
          organizationId: otherOrganizationId,
          userId: original.userId,
          role: "owner",
          createdAt: new Date(),
        },
      }),
    ]);

    // Owning a target in a different organization does not authorize a rename
    // from the active organization.
    await expect(
      raw(app, scope, "spaces/rename", { spaceId: otherWorkspaceId, name: "Wrong organization" }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      handles.prisma.space.findUniqueOrThrow({
        where: { id: otherWorkspaceId },
        select: { name: true },
      }),
    ).resolves.toEqual({ name: "Other company space" });

    const supportMe = await rpc<Actor>(app, scope, "me", {}, support.id);
    expect(supportMe.spaceId).toBe(support.id);
    const supportBot = await rpc<Bot>(app, scope, "bots/create", botInput("Support"), support.id);

    expect(await rpc<Array<{ id: string }>>(app, scope, "bots/list")).toEqual([
      expect.objectContaining({ id: originalBot.id }),
    ]);
    expect(await rpc<Array<{ id: string }>>(app, scope, "bots/list", {}, support.id)).toEqual([
      expect.objectContaining({ id: supportBot.id }),
    ]);
    await expectDenied(app, scope, "bots/get", { botId: supportBot.id });
    await expectDenied(app, scope, "bots/get", { botId: originalBot.id }, support.id);

    const navigation = await rpc<SpaceNavigation>(app, scope, "spaces/list");
    expect(navigation.current).toEqual(
      expect.objectContaining({
        id: original.spaceId,
        bots: [expect.objectContaining({ id: originalBot.id })],
      }),
    );
    expect(navigation.spaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: original.spaceId,
          bots: [expect.objectContaining({ id: originalBot.id, notifyOnFinish: false })],
        }),
        expect.objectContaining({
          id: support.id,
          name: "Customer support",
          bots: [expect.objectContaining({ id: supportBot.id, notifyOnFinish: false })],
        }),
      ]),
    );
    expect(navigation.spaces).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: otherWorkspaceId })]),
    );
    const supportNavigation = await rpc<SpaceNavigation>(app, scope, "spaces/list", {}, support.id);
    expect(supportNavigation.current).toEqual(
      expect.objectContaining({
        id: support.id,
        bots: [expect.objectContaining({ id: supportBot.id })],
      }),
    );
    const otherOrganizationNavigation = await rpc<SpaceNavigation>(
      app,
      scope,
      "spaces/list",
      {},
      otherWorkspaceId,
    );
    expect(otherOrganizationNavigation.spaces.map((space) => space.id)).toEqual([otherWorkspaceId]);

    const storedBots = await asSystem(handles.prisma).bot.findMany({
      where: { id: { in: [originalBot.id, supportBot.id] } },
      select: { id: true, spaceId: true, computerId: true },
    });
    const storedOriginal = storedBots.find((bot) => bot.id === originalBot.id);
    const storedSupport = storedBots.find((bot) => bot.id === supportBot.id);
    expect(storedOriginal?.spaceId).toBe(original.spaceId);
    expect(storedSupport?.spaceId).toBe(support.id);
    expect(storedOriginal?.computerId).not.toBe(storedSupport?.computerId);

    await expectDenied(app, scope, "bots/list", {}, "missing-space");
  });

  it("enforces the space limit across concurrent creation requests", async () => {
    const scope = await testSpace(app, "Space Limit");
    const actor = await rpc<Actor>(app, scope, "me");
    const currentSpace = await handles.prisma.space.findUniqueOrThrow({
      where: { id: actor.spaceId },
      select: { organizationId: true },
    });
    const extraSpaces = Array.from({ length: 30 }, (_, index) => ({
      id: `limit-space-${stamp}-${index}`,
      organizationId: currentSpace.organizationId,
      name: `Limit space ${index}`,
      createdAt: new Date(),
    }));
    await handles.prisma.space.createMany({ data: extraSpaces });
    await handles.prisma.spaceMember.createMany({
      data: extraSpaces.map((space, index) => ({
        id: `limit-member-${stamp}-${index}`,
        spaceId: space.id,
        organizationId: space.organizationId,
        userId: actor.userId,
        createdAt: space.createdAt,
      })),
    });

    const results = await Promise.allSettled([
      rpc<Space>(app, scope, "spaces/create", { name: "Concurrent A" }),
      rpc<Space>(app, scope, "spaces/create", { name: "Concurrent B" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      handles.prisma.spaceMember.count({
        where: { userId: actor.userId, organizationId: currentSpace.organizationId },
      }),
    ).resolves.toBe(32);
  });

  it("reuses provider credentials and selections in a new Space", async () => {
    const scope = await testSpace(app, "Provider Copy");
    const actor = await rpc<Actor>(app, scope, "me");
    const model = await rpc<ModelCredential>(app, scope, "models/connect", {
      provider: "copy-provider",
      apiKey: "fake-copy-model-key",
      label: "Copy provider",
      modelId: "copy/model",
    });
    const voice = await rpc<{ id: string; voiceId: string }>(app, scope, "voice/connect", {
      provider: "scripted",
      apiKey: "fake-copy-voice-key",
    });

    const created = await rpc<Space>(app, scope, "spaces/create", { name: "Copied defaults" });
    const [modelPreference, voicePreference] = await Promise.all([
      db.userModelPreference.findUnique({
        where: { userId_credentialId: { userId: actor.userId, credentialId: model.id } },
      }),
      db.spaceVoicePreference.findUnique({
        where: {
          spaceId_userId_credentialId: {
            spaceId: created.id,
            userId: actor.userId,
            credentialId: voice.id,
          },
        },
      }),
    ]);

    expect(modelPreference).toMatchObject({ modelId: "copy/model" });
    // The new Space follows the member's main model without a copy of its own.
    await expect(
      rpc<ModelRoleSettings>(app, scope, "models/role", { role: "main" }, created.id),
    ).resolves.toMatchObject({
      primary: { provider: "copy-provider", modelId: "copy/model", credentialId: model.id },
    });
    await expect(
      db.spaceModelRoleChoice.count({ where: { spaceId: created.id, userId: actor.userId } }),
    ).resolves.toBe(0);
    // The new Space follows the account's voice instead of copying it.
    expect(voicePreference).toBeNull();
    await expect(rpc(app, scope, "voice/status", undefined, created.id)).resolves.toMatchObject({
      voiceId: voice.voiceId,
    });
    await setSpaceSettingOverride(db, { spaceId: created.id, userId: actor.userId }, "voice", true);
    await rpc(
      app,
      scope,
      "voice/setVoice",
      { provider: "scripted", voiceId: "space-specific-voice" },
      created.id,
    );
    await expect(
      db.userVoicePreference.findUniqueOrThrow({
        where: { userId_credentialId: { userId: actor.userId, credentialId: voice.id } },
      }),
    ).resolves.toMatchObject({ voiceId: voice.voiceId, isDefault: true });
    await expect(rpc(app, scope, "voice/status")).resolves.toMatchObject({
      voiceId: voice.voiceId,
    });
    await expect(
      db.spaceVoicePreference.findUniqueOrThrow({
        where: {
          spaceId_userId_credentialId: {
            spaceId: created.id,
            userId: actor.userId,
            credentialId: voice.id,
          },
        },
      }),
    ).resolves.toMatchObject({ voiceId: "space-specific-voice", isDefault: true });
    await expect(db.userModelCredential.count({ where: { userId: actor.userId } })).resolves.toBe(
      1,
    );
    await expect(db.userVoiceCredential.count({ where: { userId: actor.userId } })).resolves.toBe(
      1,
    );
  });

  it("shares model credentials and the main model across spaces until one customizes it", async () => {
    const scope = await testSpace(app, "Model Defaults");
    const actor = await rpc<Actor>(app, scope, "me");
    const support = await rpc<Space>(app, scope, "spaces/create", { name: "Support models" });
    const expectSpaceModelDefault = async (spaceId: string, provider: string, modelId: string) => {
      const main = await rpc<ModelRoleSettings>(
        app,
        scope,
        "models/role",
        { role: "main" },
        spaceId,
      );
      expect(main.primary).toMatchObject({ provider, modelId });
    };

    const connectedA = await rpc<ModelCredential>(app, scope, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-key",
      label: "Provider A",
      modelId: "a/one",
    });
    expect(connectedA.isDefault).toBe(true);
    const providerABeforeRotation = await db.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });

    const rotatedA = await rpc<ModelCredential>(app, scope, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-replacement-key",
      label: "Provider A rotated",
      modelId: "a/rotated",
    });
    const providerAAfterRotation = await db.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });
    expect(rotatedA.id).toBe(connectedA.id);
    expect(providerAAfterRotation.secretId).not.toBe(providerABeforeRotation.secretId);
    expect(
      await db.secret.findUnique({ where: { id: providerABeforeRotation.secretId } }),
    ).toBeNull();
    await expect(
      db.secret.findUniqueOrThrow({ where: { id: providerAAfterRotation.secretId } }),
    ).resolves.toMatchObject({ userId: actor.userId, spaceId: null, kind: "model" });
    expect(
      await db.userModelCredential.count({
        where: { userId: actor.userId, provider: "provider-a" },
      }),
    ).toBe(1);

    const supportCredentials = await rpc<ModelCredential[]>(
      app,
      scope,
      "models/credentials",
      {},
      support.id,
    );
    // The other Space follows the account's main model.
    expect(supportCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: connectedA.id, provider: "provider-a", isDefault: true }),
      ]),
    );
    await expectSpaceModelDefault(support.id, "provider-a", "a/rotated");
    await rpc(
      app,
      scope,
      "models/setDefault",
      { provider: "provider-a", modelId: "a/shared" },
      support.id,
    );
    await expectSpaceModelDefault(support.id, "provider-a", "a/shared");
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/shared");

    // A customized Space starts from the account's models and then keeps its own.
    await expect(
      rpc(
        app,
        scope,
        "spaceSettings/setOverride",
        { setting: "models", enabled: true },
        support.id,
      ),
    ).resolves.toEqual(["models"]);
    await rpc(
      app,
      scope,
      "models/setDefault",
      { provider: "provider-a", modelId: "a/support" },
      support.id,
    );
    await expectSpaceModelDefault(support.id, "provider-a", "a/support");
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/shared");
    const accountFromSupport = await rpc<ModelRoleSettings>(
      app,
      scope,
      "models/role",
      { role: "main", scope: "account" },
      support.id,
    );
    expect(accountFromSupport.primary).toMatchObject({ modelId: "a/shared" });

    const connectedB = await rpc<ModelCredential>(app, scope, "models/connect", {
      provider: "provider-b",
      apiKey: "fake-provider-b-key",
      label: "Provider B",
      modelId: "b/one",
    });
    expect(connectedB.isDefault).toBe(true);
    await expectSpaceModelDefault(actor.spaceId, "provider-b", "b/one");

    await rpc(app, scope, "models/setDefault", { provider: "provider-a", modelId: "a/two" });
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/two");

    await rpc(app, scope, "models/setDefault", { provider: "provider-b", modelId: "b/two" });
    await expectSpaceModelDefault(actor.spaceId, "provider-b", "b/two");

    await rpc(app, scope, "models/setDefault", { provider: "provider-a", modelId: "a/three" });
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/three");
    await expectSpaceModelDefault(support.id, "provider-a", "a/support");

    // Using the defaults again drops the Space's copy.
    await expect(
      rpc(
        app,
        scope,
        "spaceSettings/setOverride",
        { setting: "models", enabled: false },
        support.id,
      ),
    ).resolves.toEqual([]);
    await expectSpaceModelDefault(support.id, "provider-a", "a/three");
    const listed = await rpc<ModelCredential[]>(app, scope, "models/credentials");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-a-key");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-b-key");

    const missing = await raw(app, scope, "models/setDefault", {
      provider: "missing-provider",
      modelId: "missing/model",
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await missing.text()).toMatch(/credential/i);
  });

  it("deletes an owned non-default space with all of its content", async () => {
    const scope = await testSpace(app, "Space Delete");
    const actor = await rpc<Actor>(app, scope, "me");
    const keepBot = await rpc<Bot>(app, scope, "bots/create", botInput("Keep bot"));
    const keepRoutine = await rpc<{ id: string }>(
      app,
      scope,
      "routines/create",
      routineInput(keepBot.id),
    );
    const busy = await rpc<Space>(app, scope, "spaces/create", { name: "Busy" });
    const botA = await rpc<Bot>(app, scope, "bots/create", botInput("Busy A"), busy.id);
    const botB = await rpc<Bot>(app, scope, "bots/create", botInput("Busy B"), busy.id);
    const archived = await rpc<Bot>(app, scope, "bots/create", botInput("Busy old"), busy.id);
    await rpc(app, scope, "bots/archive", { botId: archived.id }, busy.id);
    const busyGroup = await rpc<{ id: string }>(
      app,
      scope,
      "groups/create",
      { name: "Busy group", botIds: [botA.id, botB.id] },
      busy.id,
    );
    await rpc(app, scope, "routines/create", routineInput(botA.id), busy.id);
    await db.memoryDocument.create({
      data: {
        spaceId: busy.id,
        userId: actor.userId,
        botId: botA.id,
        scope: "bot",
        path: "BUSY.md",
        content: "busy-space-memory",
      },
    });
    await db.artifact.create({
      data: {
        spaceId: busy.id,
        userId: actor.userId,
        botId: botA.id,
        name: "busy.txt",
        mimeType: "text/plain",
        size: 4,
        hash: "sha256:not-a-real-hash",
        storageKey: `test/space-delete-${stamp}.txt`,
      },
    });

    const listed = await rpc<SpaceNavigation>(app, scope, "spaces/list", {}, busy.id);
    expect(listed.spaces.find((space) => space.id === busy.id)).toMatchObject({
      hasContent: true,
      canDelete: true,
      canRename: true,
      // The archived bot goes too, so the confirmation counts it.
      botCount: 3,
    });
    expect(listed.spaces.find((space) => space.id === actor.spaceId)?.canDelete).toBe(false);
    await expect(
      raw(app, scope, "spaces/remove", { spaceId: actor.spaceId }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      raw(app, scope, "spaces/remove", { spaceId: "missing-space" }),
    ).resolves.toMatchObject({ status: 404 });

    const intruder = await testSpace(app, "Intruder");
    await expect(raw(app, intruder, "spaces/remove", { spaceId: busy.id })).resolves.toMatchObject({
      status: 404,
    });
    await expect(
      raw(app, intruder, "spaces/rename", { spaceId: busy.id, name: "Stolen" }),
    ).resolves.toMatchObject({ status: 404 });
    expect(await db.bot.count({ where: { spaceId: busy.id } })).toBe(3);

    const removed = await rpc<{ ok: true; activeSpaceId: string }>(app, scope, "spaces/remove", {
      spaceId: busy.id,
    });
    expect(removed).toEqual({ ok: true, activeSpaceId: actor.spaceId });
    await expect(db.space.findUnique({ where: { id: busy.id } })).resolves.toBeNull();
    for (const count of [
      db.bot.count({ where: { spaceId: busy.id } }),
      db.chatGroup.count({ where: { id: busyGroup.id } }),
      db.thread.count({ where: { spaceId: busy.id } }),
      db.routine.count({ where: { spaceId: busy.id } }),
      db.memoryDocument.count({ where: { spaceId: busy.id } }),
      db.artifact.count({ where: { spaceId: busy.id } }),
      db.spaceMember.count({ where: { spaceId: busy.id } }),
      db.botDeletion.count({ where: { spaceId: busy.id } }),
    ]) {
      await expect(count).resolves.toBe(0);
    }
    // Nothing outside the deleted space goes with it.
    await expect(db.bot.findUnique({ where: { id: keepBot.id } })).resolves.not.toBeNull();
    await expect(db.thread.count({ where: { botId: keepBot.id } })).resolves.toBe(1);
    await expect(db.routine.findUnique({ where: { id: keepRoutine.id } })).resolves.not.toBeNull();
    await expect(
      db.memoryDocument.count({ where: { spaceId: actor.spaceId } }),
    ).resolves.toBeGreaterThan(0);
    // Already gone: a retry cannot reach another space.
    await expect(raw(app, scope, "spaces/remove", { spaceId: busy.id })).resolves.toMatchObject({
      status: 404,
    });
    const navigation = await rpc<SpaceNavigation>(app, scope, "spaces/list");
    expect(navigation.spaces.map((space) => space.id)).not.toContain(busy.id);
  });

  it("keeps a bot's sandbox handle when its teardown fails, and finishes on retry", async () => {
    const scope = await testSpace(app, "Strict Teardown");
    const actor = await rpc<Actor>(app, scope, "me");
    const space = await rpc<Space>(app, scope, "spaces/create", { name: "Strict" });
    const bot = await rpc<Bot>(app, scope, "bots/create", botInput("Sandboxed"), space.id);
    const providerRef = `space-strict-provider-${stamp}`;
    await db.computer.upsert({
      where: { scopeKey: `bot:${bot.id}` },
      create: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `bot:${bot.id}`,
        homeKey: bot.id,
        kind: "fake",
        providerRef,
      },
      update: { providerRef },
    });
    const destroy = vi
      .spyOn(handles.sandbox, "destroy")
      .mockRejectedValueOnce(new Error("provider unavailable"));
    try {
      const failed = await raw(app, scope, "spaces/remove", { spaceId: space.id });
      expect(failed.status).toBe(500);
      expect(destroy).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef }),
        expect.anything(),
      );
      await expect(db.bot.findUnique({ where: { id: bot.id } })).resolves.not.toBeNull();
      await expect(
        db.computer.findUnique({
          where: { scopeKey: `bot:${bot.id}` },
          select: { providerRef: true },
        }),
      ).resolves.toEqual({ providerRef });
      const lifecycle = await db.space.findUniqueOrThrow({
        where: { id: space.id },
        select: { deletionClaimId: true },
      });
      // Teardown may have reached the provider, so the space stays claimed.
      expect(lifecycle.deletionClaimId).toBeTruthy();
    } finally {
      destroy.mockRestore();
    }

    await db.space.update({
      where: { id: space.id },
      data: { deletingAt: new Date(Date.now() - 6 * 60_000) },
    });
    const retried = await rpc<{ ok: true; activeSpaceId: string }>(app, scope, "spaces/remove", {
      spaceId: space.id,
    });
    expect(retried).toEqual({ ok: true, activeSpaceId: actor.spaceId });
    await expect(db.space.findUnique({ where: { id: space.id } })).resolves.toBeNull();
    await expect(db.computer.count({ where: { scopeKey: `bot:${bot.id}` } })).resolves.toBe(0);
  });

  it("resumes a stale space deletion and rejects one still in progress", async () => {
    const scope = await testSpace(app, "Space Resume");
    const actor = await rpc<Actor>(app, scope, "me");
    const space = await rpc<Space>(app, scope, "spaces/create", { name: "Resume" });
    const bot = await rpc<Bot>(app, scope, "bots/create", botInput("Resume bot"), space.id);
    // A worker that claimed the space and then died.
    await runAsTenant({ spaceId: space.id, userId: actor.userId }, () =>
      claimSpaceDeletionForMember(handles.prisma, {
        currentSpaceId: space.id,
        userId: actor.userId,
        spaceId: space.id,
      }),
    );
    await expect(raw(app, scope, "spaces/remove", { spaceId: space.id })).resolves.toMatchObject({
      status: 409,
    });
    await expect(db.bot.findUnique({ where: { id: bot.id } })).resolves.not.toBeNull();

    await handles.prisma.space.update({
      where: { id: space.id },
      data: { deletingAt: new Date(Date.now() - 6 * 60_000) },
    });
    const removed = await rpc<{ ok: true; activeSpaceId: string }>(app, scope, "spaces/remove", {
      spaceId: space.id,
    });
    expect(removed).toEqual({ ok: true, activeSpaceId: actor.spaceId });
    await expect(handles.prisma.space.findUnique({ where: { id: space.id } })).resolves.toBeNull();
    await expect(db.bot.findUnique({ where: { id: bot.id } })).resolves.toBeNull();
  });

  it("blocks bot creation after space deletion is claimed", async () => {
    const scope = await testSpace(app, "Space Race");
    const actor = await rpc<Actor>(app, scope, "me");
    const space = await rpc<Space>(app, scope, "spaces/create", { name: "Concurrent" });
    await asSystem(handles.prisma).computer.create({
      data: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `space-race-scope-${stamp}`,
        homeKey: `space-race-home-${stamp}`,
        kind: "fake",
        providerRef: `space-race-provider-${stamp}`,
      },
    });
    const deleteInput = {
      currentSpaceId: space.id,
      userId: actor.userId,
      spaceId: space.id,
    };
    // The procedures run these as a member of the Space being deleted.
    const asMember = <T>(fn: () => Promise<T>) =>
      runAsTenant({ spaceId: space.id, userId: actor.userId }, fn);

    const firstClaim = await asMember(() =>
      claimSpaceDeletionForMember(handles.prisma, deleteInput),
    );
    expect(firstClaim.recovered).toBe(false);
    expect(
      await asMember(() =>
        listClaimedSpaceComputers(handles.prisma, { ...deleteInput, claimId: firstClaim.claimId }),
      ),
    ).toEqual([expect.objectContaining({ providerRef: `space-race-provider-${stamp}` })]);
    await expect(
      asMember(() =>
        renewSpaceDeletionClaim(handles.prisma, { ...deleteInput, claimId: firstClaim.claimId }),
      ),
    ).resolves.toBe(true);
    const claimedNavigation = await rpc<SpaceNavigation>(app, scope, "spaces/list", {}, space.id);
    expect(claimedNavigation.spaces.find((item) => item.id === space.id)).toMatchObject({
      canDelete: false,
      canRename: false,
    });
    await expect(
      raw(app, scope, "spaces/rename", { spaceId: space.id, name: "Blocked" }, space.id),
    ).resolves.toMatchObject({ status: 409 });
    const blockedCreate = await raw(app, scope, "bots/create", botInput("Racing bot"), space.id);
    expect(blockedCreate.ok).toBe(false);
    expect(blockedCreate.status).toBe(409);
    expect(await asSystem(handles.prisma).bot.count({ where: { spaceId: space.id } })).toBe(0);
    expect(
      await asSystem(handles.prisma).computer.findFirst({
        where: { spaceId: space.id },
        select: { providerRef: true },
      }),
    ).toEqual({ providerRef: `space-race-provider-${stamp}` });

    await handles.prisma.space.update({
      where: { id: space.id },
      data: { deletingAt: new Date(Date.now() - 6 * 60_000) },
    });
    const staleNavigation = await rpc<SpaceNavigation>(app, scope, "spaces/list", {}, space.id);
    expect(staleNavigation.spaces.find((item) => item.id === space.id)).toMatchObject({
      canDelete: true,
      canRename: false,
    });
    await expect(
      raw(app, scope, "spaces/rename", { spaceId: space.id, name: "Still blocked" }, space.id),
    ).resolves.toMatchObject({ status: 409 });
    await expect(
      handles.prisma.space.findUniqueOrThrow({ where: { id: space.id }, select: { name: true } }),
    ).resolves.toEqual({ name: "Concurrent" });
    const replacementClaim = await asMember(() =>
      claimSpaceDeletionForMember(handles.prisma, deleteInput),
    );
    expect(replacementClaim.recovered).toBe(true);
    await expect(
      asMember(() =>
        deleteClaimedSpaceForMember(handles.prisma, {
          ...deleteInput,
          claimId: firstClaim.claimId,
        }),
      ),
    ).rejects.toThrow("Space deletion is already in progress");
    await asMember(() =>
      releaseSpaceDeletionClaim(handles.prisma, { ...deleteInput, claimId: firstClaim.claimId }),
    );
    expect(
      await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletionClaimId: true },
      }),
    ).toEqual({ deletionClaimId: replacementClaim.claimId });
    await asMember(() =>
      releaseSpaceDeletionClaim(handles.prisma, {
        ...deleteInput,
        claimId: replacementClaim.claimId,
      }),
    );
    const created = await raw(app, scope, "bots/create", botInput("After retry"), space.id);
    expect(created.ok).toBe(true);
  });

  it("keeps a space claimed after ambiguous sandbox teardown failure", async () => {
    const scope = await testSpace(app, "Teardown");
    const actor = await rpc<Actor>(app, scope, "me");
    const space = await rpc<Space>(app, scope, "spaces/create", { name: "Teardown" });
    await asSystem(handles.prisma).computer.create({
      data: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `space-teardown-scope-${stamp}`,
        homeKey: `space-teardown-home-${stamp}`,
        kind: "fake",
        providerRef: `space-teardown-provider-${stamp}`,
      },
    });
    const destroy = vi
      .spyOn(handles.sandbox, "destroy")
      .mockRejectedValueOnce(new Error("ambiguous provider failure"));

    try {
      const removed = await raw(app, scope, "spaces/remove", { spaceId: space.id }, space.id);
      expect(removed.status).toBe(500);
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletingAt: true, deletionClaimId: true },
      });
      expect(lifecycle?.deletingAt).toBeInstanceOf(Date);
      expect(lifecycle?.deletionClaimId).toBeTruthy();
      expect(
        await asSystem(handles.prisma).computer.findFirst({
          where: { spaceId: space.id },
          select: { providerRef: true },
        }),
      ).toEqual({ providerRef: `space-teardown-provider-${stamp}` });
      const blockedCreate = await raw(
        app,
        scope,
        "bots/create",
        botInput("Blocked after teardown"),
        space.id,
      );
      expect(blockedCreate.ok).toBe(false);
    } finally {
      destroy.mockRestore();
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletionClaimId: true },
      });
      if (lifecycle?.deletionClaimId) {
        await releaseSpaceDeletionClaim(handles.prisma, {
          currentSpaceId: space.id,
          spaceId: space.id,
          userId: actor.userId,
          claimId: lifecycle.deletionClaimId,
        });
      }
    }
  });

  it("times out a hung sandbox teardown without unblocking the space", async () => {
    const scope = await testSpace(app, "Deadline");
    const actor = await rpc<Actor>(app, scope, "me");
    const space = await rpc<Space>(app, scope, "spaces/create", { name: "Deadline" });
    await asSystem(handles.prisma).computer.create({
      data: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `space-deadline-scope-${stamp}`,
        homeKey: `space-deadline-home-${stamp}`,
        kind: "fake",
        providerRef: `space-deadline-provider-${stamp}`,
      },
    });
    process.env.SPACE_TEARDOWN_TIMEOUT_MS = "50";
    const destroy = vi
      .spyOn(handles.sandbox, "destroy")
      .mockImplementation(() => new Promise(() => undefined));

    try {
      const removed = await raw(app, scope, "spaces/remove", { spaceId: space.id }, space.id);
      expect(removed.status).toBe(500);
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletingAt: true, deletionClaimId: true },
      });
      expect(lifecycle?.deletingAt).toBeInstanceOf(Date);
      expect(lifecycle?.deletionClaimId).toBeTruthy();
      const blockedCreate = await raw(
        app,
        scope,
        "bots/create",
        botInput("Blocked during teardown"),
        space.id,
      );
      expect(blockedCreate.status).toBe(409);
    } finally {
      destroy.mockRestore();
      delete process.env.SPACE_TEARDOWN_TIMEOUT_MS;
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletionClaimId: true },
      });
      if (lifecycle?.deletionClaimId) {
        await releaseSpaceDeletionClaim(handles.prisma, {
          currentSpaceId: space.id,
          spaceId: space.id,
          userId: actor.userId,
          claimId: lifecycle.deletionClaimId,
        });
      }
    }
  });

  it("keeps compatible headers encrypted and out of DTOs across reconnects", async () => {
    const scope = await testSpace(app, "Model Headers");
    const actor = await rpc<Actor>(app, scope, "me");
    const connection = {
      provider: "openai-compatible",
      modelId: "arbitrary-model",
      baseUrl: "http://localhost:8000/v1",
    };
    const connected = await rpc<ModelCredential>(app, scope, "models/connect", {
      ...connection,
      headers: { "x-session": "fake-session-secret" },
    });
    expect(connected.headerNames).toEqual(["x-session"]);
    expect(JSON.stringify(connected)).not.toContain("fake-session-secret");
    const credential = await db.userModelCredential.findUniqueOrThrow({
      where: { id: connected.id },
    });
    const secret = await db.secret.findUniqueOrThrow({
      where: { id: credential.secretId },
    });
    expect(secret.ciphertext).not.toContain("fake-session-secret");
    await rpc(app, scope, "models/connect", connection);
    expect(
      await runAsTenant(actor, () =>
        handles.executor.resolveModel({ userId: actor.userId, spaceId: actor.spaceId }),
      ),
    ).toMatchObject({ headers: { "x-session": "fake-session-secret" } });
    const listed = await rpc<Array<ModelCredential>>(app, scope, "models/credentials");
    expect(listed.find((row) => row.id === connected.id)?.headerNames).toEqual(["x-session"]);
    expect(JSON.stringify(listed)).not.toContain("fake-session-secret");
    await rpc(app, scope, "models/connect", { ...connection, headers: {} });
    expect(
      await runAsTenant(actor, () =>
        handles.executor.resolveModel({ userId: actor.userId, spaceId: actor.spaceId }),
      ),
    ).toMatchObject({ headers: {} });
    const cleared = await rpc<Array<ModelCredential>>(app, scope, "models/credentials");
    expect(cleared.find((row) => row.id === connected.id)?.headerNames).toEqual([]);
  });

  it("validates custom thinking against the saved connection capability", async () => {
    const scope = await testSpace(app, "Custom Thinking");
    const bot = await rpc<Bot>(app, scope, "bots/create", botInput("Thinking Bot"));
    const connection = {
      provider: "openai-compatible",
      modelId: "arbitrary-model",
      baseUrl: "http://localhost:8000/v1",
    };
    await rpc(app, scope, "models/connect", {
      ...connection,
      apiKey: "fake-saved-key",
      reasoning: false,
    });
    await rpc(app, scope, "models/connect", { ...connection, reasoning: true });
    const actor = await rpc<Actor>(app, scope, "me");
    expect(
      await runAsSystem("background job run.continue", () =>
        handles.executor.resolveModel({
          userId: actor.userId,
          spaceId: actor.spaceId,
          botId: bot.id,
        }),
      ),
    ).toMatchObject({ apiKey: "fake-saved-key", reasoning: true });
    const update = {
      botId: bot.id,
      modelProvider: connection.provider,
      modelId: connection.modelId,
    };
    expect(await rpc(app, scope, "bots/update", { ...update, thinkingLevel: "low" })).toMatchObject(
      { thinkingLevel: "low" },
    );
    expect(
      await rpc(app, scope, "bots/update", { ...update, thinkingLevel: "xhigh" }),
    ).toMatchObject({ thinkingLevel: "xhigh" });
    expect(await rpc(app, scope, "bots/update", { ...update, thinkingLevel: "max" })).toMatchObject(
      { thinkingLevel: "max" },
    );
    await rpc(app, scope, "models/connect", { ...connection, reasoning: false });
    expect((await raw(app, scope, "bots/update", { ...update, thinkingLevel: "low" })).status).toBe(
      400,
    );
    expect(
      (await raw(app, scope, "bots/update", { ...update, thinkingLevel: "xhigh" })).status,
    ).toBe(400);
    expect(await rpc(app, scope, "bots/update", { ...update, thinkingLevel: "off" })).toMatchObject(
      { thinkingLevel: "off" },
    );
  });

  it("validates per-bot model overrides against connected providers and catalog", async () => {
    const scope = await testSpace(app, "Bot Model");
    const bot = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, scope, "bots/create", botInput("Model Bot"));
    await rpc(app, scope, "models/connect", {
      provider: "xai",
      apiKey: "fake-xai-key-not-real",
      label: "xAI",
      modelId: "grok-4.6",
    });

    const updated = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, scope, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(updated).toMatchObject({
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });

    const unknown = await raw(app, scope, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "not-a-real-grok",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(await unknown.text()).toMatch(/unknown model/i);

    const disconnected = await raw(app, scope, "bots/update", {
      botId: bot.id,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(disconnected.status).toBeGreaterThanOrEqual(400);
    expect(await disconnected.text()).toMatch(/connect/i);

    const partialClear = await raw(app, scope, "bots/update", {
      botId: bot.id,
      modelId: null,
    });
    expect(partialClear.status).toBeGreaterThanOrEqual(400);
    expect(await partialClear.text()).toMatch(/both be set or both cleared/i);
  });

  it("binds a new default to the space preference credential, not a newer unused duplicate", async () => {
    const scope = await testSpace(app, "Model Duplicates");
    const actor = await rpc<Actor>(app, scope, "me");
    const olderSecret = await db.secret.create({
      data: {
        userId: actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "encrypted-older-key",
      },
    });
    const newerSecret = await db.secret.create({
      data: {
        userId: actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "encrypted-newer-key",
      },
    });
    const older = await db.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "duplicate-provider",
        label: "Older",
        secretId: olderSecret.id,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    });
    const newer = await db.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "duplicate-provider",
        label: "Newer",
        secretId: newerSecret.id,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    });
    await db.userModelPreference.create({
      data: { userId: actor.userId, credentialId: older.id, modelId: "older/model" },
    });

    await rpc(app, scope, "models/setDefault", {
      provider: "duplicate-provider",
      modelId: "newer/selected",
    });

    const preferences = await db.userModelPreference.findMany({
      where: { userId: actor.userId },
    });
    const main = await rpc<ModelRoleSettings>(app, scope, "models/role", { role: "main" });
    expect(main.primary).toMatchObject({ modelId: "newer/selected", credentialId: older.id });
    expect(preferences.find((row) => row.credentialId === older.id)).toMatchObject({
      modelId: "newer/selected",
    });
    expect(preferences.find((row) => row.credentialId === newer.id)).toBeUndefined();
    const listed = await rpc<ModelCredential[]>(app, scope, "models/credentials");
    expect(
      listed.filter((row) => row.provider === "duplicate-provider").map((row) => row.id),
    ).toEqual([newer.id, older.id]);
  });

  it("shows an organization's audit log only to its owners and admins, past deleted spaces", async () => {
    const owner = await testSpace(app, "Audit Owner");
    const outsider = await testSpace(app, "Audit Outsider");
    const account = await rpc<Actor>(app, owner, "me");
    const space = await rpc<Space>(app, owner, "spaces/create", { name: "Client A" });
    await rpc(app, owner, "spaces/remove", { spaceId: space.id });

    type Page = { events: Array<{ action: string; spaceName: string | null }> };
    const actions = (page: Page) => page.events.map((event) => event.action);
    const ownLog = await rpc<Page>(app, owner, "audit/events", { spaceId: space.id });
    expect(actions(ownLog)).toEqual(["space.deleted", "space.created"]);
    expect(ownLog.events[0]?.spaceName).toBe("Client A");
    expect(actions(await rpc<Page>(app, outsider, "audit/events", { spaceId: space.id }))).toEqual(
      [],
    );
    const exported = await app.request("/api/audit-events/export", {
      headers: { ...testSpaceHeaders(owner) },
    });
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain('"action":"space.created"');

    await db.member.updateMany({ where: { userId: account.userId }, data: { role: "member" } });
    await expectForbidden(app, owner, "audit/events", {});
    expect(
      (await app.request("/api/audit-events/export", { headers: { ...testSpaceHeaders(owner) } }))
        .status,
    ).toBe(403);
  });
});

function botInput(name: string) {
  return {
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  };
}

function routineInput(botId: string) {
  return {
    botId,
    name: "Owner Routine",
    prompt: "owner-only prompt",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    notify: false,
    active: false,
  };
}

function skillPlaybookInput() {
  return {
    whenToUse: "When needed",
    inputs: ["example"],
    steps: ["Do the thing"],
    howToCheck: "Verify result",
    whatToReturn: "Summary",
    approvalBoundaries: "Ask first",
    failureHandling: "Stop and ask",
  };
}

function capabilityInput(name: string): RpcInput<"capabilities/install"> {
  return { kind: "skill", name, source: "test://authorization", config: {} };
}

function connectionInput(displayName: string) {
  return { provider: "SLACK", displayName };
}

async function testSpace(app: App, name = "Test") {
  return createTestSpace(app, name);
}

async function raw(
  app: App,
  scope: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(scope ? testSpaceHeaders(scope) : {}),
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body ?? {} }),
  });
}

async function rpc<T>(
  app: App,
  scope: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await raw(app, scope, procedure, body, spaceId);
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, scope, procedure, payload.json as T);
}

async function expectDenied(
  app: App,
  scope: string,
  procedure: string,
  body: unknown,
  spaceId?: string,
) {
  const response = await raw(app, scope, procedure, body, spaceId);
  if (procedure === "threads/subscribe" && response.status === 200) {
    // Streaming transports commit the HTTP 200 before advancing the async iterator. The
    // ownership error is therefore encoded in the iterator response instead of the status.
    expect(await response.text(), procedure).toMatch(/error|forbidden|not.found|unauthorized/i);
    return;
  }
  expect(response.status, procedure).toBeGreaterThanOrEqual(400);
}

async function expectForbidden(app: App, scope: string, procedure: string, body: unknown) {
  const response = await raw(app, scope, procedure, body);
  expect(response.status, procedure).toBe(403);
  expect(await response.text(), procedure).toMatch(/forbidden/i);
}

interface Actor {
  userId: string;
  spaceId: string;
  isDeploymentOwner: boolean;
}

interface ModelRoleSettings {
  primary: { provider: string; modelId: string; credentialId?: string } | null;
}

interface ModelCredential {
  headerNames?: string[];
  id: string;
  provider: string;
  label: string;
  hasKey: boolean;
  isDefault: boolean;
}

interface Bot {
  id: string;
  name: string;
}
