import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { createTestSpace, testSpaceHeaders } from "./index.js";

import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
// A canary: the person's name must never reach a model request.
const personName = "Dana Q. Example";

/** What a model reads after the system message, as role and text, less the per-turn clock line. */
const turns = (request: ModelEmulatorRequest) =>
  request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      text: (typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content)
      ).replace(/\n\nCurrent date and time:.*$/s, ""),
    }));

describe.skipIf(!databaseAvailable)("group history keeps roles and speakers", () => {
  it("shows a bot the other member's earlier reply as a labelled user turn and its own as an assistant turn", async () => {
    const fixtureKey = "group-history-fixture-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        // Anya's first turn: the user's request alone, labelled like all later history.
        {
          expect(request) {
            expect(turns(request)).toEqual([
              { role: "user", text: "[User]: @Anya Invent a two-word code name for our project." },
            ]);
          },
          response: { type: "text", text: "Our code name is Blue Heron." },
        },
        // Boris sees Anya's reply, with her name, as a user turn.
        {
          expect(request) {
            expect(turns(request)).toEqual([
              {
                role: "user",
                text: "[User]: @Anya Invent a two-word code name for our project.\n\n[Anya]: Our code name is Blue Heron.\n\n[User]: @Boris Say hello.",
              },
            ]);
          },
          response: { type: "text", text: "Hello from Boris." },
        },
        // Boris's own reply is an assistant turn; Anya's stays a labelled user turn.
        {
          expect(request) {
            const [system] = request.messages;
            expect(String(system?.content)).toContain(
              'messages from other members start with "[Name]:"',
            );
            expect(turns(request)).toEqual([
              {
                role: "user",
                text: "[User]: @Anya Invent a two-word code name for our project.\n\n[Anya]: Our code name is Blue Heron.\n\n[User]: @Boris Say hello.",
              },
              { role: "assistant", text: "Hello from Boris." },
              { role: "user", text: "[User]: @Boris Who came up with the project code name?" },
            ]);
            expect(JSON.stringify(request.messages)).not.toContain("Assistant:");
            expect(JSON.stringify(request.messages)).not.toContain("Dana");
            expect(JSON.stringify(request.messages)).not.toContain("Example");
          },
          response: { type: "text", text: "Anya did: Blue Heron." },
        },
        // One send naming both: Anya speaks first, then Boris reads her reply in the same round.
        {
          expect(request) {
            const text = JSON.stringify(request.messages);
            expect(text).toContain("@Anya @Boris Compare notes on the name.");
            expect(text).not.toContain("Grey Fox");
          },
          response: { type: "text", text: "Second code name: Grey Fox." },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain(
              "[Anya]: Second code name: Grey Fox.",
            );
          },
          response: { type: "text", text: "Grey Fox works for me too." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-group-history-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("@rakazo/api/app");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,

        webOrigin: fixtureOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        composio: new ComposioConnector({ client: new FakeComposioClient() }),
        encryptionKey: "offline-model-fixture-encryption-key",
      });
      stop = handles.stop;
      const db = asSystem(handles.prisma);
      const scope = await createTestSpace(handles.app, personName);
      await rpc(handles.app, scope, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      const createBot = async (name: string) => {
        const bot = await rpc<{ id: string }>(handles.app, scope, "bots/create", {
          name,
          title: "",
          description: "",
          instructions: "Answer in one sentence.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, scope, bot.id);
        await rpc(handles.app, scope, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
        });
        return bot;
      };
      const anya = await createBot("Anya");
      const boris = await createBot("Boris");
      const group = await rpc<{ id: string; threadId: string }>(
        handles.app,
        scope,
        "groups/create",
        { name: "Project desk", botIds: [anya.id, boris.id] },
      );
      let completed = 0;
      const say = async (text: string, bot: { id: string }) => {
        await rpc(handles.app, scope, "threads/send", {
          groupId: group.id,
          text,
          mentions: [{ kind: "bot", id: bot.id }],
        });
        completed += 1;
        await expect
          .poll(
            async () => {
              const runs = await db.run.findMany({
                where: { threadId: group.threadId, trigger: "user" },
                select: { status: true },
              });
              if (runs.some((run) => run.status === "failed")) model.assertComplete();
              return runs.filter((run) => run.status === "completed").length;
            },
            { timeout: 20_000, interval: 100 },
          )
          .toBe(completed);
      };
      await say("@Anya Invent a two-word code name for our project.", anya);
      await say("@Boris Say hello.", boris);
      await say("@Boris Who came up with the project code name?", boris);
      // One message naming both members: the later member must see the earlier reply.
      await rpc(handles.app, scope, "threads/send", {
        groupId: group.id,
        text: "@Anya @Boris Compare notes on the name.",
        mentions: [
          { kind: "bot", id: anya.id },
          { kind: "bot", id: boris.id },
        ],
      });
      completed += 2;
      await expect
        .poll(
          async () => {
            const runs = await db.run.findMany({
              where: { threadId: group.threadId, trigger: "user" },
              select: { status: true },
            });
            if (runs.some((run) => run.status === "failed")) model.assertComplete();
            return runs.filter((run) => run.status === "completed").length;
          },
          { timeout: 20_000, interval: 100 },
        )
        .toBe(completed);
      model.assertComplete();
      // The labels exist only in the request: stored messages are untouched.
      const stored = await db.message.findMany({ where: { threadId: group.threadId } });
      expect(JSON.stringify(stored)).not.toContain("[Anya]");
      expect(JSON.stringify(stored)).not.toContain("[User]");
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});

async function rpc<T>(app: App, scope: string, procedure: string, input: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...testSpaceHeaders(scope),
      origin: fixtureOrigin,
    },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
