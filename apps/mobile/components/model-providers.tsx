import type { MenuAction } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type {
  ModelCatalogEntry,
  ModelCatalogSourceStatus,
  ModelCredential,
} from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  connectionDisplayName,
  MAX_MODEL_CONNECTION_LABEL,
} from "@rakazo/contracts";
import { Alert, Platform } from "react-native";
import { RowMenu } from "./model-role-settings";
import { NativeActionButton } from "./native-action-button";
import { SettingsGroup, SettingsRow } from "./settings-group";

/** Every connection the account has, with the actions that act on one of them. */
export function ModelProviders({
  catalog,
  credentials,
  onManage,
  onAdd,
  onRename,
  onDisconnect,
  sources,
  sourceError,
  syncingSources,
  onSync,
}: {
  catalog: ModelCatalogEntry[];
  credentials: ModelCredential[];
  onManage: (credential: ModelCredential) => void;
  onAdd: () => void;
  onRename: (credential: ModelCredential, label: string) => void;
  onDisconnect: (credential: ModelCredential) => void;
  sources: ModelCatalogSourceStatus[];
  sourceError: string | null;
  syncingSources: boolean;
  onSync: (sourceId?: string) => void;
}) {
  const { t } = useLingui();
  const providerName = (credential: ModelCredential) =>
    catalog.find(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(credential.provider),
    )?.providerName ?? credential.provider;
  const rows = credentials
    .map((credential) => {
      const provider = providerName(credential);
      const name = credential.catalogSource
        ? credential.label
        : connectionDisplayName(credential, provider);
      return {
        credential,
        name,
        detail:
          credential.catalogSource && !credential.catalogSource.available
            ? t`Unavailable`
            : credential.catalogSource?.unavailableModelIds.length
              ? t`Some models unavailable`
              : credential.reconnectRequired
                ? t`Sign in again`
                : credential.catalogSource || name.startsWith(provider)
                  ? undefined
                  : provider,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  function act(credential: ModelCredential, name: string, id: string) {
    if (id === "manage") onManage(credential);
    else if (id === "rename")
      // Alert.prompt, which renames, exists only on iOS.
      Alert.prompt(
        t`Rename`,
        undefined,
        [
          { text: t`Cancel`, style: "cancel" },
          {
            text: t`Save`,
            onPress: (value?: string) => {
              const label = value?.trim().slice(0, MAX_MODEL_CONNECTION_LABEL);
              if (label && label !== credential.label) onRename(credential, label);
            },
          },
        ],
        "plain-text",
        credential.label,
      );
    else if (id === "disconnect")
      Alert.alert(t`Disconnect ${name}?`, t`This removes the connection from every space.`, [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Disconnect`, style: "destructive", onPress: () => onDisconnect(credential) },
      ]);
  }

  return (
    <>
      {sources.length || sourceError ? (
        <SettingsGroup accessibilityLabel={t`Model sources`}>
          {sources.map((source) => {
            const syncedAt = source.lastSyncedAt
              ? new Date(source.lastSyncedAt).toLocaleString()
              : null;
            const syncStatus = syncedAt ? t`Synced ${syncedAt}` : t`Not synced`;
            return (
              <SettingsRow
                key={source.id}
                title={source.label}
                detail={source.error ? `${syncStatus}\n${source.error}` : syncStatus}
                value={source.group}
                trailing={
                  <NativeActionButton
                    accessibilityLabel={t`Refresh ${source.label}`}
                    icon={{ ios: "arrow.clockwise", android: "refresh" }}
                    size="compact"
                    prominence="plain"
                    busy={syncingSources}
                    onPress={() => onSync(source.id)}
                  />
                }
              />
            );
          })}
          {sourceError ? (
            <SettingsRow
              title={sourceError}
              accessibilityRole="alert"
              trailing={
                <NativeActionButton
                  accessibilityLabel={t`Retry sync`}
                  icon={{ ios: "arrow.clockwise", android: "refresh" }}
                  size="compact"
                  prominence="plain"
                  busy={syncingSources}
                  onPress={() => onSync()}
                />
              }
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      <SettingsGroup accessibilityLabel={t`Providers`} label={t`Providers`}>
        {rows.map(({ credential, name, detail }) => {
          const actions: MenuAction[] = [
            ...(Platform.OS === "ios" ? [{ id: "rename", title: t`Rename` }] : []),
            {
              id: "manage",
              title: credential.catalogSource
                ? t`Edit connection`
                : credential.authKind === "oauth"
                  ? t`Sign in again`
                  : t`Replace API key`,
            },
            { id: "disconnect", title: t`Disconnect`, attributes: { destructive: true } },
          ];
          return (
            <RowMenu
              key={credential.id}
              title={name}
              actions={actions}
              onAction={(id) => act(credential, name, id)}
            >
              <SettingsRow
                accessibilityRole="button"
                title={name}
                detail={detail}
                chevron="right"
                onPress={() => onManage(credential)}
                accessibilityActions={actions.map((action) => ({
                  name: action.id ?? action.title,
                  label: action.title,
                }))}
                onAccessibilityAction={({ nativeEvent }) =>
                  act(credential, name, nativeEvent.actionName)
                }
              />
            </RowMenu>
          );
        })}
        <SettingsRow key="add" title={t`Add provider`} onPress={onAdd} />
      </SettingsGroup>
    </>
  );
}
