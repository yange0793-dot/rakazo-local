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
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const change = vi.fn();
const preview = vi.fn();

async function render(level: ThinkingLevel = "high", disabled = false) {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <EffortBar level={level} onChange={change} onPreview={preview} disabled={disabled} />
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
  await adjust(5);
  expect(preview).toHaveBeenLastCalledWith("max");
  expect(slider().getAttribute("aria-valuetext")).toBe("Max");
  expect(change).not.toHaveBeenCalled();
  await act(async () => slider().dispatchEvent(new Event("pointerup", { bubbles: true })));
  expect(change).toHaveBeenCalledExactlyOnceWith("max");
  expect(preview).toHaveBeenLastCalledWith(null);
  await act(async () => slider().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(change).toHaveBeenCalledTimes(1);
});

it("shows protocol mapping without changing the saved choice or hiding any of the six stops", async () => {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <EffortBar
          level="minimal"
          supportedLevels={["low", "medium", "high", "xhigh", "max"]}
          onChange={change}
        />
      </I18nProvider>,
    ),
  );
  expect(container.textContent).toContain("Saved Minimal; using Low.");
  expect(slider().value).toBe("0");
  expect(container.querySelectorAll("button")).toHaveLength(6);
  expect(change).not.toHaveBeenCalled();
});

it("lets keyboard adjustment be cancelled or confirmed", async () => {
  await render();
  await adjust(1);
  expect(change).not.toHaveBeenCalled();
  await act(async () =>
    slider().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(slider().value).toBe("3");
  expect(change).not.toHaveBeenCalled();
  await adjust(5);
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
  expect(slider().value).toBe("3");
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

it("shows all six stops and preserves a saved effort", async () => {
  await render("max");
  expect(slider().max).toBe("5");
  expect(slider().getAttribute("aria-valuetext")).toBe("Max");
  expect(container.textContent).not.toContain("Saved Max; using High.");
  expect(container.querySelector('button[aria-label="Max"]')).not.toBeNull();
  expect(container.querySelector('button[aria-label="Off"]')).toBeNull();
  expect(
    container.querySelector<HTMLElement>(".effort-bar")!.style.getPropertyValue("--effort-count"),
  ).toBe("6");
  await act(async () => slider().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(change).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="High"]')!.click(),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith("high");
});

it("keeps the six effort stops", async () => {
  await render("max");
  expect(slider().max).toBe("5");
  expect(slider().getAttribute("aria-valuetext")).toBe("Max");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Minimal"]')!.click(),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith("minimal");
});

it("keeps the six effort levels", async () => {
  await render("max");
  expect(slider()).not.toBeNull();
  expect(slider().max).toBe("5");
  expect(change).not.toHaveBeenCalled();
});

it("keeps all six levels", async () => {
  await render("max");
  expect(slider().disabled).toBe(false);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="High"]')!.click(),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith("high");
});
it.each(["minimal", "low", "medium", "high", "xhigh", "max"] as const)(
  "switches directly to %s when its point is clicked",
  async (level) => {
    await render(level === "high" ? "low" : "high");
    const index = ["minimal", "low", "medium", "high", "xhigh", "max"].indexOf(level);
    const point = container.querySelectorAll<HTMLElement>(".effort-stop-hit")[index]!;
    await act(async () => point.click());
    expect(change).toHaveBeenCalledExactlyOnceWith(level);
    await render(level);
    expect(slider().value).toBe(String(index));
  },
);
