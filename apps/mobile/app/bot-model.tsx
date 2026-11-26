import { useLingui } from "@lingui/react/macro";
import type { ChatModelChoice } from "@rakazo/core";
import { botModelPickerKey, connectedModelChoices, modelChoiceChannelKey } from "@rakazo/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ModelPickerList } from "../components/model-picker-list";
import { rpc } from "../lib/api";
import { chatModelPickerChoices } from "../lib/chat-model";
import { errorText } from "../lib/user-error";

export default function BotModelScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const {
    botId,
    value = "",
    channel,
  } = useLocalSearchParams<{
    botId: string;
    value?: string;
    channel?: string;
  }>();
  const [choices, setChoices] = useState<ChatModelChoice[] | null>(null);
  const [selectedKey, setSelectedKey] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([rpc("me"), rpc("models/list"), rpc("models/credentials")])
      .then(([me, catalog, credentials]) => {
        const all = chatModelPickerChoices(me, catalog, credentials, value);
        setSelectedKey(
          botModelPickerKey(value, credentials, connectedModelChoices(credentials, catalog, true)),
        );
        setChoices(
          channel === undefined
            ? all
            : all.filter((choice) => modelChoiceChannelKey(choice) === channel),
        );
      })
      .catch((err) => setError(errorText(err, t`Could not load model settings`)));
  }, [t, value, channel]);

  return (
    <ModelPickerList
      choices={choices}
      selectedKey={selectedKey}
      error={error}
      onSelect={(item) => {
        if (!item.unavailable)
          router.dismissTo({ pathname: "/bot-settings", params: { botId, model: item.key } });
      }}
    />
  );
}
