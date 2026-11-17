import { useLingui } from "@lingui/react/macro";
import type { SemanticFact, SemanticFactPage } from "@rakazo/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { NativeStackNavigationOptions } from "expo-router";
import { useFocusEffect, useNavigation, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ListSearchInput } from "../../components/list-search-input";
import { MenuPicker, MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { native, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import { queryClient, rpcQuery } from "../../lib/query";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

type MemoryScope = SemanticFact["scope"];

/** Only the explicitly selected bot and scope are requested. */
export default function SemanticMemoryScreen() {
  const { t } = useLingui();
  const navigation = useNavigation();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [scope, setScope] = useState<MemoryScope>("isolated");
  const [query, setQuery] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [opened, setOpened] = useState<SemanticFact | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const botsQuery = useQuery(rpcQuery("bots/list"), queryClient);
  const bots = botsQuery.data ?? [];
  const botId = bots.find((bot) => bot.id === selectedBotId)?.id;
  const input = {
    botId: botId ?? "",
    scope,
    ...(query.trim() ? { query: query.trim() } : {}),
    limit: 20,
    includeHistory,
  };
  const list = useInfiniteQuery(
    {
      queryKey: rpcQuery("memory/facts", input).queryKey,
      queryFn: (context) =>
        rpcQuery("memory/facts", {
          ...input,
          ...(context.pageParam ? { cursor: context.pageParam } : {}),
        }).queryFn(context as never) as Promise<SemanticFactPage>,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page: SemanticFactPage) => page.nextCursor ?? undefined,
      enabled: false,
    },
    queryClient,
  );
  const { refetch } = list;
  useFocusEffect(
    useCallback(() => {
      if (botId) void refetch();
    }, [botId, scope, query, includeHistory, refetch]),
  );
  usePreventRemove(busy, () => undefined);
  const supported = list.data?.pages[0]?.supported === true;
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  async function exportFacts() {
    if (!botId || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const exported = await rpc("memory/exportFacts", { botId, scope });
      await Share.share({ message: JSON.stringify(exported, null, 2) });
    } catch (reason) {
      setActionError(errorText(reason, t`Could not export memory`));
    } finally {
      setBusy(false);
    }
  }

  const showHistory = () => {
    if (!busy) setIncludeHistory((value) => !value);
  };
  useLayoutEffect(() => {
    const historyLabel = includeHistory ? t`Hide history` : t`Show history`;
    navigation.setOptions({
      ...(!supported || !botId
        ? { headerRight: undefined, unstable_headerRightItems: undefined }
        : iosAtLeast(26)
          ? {
              unstable_headerRightItems: () => [
                {
                  type: "menu" as const,
                  label: t`Memory actions`,
                  accessibilityLabel: t`Memory actions`,
                  disabled: busy,
                  icon: { type: "sfSymbol" as const, name: "ellipsis" as const },
                  menu: {
                    items: [
                      {
                        type: "action" as const,
                        label: t`Export`,
                        disabled: busy,
                        onPress: () => void exportFacts(),
                      },
                      {
                        type: "action" as const,
                        label: historyLabel,
                        disabled: busy,
                        onPress: showHistory,
                      },
                    ],
                  },
                },
              ],
            }
          : {
              headerRight: () => (
                <MenuPickerMenu
                  label={t`Memory actions`}
                  choices={[
                    { key: "export", label: t`Export` },
                    { key: "history", label: historyLabel },
                  ]}
                  value=""
                  disabled={busy}
                  onChange={(key) => (key === "export" ? void exportFacts() : showHistory())}
                >
                  <View
                    accessible
                    accessibilityLabel={t`Memory actions`}
                    accessibilityRole="button"
                  >
                    <Text style={styles.headerAction}>…</Text>
                  </View>
                </MenuPickerMenu>
              ),
            }),
    } satisfies NativeStackNavigationOptions);
  }, [navigation, botId, scope, supported, includeHistory, busy, t, styles]);

  function pickBot(next: string) {
    if (busy) return;
    setSelectedBotId(next);
    setScope("isolated");
    setQuery("");
    setActionError(null);
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <SettingsGroup>
          <MenuPicker
            label={t`Bot`}
            choices={[
              { key: "", label: t`Choose bot` },
              ...bots.map((bot) => ({ key: bot.id, label: bot.name })),
            ]}
            value={botId ?? ""}
            onChange={pickBot}
          />
          {botId ? (
            <MenuPicker
              label={t`Scope`}
              choices={[
                { key: "isolated", label: t`Isolated` },
                { key: "shared", label: t`Shared` },
              ]}
              value={scope}
              onChange={(next) => {
                if (busy) return;
                setScope(next as MemoryScope);
                setQuery("");
                setActionError(null);
              }}
            />
          ) : null}
        </SettingsGroup>
        {botsQuery.isPending || (botId && list.isPending) ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        ) : null}
        {botsQuery.isError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {errorText(botsQuery.error, t`Could not load bots`)}
          </Text>
        ) : !botsQuery.isPending && bots.length === 0 ? (
          <Text style={styles.secondary}>{t`No bots available`}</Text>
        ) : null}
        {botId && list.isError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {errorText(list.error, t`Could not load memory`)}
          </Text>
        ) : null}
        {botId && list.isError && !list.data ? (
          <NativeActionButton
            label={t`Retry`}
            prominence="plain"
            fill={false}
            onPress={() => void refetch()}
          />
        ) : null}
        {botId && list.data && !supported ? (
          <Text
            style={styles.secondary}
          >{t`This provider does not support managing saved facts.`}</Text>
        ) : null}
        {actionError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {actionError}
          </Text>
        ) : null}
        {botId && supported ? (
          <>
            <ListSearchInput query={query} setQuery={setQuery} />
            {items.length ? (
              <SettingsGroup>
                {items.map((fact) => (
                  <SettingsRow
                    key={fact.id}
                    title={fact.content || t`Forgotten`}
                    chevron="right"
                    accessibilityRole="button"
                    onPress={() => setOpened(fact)}
                    disabled={busy}
                  />
                ))}
              </SettingsGroup>
            ) : !list.isError ? (
              <Text style={styles.secondary}>
                {query ? t`No matching records` : t`Nothing remembered yet`}
              </Text>
            ) : null}
            {list.hasNextPage ? (
              <NativeActionButton
                label={t`Show more`}
                prominence="plain"
                fill={false}
                disabled={busy || list.isFetchingNextPage}
                onPress={() => void list.fetchNextPage()}
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>
      {opened && botId ? (
        <SemanticFactSheet
          key={opened.id}
          fact={opened}
          botId={botId}
          scope={scope}
          onClose={() => setOpened(null)}
          onChanged={() => {
            setOpened(null);
            void refetch();
          }}
          onReload={async () => {
            await refetch({ throwOnError: true });
            setOpened(null);
          }}
          onBusyChange={setBusy}
        />
      ) : null}
    </SafeAreaView>
  );
}

function SemanticFactSheet({
  fact,
  botId,
  scope,
  onClose,
  onChanged,
  onReload,
  onBusyChange,
}: {
  fact: SemanticFact;
  botId: string;
  scope: MemoryScope;
  onClose: () => void;
  onChanged: () => void;
  onReload: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createStyles);
  const [editing, setEditing] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [draft, setDraft] = useState(fact.content);
  const [busy, setBusy] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = editing && draft !== fact.content;

  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  function markBusy(next: boolean) {
    setBusy(next);
    onBusyChange(next);
  }

  function close() {
    if (busy) return;
    if (!dirty) return onClose();
    Alert.alert(t`Discard changes?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Discard`, style: "destructive", onPress: onClose },
    ]);
  }

  async function correct() {
    if (busy || conflicted || !draft.trim() || !dirty) return;
    markBusy(true);
    setError(null);
    try {
      await rpc("memory/correctFact", {
        id: fact.id,
        botId,
        scope,
        content: draft,
        expectedRevision: fact.revision,
      });
      onChanged();
    } catch (reason) {
      if ((reason as { code?: unknown } | null)?.code === "CONFLICT") setConflicted(true);
      setError(errorText(reason, t`Could not correct memory`));
    } finally {
      markBusy(false);
    }
  }

  function confirmForget() {
    Alert.alert(t`Forget this record?`, t`It will no longer be recalled.`, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Forget`, style: "destructive", onPress: () => void forget() },
    ]);
  }

  async function forget() {
    if (busy || conflicted) return;
    markBusy(true);
    setError(null);
    try {
      await rpc("memory/forgetFact", {
        id: fact.id,
        botId,
        scope,
        expectedRevision: fact.revision,
      });
      onChanged();
    } catch (reason) {
      if ((reason as { code?: unknown } | null)?.code === "CONFLICT") setConflicted(true);
      setError(errorText(reason, t`Could not forget memory`));
    } finally {
      markBusy(false);
    }
  }

  function confirmReload() {
    Alert.alert(t`Discard changes?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Reload`,
        style: "destructive",
        onPress: async () => {
          markBusy(true);
          try {
            await onReload();
          } catch (reason) {
            setError(errorText(reason, t`Could not load memory`));
          } finally {
            markBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          {
            paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <View style={styles.sheetHeader}>
          <NativeActionButton
            label={editing ? t`Cancel` : t`Done`}
            disabled={busy}
            prominence="plain"
            fill={false}
            onPress={
              editing
                ? () => {
                    setDraft(fact.content);
                    setEditing(false);
                  }
                : close
            }
          />
          {editing ? (
            <NativeActionButton
              label={t`Save correction`}
              prominence="plain"
              fill={false}
              disabled={busy || conflicted || !draft.trim() || !dirty}
              onPress={() => void correct()}
            />
          ) : fact.status === "active" ? (
            <NativeActionButton
              label={t`Correct`}
              prominence="plain"
              fill={false}
              disabled={busy || conflicted}
              onPress={() => setEditing(true)}
            />
          ) : null}
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {editing ? (
            <TextInput
              accessibilityLabel={t`Correction`}
              value={draft}
              onChangeText={setDraft}
              editable={!busy && !conflicted}
              maxLength={20_000}
              multiline
              textAlignVertical="top"
              style={styles.editor}
            />
          ) : (
            <Text selectable style={styles.fact}>
              {fact.content}
            </Text>
          )}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {conflicted ? (
            <>
              <Text
                accessibilityRole="alert"
                style={styles.error}
              >{t`Record changed. Reload to discard your edit and use the latest version.`}</Text>
              <NativeActionButton
                label={t`Reload`}
                prominence="plain"
                disabled={busy}
                fill={false}
                onPress={confirmReload}
              />
            </>
          ) : null}
          <SettingsGroup>
            <SettingsRow
              title={t`Source`}
              chevron={showSource ? "down" : "right"}
              accessibilityRole="button"
              onPress={() => setShowSource(!showSource)}
            />
            {showSource ? <SemanticFactSource fact={fact} /> : null}
          </SettingsGroup>
          {!editing && fact.status !== "forgotten" ? (
            <NativeActionButton
              label={t`Forget`}
              prominence="destructive"
              variant="text"
              disabled={busy || conflicted}
              fill={false}
              onPress={confirmForget}
            />
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function SemanticFactSource({ fact }: { fact: SemanticFact }) {
  const { t } = useLingui();
  const source = fact.provenance;
  const kinds = {
    user: t`User`,
    run: t`Run`,
    manual: t`Manual correction`,
    import: t`Import`,
    history: t`History`,
  };
  const details = [
    { title: t`Source`, value: kinds[source.kind] },
    ...(source.sourcePath ? [{ title: t`Path`, value: source.sourcePath }] : []),
    ...(source.sourceId ? [{ title: t`Source ID`, value: source.sourceId }] : []),
    ...(source.runId ? [{ title: t`Run`, value: source.runId }] : []),
    ...(source.threadId ? [{ title: t`Thread`, value: source.threadId }] : []),
    ...(source.messageId ? [{ title: t`Message`, value: source.messageId }] : []),
    { title: t`Version`, value: String(fact.revision) },
    { title: t`Created`, value: fact.createdAt },
    { title: t`Updated`, value: fact.updatedAt },
    ...(source.observedAt ? [{ title: t`Observed`, value: source.observedAt }] : []),
    ...(source.validFrom ? [{ title: t`Valid from`, value: source.validFrom }] : []),
    ...(source.validTo ? [{ title: t`Valid to`, value: source.validTo }] : []),
    ...(fact.status === "historical" ? [{ title: t`Status`, value: t`Historical` }] : []),
    ...(fact.status === "forgotten" ? [{ title: t`Status`, value: t`Forgotten` }] : []),
    ...(source.quote ? [{ title: t`Quote`, value: source.quote }] : []),
  ];
  return (
    <View>
      {details.map(({ title, value }) => (
        <SettingsRow key={title} title={title} detail={value} />
      ))}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 20, gap: 16 },
    secondary: { color: native.secondaryLabel, fontSize: 15 },
    error: { color: mobileTokens().destructive, fontSize: 13 },
    headerAction: { color: native.label, fontSize: 24, paddingHorizontal: 12 },
    sheet: { flex: 1, backgroundColor: native.groupedPage },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
    },
    fact: { color: native.label, fontSize: 17, lineHeight: 24 },
    editor: {
      minHeight: 240,
      padding: 14,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      fontSize: 17,
      lineHeight: 24,
    },
  });
}
