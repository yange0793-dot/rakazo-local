// @vitest-environment jsdom
import type { Bot, Routine } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useRoutineEditor } from "./use-routine-editor";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
}));

const routine: Routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Daily",
  prompt: "",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: true,
  notify: true,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  emailSenders: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: null,
  watchState: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

let root: Root;
let editor: ReturnType<typeof useRoutineEditor>;
let finishUpdate: (saved: Routine) => void;
const update = vi.fn();
const create = vi.fn();
const rotateWebhookSecret = vi.fn();
let activeBot: Bot;
let timezone: string;
const activeBotId = { current: "" };

function Harness() {
  editor = useRoutineEditor({
    rpc: { routines: { update, create }, bots: { rotateWebhookSecret } } as unknown as ReturnType<
      typeof createSpaceRpc
    >,
    active: activeBot,
    activeBotId,
    timezone,
    messageProviders: [],
    setBots: () => {},
    refreshThread: async () => ({}) as never,
    setPanel: () => {},
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activeBot = { id: "bot-1", webhookConfigured: false } as Bot;
  activeBotId.current = activeBot.id;
  timezone = "UTC";
  update.mockImplementation(() => new Promise<Routine>((resolve) => (finishUpdate = resolve)));
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

it("creates a one-time routine in the displayed timezone", async () => {
  timezone = "Asia/Tokyo";
  act(() => root.render(<Harness />));
  create.mockResolvedValue({ ...routine, crons: ["@once"], nextRunAt: "2099-01-01T00:30:00Z" });
  act(() =>
    editor.editorProps!.onChange({
      ...editor.editorProps!.draft,
      name: "Reminder",
      prompt: "Check",
      active: true,
      schedules: [{ freq: "Advanced", cron: "@once", time: "9:00 AM", n: 3, unit: "minutes" }],
      runAtLocal: "2099-01-01T09:30",
    }),
  );
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      crons: ["@once"],
      timezone: "Asia/Tokyo",
      runAt: "2099-01-01T00:30:00.000Z",
      active: true,
    }),
  );
});

it("keeps an edited paused one-time routine paused", async () => {
  const paused = { ...routine, active: false, crons: ["@once"] };
  update.mockResolvedValue(paused);
  act(() => editor.editRoutine(paused));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Renamed" }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.lastCall?.[0]).not.toHaveProperty("active");
  expect(update.mock.lastCall?.[0]).not.toHaveProperty("runAt");
});

it("requires an explicit new time when re-enabling a paused one-time routine", async () => {
  const paused = { ...routine, active: false, crons: ["@once"], nextRunAt: null, lastRunAt: null };
  act(() => editor.editRoutine(paused));
  expect(editor.editorProps!.draft.runAtLocal).toBe("");
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, active: true }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(editor.editorProps!.error).toBe("Add a run time for this one-shot.");
  expect(update).not.toHaveBeenCalled();
});

it("reflects a completed one-time schedule while preserving unsaved instructions", async () => {
  const armed = { ...routine, crons: ["@once"], nextRunAt: "2099-01-01T09:00:00Z" };
  act(() => editor.editRoutine(armed));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, prompt: "New draft" }));
  const finished = {
    ...armed,
    active: false,
    nextRunAt: null,
    lastRunAt: "2099-01-01T09:00:00Z",
  };
  act(() => editor.editorProps!.onScheduleUpdate(finished));
  expect(editor.editorProps!.draft.active).toBe(false);
  expect(editor.editorProps!.draft.prompt).toBe("New draft");
  expect(editor.editingRoutine?.lastRunAt).toBe(finished.lastRunAt);
  update.mockResolvedValue({ ...finished, prompt: "New draft" });
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.lastCall?.[0]).not.toHaveProperty("active");
  expect(update.mock.lastCall?.[0]).not.toHaveProperty("runAt");
});

it("keeps an unsaved pause when the server advances a recurring schedule", () => {
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, active: false }));
  act(() =>
    editor.editorProps!.onScheduleUpdate({ ...routine, nextRunAt: "2099-01-01T09:00:00Z" }),
  );
  expect(editor.editorProps!.draft.active).toBe(false);
});

it("asks for a new time when changing a recurring routine to one-time", async () => {
  act(() => editor.editRoutine({ ...routine, nextRunAt: "2099-01-01T09:00:00Z" }));
  act(() =>
    editor.editorProps!.onChange({
      ...editor.editorProps!.draft,
      schedules: [{ freq: "Advanced", cron: "@once", time: "9:00 AM", n: 3, unit: "minutes" }],
      runAtLocal: "",
    }),
  );
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(editor.editorProps!.error).toContain("run time");
  expect(update).not.toHaveBeenCalled();
});

it("requires a future run time before creating an active one-time routine", async () => {
  for (const runAtLocal of ["", "2000-01-01T09:00"]) {
    act(() =>
      editor.editorProps!.onChange({
        ...editor.editorProps!.draft,
        active: true,
        schedules: [{ freq: "Advanced", cron: "@once", time: "9:00 AM", n: 3, unit: "minutes" }],
        runAtLocal,
      }),
    );
    await act(async () => {
      await editor.editorProps!.onSave();
    });
    expect(editor.editorProps!.error).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  }
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("keeps edits made while a save is in flight", async () => {
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Weekly" }));

  let saving!: Promise<void>;
  act(() => {
    saving = editor.editorProps!.onSave() as unknown as Promise<void>;
  });
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: "Weekly" }));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Monthly" }));

  await act(async () => {
    finishUpdate({ ...routine, name: "Weekly", prompt: "Check in." });
    await saving;
  });

  expect(editor.editingRoutine?.name).toBe("Weekly");
  expect(editor.editorProps!.draft.name).toBe("Monthly");
  expect(editor.editorProps!.draft.prompt).toBe("Check in.");
});

it("sends on/off only when the save changes it", async () => {
  update.mockResolvedValue(routine);
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Renamed" }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[0]![0]).not.toHaveProperty("active");

  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, active: false }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[1]![0]).toMatchObject({ active: false });
});

it("shows a revealed webhook secret only for the bot it belongs to", async () => {
  let finishRotate!: (result: { secret: string }) => void;
  rotateWebhookSecret.mockImplementation(() => new Promise((resolve) => (finishRotate = resolve)));
  let ensuring!: Promise<void>;
  act(() => {
    ensuring = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });

  activeBot = { id: "bot-2", webhookConfigured: false } as Bot;
  act(() => root.render(<Harness />));
  await act(async () => {
    finishRotate({ secret: "secret-1" });
    await ensuring;
  });
  expect(editor.editorProps!.webhook.secret).toBeNull();
  expect(editor.editorProps!.webhook.configured).toBe(false);

  activeBot = { id: "bot-1", webhookConfigured: true } as Bot;
  act(() => root.render(<Harness />));
  expect(editor.editorProps!.webhook.secret).toBe("secret-1");
});

it("keeps each bot's revealed secret when rotations overlap", async () => {
  const finishers: ((result: { secret: string }) => void)[] = [];
  rotateWebhookSecret.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
  let first!: Promise<void>;
  act(() => {
    first = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });
  activeBot = { id: "bot-2", webhookConfigured: false } as Bot;
  act(() => root.render(<Harness />));
  let second!: Promise<void>;
  act(() => {
    second = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });
  await act(async () => {
    finishers[0]!({ secret: "secret-1" });
    finishers[1]!({ secret: "secret-2" });
    await Promise.all([first, second]);
  });
  expect(editor.editorProps!.webhook.secret).toBe("secret-2");

  activeBot = { id: "bot-1", webhookConfigured: true } as Bot;
  act(() => root.render(<Harness />));
  expect(editor.editorProps!.webhook.secret).toBe("secret-1");
});

it("shows why a key cannot be set instead of leaving the rejection unhandled", async () => {
  rotateWebhookSecret.mockRejectedValue(
    Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 }),
  );
  await act(async () => {
    await editor.editorProps!.onEnsureWebhook();
  });
  expect(editor.editorProps!.error).toBe("Only the bot's creator can set its webhook key.");
});

it("drops a key failure that arrives after switching to another bot", async () => {
  let fail!: (error: Error) => void;
  rotateWebhookSecret.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
  let ensuring!: Promise<void>;
  act(() => {
    ensuring = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });
  activeBotId.current = "bot-2";
  await act(async () => {
    fail(Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }));
    await ensuring;
  });
  expect(editor.editorProps!.error).toBeNull();
});
