import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedSecretStore } from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import type { PageDetail, PageSummary, ThreadSnapshot } from "@rakazo/contracts";
import { SHARED_PAGE_PATH_PREFIX } from "@rakazo/contracts";
import { deletePageShareSecrets } from "@rakazo/db";
import { pageViewerCode } from "@rakazo/page-kit/compile";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { createTestSpace, testSpaceHeaders } from "./index.js";

import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describePages = hasDb ? describe : describe.skip;
let harness: BotIntroHarness | undefined;

const page = (heading: string) =>
  `const App = () => (\n  <Page title="${heading}">\n    <Metrics metrics={[{ value: "42", label: "Users" }]} />\n  </Page>\n);\nexport default App;\n`;

describePages("pages", () => {
  let app: App;
  let stop: () => Promise<void>;
  let jobs: Awaited<ReturnType<typeof createApp>>["jobs"];

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: mkdtempSync(path.join(tmpdir(), "rakazo-pages-")),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    stop = handles.stop;
    jobs = handles.jobs;
    harness = handles;
  });

  afterAll(async () => {
    await stop?.();
  });

  const db = () => asSystem(harness!.prisma);

  /**
   * Runs `during` while this test holds the page's row lock; `waitFor(n)` returns once n other
   * sessions are queued behind this transaction, directly or behind each other, so a race is
   * forced rather than left to timing. Waits elsewhere in the shared database never count.
   */
  async function holdingPageRow<T>(
    pageId: string,
    during: (
      waitFor: (count: number) => Promise<void>,
      tx: Parameters<Parameters<ReturnType<typeof db>["$transaction"]>[0]>[0],
    ) => Promise<T>,
  ): Promise<T> {
    return db().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM pages WHERE id = ${pageId} FOR UPDATE`;
        const [held] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const waitFor = async (count: number) => {
          for (let tries = 0; tries < 800; tries++) {
            const [row] = await db().$queryRaw<{ waiting: number }[]>`
              WITH RECURSIVE queued(pid) AS (
                SELECT pid FROM pg_stat_activity WHERE ${held!.pid}::int = ANY(pg_blocking_pids(pid))
                UNION
                SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
              )
              SELECT count(*)::int AS waiting FROM queued`;
            if ((row?.waiting ?? 0) >= count) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error(`${count} writers never queued behind the held page row`);
        };
        return during(waitFor, tx);
      },
      { timeout: 30_000 },
    );
  }
  const lastResult = async (botId: string) => {
    const effect = await db().externalEffect.findFirst({
      where: { kind: "save_page", run: { botId } },
      orderBy: { createdAt: "desc" },
      select: { result: true },
    });
    return effect?.result as Record<string, unknown> | undefined;
  };

  it("saves, edits and guards pages through the bot's save_page", async () => {
    const scope = await testSpace(app, "Page Owner");
    const bot = await createBot(app, scope, "Reporter");
    const save = (args: unknown, botId = bot.id, as = scope) =>
      sendAndWait(app, as, botId, { text: `call save_page with ${JSON.stringify(args)}` });

    await save({ help: true });
    expect((await lastResult(bot.id))?.guide).toContain("export default");

    // A page that fails the kit check is never stored; the bot gets line-numbered problems.
    await save({ title: "Broken", source: "const App = () => <Card />;\nexport default App;\n" });
    expect((await lastResult(bot.id))?.problems).toEqual([
      expect.stringMatching(/^line 1: <Card> is not a kit component/),
    ]);
    expect(await db().page.count({ where: { userId: (await me(app, scope)).id } })).toBe(0);

    await save({ title: "Weekly KPIs", source: page("First") });
    const created = (await lastResult(bot.id)) as { pageId: string; version: number };
    expect(created).toMatchObject({ version: 1, title: "Weekly KPIs" });
    const { pageId } = created;

    // Edits apply together into one version, or not at all.
    await save({
      pageId,
      edits: [
        { find: 'title="First"', replace: 'title="Second"' },
        { find: 'value: "42"', replace: 'value: "43"' },
      ],
    });
    expect(await lastResult(bot.id)).toEqual({
      pageId,
      version: 2,
      title: "Weekly KPIs",
      mention: `Mention it in your reply as [Weekly KPIs](page:${pageId})`,
    });
    await save({
      pageId,
      edits: [
        { find: 'title="Second"', replace: 'title="Third"' },
        { find: "Page", replace: "Sheet" },
      ],
    });
    expect(await lastResult(bot.id)).toMatchObject({
      error: expect.stringMatching(/^Edit 2: find text occurs more than once/),
    });
    await save({ pageId, edits: [{ find: "not in the page", replace: "x" }] });
    expect(await lastResult(bot.id)).toMatchObject({ error: expect.stringMatching(/^Edit 1: /) });
    // Edits whose result fails the kit check write nothing either.
    await save({ pageId, edits: [{ find: "<Metrics", replace: "<Card" }] });
    expect((await lastResult(bot.id))?.problems).toBeDefined();

    // A later save may rename the page.
    await save({ pageId, title: "KPIs", source: page("Fourth") });
    expect(await lastResult(bot.id)).toEqual({
      pageId,
      version: 3,
      title: "KPIs",
      mention: `Mention it in your reply as [KPIs](page:${pageId})`,
    });
    // A page that saves but has a likely mistake carries the kit's warnings back to the bot.
    const helper = await createBot(app, scope, "Helper");
    const scratch = `const note = "Q&amp;A";\n${page("Scratch")}`;
    await save({ title: "Scratch [draft]", source: scratch }, helper.id);
    const scratchResult = await lastResult(helper.id);
    expect(scratchResult?.mention).toBe(
      `Mention it in your reply as [Scratch \\[draft\\]](page:${scratchResult?.pageId})`,
    );
    expect(scratchResult).toMatchObject({
      version: 1,
      warnings: [expect.stringMatching(/^line 1: &amp;/)],
    });
    await save({ pageId });
    expect(await lastResult(bot.id)).toMatchObject({ version: 3, source: page("Fourth") });

    // Another account cannot read or write it by id.
    const otherCookie = await testSpace(app, "Other");
    const intruder = await createBot(app, otherCookie, "Intruder");
    await save({ pageId, source: page("Stolen") }, intruder.id, otherCookie);
    expect(await lastResult(intruder.id)).toMatchObject({ error: expect.any(String) });
    await save({ pageId }, intruder.id, otherCookie);
    expect(await lastResult(intruder.id)).not.toHaveProperty("source");

    // Every save is kept as its own version.
    expect(
      (
        await db().pageVersion.findMany({
          where: { pageId },
          orderBy: { version: "desc" },
          select: { version: true, title: true },
        })
      ).map((v) => [v.version, v.title]),
    ).toEqual([
      [3, "KPIs"],
      [2, "Weekly KPIs"],
      [1, "Weekly KPIs"],
    ]);
    const second = await rpc<PageDetail>(app, scope, "pages/get", { pageId, version: 2 });
    // Read back compiled for the viewer.
    expect(second.code).toMatch(/React\.createElement\(Page, \{ title: "Second".*"43"/s);
    expect(second).toMatchObject({ version: 2, currentVersion: 3, title: "KPIs", botId: bot.id });

    // Each save posted a page block in the chat it was saved from, never a file.
    const blocks = async (botId: string) =>
      (await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId })).messages.flatMap(
        (message) => message.blocks.filter((b) => b.kind === "page" || b.kind === "file"),
      );
    expect(await blocks(bot.id)).toEqual([
      { kind: "page", pageId, version: 1, title: "Weekly KPIs" },
      { kind: "page", pageId, version: 2, title: "Weekly KPIs" },
      { kind: "page", pageId, version: 3, title: "KPIs" },
    ]);
    expect(await blocks(helper.id)).toEqual([
      { kind: "page", pageId: expect.any(String), version: 1, title: "Scratch [draft]" },
    ]);
    expect(await rpc(app, scope, "artifacts/listSpace", {})).toMatchObject({ items: [] });

    // A message sent from the open page replies to its card: the bot reads the page's id and
    // version, never just its title as a quote.
    const cardMessage = (
      await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id })
    ).messages.find((message) => message.blocks.some((block) => block.kind === "page"))!;
    await rpc(app, scope, "threads/send", {
      botId: bot.id,
      text: "make the numbers bigger",
      replyToMessageId: cardMessage.id,
      fromPage: true,
    });
    // A reply picked on the card in the chat quotes it as any reply does.
    await rpc(app, scope, "threads/send", {
      botId: bot.id,
      text: "what is this?",
      replyToMessageId: cardMessage.id,
    });
    const replies = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id });
    const sent = (text: string) =>
      replies.messages.find((message) =>
        message.blocks.some((block) => block.kind === "text" && block.text === text),
      );
    expect(sent("make the numbers bigger")).toMatchObject({ replyPreview: { page: true } });
    expect(sent("make the numbers bigger")?.replyQuote).toBeUndefined();
    expect(sent("what is this?")).toMatchObject({
      replyPreview: { page: true },
      replyQuote: expect.stringContaining("KPIs"),
    });
  });

  it("keeps a page to the bot that made it, in any of its chats, and to its group", async () => {
    const scope = await testSpace(app, "Scope Owner");
    const maker = await createBot(app, scope, "Maker");
    const other = await createBot(app, scope, "Other");
    const save = (botId: string, args: unknown) =>
      sendAndWait(app, scope, botId, { text: `call save_page with ${JSON.stringify(args)}` });
    await save(maker.id, { title: "Private plan", source: page("Mine") });
    const { pageId } = (await lastResult(maker.id)) as { pageId: string };
    const group = await rpc<{ id: string; threadId: string }>(app, scope, "groups/create", {
      name: "Desk",
      botIds: [maker.id, other.id],
    });
    const inGroup = async (bot: { id: string }, name: string, args: unknown) => {
      const before = await db().run.count({ where: { threadId: group.threadId, botId: bot.id } });
      await rpc(app, scope, "threads/send", {
        groupId: group.id,
        text: `@${name} call save_page with ${JSON.stringify(args)}`,
        mentions: [{ kind: "bot", id: bot.id }],
      });
      await expect
        .poll(
          () =>
            db().run.count({
              where: {
                threadId: group.threadId,
                botId: bot.id,
                status: { in: ["completed", "failed", "cancelled"] },
              },
            }),
          { timeout: 20_000, interval: 100 },
        )
        .toBe(before + 1);
      return lastResult(bot.id);
    };

    // Another bot of the same user is told the page does not exist, as for a made-up id, and
    // gets neither its source nor a new version in.
    await save(other.id, { pageId: "no-such-page" });
    const notFound = await lastResult(other.id);
    expect(notFound).toEqual({ error: expect.any(String) });
    await save(other.id, { pageId });
    expect(await lastResult(other.id)).toEqual(notFound);
    await save(other.id, { pageId, source: page("Stolen") });
    expect(await lastResult(other.id)).toEqual(notFound);
    expect(await inGroup(other, "Other", { pageId })).toEqual(notFound);

    // The bot that made it reaches it from another of its chats.
    expect(await inGroup(maker, "Maker", { pageId })).toMatchObject({
      version: 1,
      source: page("Mine"),
    });
    expect(
      await inGroup(maker, "Maker", { pageId, edits: [{ find: "Mine", replace: "Ours" }] }),
    ).toMatchObject({ pageId, version: 2 });

    // A page made in the group is the group's: its other bots reach it there, but not outside.
    const made = await inGroup(maker, "Maker", { title: "Group plan", source: page("Desk") });
    const groupPageId = made!.pageId as string;
    expect(await inGroup(other, "Other", { pageId: groupPageId })).toMatchObject({
      version: 1,
      source: page("Desk"),
    });
    await save(other.id, { pageId: groupPageId });
    expect(await lastResult(other.id)).toEqual(notFound);
    expect(await db().pageVersion.count({ where: { pageId } })).toBe(2);
  });

  it("shows a routine's new page once and refreshes it each run without a new card", async () => {
    const scope = await testSpace(app, "Routine Owner");
    const bot = await createBot(app, scope, "Refresher");
    const routine = await rpc<{ id: string }>(app, scope, "routines/create", {
      botId: bot.id,
      name: "Hourly board",
      prompt: `call save_page with ${JSON.stringify({ title: "Hourly board", source: page("v1") })}`,
      crons: ["0 * * * *"],
      timezone: "UTC",
      notify: true,
      active: true,
    });
    const fired = new Set<string>();
    const fire = async () => {
      const dueAt = new Date(Date.now() - 1_000);
      await db().routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
      await jobs.enqueue({
        name: "routine.wakeup",
        payload: { routineId: routine.id, scheduledFor: dueAt.toISOString() },
      });
      for (let tries = 0; tries < 200; tries++) {
        const run = await db().run.findFirst({
          where: { routineId: routine.id, status: { in: ["completed", "failed", "cancelled"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true },
        });
        if (run && !fired.has(run.id)) {
          fired.add(run.id);
          expect(run.status).toBe("completed");
          return db().message.findMany({ where: { runId: run.id }, select: { blocks: true } });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("the routine never ran");
    };

    // The first save is news: the page's card arrives in the chat.
    const first = await fire();
    expect(JSON.stringify(first)).toContain('"kind":"page"');
    const { pageId } = (await lastResult(bot.id)) as { pageId: string };

    // Later runs edit it in place; one with nothing to report stays silent.
    await db().routine.update({
      where: { id: routine.id },
      data: {
        prompt: `call save_page with ${JSON.stringify({ pageId, edits: [{ find: 'title="v1"', replace: 'title="v2"' }] })}\nthen say NO_RESPONSE`,
      },
    });
    expect(await fire()).toEqual([]);
    expect(await lastResult(bot.id)).toMatchObject({ pageId, version: 2 });
    expect(
      await db().pageVersion.findFirst({ where: { pageId, version: 2 }, select: { source: true } }),
    ).toMatchObject({ source: expect.stringContaining('title="v2"') });
  });

  it("lists, renames, pins, shares and removes pages only for their owner", async () => {
    const scope = await testSpace(app, "Library Owner");
    const bot = await createBot(app, scope, "Librarian");
    const other = await createBot(app, scope, "Other bot");
    const ids: string[] = [];
    for (const [botId, title] of [
      [bot.id, "Oldest"],
      [bot.id, "Middle"],
      [bot.id, "Newest"],
      [other.id, "Elsewhere"],
    ] as const) {
      await sendAndWait(app, scope, botId, {
        text: `call save_page with ${JSON.stringify({ title, source: page(title) })}`,
      });
      ids.push((await lastResult(botId))!.pageId as string);
    }
    const [oldest, middle, newest] = ids;
    const titles = (items: PageSummary[]) => items.map((item) => item.title);

    await rpc(app, scope, "pages/pin", { pageId: oldest, pinned: true });
    const first = await rpc<{ items: PageSummary[]; nextCursor: string | null }>(
      app,
      scope,
      "pages/list",
      { botId: bot.id, limit: 2 },
    );
    expect(titles(first.items)).toEqual(["Oldest", "Newest"]);
    expect(first.items[0]?.pinned).toBe(true);
    const rest = await rpc<{ items: PageSummary[]; nextCursor: string | null }>(
      app,
      scope,
      "pages/list",
      { botId: bot.id, limit: 2, cursor: first.nextCursor },
    );
    expect(rest).toMatchObject({ nextCursor: null });
    expect(titles(rest.items)).toEqual(["Middle"]);
    expect(
      titles((await rpc<{ items: PageSummary[] }>(app, scope, "pages/list", {})).items),
    ).toEqual(["Oldest", "Elsewhere", "Newest", "Middle"]);

    const renamed = await rpc<PageSummary>(app, scope, "pages/rename", {
      pageId: middle,
      title: "Q3 plan",
    });
    expect(renamed.title).toBe("Q3 plan");

    // Each time the link is turned on it is a new link; turning it off kills it at once.
    const share = (visibility: "private" | "link") =>
      rpc<{ visibility: string; shareUrl: string | null }>(app, scope, "pages/setVisibility", {
        pageId: middle,
        visibility,
      });
    const read = (url: string) => {
      const token = new URL(url).pathname.slice(-43);
      return app.request(`${SHARED_PAGE_PATH_PREFIX}${token}`);
    };
    const firstLink = await share("link");
    expect(new URL(firstLink.shareUrl!).pathname).toMatch(/^\/p\/q3-plan-[\w-]{43}$/);
    const opened = await read(firstLink.shareUrl!);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    expect(opened.headers.get("x-robots-tag")).toContain("noindex");
    expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await opened.json()).toEqual({
      title: "Q3 plan",
      code: expect.stringMatching(/React\.createElement\(Page, \{ title: "Middle"/),
      version: 1,
      updatedAt: expect.any(String),
    });
    // A card's read leaves the secret store alone; only the share popover asks for the link.
    const { shareSecretId } = await db().page.findUniqueOrThrow({ where: { id: middle } });
    const load = vi.spyOn(EncryptedSecretStore.prototype, "load");
    const tokenReads = () =>
      load.mock.calls.filter(
        ([, context]) => typeof context === "object" && context.recordId === shareSecretId,
      ).length;
    const card = await rpc<PageDetail>(app, scope, "pages/get", { pageId: middle });
    expect(card).toMatchObject({ visibility: "link", shareUrl: null });
    expect(tokenReads()).toBe(0);
    const linked = await rpc<PageDetail>(app, scope, "pages/get", { pageId: middle, link: true });
    expect(linked.shareUrl).toBe(firstLink.shareUrl);
    expect(tokenReads()).toBe(1);
    load.mockRestore();
    await share("private");
    expect((await read(firstLink.shareUrl!)).status).toBe(404);
    // Off means the stored token is gone too, not only hidden behind the visibility flag.
    expect(
      await db().page.findUnique({ where: { id: middle }, select: { shareTokenHash: true } }),
    ).toEqual({ shareTokenHash: null });
    const secondLink = await share("link");
    expect(secondLink.shareUrl).not.toBe(firstLink.shareUrl);
    expect((await read(firstLink.shareUrl!)).status).toBe(404);
    expect((await read(secondLink.shareUrl!)).status).toBe(200);
    // Reads serve the code compiled when the page was saved; they never compile it again.
    await db().pageVersion.updateMany({ where: { pageId: middle }, data: { code: "/* saved */" } });
    expect(await (await read(secondLink.shareUrl!)).json()).toMatchObject({ code: "/* saved */" });
    expect(await rpc<PageDetail>(app, scope, "pages/get", { pageId: middle })).toMatchObject({
      code: "/* saved */",
    });
    expect(
      await db().secret.count({
        where: { kind: "page_share", userId: (await me(app, scope)).id },
      }),
    ).toBe(1);

    // Another account sees none of it and can change none of it.
    const otherCookie = await testSpace(app, "Outsider");
    expect(await rpc(app, otherCookie, "pages/list", {})).toEqual({ items: [], nextCursor: null });
    for (const [proc, body] of [
      ["pages/get", { pageId: middle }],
      ["pages/rename", { pageId: middle, title: "Mine" }],
      ["pages/setVisibility", { pageId: middle, visibility: "private" }],
      ["pages/pin", { pageId: middle, pinned: true }],
      ["pages/remove", { pageId: middle }],
    ] as const) {
      expect((await raw(app, otherCookie, proc, body)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await read(secondLink.shareUrl!)).status).toBe(200);

    // Two tabs delete it at once: both pass the ownership read; the later one finds it gone.
    const statuses = await holdingPageRow(middle!, async (waitFor) => {
      const first = raw(app, scope, "pages/remove", { pageId: middle });
      await waitFor(1);
      const second = raw(app, scope, "pages/remove", { pageId: middle });
      await waitFor(2);
      return [first, second];
    });
    expect((await Promise.all(statuses)).map((res) => res.status).sort()).toEqual([200, 404]);
    expect((await read(secondLink.shareUrl!)).status).toBe(404);
    expect(await db().pageVersion.count({ where: { pageId: middle } })).toBe(0);
    expect(
      await db().secret.count({
        where: { kind: "page_share", userId: (await me(app, scope)).id },
      }),
    ).toBe(0);
    expect(newest).toBeDefined();
  });

  it("keeps one live link under racing share changes and deletes it with the page's group", async () => {
    const scope = await testSpace(app, "Race Owner");
    const userId = (await me(app, scope)).id;
    const bot = await createBot(app, scope, "Racer");
    const partner = await createBot(app, scope, "Partner");
    await sendAndWait(app, scope, bot.id, {
      text: `call save_page with ${JSON.stringify({ title: "Race", source: page("Race") })}`,
    });
    const pageId = (await lastResult(bot.id))!.pageId as string;
    const share = (visibility: "private" | "link") =>
      rpc<{ visibility: string; shareUrl: string | null }>(app, scope, "pages/setVisibility", {
        pageId,
        visibility,
      });
    const secrets = () => db().secret.count({ where: { kind: "page_share", userId } });
    const stored = () =>
      db().page.findUnique({
        where: { id: pageId },
        select: { visibility: true, shareSecretId: true },
      });

    // Two links at once: one wins, both callers get its link, and no sealed token is left that
    // no page points to.
    const links = await Promise.all([share("link"), share("link")]);
    expect(await secrets()).toBe(1);
    const live = await rpc<PageDetail>(app, scope, "pages/get", { pageId, link: true });
    expect(links.map((link) => link.shareUrl)).toEqual([live.shareUrl, live.shareUrl]);
    // A link and an off at once end consistent: a link has its one secret, off has none.
    await Promise.all([share("link"), share("private")]);
    const after = await stored();
    expect(await secrets()).toBe(after?.visibility === "link" ? 1 : 0);
    expect(Boolean(after?.shareSecretId)).toBe(after?.visibility === "link");

    // Removing while a link is being turned on leaves no sealed token behind.
    await sendAndWait(app, scope, bot.id, {
      text: `call save_page with ${JSON.stringify({ title: "Gone", source: page("Gone") })}`,
    });
    const goneId = (await lastResult(bot.id))!.pageId as string;
    const before = await secrets();
    // The link's swap waits on the held row first; the remove reads the row, then waits behind it.
    const racing = await holdingPageRow(goneId, async (waitFor) => {
      const linking = rpc(app, scope, "pages/setVisibility", {
        pageId: goneId,
        visibility: "link",
      });
      await waitFor(1);
      const removing = rpc(app, scope, "pages/remove", { pageId: goneId });
      await waitFor(2);
      return [linking, removing];
    });
    await Promise.allSettled(racing);
    expect(await db().page.count({ where: { id: goneId } })).toBe(0);
    expect(await secrets()).toBe(before);

    // Pages go with their group; their sealed links must go too.
    await share("link");
    const group = await rpc<{ id: string }>(app, scope, "groups/create", {
      name: "Pair",
      botIds: [bot.id, partner.id],
    });
    await db().page.update({ where: { id: pageId }, data: { groupId: group.id } });
    expect(await secrets()).toBe(1);
    await rpc(app, scope, "groups/remove", { groupId: group.id });
    expect(await db().page.count({ where: { id: pageId } })).toBe(0);
    expect(await secrets()).toBe(0);
  });

  it("hands cleanup the link a swap commits while its pages' links are being deleted", async () => {
    const scope = await testSpace(app, "Swap Owner");
    const owner = await rpc<{ userId: string; spaceId: string }>(app, scope, "me");
    const sealed = (ciphertext: string) =>
      db().secret.create({
        data: { userId: owner.userId, spaceId: owner.spaceId, kind: "page_share", ciphertext },
      });
    const first = await sealed("sealed-first");
    const { id: pageId } = await db().page.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        title: "Swapped",
        visibility: "link",
        shareTokenHash: "first-hash",
        shareSecretId: first.id,
        versions: {
          create: {
            version: 1,
            title: "Swapped",
            source: page("S"),
            code: pageViewerCode(page("S")),
          },
        },
      },
    });
    // A swap has moved the page to a new secret but not committed when the delete starts.
    const { deleting, nextId } = await holdingPageRow(pageId, async (waitFor, tx) => {
      const next = await tx.secret.create({
        data: {
          userId: owner.userId,
          spaceId: owner.spaceId,
          kind: "page_share",
          ciphertext: "sealed-next",
        },
      });
      await tx.page.update({
        where: { id: pageId },
        data: { shareSecretId: next.id, shareTokenHash: "next-hash" },
      });
      const deleting = db().$transaction((other) => deletePageShareSecrets(other, { id: pageId }));
      await waitFor(1);
      await tx.secret.delete({ where: { id: first.id } });
      return { deleting, nextId: next.id };
    });
    expect((await deleting).map((secret) => secret.ciphertext)).toEqual(["sealed-next"]);
    expect(await db().secret.count({ where: { id: { in: [first.id, nextId] } } })).toBe(0);
    expect(await db().page.findUniqueOrThrow({ where: { id: pageId } })).toMatchObject({
      visibility: "private",
      shareTokenHash: null,
      shareSecretId: null,
    });
  });

  it("deletes a deleted bot's own pages and their links, and leaves its group's pages", async () => {
    const scope = await testSpace(app, "Bot Owner");
    const userId = (await me(app, scope)).id;
    const bot = await createBot(app, scope, "Leaving");
    const partner = await createBot(app, scope, "Staying");
    // Three members, so the group outlives one of them.
    const third = await createBot(app, scope, "Also staying");
    const saved = async (title: string) => {
      await sendAndWait(app, scope, bot.id, {
        text: `call save_page with ${JSON.stringify({ title, source: page(title) })}`,
      });
      const pageId = (await lastResult(bot.id))!.pageId as string;
      const link = await rpc<{ shareUrl: string }>(app, scope, "pages/setVisibility", {
        pageId,
        visibility: "link",
      });
      return { pageId, shareUrl: link.shareUrl };
    };
    const own = await saved("Own");
    const shared = await saved("Shared");
    const group = await rpc<{ id: string }>(app, scope, "groups/create", {
      name: "Kept",
      botIds: [bot.id, partner.id, third.id],
    });
    await db().page.update({ where: { id: shared.pageId }, data: { groupId: group.id } });
    const read = (url: string) =>
      app.request(`${SHARED_PAGE_PATH_PREFIX}${new URL(url).pathname.slice(-43)}`);
    expect((await read(own.shareUrl)).status).toBe(200);

    await rpc(app, scope, "bots/remove", { botId: bot.id, deleteMemories: true });
    expect((await read(own.shareUrl)).status).toBe(404);
    expect(await db().page.count({ where: { id: own.pageId } })).toBe(0);
    expect(await db().page.count({ where: { id: shared.pageId, groupId: group.id } })).toBe(1);
    expect((await read(shared.shareUrl)).status).toBe(200);
    expect(await db().secret.count({ where: { kind: "page_share", userId } })).toBe(1);
  });

  it("shows a page a bot saved while answering another bot in that bot's history", async () => {
    const scope = await testSpace(app, "Peer Owner");
    const asker = await createBot(app, scope, "Asker");
    const builder = await createBot(app, scope, "Builder");
    const args = { title: "Peer report", source: page("Peer report") };
    await sendAndWait(app, scope, asker.id, {
      text: `message the bot named Builder saying call save_page with ${JSON.stringify(args)}`,
    });
    const start = Date.now();
    let blocks: unknown[] = [];
    while (Date.now() - start < 20_000) {
      const snap = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: builder.id });
      blocks = snap.messages.flatMap((message) => message.blocks.filter((b) => b.kind === "page"));
      if (blocks.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(blocks).toEqual([
      { kind: "page", pageId: expect.any(String), version: 1, title: "Peer report" },
    ]);
  });

  it("lets only one of two saves built on the same version through", async () => {
    const scope = await testSpace(app, "Save Racer");
    const first = await createBot(app, scope, "First");
    const second = await createBot(app, scope, "Second");
    await sendAndWait(app, scope, first.id, {
      text: `call save_page with ${JSON.stringify({ title: "Race", source: page("One") })}`,
    });
    const pageId = (await lastResult(first.id))!.pageId as string;
    // A page of both bots' group: its maker saves from its own chat, the other in the group.
    const group = await rpc<{ id: string; threadId: string }>(app, scope, "groups/create", {
      name: "Racers",
      botIds: [first.id, second.id],
    });
    await db().page.update({ where: { id: pageId }, data: { groupId: group.id } });
    const saveText = (heading: string) =>
      `call save_page with ${JSON.stringify({ pageId, source: page(heading) })}`;
    // Hold the page row until both saves have read version 1 and wait to write.
    await holdingPageRow(pageId, async (waitFor) => {
      await Promise.all([
        rpc(app, scope, "threads/send", { botId: first.id, text: saveText("Two") }),
        rpc(app, scope, "threads/send", {
          groupId: group.id,
          text: `@Second ${saveText("Three")}`,
          mentions: [{ kind: "bot", id: second.id }],
        }),
      ]);
      await waitFor(2);
    });
    await sendAndWait(app, scope, first.id, { text: "hello" });
    await expect
      .poll(
        () =>
          db().run.count({
            where: {
              threadId: group.threadId,
              status: { in: ["completed", "failed", "cancelled"] },
            },
          }),
        { timeout: 20_000, interval: 100 },
      )
      .toBe(1);
    const results = await db().externalEffect.findMany({
      where: { kind: "save_page", run: { botId: { in: [first.id, second.id] } } },
      orderBy: { createdAt: "asc" },
      select: { result: true },
    });
    const outcomes = results.slice(1).map((effect) => effect.result as Record<string, unknown>);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((result) => result.version === 2)).toHaveLength(1);
    expect(outcomes.filter((result) => result.unchanged === true)).toEqual([
      { error: "The page changed while saving; read it again and retry.", unchanged: true },
    ]);
    expect(await db().pageVersion.count({ where: { pageId } })).toBe(2);
  });

  it("keeps a page editable after importing an export that a save raced", async () => {
    const scope = await testSpace(app, "Export Racer");
    // Export this space first so its version query is the one blocked by the table lock.
    await db().space.update({ where: { id: scope }, data: { createdAt: new Date(0) } });
    const bot = await createBot(app, scope, "Builder");
    await sendAndWait(app, scope, bot.id, {
      text: `call save_page with ${JSON.stringify({ title: "Plan", source: page("One") })}`,
    });
    const pageId = (await lastResult(bot.id))!.pageId as string;
    const { token } = await rpc<{ token: string }>(app, scope, "export/accountToken");
    // The export has read the page at version 1 and waits on its versions while a save commits.
    const { archive } = await holdingPageRow(pageId, async (waitFor, tx) => {
      await tx.$executeRaw`LOCK TABLE page_versions IN ACCESS EXCLUSIVE MODE`;
      const archive = Promise.resolve(app.request(`/api/account/export?token=${token}`)).then(
        (response) => response.arrayBuffer(),
      );
      await waitFor(1);
      await tx.page.update({ where: { id: pageId }, data: { currentVersion: 2 } });
      await tx.pageVersion.create({
        data: { pageId, version: 2, title: "Plan", source: page("Two"), code: "" },
      });
      return { archive };
    });
    const imported = await app.request("/api/account/import", {
      method: "POST",
      headers: {
        ...testSpaceHeaders(scope),
        origin: "http://127.0.0.1:5173",
        "content-type": "application/zip",
      },
      body: await archive,
    });
    expect(imported.status).toBe(200);
    const { spaces } = (await imported.json()) as { spaces: { id: string; name: string }[] };
    const space = spaces.find((entry) => entry.name === "Export Racer");
    const copy = await db().page.findFirstOrThrow({ where: { spaceId: space!.id } });
    expect(copy.currentVersion).toBe(1);
    const builder = await db().bot.findFirstOrThrow({ where: { spaceId: space!.id } });
    await sendAndWait(
      app,
      scope,
      builder.id,
      { text: `call save_page with ${JSON.stringify({ pageId: copy.id, source: page("Three") })}` },
      space!.id,
    );
    expect(await lastResult(builder.id)).toMatchObject({ pageId: copy.id, version: 2 });
  });

  it("keeps a rename that lands while a bot's untitled save is in flight", async () => {
    const scope = await testSpace(app, "Rename Racer");
    const bot = await createBot(app, scope, "Builder");
    await sendAndWait(app, scope, bot.id, {
      text: `call save_page with ${JSON.stringify({ title: "Q3 plan", source: page("One") })}`,
    });
    const pageId = (await lastResult(bot.id))!.pageId as string;
    const edits = [{ find: 'title="One"', replace: 'title="Two"' }];
    // The save has read the page and waits to write; the user's rename commits first.
    await holdingPageRow(pageId, async (waitFor, tx) => {
      await rpc(app, scope, "threads/send", {
        botId: bot.id,
        text: `call save_page with ${JSON.stringify({ pageId, edits })}`,
      });
      await waitFor(1);
      await tx.page.update({ where: { id: pageId }, data: { title: "Budget" } });
    });
    await sendAndWait(app, scope, bot.id, { text: "hello" });
    expect(await lastResult(bot.id)).toMatchObject({ version: 2, title: "Budget" });
    const stored = await db().page.findUniqueOrThrow({
      where: { id: pageId },
      select: { title: true, versions: { where: { version: 2 }, select: { title: true } } },
    });
    expect(stored.title).toBe("Budget");
    expect(stored.versions).toEqual([{ title: "Budget" }]);
  });

  it("pages through pinned then unpinned pages one at a time with no gap or repeat, and finds titles", async () => {
    const scope = await testSpace(app, "Walker");
    const owner = await rpc<{ userId: string; spaceId: string }>(app, scope, "me");
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));
    const made = async (title: string, updatedAt: Date, pinnedAt: Date | null) =>
      (
        await db().page.create({
          data: {
            spaceId: owner.spaceId,
            userId: owner.userId,
            title,
            updatedAt,
            pinnedAt,
            versions: {
              create: { version: 1, title, source: page(title), code: pageViewerCode(page(title)) },
            },
          },
        })
      ).id;
    // Two pinned, then three unpinned of which two share one updatedAt.
    const order = [
      await made("Pinned later", at(1), at(9)),
      await made("Pinned first", at(8), at(5)),
      await made("Newest", at(7), null),
    ];
    const tied = [await made("Tie A", at(3), null), await made("Tie B", at(3), null)];
    order.push(...tied.sort().reverse(), await made("Zeta oldest", at(2), null));

    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const step: { items: { id: string }[]; nextCursor: string | null } = await rpc(
        app,
        scope,
        "pages/list",
        { limit: 1, ...(cursor ? { cursor } : {}) },
      );
      walked.push(...step.items.map((item) => item.id));
      cursor = step.nextCursor;
    } while (cursor && walked.length < 20);
    expect(walked).toEqual(order);

    const found = await rpc<{ items: { title: string }[] }>(app, scope, "pages/list", {
      query: "zETA",
    });
    expect(found.items.map((item) => item.title)).toEqual(["Zeta oldest"]);
  });

  it("answers every unusable token alike and throttles one address", async () => {
    const answers = new Set<string>();
    for (const token of [
      "short",
      "x".repeat(43),
      `${"x".repeat(42)}!`,
      `${"x".repeat(35)}%2f..%2f`,
    ]) {
      const response = await app.request(`${SHARED_PAGE_PATH_PREFIX}${token}`);
      answers.add(
        `${response.status} ${response.headers.get("cache-control")} ${await response.text()}`,
      );
    }
    expect([...answers]).toEqual(['404 no-store {"error":"Not found"}']);
    let last = 0;
    for (let i = 0; i < 125 && last !== 429; i++) {
      last = (await app.request(`${SHARED_PAGE_PATH_PREFIX}${"y".repeat(43)}`)).status;
    }
    expect(last).toBe(429);
  });
});

async function createBot(app: App, scope: string, name: string) {
  return rpc<{ id: string }>(app, scope, "bots/create", {
    name,
    title: name,
    description: "tests pages",
    instructions: "",
    notifyOnFinish: true,
  });
}

async function me(app: App, scope: string) {
  const response = await app.request("/api/local-identity", { headers: testSpaceHeaders(scope) });
  return (await response.json()) as { id: string };
}

async function testSpace(app: App, name = "Test") {
  return createTestSpace(app, name);
}

async function rpc<T>(
  app: App,
  scope: string,
  proc: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const res = await raw(app, scope, proc, body, spaceId);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(harness, scope, proc, parsed.json as T);
}

async function raw(app: App, scope: string, proc: string, body: unknown, spaceId?: string) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...testSpaceHeaders(scope),
      origin: "http://127.0.0.1:5173",
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: body }),
  });
}

async function sendAndWait(
  app: App,
  scope: string,
  botId: string,
  input: { text: string },
  spaceId?: string,
) {
  await rpc(app, scope, "threads/send", { botId, ...input }, spaceId);
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const snap = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId }, spaceId);
    if (!snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timeout waiting for the run");
}
