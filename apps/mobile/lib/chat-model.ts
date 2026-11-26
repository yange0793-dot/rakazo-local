import { t } from "@lingui/core/macro";
import type { ChatModelChoice } from "@rakazo/core";
import {
  chatModelChoices,
  botModelPickerKey,
  connectedModelChoices,
  connectionModelUnavailable,
  credentialForModel,
  modelChoiceChannelKey,
} from "@rakazo/core";
import type { MobileMe, MobileModel, MobileModelCredential } from "./mobile-types";

/** What a chat's model picker lists, with the space default named after its model. */
export function chatModelPickerChoices(
  me: MobileMe | null,
  catalog: MobileModel[],
  credentials: MobileModelCredential[],
  selectedKey: string,
): ChatModelChoice[] {
  const defaultEntry = me?.defaultModel
    ? catalogEntry(catalog, me.defaultProvider, me.defaultModel)
    : undefined;
  const spaceDefaultLabel = me?.defaultModel
    ? `${t`Space default`} (${defaultEntry?.label ?? me.defaultModel})`
    : t`Space default`;
  const connected = connectedModelChoices(credentials, catalog, true);
  const choices = chatModelChoices(
    connected,
    botModelPickerKey(selectedKey, credentials, connected),
    spaceDefaultLabel,
    defaultEntry?.images,
  );
  choices[0] = {
    ...choices[0]!,
    title: t`Space default`,
    detail: me?.defaultModel ? (defaultEntry?.label ?? me.defaultModel) : undefined,
  };
  return choices.map((choice) => {
    if (choice.key === "" || choice.providerLabel || !choice.provider || !choice.modelId)
      return choice;
    const credential = choice.connectionId
      ? credentials.find((entry) => entry.id === choice.connectionId)
      : credentialForModel(credentials, choice.provider, choice.modelId);
    if (
      !choice.connectionId &&
      !connectionModelUnavailable(credential, choice.modelId) &&
      (choice.provider !== "openai-compatible" || credential)
    )
      return choice;
    return {
      ...choice,
      connectionId: choice.connectionId ?? credential?.id,
      providerLabel: credential?.label,
      label: t`${choice.label} (Unavailable)`,
      unavailable: true,
    };
  });
}

export function chatModelChannels(choices: readonly ChatModelChoice[]) {
  const channels = new Map<string, { key: string; label: string }>();
  for (const choice of choices) {
    const key = modelChoiceChannelKey(choice);
    if (!channels.has(key)) {
      channels.set(key, {
        key,
        label: choice.providerLabel ?? choice.provider ?? choice.title ?? choice.label,
      });
    }
  }
  return [...channels.values()];
}

function catalogEntry(
  catalog: MobileModel[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId);
}
