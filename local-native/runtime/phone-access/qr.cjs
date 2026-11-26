"use strict";

const fs = require("node:fs");
const path = require("node:path");
const QRCode = require("qrcode");
const { CONNECT_PATH } = require("./gateway.cjs");

process.umask(0o077);

async function writeQr(config) {
  const root = path.resolve(__dirname, "../..");
  const png = await QRCode.toBuffer(`${config.publicOrigin}${CONNECT_PATH}#${config.pairingKey}`, {
    width: 720,
    margin: 4,
    errorCorrectionLevel: "M",
  });
  fs.writeFileSync(path.join(root, "phone-connect.png"), png, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "phone-connect.html"), `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rakazo 手机连接</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-content:center;justify-items:center;padding:24px;background:#fff;color:#171717;font:16px system-ui,sans-serif;letter-spacing:0}
h1{font-size:28px;margin:0 0 24px;font-weight:600}img{width:360px;max-width:100%;height:auto}p{margin:20px 0 0;color:#555}
</style>
<h1>Rakazo 手机连接</h1>
<img src="data:image/png;base64,${png.toString("base64")}" width="360" height="360" alt="Rakazo 手机连接二维码">
<p>扫码连接</p>
</html>\n`, { mode: 0o600 });
}
module.exports = { writeQr };

if (require.main === module) {
  const configPath = path.join(__dirname, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  writeQr(config)
    .then(() => console.log("Created phone-connect.png and phone-connect.html"))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
