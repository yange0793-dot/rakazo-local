import { mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerHealthIsFresh } from "./health.js";

const roots: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function healthPath() {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-worker-health-"));
  roots.push(root);
  return path.join(root, "worker-health.json");
}

async function startHealth(file: string, reconciled: () => number) {
  vi.stubEnv("WORKER_HEALTH_FILE", file);
  vi.resetModules();
  const { startWorkerHealth } = await import("./health.js");
  const stop = startWorkerHealth(reconciled);
  stops.push(stop);
  return stop;
}

function readHealth(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("worker health", () => {
  it("publishes reconciliation freshness and removes its heartbeat on shutdown", async () => {
    vi.useFakeTimers();
    const file = healthPath();
    const reconciled = vi.fn(() => 123);
    const stop = await startHealth(file, reconciled);
    await vi.waitFor(() =>
      expect(readHealth(file)).toMatchObject({ pid: process.pid, reconciled: 123 }),
    );
    reconciled.mockReturnValue(456);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(readHealth(file).reconciled).toBe(456));
    await stop();
    expect(() => readHealth(file)).toThrow(/ENOENT/);
    const calls = reconciled.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconciled).toHaveBeenCalledTimes(calls);
  });

  it("keeps heartbeats in separate stack roots", async () => {
    const first = healthPath();
    const second = healthPath();
    const stopFirst = await startHealth(first, () => 123);
    await startHealth(second, () => 456);
    await vi.waitFor(() => {
      expect(readHealth(first).reconciled).toBe(123);
      expect(readHealth(second).reconciled).toBe(456);
    });
    const secondHeartbeat = readHealth(second);
    await stopFirst();
    expect(() => readHealth(first)).toThrow(/ENOENT/);
    expect(readHealth(second)).toEqual(secondHeartbeat);
  });

  it("keeps a replacement's heartbeat through the previous writer's refresh and shutdown", async () => {
    vi.useFakeTimers();
    const file = healthPath();
    const original = vi.fn(() => 123);
    const stopOriginal = await startHealth(file, original);
    await vi.waitFor(() => expect(readHealth(file).reconciled).toBe(123));
    const originalTarget = readlinkSync(file);
    await startHealth(file, () => 456);
    await vi.waitFor(() => expect(readHealth(file).reconciled).toBe(456));
    const replacement = readlinkSync(file);
    expect(replacement).not.toBe(originalTarget);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(original).toHaveBeenCalledTimes(2));
    await stopOriginal();
    expect(readlinkSync(file)).toBe(replacement);
    expect(readHealth(file).reconciled).toBe(456);
    expect(() => readHealth(path.join(path.dirname(file), originalTarget))).toThrow(/ENOENT/);
  });

  it("requires the expected worker PID when a native probe supplies it", () => {
    const fresh = { heartbeat: 1_000_000, reconciled: 1_000_000, pid: 42 };
    expect(workerHealthIsFresh(fresh, 1_000_000, 42)).toBe(true);
    expect(workerHealthIsFresh(fresh, 1_000_000, 43)).toBe(false);
    expect(workerHealthIsFresh({ ...fresh, pid: undefined }, 1_000_000, 42)).toBe(false);
  });

  it("Docker probes reject stale heartbeats and stalled reconciliation", () => {
    expect(workerHealthIsFresh({ heartbeat: 1_000_000, reconciled: 1_000_000 }, 1_000_000)).toBe(
      true,
    );
    for (const health of [
      {},
      { heartbeat: 0, reconciled: 1_000_000 },
      { heartbeat: 1_000_000, reconciled: 0 },
      { heartbeat: "invalid", reconciled: NaN },
      { heartbeat: 1_000_000 - 90_001, reconciled: 1_000_000 },
      { heartbeat: 1_000_000, reconciled: 1_000_000 - 300_001 },
      { heartbeat: 1_000_000 + 5_001, reconciled: 1_000_000 },
    ]) {
      expect(workerHealthIsFresh(health, 1_000_000)).toBe(false);
    }
    for (const name of ["images", "prod", "topology", ""]) {
      const suffix = name ? `.${name}` : "";
      const source = readFileSync(
        new URL(`../../../infra/compose/docker-compose${suffix}.yml`, import.meta.url),
        "utf8",
      );
      expect(source.slice(source.indexOf("\n  worker:"))).toContain(
        'test: ["CMD", "node", "dist/health-check.js"]',
      );
    }
  });
});
