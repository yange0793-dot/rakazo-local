// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: (props: ComponentProps<"label">) => <label {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import { LocalMemorySettingsForm } from "./LocalMemorySettingsForm";
import { defaultMemoryProviderSettings, memoryProviderSettings } from "./registry";

let container: HTMLDivElement;
let root: Root;
const onConnect = vi.fn();
beforeEach(() => {
  // The registry reads its labels through the shared catalog, so a locale must be active.
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onConnect.mockReset().mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(busy = false) {
  await act(async () => root.render(<LocalMemorySettingsForm busy={busy} onConnect={onConnect} />));
}
async function type(type: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[type="${type}"]`);
  if (!input) throw new Error("Missing input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("registers a generic local provider without vendor copy", () => {
  const registration = memoryProviderSettings("local");
  expect(defaultMemoryProviderSettings().id).toBe("local");
  expect(registration?.name).toBe("Local memory");
  expect(registration?.SettingsForm).toBe(LocalMemorySettingsForm);
  expect(
    registration?.connectedLabel({
      provider: "local",
      settings: { baseUrl: "http://localhost:4321" },
      defaultMemoryScope: "isolated",
      updatedAt: "",
    }),
  ).toBe("http://localhost:4321");
});

it("requires explicit endpoint and token, emits generic settings, and clears a saved token", async () => {
  await render();
  const button = container.querySelector("button");
  expect(button?.disabled).toBe(true);
  await type("url", " http://localhost:4321 ");
  await type("password", " synthetic-token ");
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  expect(onConnect).toHaveBeenCalledWith({
    settings: { baseUrl: "http://localhost:4321" },
    credentials: { token: "synthetic-token" },
  });
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
});

it("keeps credentials after a failed connection and disables fields while busy", async () => {
  onConnect.mockResolvedValue(false);
  await render();
  await type("url", "http://localhost:4321");
  await type("password", "synthetic-token");
  await act(async () => container.querySelector("button")?.click());
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
    "synthetic-token",
  );
  await render(true);
  expect([...container.querySelectorAll("input")].every((input) => input.disabled)).toBe(true);
  expect(container.querySelector("button")?.disabled).toBe(true);
});
