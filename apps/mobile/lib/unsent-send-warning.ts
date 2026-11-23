import { t } from "@lingui/core/macro";
import { Alert } from "react-native";
import { hasUnsentSends } from "./thread-feedback";
import { unsentSendsRestored } from "./unsent-sends";

/**
 * Confirms an action that deletes this device's unsent messages. Resolves false when
 * messages wait and their owner keeps them, so the action must not run then.
 */
export async function confirmUnsentSendLoss(): Promise<boolean> {
  // The persisted queue loads asynchronously at startup; reading the in-memory list
  // before that lands, or after it failed, would treat an unknown queue as empty.
  if ((await unsentSendsRestored()) && !hasUnsentSends()) return true;
  return new Promise((resolve) => {
    Alert.alert(t`Unsent messages`, t`Switching servers deletes unsent messages.`, [
      { text: t`Cancel`, style: "cancel", onPress: () => resolve(false) },
      { text: t`Switch anyway`, style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}
