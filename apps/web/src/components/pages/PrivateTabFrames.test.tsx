// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PrivateTabFrames } from "./PrivateTabFrames";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));

it("does not display or retain a sensitive frame received after the view closes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const create = vi.fn(() => "blob:one");
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
  const root = createRoot(document.createElement("div"));
  let resolve!: (b: Blob) => void;
  let signal!: AbortSignal;
  const read = (s: AbortSignal) => {
    signal = s;
    return new Promise<Blob>((r) => {
      resolve = r;
    });
  };
  try {
    await act(async () => root.render(<PrivateTabFrames readFrame={read} />));
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
    resolve(new Blob(["frame"], { type: "image/png" }));
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("recovers a missed frame without requiring the view to close", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:frame", revokeObjectURL: revoke });
  const container = document.createElement("div");
  const root = createRoot(container);
  const read = vi
    .fn()
    .mockResolvedValueOnce(new Blob(["frame"], { type: "image/png" }))
    .mockRejectedValueOnce(new Error("frame unavailable"))
    .mockResolvedValue(new Blob(["frame"], { type: "image/png" }));
  try {
    await act(async () => root.render(<PrivateTabFrames readFrame={read} />));
    expect(container.querySelector("img")).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(container.querySelector("img")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:frame");
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(container.querySelector("img")).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("stops after repeated failures and lets the user reconnect in place", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:frame", revokeObjectURL: vi.fn() });
  const container = document.createElement("div");
  const root = createRoot(container);
  const read = vi.fn().mockRejectedValue(new Error("frame unavailable"));
  try {
    await act(async () => root.render(<PrivateTabFrames readFrame={read} />));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(container.querySelector("button")?.textContent).toBe("Try again");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue(new Blob(["frame"], { type: "image/png" }));
    await act(async () => container.querySelector("button")?.click());
    expect(container.querySelector("img")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
