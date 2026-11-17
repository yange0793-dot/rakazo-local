// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { printPage } from "./print-page";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function fixture() {
  const page = document.body.appendChild(document.createElement("div"));
  const box = page.appendChild(document.createElement("div"));
  box.dataset.pageFrame = "true";
  const frame = box.appendChild(document.createElement("iframe"));
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  return { page, box, frame, post };
}

it("prints only after its own frame reports paper height, then restores the page", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => callback(0));
  const { page, box, frame, post } = fixture();
  const print = vi.spyOn(window, "print").mockImplementation(() => {
    expect(box.style.getPropertyValue("--page-height")).toBe("2400px");
    expect(page.hasAttribute("data-page-print-preparing")).toBe(true);
  });
  const pending = printPage(page);
  expect(post).toHaveBeenCalledWith({ type: "rakazo-page:prepare-print" }, "*");
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: { type: "rakazo-page:print-ready", height: 1 },
    }),
  );
  expect(print).not.toHaveBeenCalled();
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: { type: "rakazo-page:print-ready", height: 2400 },
    }),
  );
  await pending;
  expect(print).toHaveBeenCalledTimes(1);
  expect(page.hasAttribute("data-page-print-preparing")).toBe(false);
  expect(post).toHaveBeenLastCalledWith({ type: "rakazo-page:restore-print" }, "*");
});

it("restores a stalled page so printing can be retried", async () => {
  vi.useFakeTimers();
  const { page, post } = fixture();
  const print = vi.spyOn(window, "print").mockImplementation(() => {});
  const failed = expect(printPage(page)).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(15_000);
  await failed;
  expect(print).not.toHaveBeenCalled();
  expect(page.hasAttribute("data-page-print-preparing")).toBe(false);
  expect(post).toHaveBeenLastCalledWith({ type: "rakazo-page:restore-print" }, "*");
});
