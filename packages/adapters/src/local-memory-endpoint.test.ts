import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLocalMemoryEndpointAllowed,
  localMemoryEndpointAllowed,
  normalizeLocalMemoryBaseUrl,
} from "./local-memory-endpoint.js";

afterEach(() => vi.unstubAllEnvs());

describe("local memory endpoint policy", () => {
  it("authorizes the exact origin, not a host or every local service", () => {
    const allowed = "http://127.0.0.1:17676/, http://[::1]:17676";
    expect(assertLocalMemoryEndpointAllowed("http://127.0.0.1:17676", allowed)).toBe(
      "http://127.0.0.1:17676",
    );
    expect(localMemoryEndpointAllowed("http://[::1]:17676/", allowed)).toBe(true);
    expect(localMemoryEndpointAllowed("http://127.0.0.1:17677", allowed)).toBe(false);
    expect(localMemoryEndpointAllowed("https://127.0.0.1:17676", allowed)).toBe(false);
    expect(localMemoryEndpointAllowed("http://127.0.0.2:17676", allowed)).toBe(false);
  });

  it("is independent from the global private MCP switch and observes revocation", () => {
    vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", "true");
    vi.stubEnv("RAKAZO_LOCAL_MEMORY_ALLOWED_URLS", "");
    expect(() => assertLocalMemoryEndpointAllowed("http://127.0.0.1:17676")).toThrow(/allowlist/);
    vi.stubEnv("RAKAZO_LOCAL_MEMORY_ALLOWED_URLS", "http://127.0.0.1:17676");
    expect(localMemoryEndpointAllowed("http://127.0.0.1:17676")).toBe(true);
    vi.stubEnv("RAKAZO_LOCAL_MEMORY_ALLOWED_URLS", "");
    expect(localMemoryEndpointAllowed("http://127.0.0.1:17676")).toBe(false);
  });

  it.each([
    "http://localhost:17676",
    "http://memory.example.test:17676",
    "http://10.0.0.8:17676",
    "http://169.254.169.254",
    "http://203.0.113.8:17676",
    "http://[::]:17676",
    "http://[::ffff:127.0.0.1]:17676",
    "file:///tmp/index",
    "http://127.0.0.1:17676/path",
    "http://127.0.0.1:17676/?",
    "http://127.0.0.1:17676/#",
    "http://token@127.0.0.1:17676",
    "http://127.0.0.1:17676/../",
    "http://127.0.0.1:17676\\",
    "http://0x7f000001:17676",
    "http://2130706433:17676",
    "http://127.1:17676",
    "http://127.000.000.001:17676",
    "http://127.0.0.1:17676//",
  ])("rejects nonliteral or ambiguous target %s", (baseUrl) => {
    expect(() => normalizeLocalMemoryBaseUrl(baseUrl)).toThrow();
  });

  it("does not accept a wildcard allowlist", () => {
    expect(() => assertLocalMemoryEndpointAllowed("http://127.0.0.1:17676", "*")).toThrow();
  });
});
