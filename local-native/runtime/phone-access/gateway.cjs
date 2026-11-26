"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream");

const COOKIE_NAME = "__Host-rakazo-phone";
const CONNECT_PATH = "/api/phone/connect";
const PAIR_PATH = "/api/phone/pair";
const PUBLIC_FILES = new Set(["/site.webmanifest", "/icon-192.png", "/icon-512.png", "/favicon.ico"]);
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function equalSecret(actual, expected) {
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(actual || "").digest(),
    crypto.createHash("sha256").update(expected).digest(),
  );
}

function sessionToken(pairingKey) {
  return crypto.createHmac("sha256", pairingKey).update("rakazo-phone-session-v1").digest("base64url");
}

function createGateway({ publicOrigin, pairingKey, target = "http://127.0.0.1:5173" }) {
  const origin = new URL(publicOrigin);
  const upstream = new URL(target);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== publicOrigin ||
    upstream.protocol !== "http:" ||
    upstream.hostname !== "127.0.0.1" ||
    !/^[A-Za-z0-9_-]{43}$/.test(pairingKey)
  ) {
    throw new Error("Invalid phone gateway configuration");
  }
  const token = sessionToken(pairingKey);
  const agent = new http.Agent({ keepAlive: true });

  function allowedRequest(req, upgrade = false) {
    if (req.headers.host !== origin.host) return false;
    if (req.headers.origin && req.headers.origin !== publicOrigin) return false;
    if (upgrade && req.headers.origin !== publicOrigin) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") {
      return (
        !upgrade &&
        req.method === "GET" &&
        req.headers["sec-fetch-mode"] === "navigate" &&
        req.headers["sec-fetch-dest"] === "document"
      );
    }
    return true;
  }

  function paired(req) {
    const value = (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    return equalSecret(value, token);
  }

  function proxyHeaders(req, upgrade = false) {
    const headers = { ...req.headers };
    const connectionHeaders = (headers.connection || "").toLowerCase().split(",").map((s) => s.trim());
    for (const name of Object.keys(headers)) {
      if (
        HOP_HEADERS.has(name) ||
        connectionHeaders.includes(name) ||
        name === "forwarded" ||
        name.startsWith("x-forwarded-") ||
        name === "x-real-ip" ||
        name === "x-rakazo-phone-key" ||
        name === "authorization"
      ) {
        delete headers[name];
      }
    }
    headers.host = upstream.host;
    if (req.headers.origin) headers.origin = upstream.origin;
    if (headers.referer) delete headers.referer;
    if (headers.cookie) {
      headers.cookie = headers.cookie
        .split(";")
        .filter((part) => !part.trim().startsWith(`${COOKIE_NAME}=`))
        .join(";");
      if (!headers.cookie) delete headers.cookie;
    }
    if (upgrade) {
      headers.connection = "Upgrade";
      headers.upgrade = req.headers.upgrade;
    }
    return headers;
  }

  function responseHeaders(incoming, upgrade = false) {
    const headers = { ...incoming.headers };
    for (const name of HOP_HEADERS) delete headers[name];
    if (headers["access-control-allow-origin"] === upstream.origin) {
      headers["access-control-allow-origin"] = publicOrigin;
    }
    if (headers.location?.startsWith(`${upstream.origin}/`)) {
      headers.location = publicOrigin + headers.location.slice(upstream.origin.length);
    }
    if (upgrade) {
      headers.connection = "Upgrade";
      headers.upgrade = incoming.headers.upgrade;
    }
    return headers;
  }

  const server = http.createServer((req, res) => {
    const respond = (status, text, headers = {}) => {
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        ...headers,
      }).end(text);
    };
    if (!allowedRequest(req)) return respond(403, "Forbidden");
    const pathname = req.url?.split("?", 1)[0];
    if (pathname === CONNECT_PATH && req.method === "GET") {
      const nonce = crypto.randomBytes(18).toString("base64url");
      return respond(200, `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rakazo</title><body><p id="status">正在连接 Rakazo...</p>
<script nonce="${nonce}">
(async () => {
  const key = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  if (!key) {
    document.getElementById("status").textContent = "请重新扫描电脑上的二维码。";
    return;
  }
  try {
    const response = await fetch("${PAIR_PATH}", {
      method: "POST", headers: { "x-rakazo-phone-key": key }, credentials: "same-origin"
    });
    if (!response.ok) throw new Error("pairing failed");
    localStorage.setItem("rakazo.uiLocale", "zh-CN");
    location.replace("/");
  } catch {
    document.getElementById("status").textContent = "连接失败，请重新扫码。";
  }
})();
</script></body></html>`, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
        "x-content-type-options": "nosniff",
      });
    }
    if (pathname === PAIR_PATH) {
      if (
        req.method !== "POST" ||
        req.headers.origin !== publicOrigin ||
        !equalSecret(req.headers["x-rakazo-phone-key"], pairingKey)
      ) {
        return respond(403, "Forbidden");
      }
      req.resume();
      return respond(204, "", {
        "set-cookie": `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      });
    }
    const publicFile = PUBLIC_FILES.has(pathname) && (req.method === "GET" || req.method === "HEAD");
    if (!publicFile && !paired(req)) return respond(401, "请扫描电脑上的 Rakazo 连接二维码。");
    const request = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req),
      agent,
    }, (incoming) => {
      const headers = responseHeaders(incoming);
      const compress =
        req.method === "GET" &&
        incoming.statusCode === 200 &&
        (req.headers["accept-encoding"] || "").split(",").some((item) => item.trim() === "gzip") &&
        !headers["content-encoding"] &&
        /^(text\/(html|css|javascript)|application\/(javascript|json|manifest\+json))/.test(headers["content-type"] || "");
      if (compress) {
        delete headers["content-length"];
        headers["content-encoding"] = "gzip";
        headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : "Accept-Encoding";
      }
      if (pathname.startsWith("/assets/") && incoming.statusCode === 200) {
        headers["cache-control"] = "private, max-age=31536000, immutable";
      }
      res.writeHead(incoming.statusCode, headers);
      incoming.on("error", () => res.destroy());
      if (compress) pipeline(incoming, zlib.createGzip(), res, () => {});
      else incoming.pipe(res);
    });
    request.on("error", () => {
      if (res.headersSent) res.destroy();
      else respond(502, "Rakazo 暂时未启动。");
    });
    req.on("aborted", () => request.destroy());
    res.once("close", () => {
      if (!res.writableFinished) request.destroy();
    });
    req.pipe(request);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!allowedRequest(req, true) || !paired(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const request = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      headers: proxyHeaders(req, true),
      agent: false,
    });
    request.once("upgrade", (incoming, remote, remoteHead) => {
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (const [name, value] of Object.entries(responseHeaders(incoming, true))) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      remote.on("error", () => socket.destroy());
      socket.on("error", () => remote.destroy());
      remote.once("close", () => socket.destroy());
      socket.once("close", () => remote.destroy());
    });
    request.once("response", (incoming) => {
      incoming.resume();
      socket.end(`HTTP/1.1 ${incoming.statusCode} Upstream Response\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    request.on("error", () => socket.destroy());
    socket.on("error", () => request.destroy());
    socket.once("close", () => request.destroy());
    request.end();
  });
  server.on("close", () => agent.destroy());
  return server;
}

module.exports = { createGateway, sessionToken, COOKIE_NAME, CONNECT_PATH, PAIR_PATH };
