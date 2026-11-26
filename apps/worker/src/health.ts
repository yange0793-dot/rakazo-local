import { randomUUID } from "node:crypto";
import { rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLogger, logSinkHealth } from "@rakazo/logging";

export const WORKER_HEALTH_FILE =
  process.env.WORKER_HEALTH_FILE || "/tmp/rakazo-worker-health.json";

/** A separate Docker process can detect a dead or blocked worker even when it cannot log. */
export function startWorkerHealth(lastReconciled: () => number) {
  const file = `${WORKER_HEALTH_FILE}.${process.pid}.${randomUUID()}`;
  const stage = `${file}.tmp`;
  const link = `${file}.link`;
  let published = false;
  let stopped = false;
  let writing: Promise<void> | undefined;
  const write = async () => {
    await writeFile(
      stage,
      JSON.stringify({
        pid: process.pid,
        heartbeat: Date.now(),
        reconciled: lastReconciled(),
        telemetry: logSinkHealth(),
      }),
      { mode: 0o600 },
    );
    await rename(stage, file);
    if (!published) {
      // Only the initial publication changes the shared link. A replaced worker
      // keeps refreshing and eventually removes only its own file.
      await symlink(path.basename(file), link);
      try {
        await rename(link, WORKER_HEALTH_FILE);
        published = true;
      } finally {
        if (!published) await unlink(link);
      }
    }
  };
  const publish = () => {
    if (writing || stopped) return;
    writing = write()
      .catch((error) => {
        getLogger().error("worker heartbeat failed", error);
      })
      .finally(() => {
        writing = undefined;
      });
  };
  void publish();
  const timer = setInterval(() => void publish(), 30_000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await writing;
    await Promise.all([file, stage].map((name) => unlink(name).catch(() => undefined)));
  };
}

export function workerHealthIsFresh(
  value: unknown,
  now = Date.now(),
  expectedPid?: number,
): boolean {
  if (!value || typeof value !== "object") return false;
  const health = value as Record<string, unknown>;
  if (expectedPid !== undefined && health.pid !== expectedPid) return false;
  const checks = [
    ["heartbeat", 90_000],
    ["reconciled", 300_000],
  ] as const;
  return checks.every(([key, limit]) => {
    const timestamp = health[key];
    return (
      typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      timestamp <= now + 5_000 &&
      now - timestamp <= limit
    );
  });
}
