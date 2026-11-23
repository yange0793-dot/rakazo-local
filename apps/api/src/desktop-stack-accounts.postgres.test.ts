import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { expect, it } from "vitest";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const webOrigin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)(
  "the app-managed stack returns the local owner without a login",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-desktop-accounts-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "docker",
      sandbox: new FakeSandboxProvider(),
      desktopStackToken: "cd".repeat(32),
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      webOrigin,
    });
    try {
      const post = (path: string) =>
        handles.app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: {} }),
        });
      const me = await post("/rpc/me");
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        json: { email: "local@rakazo.local", isDeploymentOwner: true },
      });
      expect((await post("/api/auth/sign-up/email")).status).toBe(404);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
