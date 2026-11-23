import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  startWorkActivity: vi.fn(async () => undefined),
  refreshWorkActivity: vi.fn(async () => undefined),
  endWorkActivity: vi.fn(async () => undefined),
  token: undefined as undefined | ((event: { token: string }) => void),
  startToken: undefined as undefined | ((event: { token: string }) => void),
  addListener(name: string, callback: (event: { token: string }) => void) {
    if (name === "onWorkActivityStartToken") native.startToken = callback;
    else native.token = callback;
    return { remove() {} };
  },
}));
const app = vi.hoisted(() => ({
  appState: undefined as undefined | ((state: string) => void),
  session: undefined as undefined | (() => void),
  generation: 1,
  ready: 1,
}));
const rpc = vi.hoisted(() => vi.fn());

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => native }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    addEventListener: (_name: string, callback: (state: string) => void) => {
      app.appState = callback;
      return { remove() {} };
    },
  },
}));
vi.mock("./api", () => ({ rpc }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => app.generation,
  currentReadySessionGeneration: () => app.ready,
  subscribeSessionGeneration: (listener: () => void) => {
    app.session = listener;
    return () => undefined;
  },
}));

const { startWorkActivities, startWorkActivity } = await import("./work-activity");
startWorkActivities();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  app.generation = 1;
  app.ready = 1;
});

it("starts the card for the chat just sent to", () => {
  startWorkActivity({ title: "Planner", spaceId: "space-1", target: { groupId: "group-1" } });
  expect(native.startWorkActivity).toHaveBeenCalledWith("Planner", "space-1", null, "group-1");
});

it("ends the card only when the server says nothing would update it", async () => {
  rpc.mockResolvedValueOnce({ following: true });
  native.token!({ token: "ab" });
  await settle();
  expect(rpc).toHaveBeenCalledWith("notifications/followWorkActivity", { token: "ab" });
  expect(native.endWorkActivity).not.toHaveBeenCalled();

  rpc.mockRejectedValueOnce(new Error("offline"));
  native.token!({ token: "ab" });
  await settle();
  expect(native.endWorkActivity).not.toHaveBeenCalled();

  // A reply that lands after the account changed is ignored.
  let reply!: (value: { following: boolean }) => void;
  rpc.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
  native.token!({ token: "ab" });
  app.generation += 1;
  reply({ following: false });
  await settle();
  expect(native.endWorkActivity).not.toHaveBeenCalled();

  rpc.mockResolvedValueOnce({ following: false });
  native.token!({ token: "ab" });
  await settle();
  expect(native.endWorkActivity).toHaveBeenCalledOnce();
});

it("hands the phone's token for starting cards to the server", async () => {
  rpc.mockResolvedValueOnce({ ok: true });
  native.startToken!({ token: "cd" });
  await settle();
  expect(rpc).toHaveBeenCalledWith("notifications/registerWorkActivityStarts", { token: "cd" });
  // A failed request is asked again on the next open.
  rpc.mockRejectedValueOnce(new Error("offline"));
  native.startToken!({ token: "cd" });
  await settle();
});

it("refreshes on launch, foreground, and a completed local endpoint change", async () => {
  startWorkActivities();
  expect(native.refreshWorkActivity).toHaveBeenCalledOnce();
  native.refreshWorkActivity.mockClear();
  app.appState!("background");
  app.appState!("active");
  expect(native.refreshWorkActivity).toHaveBeenCalledOnce();

  native.refreshWorkActivity.mockClear();
  app.session!();
  await settle();
  expect(native.endWorkActivity).not.toHaveBeenCalled();
  expect(native.refreshWorkActivity).toHaveBeenCalledOnce();
  native.refreshWorkActivity.mockClear();
  app.ready = 0;
  app.session!();
  expect(native.refreshWorkActivity).not.toHaveBeenCalled();
  app.ready = 1;
  app.session!();
  await settle();
  expect(native.refreshWorkActivity).toHaveBeenCalledOnce();
  expect(native.endWorkActivity).not.toHaveBeenCalled();
});
