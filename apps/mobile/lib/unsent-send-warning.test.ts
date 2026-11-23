import { Alert } from "react-native";
import { beforeEach, expect, it, vi } from "vitest";
import { hasUnsentSends } from "./thread-feedback";
import { confirmUnsentSendLoss } from "./unsent-send-warning";
import { unsentSendsRestored } from "./unsent-sends";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./thread-feedback", () => ({ hasUnsentSends: vi.fn() }));
vi.mock("./unsent-sends", () => ({ unsentSendsRestored: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasUnsentSends).mockReturnValue(false);
  vi.mocked(unsentSendsRestored).mockResolvedValue(true);
});

it("proceeds without a prompt when no unsent messages wait", async () => {
  await expect(confirmUnsentSendLoss()).resolves.toBe(true);
  expect(Alert.alert).not.toHaveBeenCalled();
});

it("waits for the persisted queue to load before deciding nothing is unsent", async () => {
  let restoreUnblocked!: () => void;
  vi.mocked(unsentSendsRestored).mockReturnValue(
    new Promise<boolean>((resolve) => {
      restoreUnblocked = () => resolve(true);
    }),
  );
  vi.mocked(hasUnsentSends).mockReturnValue(false);
  const pending = confirmUnsentSendLoss();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The queue is still on disk; consulting the in-memory list now would look empty.
  expect(hasUnsentSends).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();

  vi.mocked(hasUnsentSends).mockReturnValue(true);
  restoreUnblocked();
  await vi.waitFor(() => expect(Alert.alert).toHaveBeenCalledOnce());
  vi.mocked(Alert.alert).mock.calls[0]![2]![0]!.onPress?.();
  await expect(pending).resolves.toBe(false);
});

it("asks when the persisted queue could not be restored", async () => {
  vi.mocked(unsentSendsRestored).mockResolvedValue(false);
  vi.mocked(hasUnsentSends).mockReturnValue(false);
  const pending = confirmUnsentSendLoss();
  await vi.waitFor(() => expect(Alert.alert).toHaveBeenCalledOnce());
  vi.mocked(Alert.alert).mock.calls[0]![2]![0]!.onPress?.();
  await expect(pending).resolves.toBe(false);
});

it("asks before switching servers clears the queue and follows the chosen button", async () => {
  vi.mocked(hasUnsentSends).mockReturnValue(true);
  const pending = confirmUnsentSendLoss();
  await vi.waitFor(() => expect(Alert.alert).toHaveBeenCalledOnce());
  const [title, body, buttons] = vi.mocked(Alert.alert).mock.calls[0]!;
  const confirmButtons = buttons!;
  expect(title).toBe("Unsent messages");
  expect(body).toBe("Switching servers deletes unsent messages.");
  expect(confirmButtons[0]!.text).toBe("Cancel");
  expect(confirmButtons[0]!.style).toBe("cancel");
  expect(confirmButtons[1]!.text).toBe("Switch anyway");
  expect(confirmButtons[1]!.style).toBe("destructive");

  confirmButtons[0]!.onPress?.();
  await expect(pending).resolves.toBe(false);

  const confirmed = confirmUnsentSendLoss();
  await vi.waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(2));
  vi.mocked(Alert.alert).mock.calls[1]![2]![1]!.onPress?.();
  await expect(confirmed).resolves.toBe(true);
});
