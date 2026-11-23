import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposioConnector,
  DestinationEmulator,
  FakeComposioClient,
  listPiCatalog,
} from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestSpace, testSpaceHeaders } from "./index.js";

import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;
type Snapshot = {
  run: { id: string; status: string } | null;
  activeRuns?: Array<{ id: string; status: string; trigger?: string }>;
  messages: Array<{
    id: string;
    runId?: string | null;
    blocks: Array<{
      kind?: string;
      status?: string;
      result?: string;
      approvalEffectId?: string;
      helper?: { messageId?: string; name?: string };
      agentId?: string;
      task?: string;
    }>;
  }>;
};

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

/**
 * A background helper that needs approval asks in the chat that started it while its run stays
 * on the helper's own thread: the owner answers there, the action runs once, and stop or clear
 * ends the helper and its pending effect.
 */
describeWithDatabase("background helper approval", () => {
  let handles: AppHandles;
  let app: App;
  let prisma: AppHandles["prisma"];
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-helper-approval-"));
  const connector = new DestinationEmulator();

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      modelConnectionFetch: createModelConnectionFixtureFetch(listPiCatalog()),
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      // A helper is enqueued from inside its parent run, so a run is resident when its job
      // arrives. The in-memory queue dispatches it directly; the durable publisher hands it to
      // a worker this isolated process does not have.
      wakeupDriver: "memory",
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
      connectors: [connector],
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  let _chiefs = 0;

  async function newChief(label: string) {
    // The sign-in address is its own nonce: the label is only the person's display name.
    _chiefs += 1;
    const scope = await testSpace(app, label);
    const bot = await rpc<{ id: string }>(app, scope, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const chat = await prisma.thread.findUniqueOrThrow({
      where: { botId: bot.id },
      select: { id: true },
    });
    return { scope, bot, chat };
  }

  /** `bots/create` starts an intro turn; the chat's own send must not land inside it. */
  async function waitForQuietBot(botId: string) {
    await waitFor(
      async () =>
        (await prisma.run.count({
          where: { botId, status: { in: ["queued", "leased", "running"] } },
        })) === 0,
      "the bot's creation intro finishes",
    );
  }

  /**
   * What the bot's runs, card and effects looked like when the helper wait gave up. The failure
   * carries it instead of waiting longer, so a stopped helper is read from its own row.
   */
  async function helperStartReport(botId: string) {
    const runs = await prisma.run.findMany({
      where: { botId },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        trigger: true,
        status: true,
        error: true,
        sourceMessageId: true,
        threadId: true,
        wakeAt: true,
        leaseOwner: true,
        // A claim bumps the fence even when the run is immediately requeued for its computer.
        leaseFence: true,
        updatedAt: true,
        task: { select: { prompt: true } },
      },
    });
    const [card, effects, helperAttempts] = await Promise.all([
      prisma.message.findFirst({
        where: { botId, blocks: { array_contains: [{ kind: "subagent" }] } },
        select: { id: true, threadId: true, blocks: true },
      }),
      prisma.externalEffect.findMany({
        where: { runId: { in: runs.map((run) => run.id) } },
        select: { id: true, runId: true, kind: true, status: true },
      }),
      prisma.attempt.count({ where: { run: { botId, trigger: "helper" } } }),
    ]);
    // Which queue held the job, and whether any of its handlers threw: a helper run that never
    // leaves queued is either a job that threw or one that was never dispatched.
    const queue = {
      driver: process.env.WAKEUP_DRIVER,
      publisher: handles.jobs?.constructor?.name,
      failures: handles.backgroundFailures?.() ?? null,
    };
    return { runs, card, effects, helperAttempts, queue };
  }

  /** The parent turn starts a background helper; the helper's own task needs a write approval. */
  async function startWaitingHelper(scope: string, botId: string) {
    await waitForQuietBot(botId);
    const sent = await rpc<{ runId: string }>(app, scope, "threads/send", {
      botId,
      text: "write the destination crm note in the background",
    });
    await waitFor(
      async () =>
        (await prisma.run.findUnique({ where: { id: sent.runId }, select: { status: true } }))
          ?.status === "completed",
      "the chat's own turn completes while its helper keeps working",
    );
    let helper = null as { id: string; threadId: string } | null;
    try {
      await waitFor(async () => {
        helper = await prisma.run.findFirst({
          where: { botId, trigger: "helper", status: "waiting_input" },
          orderBy: { createdAt: "desc" },
          select: { id: true, threadId: true },
        });
        return Boolean(helper);
      }, "the helper pauses for approval");
    } catch (error) {
      const report = await helperStartReport(botId);
      throw new Error(`${(error as Error).message}: ${JSON.stringify(report)}`);
    }
    return helper!;
  }

  function helperAskIn(snapshot: Snapshot, runId: string) {
    return snapshot.messages.find(
      (message) =>
        message.runId === runId &&
        message.blocks.some((block) => block.kind === "ask" && block.approvalEffectId),
    );
  }

  function helperCardIn(snapshot: Snapshot) {
    return snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "subagent"),
    );
  }

  async function thread(scope: string, botId: string) {
    return rpc<Snapshot>(app, scope, "threads/get", { botId });
  }

  async function groupThread(scope: string, groupId: string) {
    return rpc<Snapshot & { threadId: string }>(app, scope, "threads/get", { groupId });
  }

  it("asks the owner in the chat and runs the approved write exactly once", async () => {
    const { scope, bot, chat } = await newChief("Helper Allow");
    const helper = await startWaitingHelper(scope, bot.id);
    const written = connector.records.length;

    const waiting = await thread(scope, bot.id);
    const ask = helperAskIn(waiting, helper.id);
    const card = helperCardIn(waiting);
    expect(ask).toBeDefined();
    expect(card).toBeDefined();
    // The card is a message of the chat, not of the helper's own thread.
    expect(await prisma.message.count({ where: { id: card!.id, threadId: chat.id } })).toBe(1);
    // Its run is the helper's, and the entry is what makes the card answerable here.
    expect(waiting.activeRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: helper.id, status: "waiting_input", trigger: "helper" }),
      ]),
    );
    expect(waiting.run?.id).not.toBe(helper.id);
    // Every helper ask names the card it belongs to, so a settled card ends the wait.
    expect(ask!.blocks.find((block) => block.kind === "ask")?.helper).toMatchObject({
      messageId: card!.id,
      name: "helper",
    });
    expect(card!.blocks.find((block) => block.kind === "subagent")?.status).toBe("waiting");
    // Nothing ran yet, and waiting on a person holds no computer. The pause leaves an
    // expired lease tombstone so the next acquisition still increments its fence.
    expect(connector.records).toHaveLength(written);
    expect(
      await prisma.computerExecutionLease.count({
        where: { runId: helper.id, expiresAt: { gt: new Date() } },
      }),
    ).toBe(0);

    await rpc(app, scope, "threads/answer", {
      botId: bot.id,
      runId: helper.id,
      messageId: ask!.id,
      answer: "allow",
    });
    await waitFor(
      async () =>
        (await prisma.run.findUnique({ where: { id: helper.id }, select: { status: true } }))
          ?.status === "completed",
      "the approved helper finishes",
    );

    expect(connector.records).toHaveLength(written + 1);
    await waitFor(async () => {
      const settled = await thread(scope, bot.id);
      return (
        helperCardIn(settled)?.blocks.find((block) => block.kind === "subagent")?.status ===
        "completed"
      );
    }, "the helper's card settles as completed");
    // The approved card is spent: answering it again is refused, so nothing runs twice.
    const again = await raw(app, scope, "threads/answer", {
      botId: bot.id,
      runId: helper.id,
      messageId: ask!.id,
      answer: "allow",
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(connector.records).toHaveLength(written + 1);

    const settled = await thread(scope, bot.id);
    expect(settled.activeRuns ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: helper.id })]),
    );
    // The helper's result comes back as the chat's own new turn.
    await waitFor(
      async () =>
        (await prisma.run.count({ where: { threadId: chat.id, trigger: "helper_result" } })) === 1,
      "the helper's result returns to the chat",
    );
  });

  it("keeps the chat free while the helper waits and records a denied answer", async () => {
    const { scope, bot, chat } = await newChief("Helper Deny");
    const helper = await startWaitingHelper(scope, bot.id);
    const written = connector.records.length;
    const ask = helperAskIn(await thread(scope, bot.id), helper.id);

    // The chat answers its own person meanwhile: a helper's wait never queues the main bot.
    const meanwhile = await rpc<{ runId: string }>(app, scope, "threads/send", {
      botId: bot.id,
      text: "say hello",
    });
    await waitFor(
      async () =>
        (await prisma.run.findUnique({ where: { id: meanwhile.runId }, select: { status: true } }))
          ?.status === "completed",
      "the chat continues while its helper waits",
    );
    expect((await prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status).toBe(
      "waiting_input",
    );

    await rpc(app, scope, "threads/answer", {
      botId: bot.id,
      runId: helper.id,
      messageId: ask!.id,
      answer: "deny",
    });
    await waitFor(
      async () =>
        ["completed", "failed"].includes(
          (await prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status,
        ),
      "the denied helper ends",
    );
    expect(connector.records).toHaveLength(written);
    const effect = await prisma.externalEffect.findFirst({
      where: { runId: helper.id },
      select: { status: true },
    });
    expect(effect?.status).toBe("denied");
    // The helper still reports how it went; the denial is what keeps the write from happening.
    await waitFor(
      async () =>
        (await prisma.run.count({ where: { threadId: chat.id, trigger: "helper_result" } })) === 1,
      "the denied helper still returns its result to the chat",
    );
  });

  it("refuses another user, another chat, and a stale answer", async () => {
    const { scope, bot } = await newChief("Helper Refuse");
    const helper = await startWaitingHelper(scope, bot.id);
    const ask = helperAskIn(await thread(scope, bot.id), helper.id);
    const outsider = await testSpace(app, "Outsider");
    const outsiderBot = await rpc<{ id: string }>(app, outsider, "bots/create", {
      name: "Outsider",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });

    // Another person's chat cannot answer this helper, even naming its real run and card.
    const foreign = await raw(app, outsider, "threads/answer", {
      botId: outsiderBot.id,
      runId: helper.id,
      messageId: ask!.id,
      answer: "allow",
    });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    // The owner naming the wrong chat is refused too.
    const wrongChat = await raw(app, scope, "threads/answer", {
      botId: outsiderBot.id,
      runId: helper.id,
      messageId: ask!.id,
      answer: "allow",
    });
    expect(wrongChat.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status).toBe(
      "waiting_input",
    );
    expect(
      (
        await prisma.externalEffect.findFirst({
          where: { runId: helper.id },
          select: { status: true },
        })
      )?.status,
    ).toBe("intended");

    // The owner can still answer in their own chat afterwards.
    await rpc(app, scope, "threads/answer", {
      botId: bot.id,
      runId: helper.id,
      messageId: ask!.id,
      answer: "deny",
    });
    await waitFor(
      async () =>
        (await prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status !==
        "waiting_input",
      "the refused answers left the helper answerable to its owner",
    );
  });

  it("stops a waiting helper from its card and denies what it asked for", async () => {
    const { scope, bot } = await newChief("Helper Stop");
    const helper = await startWaitingHelper(scope, bot.id);
    const card = helperCardIn(await thread(scope, bot.id));

    await rpc(app, scope, "threads/stopHelper", {
      botId: bot.id,
      messageId: card!.id,
    });

    await waitFor(
      async () =>
        (await prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status === "cancelled",
      "the waiting helper is cancelled",
    );
    expect(
      (
        await prisma.externalEffect.findFirst({
          where: { runId: helper.id },
          select: { status: true },
        })
      )?.status,
    ).toBe("denied");
    const stopped = await thread(scope, bot.id);
    expect(helperCardIn(stopped)?.blocks.find((block) => block.kind === "subagent")).toMatchObject({
      status: "failed",
      result: "stopped",
    });
    // The card's ask is no longer answerable: its run is gone.
    expect(stopped.activeRuns ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: helper.id })]),
    );
  });

  it("clears a chat with a waiting helper and its pending effect", async () => {
    const { scope, bot } = await newChief("Helper Clear");
    const helper = await startWaitingHelper(scope, bot.id);

    await rpc(app, scope, "threads/clear", { botId: bot.id });

    await waitFor(
      async () =>
        (await prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status === "cancelled",
      "clearing the chat cancels its waiting helper",
    );
    expect(
      (
        await prisma.externalEffect.findFirst({
          where: { runId: helper.id },
          select: { status: true },
        })
      )?.status,
    ).toBe("denied");
    const cleared = await thread(scope, bot.id);
    expect(cleared.activeRuns ?? []).toEqual([]);
    expect(cleared.messages).toEqual([]);
  });

  it("clears a group chat's waiting helpers, whichever member started them", async () => {
    const scope = await testSpace(app, "Group Helpers");
    const createBot = (name: string) =>
      rpc<{ id: string }>(app, scope, "bots/create", {
        name,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
    const alpha = await createBot("Alpha");
    const beta = await createBot("Beta");
    const group = await rpc<{ id: string }>(app, scope, "groups/create", {
      name: "Helper group",
      botIds: [alpha.id, beta.id],
    });
    const sent = await rpc<{ runIds?: string[]; runId: string }>(app, scope, "threads/send", {
      groupId: group.id,
      text: "write the destination crm note in the background",
    });
    const parentRuns = sent.runIds ?? [sent.runId];
    await waitFor(
      async () =>
        (await prisma.run.count({ where: { id: { in: parentRuns }, status: "completed" } })) ===
        parentRuns.length,
      "each group member finishes its own turn",
    );
    const groupThreadId = (await groupThread(scope, group.id)).threadId;

    let helpers: Array<{ id: string }> = [];
    await waitFor(async () => {
      helpers = await prisma.run.findMany({
        where: {
          trigger: "helper",
          status: "waiting_input",
          sourceMessage: { threadId: groupThreadId },
        },
        select: { id: true },
      });
      return helpers.length === parentRuns.length;
    }, "each member's helper waits in the group");

    await rpc(app, scope, "threads/clear", { groupId: group.id });

    for (const helper of helpers) {
      await waitFor(
        async () =>
          (await prisma.run.findUniqueOrThrow({ where: { id: helper.id } })).status === "cancelled",
        "clearing the group cancels every helper it started",
      );
      expect(
        (
          await prisma.externalEffect.findFirst({
            where: { runId: helper.id },
            select: { status: true },
          })
        )?.status,
      ).toBe("denied");
    }
    const cleared = await groupThread(scope, group.id);
    expect(cleared.activeRuns ?? []).toEqual([]);
  });
});

async function testSpace(app: App, name = "Test") {
  return createTestSpace(app, name);
}

async function raw(app: App, scope: string, proc: string, body: unknown = {}) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...testSpaceHeaders(scope),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function rpc<T>(app: App, scope: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, scope, proc, body);
  const text = await res.text();
  let parsed: { json?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  } catch {
    throw new Error(`${proc} ${res.status}: ${text}`);
  }
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function waitFor(pred: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting until ${what}`);
}
