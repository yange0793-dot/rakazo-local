// @vitest-environment jsdom

import { reduceThreadSnapshot } from "@rakazo/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { subscribeThread } from "./api-live";
import type { MobileSnapshot } from "./mobile-types";
import { ThreadJumpAnchor } from "./thread-jump";
import { useThreadLiveSubscription } from "./thread-live";

const stream = vi.hoisted(() => ({ subscribe: vi.fn(), haptic: vi.fn() }));
vi.mock("./api", () => ({ rpc: async () => ({ cursor: 10 }) }));
vi.mock("./api-live", () => ({ subscribeThread: stream.subscribe }));
vi.mock("./haptics", () => ({
  getHapticsEnabled: () => true,
  hapticSuccess: stream.haptic,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./user-error", () => ({ errorText: String }));

it("keeps the refreshed snapshot while acknowledging buffered events and resuming from transport", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const ref = <T,>(current: T) => ({ current });
  const start: MobileSnapshot = {
    botId: "bot",
    threadId: "thread",
    cursor: 10,
    messages: [],
    olderCursor: null,
    run: null,
  };
  const snapRef = ref<MobileSnapshot | null>(start);
  const delta = {
    type: "thread.progress",
    threadId: "thread",
    botId: "bot",
    runId: "run",
    seq: 11,
    createdAt: "2026-01-01T00:00:00Z",
    payload: { delta: "piece", streaming: true },
  };
  const completed = { ...delta, type: "run.completed", runId: "completed", seq: 12, payload: {} };
  const message = { ...delta, type: "thread.message.created", seq: 13, payload: { role: "bot" } };
  const projected = reduceThreadSnapshot(start, delta)!;
  const refreshed = { ...projected, cursor: 14 };
  const commitSnap = vi.fn((next: MobileSnapshot | null) => {
    snapRef.current = next;
  });
  const terminalRunIds = ref(new Set<string>());
  const markReadIfVisible = vi.fn();
  const refreshMentionBots = vi.fn(async () => undefined);
  let deliver!: Parameters<typeof subscribeThread>[2];
  let disconnect!: () => void;
  stream.subscribe.mockImplementation(
    (_target, _cursor, handler: typeof deliver, signal: AbortSignal) => {
      deliver = handler;
      return new Promise<void>((resolve, reject) => {
        disconnect = () => reject({ status: 503 });
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  );
  const refresh = vi.fn().mockResolvedValueOnce(start).mockResolvedValue(refreshed);
  function Probe() {
    useThreadLiveSubscription({
      botId: "bot",
      foreground: true,
      focused: true,
      readOnly: false,
      sessionEpoch: 1,
      userId: "user",
      historyEpoch: ref(0),
      expandedHistoryThread: ref(null),
      pinnedAroundRef: ref(null),
      jumpScrollTarget: ref(null),
      jumpAnchor: ref(new ThreadJumpAnchor()),
      snapRef,
      terminalRunIds,
      readVisibleTarget: ref("thread"),
      showSavedThread() {},
      refresh,
      commitSnap,
      setError() {},
      refreshMentionBots,
      markReadIfVisible,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(stream.subscribe.mock.calls[0]?.[1]).toBe(10);
    snapRef.current = refreshed;
    expect(JSON.stringify(refreshed.messages)).toContain('"text":"piece"');

    deliver(delta);
    deliver(completed);
    deliver(completed);
    deliver(message);
    expect(commitSnap).not.toHaveBeenCalled();
    expect(snapRef.current).toBe(refreshed);
    expect(terminalRunIds.current.has("completed")).toBe(true);
    expect(stream.haptic).toHaveBeenCalledOnce();
    expect(refreshMentionBots).toHaveBeenCalled();
    expect(markReadIfVisible).toHaveBeenCalledOnce();

    disconnect();
    await vi.advanceTimersByTimeAsync(250);
    expect(stream.subscribe.mock.calls[1]?.[1]).toBe(13);
    deliver({ ...delta, seq: 15, payload: { delta: " more", streaming: true } });
    expect(commitSnap).toHaveBeenCalledOnce();
    expect(snapRef.current?.cursor).toBe(15);
    expect(JSON.stringify(snapRef.current?.messages)).toContain('"text":"piece more"');
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
