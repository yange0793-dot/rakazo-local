import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyResolvedAppearance,
  readSystemAppearance,
  watchSystemAppearance,
} from "./ui-appearance";

afterEach(() => vi.unstubAllGlobals());

describe("ui-appearance", () => {
  it("treats matching light media as light", () => {
    expect(readSystemAppearance({ matches: true })).toBe("light");
    expect(readSystemAppearance({ matches: false })).toBe("dark");
  });

  it("writes data-theme and color-scheme on the root", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" },
    };
    applyResolvedAppearance("light", root as unknown as HTMLElement);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("keeps the screen theme through printing and resumes system changes afterward", () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    const print = { matches: false };
    const host = Object.assign(new EventTarget(), {
      matchMedia: (query: string) => (query === "print" ? print : media),
    });
    vi.stubGlobal("window", host);
    const onChange = vi.fn();
    const stop = watchSystemAppearance(onChange);

    host.dispatchEvent(new Event("beforeprint"));
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(onChange).not.toHaveBeenCalled();
    print.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(onChange).not.toHaveBeenCalled();

    print.matches = false;
    media.matches = false;
    host.dispatchEvent(new Event("afterprint"));
    expect(onChange).toHaveBeenLastCalledWith("dark");
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenLastCalledWith("light");

    stop();
    onChange.mockClear();
    media.dispatchEvent(new Event("change"));
    host.dispatchEvent(new Event("afterprint"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores print media changes even without a beforeprint event", () => {
    const media = Object.assign(new EventTarget(), { matches: true });
    const host = Object.assign(new EventTarget(), {
      matchMedia: (query: string) => (query === "print" ? { matches: true } : media),
    });
    vi.stubGlobal("window", host);
    const onChange = vi.fn();
    const stop = watchSystemAppearance(onChange);
    media.dispatchEvent(new Event("change"));
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });
});
