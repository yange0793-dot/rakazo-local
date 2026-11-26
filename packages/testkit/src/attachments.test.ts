import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { createTestSpace, testSpaceHeaders } from "./index.js";

import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeAttachments = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeAttachments("chat attachments", () => {
  let app: App;
  let stop: () => Promise<void>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-attachments-"));
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

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

  it("uploads, sends with image/file, and rejects invalid attachments", async () => {
    const scope = await testSpace(app, "Attachment User");
    const bot = await rpc<{ id: string }>(app, scope, "bots/create", {
      name: "Attacher",
      title: "Attacher",
      description: "tests attachments",
      instructions: "",
      notifyOnFinish: true,
    });

    const image = await rpc<{ id: string; mimeType: string }>(app, scope, "artifacts/create", {
      botId: bot.id,
      name: "pixel.png",
      mimeType: "image/png",
      contentBase64: tinyPng.toString("base64"),
    });
    const file = await rpc<{ id: string }>(app, scope, "artifacts/create", {
      botId: bot.id,
      name: "notes.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("hello attachment").toString("base64"),
    });

    await sendAndWait(app, scope, bot.id, { text: "see this", artifactIds: [image.id] });
    let snapshot = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id });
    const imageMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "image"),
    );
    expect(imageMessage?.blocks).toEqual(
      expect.arrayContaining([
        { kind: "text", text: "see this" },
        expect.objectContaining({ kind: "image", artifactId: image.id, name: "pixel.png" }),
      ]),
    );

    await sendAndWait(app, scope, bot.id, { artifactIds: [file.id] });
    snapshot = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id });
    const fileMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "file"),
    );
    expect(fileMessage?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", artifactId: file.id, name: "notes.txt" }),
      ]),
    );

    const fetched = await rpc<{ contentBase64: string }>(app, scope, "artifacts/get", {
      botId: bot.id,
      artifactId: image.id,
    });
    expect(fetched.contentBase64).toBe(tinyPng.toString("base64"));

    const zipBytes = Buffer.from("PK\x03\x04zip");
    let zip!: { id: string; mimeType: string };
    for (const mimeType of [
      "application/zip",
      "application/x-zip-compressed",
      "application/x-zip",
      "multipart/x-zip",
      "application/octet-stream",
    ]) {
      zip = await rpc(app, scope, "artifacts/create", {
        botId: bot.id,
        name: "bundle.ZIP",
        mimeType,
        contentBase64: zipBytes.toString("base64"),
      });
      expect(zip.mimeType).toBe("application/zip");
    }
    await sendAndWait(app, scope, bot.id, { artifactIds: [zip.id] });
    snapshot = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id });
    const zipMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "file" && block.name === "bundle.ZIP"),
    );
    expect(zipMessage?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          artifactId: zip.id,
          mimeType: "application/zip",
          name: "bundle.ZIP",
        }),
      ]),
    );
    const fetchedZip = await rpc<{ contentBase64: string }>(app, scope, "artifacts/get", {
      botId: bot.id,
      artifactId: zip.id,
    });
    expect(Buffer.from(fetchedZip.contentBase64, "base64")).toEqual(zipBytes);

    const badMime = await raw(app, scope, "artifacts/create", {
      botId: bot.id,
      name: "payload.exe",
      mimeType: "application/octet-stream",
      contentBase64: Buffer.from("nope").toString("base64"),
    });
    expect(badMime.status).toBeGreaterThanOrEqual(400);

    const oversize = await raw(app, scope, "artifacts/create", {
      botId: bot.id,
      name: "big.zip",
      mimeType: "application/zip",
      contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64"),
    });
    expect(oversize.status).toBeGreaterThanOrEqual(400);
  });

  it("attaches a workspace file into the thread", async () => {
    const scope = await testSpace(app, "Attach Thread User");
    await rpc(app, scope, "spaceSettings/setOverride", { setting: "confirmations", enabled: true });
    await rpc(app, scope, "autoReview/set", { mode: "bypermission" });
    const bot = await rpc<{ id: string }>(app, scope, "bots/create", {
      name: "Attacher",
      title: "Attacher",
      description: "tests attach_file",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, scope, bot.id, {
      text: "write notes/result.txt and attach it to the thread",
    });
    const snapshot = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id });
    const fileMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "file"),
    );
    const fileBlock = fileMessage?.blocks.find((block) => block.kind === "file");
    expect(fileBlock).toMatchObject({ kind: "file", name: "result.txt" });
    if (fileBlock?.kind !== "file") throw new Error("expected file block");
    const fetched = await rpc<{ contentBase64: string }>(app, scope, "artifacts/get", {
      botId: bot.id,
      artifactId: fileBlock.artifactId,
    });
    expect(Buffer.from(fetched.contentBase64, "base64").toString("utf8")).toContain(
      "write notes/result.txt and attach it to the thread",
    );
  });
  it("persists server-owned reply previews, isolates threads, and handles deletion", async () => {
    const scope = await testSpace(app, "Reply User");
    const otherCookie = await testSpace(app, "Other User");
    const bot = await rpc<{ id: string }>(app, scope, "bots/create", {
      name: "Helper",
      title: "Helper",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, scope, bot.id, { text: "Parent first line\nSecond line" });
    let snapshot = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id });
    const parent = snapshot.messages.find((message) => message.role === "user")!;
    await sendAndWait(app, scope, bot.id, { text: "A reply", replyToMessageId: parent.id });
    snapshot = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id });
    const reply = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text === "A reply"),
    )!;
    expect(reply.replyToMessageId).toBe(parent.id);
    expect(reply.replyQuote).toBe("Parent first line");
    const me = await rpc<{ userId: string; name: string }>(app, scope, "me");
    expect(reply.replyPreview).toEqual({
      role: "user",
      author: { id: me.userId, name: me.name },
      text: "Parent first line",
    });
    const event = await asSystem(botIntroHarness!.prisma).event.findFirst({
      where: {
        threadId: snapshot.threadId,
        type: "thread.message.created",
        payload: { path: ["messageId"], equals: reply.id },
      },
    });
    expect(event?.payload).toMatchObject({
      replyPreview: { role: "user", text: "Parent first line" },
    });

    const denied = await raw(app, otherCookie, "threads/send", {
      botId: bot.id,
      text: "Unauthorized",
      replyToMessageId: parent.id,
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    const otherBot = await rpc<{ id: string }>(app, scope, "bots/create", {
      name: "Other",
      title: "Other",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, scope, otherBot.id, {
      text: "Foreign target",
      replyToMessageId: parent.id,
    });
    const otherThread = await rpc<ThreadSnapshot>(app, scope, "threads/get", {
      botId: otherBot.id,
    });
    const foreignReply = otherThread.messages.find((message) => message.role === "user")!;
    expect(foreignReply.replyToMessageId).toBeUndefined();
    expect(foreignReply.replyPreview).toBeNull();
    expect(foreignReply.replyQuote).toBe("");

    await asSystem(botIntroHarness!.prisma).message.delete({ where: { id: parent.id } });
    snapshot = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id });
    const deletedReply = snapshot.messages.find((message) => message.id === reply.id)!;
    expect(deletedReply.replyToMessageId).toBeUndefined();
    expect(deletedReply.replyPreview).toBeNull();
    expect(deletedReply.replyQuote).toBe("Parent first line");
    await sendAndWait(app, scope, bot.id, { text: "Deleted target", replyToMessageId: parent.id });
    snapshot = await rpc<ThreadSnapshot>(app, scope, "threads/get", { botId: bot.id });
    const missingReply = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text === "Deleted target"),
    );
    expect(missingReply?.replyToMessageId).toBeUndefined();
    expect(missingReply?.replyPreview).toBeNull();
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
  input: { text?: string; artifactIds?: string[]; replyToMessageId?: string },
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
