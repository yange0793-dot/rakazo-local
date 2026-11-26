"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { sessionToken, COOKIE_NAME, CONNECT_PATH, PAIR_PATH } = require("./gateway.cjs");

const root = path.resolve(__dirname, "../..");
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const status = JSON.parse(fs.readFileSync(path.join(root, "run/phone-access.json"), "utf8"));
process.kill(status.pid, 0);
assert.equal(status.url, config.publicOrigin);
const cookie = `${COOKIE_NAME}=${sessionToken(config.pairingKey)}`;
const common = `header = "Origin: ${config.publicOrigin}"\nheader = "ngrok-skip-browser-warning: true"\n`;

function request(url, { authenticated = false, method = "GET", body, pairing = false } = {}) {
  const args = ["--silent", "--show-error", "--suppress-connect-headers", "--compressed",
    "--max-time", "25", "-D", "-", "--config", "-", "-X", method];
  if (url.startsWith("http://127.0.0.1")) args.push("--noproxy", "*");
  if (body) args.push("-H", "content-type: application/json", "--data-binary", body);
  args.push(url);
  const input = common +
    (authenticated ? `header = "Cookie: ${cookie}"\n` : "") +
    (pairing ? `header = "x-rakazo-phone-key: ${config.pairingKey}"\n` : "");
  const raw = execFileSync("/usr/bin/curl", args, { input, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const end = raw.indexOf("\r\n\r\n");
  const headers = raw.slice(0, end);
  return { status: Number(/^HTTP\/\S+ (\d+)/.exec(headers)?.[1]), headers, body: raw.slice(end + 4) };
}

async function main() {
  const denied = request(config.publicOrigin + "/api/local-identity");
  assert.equal(denied.status, 401);
  const connect = request(config.publicOrigin + CONNECT_PATH);
  assert.equal(connect.status, 200);
  assert.equal(connect.body.includes(config.pairingKey), false);
  const paired = request(config.publicOrigin + PAIR_PATH, { method: "POST", pairing: true });
  assert.equal(paired.status, 204);
  assert.ok(paired.headers.includes(cookie));
  const identity = request(config.publicOrigin + "/api/local-identity", { authenticated: true });
  assert.equal(identity.status, 200);
  const localIdentity = await fetch("http://127.0.0.1:5173/api/local-identity").then((r) => r.json());
  assert.equal(JSON.parse(identity.body).id, localIdentity.id);
  const health = request(config.publicOrigin + "/rpc/health", {
    authenticated: true, method: "POST", body: '{"json":{}}',
  });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).json.ok, true);
  const build = request(config.publicOrigin + "/build-id", { authenticated: true });
  const source = process.env.RAKAZO_SRC || path.resolve(root, "..");
  assert.equal(build.body.trim(), fs.readFileSync(path.join(source, "apps/web/dist/build-id"), "utf8").trim());
  assert.equal(request(config.publicOrigin + "/site.webmanifest").status, 200);
  assert.equal(request(config.publicOrigin + "/icon-192.png").status, 200);
  console.log("Phone: running, QR pairing, local identity, RPC, latest build and install resources passed");

  const stream = await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/curl", [
      "--silent", "--show-error", "--suppress-connect-headers", "--no-buffer",
      "--max-time", "25", "-D", "-", "--config", "-", "-H", "content-type: application/json",
      "--data-binary", '{"json":{}}', config.publicOrigin + "/rpc/notifications/subscribe",
    ]);
    child.stdin.end(common + `header = "Cookie: ${cookie}"\n`);
    let output = "";
    let complete = false;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!complete && /\ndata:/.test(output)) {
        complete = true;
        child.kill("SIGTERM");
      }
    });
    child.once("error", reject);
    child.once("close", () => {
      if (!complete) return reject(new Error("Public event stream did not deliver an event"));
      assert.match(output, /HTTP\/\S+ 200/);
      assert.match(output, /content-type: text\/event-stream/i);
      resolve(true);
    });
  });
  console.log("Phone: live event stream delivered an event through public HTTPS");
  if (process.argv[2]) {
    fs.writeFileSync(process.argv[2], JSON.stringify({
      at: new Date().toISOString(),
      url: config.publicOrigin,
      build: build.body.trim(),
      unauthorizedRejected: true,
      pairing: true,
      sameLocalIdentity: true,
      rpc: true,
      installResources: true,
      streaming: stream,
    }, null, 2) + "\n", { mode: 0o600 });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
