// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ saveLesson: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: { memory: { saveLesson: api.saveLesson } },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray | { id: string; message?: string }, ...values: unknown[]) =>
      "raw" in parts ? String.raw(parts, ...values) : (parts.message ?? parts.id),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  cn: (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" "),
  Button: ({ variant: _variant, size: _size, ...props }: { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

import { LessonDraftCard } from "./LessonDraftCard";

type LessonDraftBlock = Extract<MessageBlock, { kind: "lesson_draft" }>;

const draft: LessonDraftBlock = {
  kind: "lesson_draft",
  lessonId: "lesson-fixture",
  runId: "run-fixture",
  cue: "The build failed twice in a row.",
  lesson: "Read the whole log before retrying.",
  evidence: { kind: "run_failed", quote: "build failed: missing module" },
  status: "draft",
};

let container: HTMLDivElement;
let root: Root;
let refresh: Mock<() => Promise<void>>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.saveLesson.mockReset().mockResolvedValue({});
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
async function render(block: LessonDraftBlock = draft) {
  await act(async () =>
    root.render(<LessonDraftCard botId="bot-fixture" block={block} onRefresh={refresh} />),
  );
}
function button(label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label,
  );
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}

it("shows the host's draft read-only and saves it by id", async () => {
  await render();
  expect(container.textContent).toContain("Draft experience");
  expect(container.textContent).toContain(draft.cue);
  expect(container.textContent).toContain(draft.lesson);
  expect(container.textContent).toContain(draft.evidence.quote);
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => button("Save").click());
  expect(api.saveLesson).toHaveBeenCalledWith({
    botId: "bot-fixture",
    lessonId: draft.lessonId,
  });
  expect(button("Saved").disabled).toBe(true);
  expect(refresh).toHaveBeenCalled();
});

it("stays saved without a second write once the block says so", async () => {
  await render({ ...draft, status: "saved" });
  expect(button("Saved").disabled).toBe(true);
  await act(async () => button("Saved").click());
  expect(api.saveLesson).not.toHaveBeenCalled();
});

it("keeps the draft open with the failure when the save does not go through", async () => {
  api.saveLesson.mockRejectedValue(new Error("The run is gone"));
  await render();
  await act(async () => button("Save").click());
  expect(container.textContent).toContain("The run is gone");
  expect(button("Save").disabled).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});
