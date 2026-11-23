import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { Bot, BotTemplateListing, MessageBlock } from "@rakazo/contracts";
import { BOT_TEMPLATE_CHANGED } from "@rakazo/contracts";
import { buildSkillMd, findBotTemplate } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestSpace, testSpaceHeaders } from "./index.js";

import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Created = { bot: Bot; created: boolean };

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;

const briefing = findBotTemplate("morning-briefing")!;
const triage = findBotTemplate("inbox-triage")!;

describeIntegration("bot templates", () => {
  let app: App;
  let db: PrismaClient;
  let stop: () => Promise<void>;
  const composio = new ComposioConnector({ client: new FakeComposioClient() });
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-bot-templates-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      composio,
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.agentSkill.deleteMany();
  });

  it("creates the bot, its skill and a paused routine, and asks only for missing apps", async () => {
    const scope = await testSpace(app, "Test");
    const owner = await ownerOf(scope);
    // Gmail is already connected, so only the calendar is asked for.
    await composio.begin(
      { provider: "gmail", redirectUrl: "http://127.0.0.1.invalid/callback" },
      {
        operationId: "template-test",
        traceId: "template-test",
        ...owner,
        signal: new AbortController().signal,
      },
    );

    const before = await rpc<BotTemplateListing[]>(app, scope, "bots/templates");
    expect(before.find((item) => item.id === briefing.id)).toEqual({ ...briefing, botId: null });

    const { bot, created } = await rpc<Created>(app, scope, "bots/createFromTemplate", {
      templateId: briefing.id,
      version: briefing.version,
    });
    expect(created).toBe(true);
    expect([bot.name, bot.description, bot.instructions]).toEqual([
      briefing.name,
      briefing.description,
      briefing.instructions,
    ]);

    const skills = await db.agentSkill.findMany({ where: owner });
    expect(skills.map((row) => [row.name, row.content, row.source])).toEqual([
      ["Morning briefing", buildSkillMd(briefing.skills[0]!), "user"],
    ]);
    const routines = await db.routine.findMany({ where: { botId: bot.id } });
    expect(routines.map((row) => [row.name, row.prompt, row.crons, row.active])).toEqual([
      ["Morning briefing", briefing.routines[0]!.prompt, ["30 7 * * 1-5"], false],
    ]);
    expect(routines[0]!.nextRunAt).toBeNull();
    // Nothing runs for the user: no intro, and no routine until they turn it on.
    expect(await db.run.count({ where: { botId: bot.id } })).toBe(0);

    const messages = await db.message.findMany({
      where: { threadId: bot.threadId! },
      orderBy: { createdAt: "asc" },
    });
    const blocks = messages.flatMap((message) => message.blocks as MessageBlock[]);
    expect(blocks.map((block) => block.kind)).toEqual(["app_connect", "import_setup"]);
    expect(blocks[0]).toMatchObject({ kind: "app_connect", name: "Google Calendar" });
    expect(blocks[1]).toEqual({
      kind: "import_setup",
      items: [{ kind: "routine", routineId: routines[0]!.id, name: "Morning briefing" }],
    });

    const after = await rpc<BotTemplateListing[]>(app, scope, "bots/templates");
    expect(after.find((item) => item.id === briefing.id)?.botId).toBe(bot.id);
    expect(await db.agentImport.findMany({ where: owner, select: { source: true } })).toEqual([
      { source: "template" },
    ]);
  });

  it("returns the existing bot on a repeat, even from an older preview, until it is deleted", async () => {
    const scope = await testSpace(app, "Test");
    const owner = await ownerOf(scope);
    const input = { templateId: triage.id, version: triage.version };

    const stale = await raw(app, scope, "bots/createFromTemplate", { ...input, version: 999 });
    expect(stale.status).toBe(412);
    expect(JSON.stringify(await stale.json())).toContain(BOT_TEMPLATE_CHANGED);
    expect(await db.bot.count({ where: owner })).toBe(0);

    const results = await Promise.all([
      rpc<Created>(app, scope, "bots/createFromTemplate", input),
      rpc<Created>(app, scope, "bots/createFromTemplate", input),
    ]);
    expect(results[0]!.bot.id).toBe(results[1]!.bot.id);
    const again = await rpc<Created>(app, scope, "bots/createFromTemplate", {
      ...input,
      version: 999,
    });
    expect([again.bot.id, again.created]).toEqual([results[0]!.bot.id, false]);
    expect(await db.bot.count({ where: owner })).toBe(1);
    expect(await db.routine.count({ where: owner })).toBe(1);

    // An archived bot no longer counts: the listing offers Create, which makes a new bot.
    await rpc(app, scope, "bots/archive", { botId: again.bot.id });
    const listed = await rpc<BotTemplateListing[]>(app, scope, "bots/templates");
    expect(listed.find((item) => item.id === triage.id)?.botId).toBeNull();
    // A refused create keeps the archived bot's record, so restoring it brings it back as Open.
    expect(
      (await raw(app, scope, "bots/createFromTemplate", { ...input, version: 999 })).status,
    ).toBe(412);
    await rpc(app, scope, "bots/restore", { botId: again.bot.id });
    const restored = await rpc<BotTemplateListing[]>(app, scope, "bots/templates");
    expect(restored.find((item) => item.id === triage.id)?.botId).toBe(again.bot.id);
    await rpc(app, scope, "bots/archive", { botId: again.bot.id });
    const replacement = await rpc<Created>(app, scope, "bots/createFromTemplate", input);
    expect(replacement.created).toBe(true);
    expect(replacement.bot.id).not.toBe(again.bot.id);
    const repeated = await rpc<Created>(app, scope, "bots/createFromTemplate", input);
    expect([repeated.bot.id, repeated.created]).toEqual([replacement.bot.id, false]);

    await rpc(app, scope, "bots/remove", { botId: replacement.bot.id });
    const fresh = await rpc<Created>(app, scope, "bots/createFromTemplate", input);
    expect(fresh.created).toBe(true);
    expect(fresh.bot.id).not.toBe(replacement.bot.id);
    // Each new copy reuses the unchanged skill the first one added instead of adding another.
    const skills = await db.agentSkill.findMany({ where: owner, select: { name: true } });
    expect(skills.map((row) => row.name)).toEqual(["Inbox triage"]);
    const routine = await db.routine.findFirstOrThrow({ where: { botId: fresh.bot.id } });
    expect(routine.prompt).toBe("Triage my new email with @Inbox triage.");
  });

  it("renames its skill on a clash and points the routine at the new name", async () => {
    const scope = await testSpace(app, "Test");
    const existing = buildSkillMd({ name: "Inbox triage", description: "Mine", body: "Mine." });
    await rpc(app, scope, "agentSkills/create", { content: existing });
    // The name the preview showed in the user's language is the one the bot gets.
    const { bot } = await rpc<Created>(app, scope, "bots/createFromTemplate", {
      templateId: triage.id,
      version: triage.version,
      name: "Posteingang sortieren",
    });
    expect(bot.name).toBe("Posteingang sortieren");
    const owner = await ownerOf(scope);
    const skills = await db.agentSkill.findMany({ where: owner, orderBy: { name: "asc" } });
    expect(skills.map((row) => row.name)).toEqual(["Inbox triage", "Inbox triage-2"]);
    expect(skills[0]!.content).toBe(existing);
    const routine = await db.routine.findFirstOrThrow({ where: { botId: bot.id } });
    expect(routine.prompt).toBe("Triage my new email with @Inbox triage-2.");

    // Made again after the first copy goes, it reuses the renamed, unchanged skill.
    await rpc(app, scope, "bots/remove", { botId: bot.id });
    const again = await rpc<Created>(app, scope, "bots/createFromTemplate", {
      templateId: triage.id,
      version: triage.version,
    });
    const after = await db.agentSkill.findMany({ where: owner, orderBy: { name: "asc" } });
    expect(after.map((row) => row.name)).toEqual(["Inbox triage", "Inbox triage-2"]);
    const next = await db.routine.findFirstOrThrow({ where: { botId: again.bot.id } });
    expect(next.prompt).toBe("Triage my new email with @Inbox triage-2.");
  });

  it("writes nothing when the last write fails", async () => {
    const scope = await testSpace(app, "Test");
    const owner = await ownerOf(scope);
    const count = async () => ({
      bots: await db.bot.count({ where: owner }),
      routines: await db.routine.count({ where: owner }),
      skills: await db.agentSkill.count({ where: owner }),
      imports: await db.agentImport.count({ where: owner }),
    });
    const before = await count();
    const ownerDb = createDb(process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!);
    await ownerDb.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION bot_template_test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
    await ownerDb.prisma.$executeRawUnsafe(
      `CREATE TRIGGER bot_template_test_fail BEFORE INSERT ON agent_imports
       FOR EACH ROW EXECUTE FUNCTION bot_template_test_fail()`,
    );
    try {
      const response = await raw(app, scope, "bots/createFromTemplate", {
        templateId: briefing.id,
        version: briefing.version,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      await ownerDb.prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS bot_template_test_fail ON agent_imports",
      );
      await ownerDb.prisma.$disconnect();
    }
    expect(await count()).toEqual(before);
  });

  async function ownerOf(scope: string) {
    const me = await rpc<{ userId: string; spaceId: string }>(app, scope, "me");
    return { spaceId: me.spaceId, userId: me.userId };
  }
});

async function testSpace(app: App, name = "Test") {
  return createTestSpace(app, name);
}

async function rpc<T>(app: App, scope: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, scope, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function raw(app: App, scope: string, proc: string, body: unknown) {
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
