import { describe, expect, it } from "vitest";
import { isLocalInstallSessionId, localRequestAllowed } from "./local-install.js";

describe("local installation", () => {
  it.each([
    ["127.0.0.1:3100", {}, true],
    ["localhost:5173", { "x-forwarded-for": "::1, 127.0.0.1" }, true],
    ["[::1]:5173", {}, true],
    ["public.example", {}, false],
    ["localhost:5173", { "x-forwarded-for": "192.0.2.1, 127.0.0.1" }, false],
    ["localhost:5173", { "x-forwarded-host": "public.example" }, false],
  ] as const)("checks the listener authority and proxy chain: %s %j", (host, headers, ok) => {
    expect(localRequestAllowed(host, (name) => (headers as Record<string, string>)[name])).toBe(ok);
  });

  it("accepts installation identifiers, not old login tokens", () => {
    expect(isLocalInstallSessionId("rakazo-local-install:1234-abcd")).toBe(true);
    expect(isLocalInstallSessionId("old-login-token")).toBe(false);
  });
});
