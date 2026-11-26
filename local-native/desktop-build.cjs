const { createRequire } = require("node:module");
const path = require("node:path");
const source = process.env.RAKAZO_SRC || path.resolve(__dirname, "..");
const desktopPackage = path.join(source, "apps/desktop/package.json");
const base = require(desktopPackage).build;
const desktopRequire = createRequire(desktopPackage);
const nativeRequire = createRequire(desktopRequire.resolve("koffi"));

module.exports = {
  ...base,
  files: [
    ...base.files,
    ...["x64", "arm64"].map((arch) => ({
      from: path.dirname(nativeRequire.resolve(`@koromix/koffi-darwin-${arch}`)),
      to: `node_modules/@koromix/koffi-darwin-${arch}`,
      filter: ["**/*"],
    })),
  ],
  asarUnpack: ["**/*.node"],
  electronDist: path.join(source, "apps/desktop/node_modules/electron/dist"),
  extraMetadata: {
    ...base.extraMetadata,
    version: "0.11.0-local.20261123.2",
  },
  publish: null,
  mac: {
    ...base.mac,
    icon: "assets/icon-macos.png",
    identity: null,
    notarize: false,
    extraResources: [
      { from: "build/speech/rakazo-speech", to: "speech/rakazo-speech" },
      { from: "assets/es.lproj", to: "es.lproj" },
      { from: "assets/pl.lproj", to: "pl.lproj" },
    ],
  },
};
