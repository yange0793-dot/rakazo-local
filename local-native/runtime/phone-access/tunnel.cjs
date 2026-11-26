"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ngrok = require("@ngrok/ngrok");
const { createGateway } = require("./gateway.cjs");
const { writeQr } = require("./qr.cjs");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const statusPath = path.join(root, "run", "phone-access.json");
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
let listener;
let gateway;
let stopping = false;

async function stop(code) {
  if (stopping) return;
  stopping = true;
  fs.rmSync(statusPath, { force: true });
  gateway?.close();
  gateway?.closeAllConnections();
  setTimeout(() => process.exit(code), 3000).unref();
  await listener?.close();
  await ngrok.disconnect();
  process.exit(code);
}

async function start() {
  if (!config.authtoken) throw new Error("The original fixed tunnel account token is missing");
  gateway = createGateway(config);
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(5174, "127.0.0.1", resolve);
  });
  listener = await ngrok.forward({
    addr: "http://127.0.0.1:5174",
    authtoken: config.authtoken,
    domain: new URL(config.publicOrigin).hostname,
    schemes: ["https"],
    onStatusChange(status) {
      log(`tunnel ${status}`);
      if (status === "closed" && !stopping) void stop(1);
    },
  });
  if (listener.url() !== config.publicOrigin) {
    throw new Error("The tunnel did not use the configured fixed address");
  }
  await writeQr(config);
  fs.writeFileSync(statusPath, JSON.stringify({
    pid: process.pid,
    url: config.publicOrigin,
    connectedAt: new Date().toISOString(),
    gateway: "127.0.0.1:5174",
  }, null, 2) + "\n", { mode: 0o600 });
  log(`phone access listening at ${config.publicOrigin}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void stop(0));
start().catch((error) => {
  log(String(error.message).split(config.authtoken || "\0").join("[redacted]"));
  void stop(1);
});
