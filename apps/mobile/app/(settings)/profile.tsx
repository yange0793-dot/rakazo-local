import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { accountDisplay, displayName } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Platform, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NameDialog } from "../../components/name-dialog";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../../components/settings-group";
import { createAccountNameEditor } from "../../lib/account-name-editor";
import { rpc } from "../../lib/api";
import type { MobileMe } from "../../lib/mobile-types";
import { useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { createSettingsPageStyles } from "../../lib/settings-page-styles";
import { useSideInsets } from "../../lib/side-insets";
import {
  loadTrustedLinkSites,
  removeTrustedLinkSite,
  useTrustedLinkSites,
} from "../../lib/trusted-link-sites";
import { errorText } from "../../lib/user-error";

export default function Profile() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const styles = useThemedStyles(createSettingsPageStyles);
  const stacked = useStackedSettings();
  const colorScheme = useResolvedAppearance();
  const [me, setMe] = useState<MobileMe | null>(null);
  const account = accountDisplay(me ?? {}, t`Your account`);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [namePending, setNamePending] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const currentName = account.label === me?.email ? "" : displayName(me?.name, "");

  const nameSaving = useRef(false);
  const nameSaveVersion = useRef(0);
  const { saveName, editName, closeNameDialog } = createAccountNameEditor({
    currentName,
    pending: nameSaving,
    saveVersion: nameSaveVersion,
    Platform,
    Alert,
    errorText,
    updateAccountName: async (name) => { await rpc("profile/updateName", { name }); },
    refresh: () => rpc("me"),
    onSaved: (name) => setMe((current) => (current ? { ...current, name } : current)),
    onRefreshed: setMe,
    setNameDraft,
    setNamePending,
    setNameError,
    setNameDialogOpen,
  });

  const trustedSites = useTrustedLinkSites();

  // Read on every visit, so a failed read retries when the page is shown again.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void rpc("me")
        .then((next) => {
          if (active) setMe(next);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      void loadTrustedLinkSites().catch(() => undefined);
    }, []),
  );

  function removeTrustedSite(site: string) {
    void removeTrustedLinkSite(site).catch((cause: unknown) =>
      Alert.alert(t`Could not continue`, errorText(cause, t`Try again.`)),
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t`Edit name`}
            accessibilityValue={{
              text:
                me?.email && account.label !== me.email
                  ? `${account.label}, ${me.email}`
                  : account.label,
            }}
            chevron="right"
            disabled={!me}
            detail={me?.email && account.label !== me.email ? me.email : undefined}
            prominent
            title={account.label}
            dimmed={namePending}
            onPress={editName}
          />
        </SettingsGroup>

        {trustedSites.length > 0 ? (
          <SettingsGroup accessibilityLabel={t`Trusted sites`} label={t`Trusted sites`}>
            {trustedSites.map((site) => (
              <MenuView
                key={site}
                actions={[{ id: "remove", title: t`Remove`, attributes: { destructive: true } }]}
                colorScheme={colorScheme}
                onPressAction={() => removeTrustedSite(site)}
                title={site}
              >
                <SettingsRow accessible accessibilityRole="button" title={site} />
              </MenuView>
            ))}
          </SettingsGroup>
        ) : null}

      </ScrollView>
      {nameDialogOpen ? (
        <NameDialog
          draft={nameDraft}
          error={nameError}
          saving={namePending}
          onChange={(value) => {
            setNameDraft(value);
            setNameError(null);
          }}
          onSave={(value) => void saveName(value)}
          onClose={closeNameDialog}
        />
      ) : null}
    </SafeAreaView>
  );
}
