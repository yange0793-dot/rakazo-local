import { ATTACHMENT_MAX_BASE64_LENGTH } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_RPC_REQUEST_BYTES,
  requestBodyLimit,
  rpcBodyLimit,
  rpcRequestMaxBytes,
} from "./request-body-limit.js";

function rpcApp(maxUploadSizeBytes?: number) {
  const parse = vi.fn(async (request: Request) => request.json());
  const app = new Hono();
  const limit = rpcBodyLimit(maxUploadSizeBytes);
  app.post("/rpc/*", async (c) => (await limit(c)) ?? c.json(await parse(c.req.raw)));
  return { app, parse };
}

function testApp(maxSize: number, parse = vi.fn(async (request: Request) => request.json())) {
  const app = new Hono();
  app.use("/*", requestBodyLimit(maxSize));
  app.post("/parse", async (c) => c.json(await parse(c.req.raw)));
  return { app, parse };
}

describe("API request body limits", () => {
  it("expands the HTTP envelope for a larger configured upload", async () => {
    const limit = 25 * 1024 * 1024;
    const { app } = rpcApp(limit);
    const request = (length: number) =>
      app.request("/rpc/artifacts/create", {
        method: "POST",
        headers: { "content-length": String(length) },
        body: "{}",
      });
    expect((await request(Math.ceil(limit / 3) * 4 + 100)).status).toBe(200);
    const rejected = await request(rpcRequestMaxBytes(limit) + 1);
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({
      error: "Request body is too large. Upload limit: 25 MiB per file.",
    });
  });

  it("applies the same RPC body limit without a cookie", async () => {
    const { app, parse } = rpcApp();
    const response = await app.request("/rpc/me", {
      method: "POST",
      headers: { "content-length": String(rpcRequestMaxBytes() + 1) },
      body: "{}",
    });
    expect(response.status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
  });

  it("keeps the RPC allowance above the largest supported attachment envelope", () => {
    expect(MAX_RPC_REQUEST_BYTES).toBeGreaterThan(ATTACHMENT_MAX_BASE64_LENGTH);
  });

  it("rejects an oversized declared body before the route parser", async () => {
    const { app, parse } = testApp(8);
    const response = await app.request("/parse", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9" },
      body: JSON.stringify({ ok: true }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(["", "8.0"])(
    "rejects invalid declared length %j before the route parser",
    async (contentLength) => {
      const { app, parse } = testApp(8);
      const response = await app.request("/parse", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": contentLength },
        body: "{}",
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it("stops an oversized streamed body before the route parser", async () => {
    const cancel = vi.fn();
    const { app, parse } = testApp(8);
    const response = await app.request(
      new Request("http://localhost/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"value":"'));
            controller.enqueue(new TextEncoder().encode('too large"}'));
          },
          cancel,
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
    expect(parse).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("counts the streamed body when transfer-encoding accompanies a small declared length", async () => {
    const { app, parse } = testApp(8);
    const response = await app.request("/parse", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "2",
        "transfer-encoding": "chunked",
      },
      body: JSON.stringify({ ok: true }),
    });

    expect(response.status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
  });

  it("passes bodies at the configured boundary to the route parser", async () => {
    const { app, parse } = testApp(2);
    for (const headers of [{}, { "content-length": "2" }] as Record<string, string>[]) {
      const response = await app.request("/parse", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
      expect(response.status).toBe(200);
    }
    expect(parse).toHaveBeenCalledTimes(2);
  });
});
