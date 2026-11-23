import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SearchHit, ThreadSnapshot } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { createTestSpace, testSpaceHeaders } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeSearch = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeSearch("workspace search", () => {
  let app: App;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-search-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    stop = handles.stop;
    botIntroHarness = handles;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("finds bots, messages, files, links, and routines within the workspace", async () => {
    const scope = await testSpace(app, "Search User");
    const bot = await rpc<{ id: string }>(app, scope, "bots/create", {
      name: "Finder",
      title: "Finder",
      description: "search fixture",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, scope, bot.id, {
      text: "Bookmark https://example.com/spec for later",
    });
    const artifact = await rpc<{ id: string }>(app, scope, "artifacts/create", {
      botId: bot.id,
      name: "fixture-notes.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("fixture file").toString("base64"),
    });
    const secondArtifact = await rpc<{ id: string }>(app, scope, "artifacts/create", {
      botId: bot.id,
      name: "fixture-second.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("second fixture").toString("base64"),
    });
    await rpc(app, scope, "artifacts/create", {
      botId: bot.id,
      name: "fixture-unattached.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("unattached fixture").toString("base64"),
    });
    await sendAndWait(app, scope, bot.id, { artifactIds: [artifact.id, secondArtifact.id] });
    const initialFiles = await rpc<{ hits: SearchHit[] }>(app, scope, "search/query", {
      q: "fixture",
    });
    expect(
      initialFiles.hits.filter((hit) => hit.kind === "file").map((hit) => hit.artifactId),
    ).toEqual(expect.arrayContaining([artifact.id, secondArtifact.id]));
    expect(initialFiles.hits.filter((hit) => hit.kind === "file")).toHaveLength(2);
    const initialMessageId = initialFiles.hits.find(
      (hit) => hit.artifactId === artifact.id,
    )?.messageId;
    await sendAndWait(app, scope, bot.id, { artifactIds: [artifact.id] });
    const latestFiles = await rpc<{ hits: SearchHit[] }>(app, scope, "search/query", {
      q: "fixture",
    });
    const latestMessageId = latestFiles.hits.find(
      (hit) => hit.artifactId === artifact.id,
    )?.messageId;
    expect(latestMessageId).toBeDefined();
    expect(latestMessageId).not.toBe(initialMessageId);
    await rpc(app, scope, "routines/create", {
      botId: bot.id,
      name: "Weekly fixture",
      prompt: "check the fixture",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      active: true,
      notify: true,
    });

    const hits = await rpc<{ hits: Array<{ kind: string }> }>(app, scope, "search/query", {
      q: "fixture",
    });
    expect(hits.hits.map((hit) => hit.kind)).toEqual(
      expect.arrayContaining(["conversation", "message", "file", "routine"]),
    );
    const linkHits = await rpc<{ hits: Array<{ kind: string }> }>(app, scope, "search/query", {
      q: "example.com",
    });
    expect(linkHits.hits.some((hit) => hit.kind === "link")).toBe(true);
  });

  it("finds literal message text without widening wildcard queries", async () => {
    const scope = await testSpace(app, "Literal Search");
    const bot = await rpc<{ id: string }>(app, scope, "bots/create", {
      name: "Literal Finder",
      title: "Literal Finder",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const queries = [String.raw`back\slash`, 'say "hi"', "50%_off", "café/東京"];
    for (const text of [...queries, "500 off"]) {
      await sendAndWait(app, scope, bot.id, { text });
    }
    for (const q of queries) {
      const { hits } = await rpc<{ hits: SearchHit[] }>(app, scope, "search/query", { q });
      expect(hits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "message", botId: bot.id, snippet: q }),
        ]),
      );
    }
    const { hits } = await rpc<{ hits: SearchHit[] }>(app, scope, "search/query", { q: "50%" });
    const messages = hits.filter((hit) => hit.kind === "message");
    expect(messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ botId: bot.id, snippet: "50%_off" })]),
    );
    expect(messages.some((hit) => hit.snippet.includes("500 off"))).toBe(false);
  });

  it("returns no hits for another workspace", async () => {
    const ownerCookie = await testSpace(app, "Owner");
    const ownerBot = await rpc<{ id: string }>(app, ownerCookie, "bots/create", {
      name: "OwnerOnly",
      title: "OwnerOnly",
      description: "private fixture token",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, ownerCookie, ownerBot.id, { text: "owner-only-token-xyz" });

    const intruderCookie = await testSpace(app, "Intruder");
    const hits = await rpc<{ hits: unknown[] }>(app, intruderCookie, "search/query", {
      q: "owner-only-token-xyz",
    });
    expect(hits.hits).toEqual([]);
  });

  it("finds group conversations, messages, and files", async () => {
    const scope = await testSpace(app, "Group Search User");
    const botA = await rpc<{ id: string }>(app, scope, "bots/create", {
      name: "Alpha",
      title: "Alpha",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, scope, "bots/create", {
      name: "Beta",
      title: "Beta",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string }>(app, scope, "groups/create", {
      name: "Squad",
      botIds: [botA.id, botB.id],
    });
    const groupToken = `squad-search-token-${stamp}`;
    await rpc(app, scope, "threads/send", { groupId: group.id, text: groupToken });
    const artifact = await rpc<{ id: string }>(app, scope, "artifacts/create", {
      groupId: group.id,
      name: `squad-notes-${stamp}.txt`,
      mimeType: "text/plain",
      contentBase64: Buffer.from("group fixture").toString("base64"),
    });
    await rpc(app, scope, "threads/send", {
      groupId: group.id,
      text: "see attachment",
      artifactIds: [artifact.id],
    });

    const squadHits = await rpc<{
      hits: Array<{ kind: string; groupId?: string; botId?: string }>;
    }>(app, scope, "search/query", { q: "Squad" });
    expect(
      squadHits.hits.some((hit) => hit.kind === "conversation" && hit.groupId === group.id),
    ).toBe(true);

    const messageHits = await rpc<{
      hits: Array<{ kind: string; groupId?: string; botId?: string; messageId?: string }>;
    }>(app, scope, "search/query", { q: groupToken });
    const groupMessage = messageHits.hits.find((hit) => hit.kind === "message");
    expect(groupMessage?.groupId).toBe(group.id);
    expect(groupMessage?.botId).toBeUndefined();
    expect(groupMessage?.messageId).toBeDefined();
    const page = await rpc<{ messages: Array<{ id: string }> }>(app, scope, "threads/messages", {
      groupId: group.id,
      around: { messageId: groupMessage!.messageId! },
    });
    expect(page.messages.some((message) => message.id === groupMessage!.messageId)).toBe(true);

    const fileHits = await rpc<{
      hits: Array<{ kind: string; groupId?: string; artifactId?: string }>;
    }>(app, scope, "search/query", { q: `squad-notes-${stamp}` });
    const groupFile = fileHits.hits.find((hit) => hit.kind === "file");
    expect(groupFile?.groupId).toBe(group.id);
    expect(groupFile?.artifactId).toBe(artifact.id);
  });
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
  return discardBotIntroFromCreate(botIntroHarness, scope, proc, parsed.json as T);
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

async function sendAndWait(
  app: App,
  scope: string,
  botId: string,
  input: { text?: string; artifactIds?: string[] },
) {
  await rpc(app, scope, "threads/send", { botId, ...input });
  await waitFor(
    app,
    scope,
    botId,
    (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
  );
}

async function waitFor(
  app: App,
  scope: string,
  botId: string,
  pred: (snap: ThreadSnapshot) => boolean,
) {
  const start = Date.now();
  let last: ThreadSnapshot | null = null;
  while (Date.now() - start < 20_000) {
    last = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId });
    if (pred(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for thread: ${JSON.stringify(last)}`);
}
