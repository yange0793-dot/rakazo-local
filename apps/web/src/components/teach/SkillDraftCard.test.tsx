// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { skills: api } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  cn: (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" "),
  Button: ({ variant: _variant, size: _size, ...props }: { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  // biome-ignore lint/a11y/noLabelWithoutControl: the mock renders the htmlFor the card sets
  Label: (props: ComponentProps<"label">) => <label {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { SkillDraftCard } from "./SkillDraftCard";

type Block = ComponentProps<typeof SkillDraftCard>["block"];

const draft: Block = {
  kind: "skill_draft",
  skillId: "skill-fixture",
  name: "Weekly report",
  goal: "Send the weekly report",
  playbook: {
    whenToUse: "Fridays",
    inputs: [],
    steps: ["Collect"],
    howToCheck: "",
    whatToReturn: "",
    approvalBoundaries: "",
    failureHandling: "",
  },
  status: "saved",
};

let container: HTMLDivElement;
let root: Root;
let refresh: Mock<() => Promise<void>>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.remove.mockReset().mockResolvedValue({ ok: true });
  refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function render(block: Block) {
  await act(async () =>
    root.render(<SkillDraftCard block={block} onRefresh={refresh} onAddRoutine={vi.fn()} />),
  );
}
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label,
  );
}

it("deletes the skill only on the second, confirming click", async () => {
  await render(draft);
  await act(async () => button("Delete")?.click());
  expect(api.remove).not.toHaveBeenCalled();
  expect(button("Confirm delete")).toBeTruthy();
  await act(async () => button("Confirm delete")?.click());
  expect(api.remove).toHaveBeenCalledWith({ skillId: draft.skillId });
  expect(container.querySelector('[data-testid="skill-draft-card"]')).toBeNull();
});

it("shows nothing once the thread says the skill was deleted", async () => {
  await render({ ...draft, status: "deleted" });
  expect(container.querySelector('[data-testid="skill-draft-card"]')).toBeNull();
});
