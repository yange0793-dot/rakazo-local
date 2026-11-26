// @vitest-environment jsdom

import type { ChatModelChoice } from "@rakazo/core";
import type { PopoverContent } from "@rakazo/ui-web/components/ui/popover";
import type { ComponentProps, ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatModelPicker } from "./chat-model-picker";

const { popoverProps } = vi.hoisted(() => ({ popoverProps: vi.fn() }));

vi.mock("@rakazo/ui-web/components/ui/popover", async (importOriginal) => {
  const actual = await importOriginal<{ PopoverContent: typeof PopoverContent }>();
  return {
    ...actual,
    PopoverContent: (props: ComponentProps<typeof PopoverContent>) => {
      popoverProps(props);
      return createElement(actual.PopoverContent, props);
    },
  };
});

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

function choices(count: number): ChatModelChoice[] {
  return [
    { key: "", label: "Space default" },
    ...Array.from({ length: count }, (_, index) => ({
      key: `openrouter::vendor/model-${index + 1}`,
      label: `Model ${index + 1} (OpenRouter)`,
      provider: "openrouter",
      providerLabel: "OpenRouter",
      modelLabel: `Model ${index + 1}`,
      modelId: `vendor/model-${index + 1}`,
    })),
  ];
}

describe("ChatModelPicker", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = () => undefined;
    onChange.mockReset();
    popoverProps.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (list: ChatModelChoice[], value: string) =>
    act(() =>
      root.render(<ChatModelPicker id="model" choices={list} value={value} onChange={onChange} />),
    );
  const options = () => [...document.querySelectorAll('[role="option"]')];
  const search = (text: string) =>
    act(() => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("shows separate channel and model selects for a short list", () => {
    render(choices(9), "");
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.options,
    ).toHaveLength(2);
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.options,
    ).toHaveLength(1);
  });

  it("keeps compatible connections separate and filters models by the selected connection", () => {
    const list: ChatModelChoice[] = [
      {
        key: "openai-compatible::channel-a/model-a",
        connectionId: "connection-a",
        provider: "openai-compatible",
        providerLabel: "Channel A",
        label: "Model A",
      },
      {
        key: "openai-compatible::channel-b/model-b",
        connectionId: "connection-b",
        provider: "openai-compatible",
        providerLabel: "Channel B",
        label: "Model B",
      },
    ];
    render(list, list[0]!.key);
    const channel = container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
    const models = () =>
      [...container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.options].map(
        (option) => option.textContent,
      );
    expect([...channel.options].map((option) => option.textContent)).toEqual([
      "Channel A",
      "Channel B",
    ]);
    expect(models()).toEqual(["Model A"]);
    act(() => {
      channel.value = "connection:connection-b";
      channel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(list[1]!.key);
    render(list, list[1]!.key);
    expect(models()).toEqual(["Model B"]);
  });

  it("changes the selected model with the channel and marks text-only models", () => {
    const list = [
      ...choices(2).map((choice, index) =>
        index === 1 ? { ...choice, images: false } : { ...choice, images: true },
      ),
      {
        key: "anthropic::claude",
        label: "Claude (Anthropic)",
        provider: "anthropic",
        providerLabel: "Anthropic",
        modelLabel: "Claude",
        modelId: "claude",
      },
    ];
    render(list, "openrouter::vendor/model-1");
    const channel = container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
    const hint = () => document.getElementById(select.getAttribute("aria-describedby") ?? "");
    expect(container.querySelector('[title="Can\'t read images"]')).not.toBeNull();
    expect(hint()?.textContent).toBe("Can't read images");

    act(() => {
      channel.value = "anthropic";
      channel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("anthropic::claude");
    render(list, "openrouter::vendor/model-2");
    expect(container.querySelector('[title="Can\'t read images"]')).toBeNull();
    expect(select.hasAttribute("aria-describedby")).toBe(false);
  });

  it("marks text-only rows and the selected model in a searchable model list", () => {
    const list = choices(11).map((choice) =>
      choice.modelId === "vendor/model-3" ? { ...choice, images: false } : choice,
    );
    render(list, "openrouter::vendor/model-3");
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!;
    expect(trigger.querySelector('[title="Can\'t read images"]')).not.toBeNull();
    act(() => trigger.click());
    const marked = options().filter((option) =>
      option.querySelector('[title="Can\'t read images"]'),
    );
    expect(marked.map((option) => option.textContent)).toEqual(["Model 3"]);
    expect(marked[0]?.getAttribute("aria-describedby")).toBe(
      trigger.getAttribute("aria-describedby"),
    );
  });

  it("searches a long list by name or id and picks from it", () => {
    const list = choices(11);
    render(list, "openrouter::vendor/model-2");
    expect(container.querySelector('select[aria-label="Provider"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Model"]')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!;
    expect(trigger.textContent).toBe("Model 2");

    act(() => trigger.click());
    expect(options()).toHaveLength(11);
    expect(document.querySelector("[cmdk-group-heading]")?.textContent).toBe("OpenRouter");
    expect(options()[1]?.getAttribute("aria-label")).toBe("Model 2 (OpenRouter)");
    const checked = options().filter((option) => option.getAttribute("data-checked") === "true");
    expect(checked.map((option) => option.textContent)).toEqual(["Model 2"]);

    search("MODEL 1");
    expect(options().map((option) => option.textContent)).toEqual([
      "Model 1",
      "Model 10",
      "Model 11",
    ]);
    search("vendor/model-7");
    expect(options().map((option) => option.textContent)).toEqual(["Model 7"]);

    act(() => (options()[0] as HTMLElement).click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("openrouter::vendor/model-7");
    expect(options()).toHaveLength(0);
  });

  it("says when nothing matches", () => {
    render(choices(11), "openrouter::vendor/model-1");
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!.click());
    search("no such model");
    expect(options()).toHaveLength(0);
    expect(document.querySelector("[cmdk-group-heading]")).toBeNull();
    expect(document.body.textContent).toContain("No matching models");
  });

  it("lets the popup flip vertically without switching axes", () => {
    render(choices(11), "openrouter::vendor/model-1");
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!.click());
    expect(popoverProps.mock.lastCall?.[0]).toMatchObject({
      side: "bottom",
      align: "start",
      collisionAvoidance: { side: "flip", align: "shift", fallbackAxisSide: "none" },
    });
  });
});
