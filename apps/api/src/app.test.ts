import { describe, expect, it } from "vitest";
import { rpcOriginAllowed } from "./app.js";

// The deployment's own values: the desktop shell loads the web app from WEB_ORIGIN, and the
// tunnel is listed as an extra auth origin.
const env = {
  webOrigin: "http://127.0.0.1:5173",
  apiUrl: "http://127.0.0.1:3100",
  authUrl: "http://127.0.0.1:5173",
  extraAuthOrigins: ["https://kiln-bagpipe.example.test"],
};

describe("rpcOriginAllowed", () => {
  it("lets a request with no Origin through: the desktop shell and native clients", () => {
    expect(rpcOriginAllowed(undefined, env)).toBe(true);
  });

  it("lets the app's own origins through", () => {
    for (const origin of [
      // The page the desktop shell loads, and the dev/preview server's proxy target.
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3100",
      "https://kiln-bagpipe.example.test",
      "rakazo://sign-in",
    ]) {
      expect(rpcOriginAllowed(origin, env), origin).toBe(true);
    }
  });

  it("refuses a writable call from a page on another site", () => {
    for (const origin of [
      "https://evil.example",
      "http://127.0.0.1:9999",
      "https://kiln-bagpipe.example.test.evil.example",
    ]) {
      expect(rpcOriginAllowed(origin, env), origin).toBe(false);
    }
  });
});
