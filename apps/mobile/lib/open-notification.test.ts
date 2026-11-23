import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  addNotificationResponseReceivedListener: vi.fn(),
  clearLastNotificationResponse: vi.fn(),
  getLastNotificationResponse: vi.fn(),
  useLastNotificationResponse: vi.fn(),
}));
vi.mock("expo-router", () => ({
  router: { push: vi.fn() },
}));
vi.mock("./settings-sheet", () => ({
  closeSettingsSheet: vi.fn(),
}));

import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { threadRouteId } from "./notification-open";
import { openNotificationResponse } from "./open-notification";
import { closeSettingsSheet } from "./settings-sheet";

const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

function tap(id: string, data: Record<string, unknown> = { botId: "bot-1", threadId: "thread-1" }) {
  return {
    actionIdentifier: DEFAULT_ACTION,
    notification: { request: { identifier: id, content: { data } } },
  } as Notifications.NotificationResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("opening a notification tap", () => {
  it("closes the settings sheet before opening the thread, so it doesn't open behind it", async () => {

    await expect(openNotificationResponse(tap("tap-over-settings"))).resolves.toBe(true);
    expect(closeSettingsSheet).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeSettingsSheet).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(router.push).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("opens a local tap once when the cold start and the listener both see it", async () => {
    const response = tap("tap-signed-in");
    const first = openNotificationResponse(response);
    const second = openNotificationResponse(response);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      { pathname: "/thread", params: { botId: "bot-1", threadId: "thread-1" } },
      { dangerouslySingular: threadRouteId },
    );
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  it("leaves the last response in place when the tap cannot be opened or navigation fails", async () => {
    await expect(openNotificationResponse(null)).resolves.toBe(false);
    await expect(openNotificationResponse(tap("tap-empty", { kind: "completion" }))).resolves.toBe(
      false,
    );
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    vi.mocked(router.push).mockImplementationOnce(() => { throw new Error("router unavailable"); });
    await expect(openNotificationResponse(tap("tap-locked"))).resolves.toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    await expect(openNotificationResponse(tap("tap-locked"))).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("opens both distinct deliveries that share a request identifier", async () => {
    const shared = { botId: "bot-1", threadId: "thread-1" };
    const first = tap("thread-shared-in", { ...shared, deliveryId: "delivery-in-1" });
    const second = tap("thread-shared-in", { ...shared, deliveryId: "delivery-in-2" });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(second);
    const pendingFirst = openNotificationResponse(first);
    const pendingSecond = openNotificationResponse(second);
    await expect(pendingFirst).resolves.toBe(true);
    await expect(pendingSecond).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("opens one shared-identifier delivery only once", async () => {
    const data = { botId: "bot-1", threadId: "thread-1", deliveryId: "delivery-once" };
    await expect(openNotificationResponse(tap("thread-shared-once", data))).resolves.toBe(true);
    await expect(openNotificationResponse(tap("thread-shared-once", data))).resolves.toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});
