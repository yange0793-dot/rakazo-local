import { readFileSync } from "node:fs";
import { WORKER_HEALTH_FILE, workerHealthIsFresh } from "./health.js";

try {
  const pid = process.env.WORKER_HEALTH_PID;
  const expectedPid = pid === undefined ? undefined : Number(pid);
  if (expectedPid !== undefined && (!Number.isSafeInteger(expectedPid) || expectedPid < 1)) {
    throw new Error("Invalid WORKER_HEALTH_PID");
  }
  process.exitCode = workerHealthIsFresh(
    JSON.parse(readFileSync(WORKER_HEALTH_FILE, "utf8")),
    Date.now(),
    expectedPid,
  )
    ? 0
    : 1;
} catch {
  process.exitCode = 1;
}
