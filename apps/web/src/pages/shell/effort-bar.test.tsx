// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ThinkingLevel } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EffortBar } from "./bot-settings-sections";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const change = vi.fn();
const preview = vi.fn();

const fullLevels: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

async function render(
  level: ThinkingLevel = "high",
  disabled = false,
  levels: ThinkingLevel[] = fullLevels,
) {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <EffortBar
          level={level}
          levels={levels}
          onChange={change}
          onPreview={preview}
          disabled={disabled}
        />
      </I18nProvider>,
    ),
  );
}

function slider() {
  return container.querySelector<HTMLInputElement>('input[type="range"]')!;
}

async function adjust(value: number) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      slider(),
      String(value),
    );
    slider().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  change.mockReset();
  preview.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("previews a drag and saves only the released stop, once", async () => {
  await render();
  await act(async () => slider().dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await adjust(0);
  await adjust(4);
  expect(preview).toHaveBeenLastCalledWith("max");
  expect(slider().getAttribute("aria-valuetext")).toBe("Max");
  expect(change).not.toHaveBeenCalled();
  await act(async () => slider().dispatchEvent(new Event("pointerup", { bubbles: true })));
  expect(change).toHaveBeenCalledExactlyOnceWith("max");
  expect(preview).toHaveBeenLastCalledWith(null);
  await act(async () => slider().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(change).toHaveBeenCalledTimes(1);
});

it("lets keyboard adjustment be cancelled or confirmed", async () => {
  await render();
  await adjust(3);
  expect(change).not.toHaveBeenCalled();
  await act(async () =>
    slider().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(slider().value).toBe("2");
  expect(change).not.toHaveBeenCalled();
  await adjust(4);
  await act(async () =>
    slider().dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith("max");
});

it("accepts a saved value or rollback and allows retrying the same stop", async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Max"]')!.click(),
  );
  await render("max", true);
  expect(slider().disabled).toBe(true);
  await render("high");
  expect(slider().value).toBe("2");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Max"]')!.click(),
  );
  expect(change.mock.calls).toEqual([["max"], ["max"]]);
});

it("does not rewrite an older setting just because the field loses focus", async () => {
  await render("minimal");
  await act(async () => slider().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(change).not.toHaveBeenCalled();
});

it("shows only supported stops and explains an unsupported saved effort", async () => {
  await render("max", false, ["off", "low", "medium", "high"]);
  expect(slider().max).toBe("2");
  expect(slider().getAttribute("aria-valuetext")).toBe("High");
  expect(container.textContent).toContain("Saved Max; using High.");
  expect(container.querySelector('button[aria-label="Max"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Off"]')).toBeNull();
  expect(
    container.querySelector<HTMLElement>(".effort-bar")!.style.getPropertyValue("--effort-count"),
  ).toBe("3");
  await act(async () => slider().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(change).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="High"]')!.click(),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith("high");
});

it("updates supported stops when model capabilities change", async () => {
  await render("max");
  await render("max", false, ["minimal", "low", "high"]);
  expect(slider().max).toBe("2");
  expect(slider().getAttribute("aria-valuetext")).toBe("High");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Minimal"]')!.click(),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith("minimal");
});

it("does not invent an effort scale for a model without available levels", async () => {
  await render("max", false, []);
  expect(slider()).toBeNull();
  expect(container.textContent).toContain("Effort unavailable for this model");
  expect(change).not.toHaveBeenCalled();
});

it("keeps a single supported level usable without a movable range", async () => {
  await render("max", false, ["high"]);
  expect(slider().disabled).toBe(true);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="High"]')!.click(),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith("high");
});
it.each(["low", "medium", "high", "xhigh", "max"] as const)(
  "switches directly to %s when its point is clicked",
  async (level) => {
    await render(level === "high" ? "low" : "high");
    const index = ["low", "medium", "high", "xhigh", "max"].indexOf(level);
    const point = container.querySelectorAll<HTMLElement>(".effort-stop-hit")[index]!;
    await act(async () => point.click());
    expect(change).toHaveBeenCalledExactlyOnceWith(level);
    expect(slider().value).toBe(String(index));
  },
);
