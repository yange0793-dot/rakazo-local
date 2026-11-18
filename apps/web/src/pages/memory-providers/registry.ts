import { i18n } from "@lingui/core";
import type { SpaceMemoryConfig } from "@rakazo/contracts";
import type { ComponentType } from "react";
import { HonchoSettingsForm } from "./HonchoSettingsForm";
import { LocalMemorySettingsForm } from "./LocalMemorySettingsForm";
import { SerenitySettingsForm } from "./SerenitySettingsForm";
import { SupermemorySettingsForm } from "./SupermemorySettingsForm";

export interface MemoryProviderConnectionDraft {
  settings: Record<string, string>;
  credentials: Record<string, string>;
}

export interface MemoryProviderSettingsFormProps {
  busy: boolean;
  onConnect: (draft: MemoryProviderConnectionDraft) => Promise<boolean>;
}

export interface MemoryProviderSettingsRegistration {
  id: string;
  name: string;
  SettingsForm: ComponentType<MemoryProviderSettingsFormProps>;
  connectedLabel: (config: SpaceMemoryConfig) => string;
}

// The overlay paints these through the shared catalog, so a Chinese Space reads them in Chinese.
export const MEMORY_PROVIDER_SETTINGS: readonly MemoryProviderSettingsRegistration[] = [
  {
    id: "local",
    get name() {
      return i18n._({ id: "Local memory", message: "Local memory" });
    },
    SettingsForm: LocalMemorySettingsForm,
    connectedLabel: (config) => config.settings.baseUrl ?? "",
  },
  {
    id: "supermemory",
    name: "Supermemory",
    SettingsForm: SupermemorySettingsForm,
    connectedLabel: (config) =>
      config.settings.mode === "cloud"
        ? i18n._({ id: "Supermemory Cloud", message: "Supermemory Cloud" })
        : i18n._({
            id: "Self-hosted ({baseUrl})",
            message: "Self-hosted ({baseUrl})",
            values: { baseUrl: config.settings.baseUrl ?? "" },
          }),
  },
  {
    id: "serenity",
    name: "Serenity",
    SettingsForm: SerenitySettingsForm,
    connectedLabel: (config) => {
      const endpoint = config.settings.endpoint ?? "Serenity";
      const mode =
        config.settings.allowWrites === "true"
          ? i18n._({ id: "read/write", message: "read/write" })
          : i18n._({ id: "recall only", message: "recall only" });
      return `${config.settings.brainLabel?.trim() || endpoint}, ${mode}`;
    },
  },
  {
    id: "honcho",
    name: "Honcho",
    SettingsForm: HonchoSettingsForm,
    connectedLabel: (config) => {
      const { mode, baseUrl, workspaceId } = config.settings;
      if (mode === "local")
        return [
          i18n._({
            id: "Self-hosted ({baseUrl})",
            message: "Self-hosted ({baseUrl})",
            values: { baseUrl: baseUrl ?? "" },
          }),
          workspaceId,
        ]
          .filter(Boolean)
          .join(", ");
      if (!workspaceId) return i18n._({ id: "Honcho Cloud", message: "Honcho Cloud" });
      return i18n._({
        id: "Honcho Cloud ({workspaceId})",
        message: "Honcho Cloud ({workspaceId})",
        values: { workspaceId },
      });
    },
  },
];

export function memoryProviderSettings(provider: string) {
  return MEMORY_PROVIDER_SETTINGS.find((entry) => entry.id === provider) ?? null;
}

export function defaultMemoryProviderSettings(): MemoryProviderSettingsRegistration {
  const registration = MEMORY_PROVIDER_SETTINGS[0];
  if (!registration) throw new Error("No memory provider settings are registered.");
  return registration;
}
