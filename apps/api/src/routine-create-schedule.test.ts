import { CreateRoutineInput } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRoutineSchedule, routineNextRunAt } from "./routines.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T04:00:00Z"));
});

afterEach(() => vi.useRealTimers());

describe("one-time routine creation", () => {
  const input = (patch: Record<string, unknown> = {}) =>
    CreateRoutineInput.parse({
      botId: "bot-1",
      name: "Reminder",
      prompt: "Check the report",
      crons: ["@once"],
      active: true,
      runAt: "2026-11-17T13:00:00+08:00",
      ...patch,
    });

  it("arms a future instant with its explicit offset", () => {
    const schedule = input();
    expect(() => assertRoutineSchedule(schedule)).not.toThrow();
    expect(routineNextRunAt(schedule)?.toISOString()).toBe("2026-11-17T05:00:00.000Z");
  });

  it.each([undefined, "2026-11-17T03:00:00Z"])("rejects an active invalid run time %s", (runAt) => {
    expect(() => assertRoutineSchedule(input({ runAt }))).toThrow();
  });

  it("keeps a paused draft inert without a run time", () => {
    const schedule = input({ active: false, runAt: undefined });
    expect(() => assertRoutineSchedule(schedule)).not.toThrow();
    expect(routineNextRunAt(schedule)).toBeNull();
  });

  it("rejects a run time on a recurring schedule and mixed one-time schedules", () => {
    expect(() => assertRoutineSchedule(input({ crons: ["0 9 * * *"] }))).toThrow();
    expect(() => assertRoutineSchedule(input({ crons: ["@once", "0 9 * * *"] }))).toThrow();
  });
});
