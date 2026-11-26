"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");
const { createGateway, sessionToken, COOKIE_NAME, CONNECT_PATH, PAIR_PATH } = require("./gateway.cjs");

const publicOrigin = "https://phone.example.test";
const pairingKey = crypto.randomBytes(32).toString("base64url");
const cookie = `${COOKIE_NAME}=${sessionToken(pairingKey)}`;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function request(port, pathname, headers = {}, method = "GET", body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: { host: "phone.example.test", ...headers },
      agent: false,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("phone pairing, HTTP boundaries, streaming and WebSocket forwarding", async (t) => {
  let seen;
  let finishStream;
  const upgradedSockets = new Set();
  const backend = http.createServer((req, res) => {
    seen = { headers: req.headers, url: req.url, method: req.method };
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      finishStream = () => res.end("data: last\n\n");
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...seen, body }));
    });
  });
  backend.on("upgrade", (req, socket, head) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    seen = { headers: req.headers, url: req.url, method: req.method };
    const accept = crypto.createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (head.length) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => {});
  });
  const backendPort = await listen(backend);
  const gateway = createGateway({ publicOrigin, pairingKey, target: `http://127.0.0.1:${backendPort}` });
  const port = await listen(gateway);
  t.after(() => {
    for (const socket of upgradedSockets) socket.destroy();
    gateway.closeAllConnections();
    gateway.close();
    backend.closeAllConnections();
    backend.close();
  });

  await t.test("requires pairing for the shell, identity, RPC, assets and downloads", async () => {
    for (const path of ["/", "/api/local-identity", "/rpc/context/get", "/assets/main.js", "/api/files/1"]) {
      assert.equal((await request(port, path)).status, 401, path);
    }
    assert.equal(seen, undefined);
  });

  await t.test("pairing page keeps the key in the fragment and does not leak it", async () => {
    const result = await request(port, CONNECT_PATH);
    assert.equal(result.status, 200);
    assert.match(result.text, /location\.hash/);
    assert.match(result.text, /history\.replaceState/);
    assert.match(result.text, /rakazo\.uiLocale", "zh-CN"/);
    assert.equal(result.text.includes(pairingKey), false);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.match(result.headers["content-security-policy"], /frame-ancestors 'none'/);
  });

  await t.test("the install manifest and icons work without exposing application data", async () => {
    for (const path of ["/site.webmanifest", "/icon-192.png", "/icon-512.png"]) {
      assert.equal((await request(port, path)).status, 200);
    }
    assert.equal((await request(port, "/api/local-identity")).status, 401);
  });

  await t.test("only a correct key from this origin pairs the browser", async () => {
    for (const headers of [
      { origin: publicOrigin, "x-rakazo-phone-key": "wrong" },
      { "x-rakazo-phone-key": pairingKey },
      { origin: "https://foreign.test", "x-rakazo-phone-key": pairingKey },
    ]) {
      assert.equal((await request(port, PAIR_PATH, headers, "POST")).status, 403);
    }
    const result = await request(port, PAIR_PATH, {
      origin: publicOrigin,
      "x-rakazo-phone-key": pairingKey,
    }, "POST");
    assert.equal(result.status, 204);
    assert.equal(result.headers["set-cookie"][0].split(";")[0], cookie);
    assert.match(result.headers["set-cookie"][0], /Secure; HttpOnly; SameSite=Lax; Max-Age=31536000/);
    assert.equal(result.headers["set-cookie"][0].includes(pairingKey), false);
  });

  await t.test("authenticated requests reach the unchanged local host with their body", async () => {
    const result = await request(port, "/rpc/message?mode=stream", {
      origin: publicOrigin,
      cookie: `${cookie}; unrelated=kept`,
      forwarded: "for=198.51.100.20",
      "x-forwarded-for": "198.51.100.20",
      "x-forwarded-host": "foreign.test",
      "x-real-ip": "198.51.100.20",
      "content-type": "application/json",
      authorization: "Bearer should-not-forward",
    }, "POST", '{"message":"test"}');
    assert.equal(result.status, 200);
    const echoed = JSON.parse(result.text);
    assert.equal(echoed.body, '{"message":"test"}');
    assert.equal(echoed.headers.host, `127.0.0.1:${backendPort}`);
    assert.equal(echoed.headers.origin, `http://127.0.0.1:${backendPort}`);
    assert.equal(echoed.headers.cookie, " unrelated=kept".trim());
    for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "authorization"]) {
      assert.equal(echoed.headers[name], undefined, name);
    }
    assert.equal(echoed.url, "/rpc/message?mode=stream");
  });

  await t.test("paired browsers cannot use a foreign origin or host", async () => {
    for (const headers of [
      { cookie, origin: "https://foreign.test" },
      { cookie, host: "foreign.test" },
      { cookie, "sec-fetch-site": "cross-site" },
      { cookie: `${COOKIE_NAME}=wrong`, origin: publicOrigin },
    ]) {
      assert.ok([401, 403].includes((await request(port, "/api/local-identity", headers)).status));
    }
  });

  await t.test("streams the first event before the upstream response ends", async () => {
    await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: "127.0.0.1",
        port,
        path: "/stream",
        headers: { host: "phone.example.test", cookie },
      }, (res) => {
        res.once("data", (chunk) => {
          assert.match(chunk.toString(), /data: first/);
          finishStream();
        });
        res.on("end", resolve);
        res.on("error", reject);
      });
      req.on("error", reject);
    });
  });

  await t.test("WebSocket requires pairing and the exact origin", async () => {
    for (const headers of [
      { origin: publicOrigin },
      { cookie, origin: "https://foreign.test" },
      { cookie },
    ]) {
      const result = await request(port, "/ws", {
        ...headers, connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      });
      assert.equal(result.status, 403);
    }
  });

  await t.test("paired WebSocket handshake and bytes pass in both directions", async () => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/ws",
      headers: {
        host: "phone.example.test", cookie, origin: publicOrigin,
        connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    const upgrade = once(req, "upgrade");
    req.end();
    const [, socket] = await upgrade;
    const data = once(socket, "data");
    socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
    const [bytes] = await data;
    assert.deepEqual(bytes, Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
    assert.equal(seen.headers.origin, `http://127.0.0.1:${backendPort}`);
    assert.equal(seen.headers.cookie, undefined);
    socket.destroy();
  });

  await t.test("a restart preserves the phone pairing", async () => {
    const restarted = createGateway({ publicOrigin, pairingKey, target: `http://127.0.0.1:${backendPort}` });
    const restartedPort = await listen(restarted);
    assert.equal((await request(restartedPort, "/api/local-identity", { cookie })).status, 200);
    restarted.closeAllConnections();
    restarted.close();
  });

});
