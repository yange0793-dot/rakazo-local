import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  BotAvatarSet,
  ComputerMode,
  ModelCatalogEntry,
  ReplyMode,
  ThinkingLevel,
} from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH, isBuiltinToolName, resolveBotAvatarSet } from "@rakazo/contracts";
import type { ChatModelChoice } from "@rakazo/core";
import {
  botLookState,
  chatModelChoices,
  clampCatalogThinkingLevel,
  connectedModelChoices,
  credentialForModel,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";
import { Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Cloud, Mail } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Suspense, useEffect, useId, useRef, useState } from "react";
import { BotEmailAddressField } from "../../components/BotEmailAddressField";
import { ErrorBoundary, SectionLoadFailed } from "../../components/ErrorBoundary";
import { InstructionSettings } from "../../components/InstructionSettings";
import { PagesList } from "../../components/pages/PagesList";
import { botProfilePatch } from "../../lib/bot-profile-patch";
import { lazyComponent } from "../../lib/preload-recovery";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";
import { AvatarStudioPopover } from "./avatar-studio-popover";
import {
  ComputerGroup,
  DescriptionGroup,
  ExportAndClear,
  ModelSection,
  NotificationsSection,
  PermissionsGroup,
  RepliesGroup,
  ToolsGroup,
  VoiceGroup,
} from "./bot-settings-sections";
import { EffortAvatar } from "./effort-avatar";

const ScratchpadSection = lazyComponent(() =>
  import("../ScratchpadSection").then((module) => module.ScratchpadSection),
);

const KnowledgeSection = lazyComponent(() =>
  import("../KnowledgeSection").then((module) => module.KnowledgeSection),
);

/** The advanced fields one Save sends, in the order their saved snapshot keeps them. */
function advancedValues(bot: Bot) {
  return [
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
    bot.thinkingLevel ?? "",
    bot.computerMode,
    bot.memoryScope,
    bot.autoSpeak,
    bot.voiceId ?? "",
  ] as const;
}

export type BotPanelTab = "computer" | "routines" | "pages" | "settings";

const BOX_COMPUTER_VIEW_URL = "https://box.simular.ai/box/cb-372272703d21/live";

/** The cloud desktop lives outside this app's window; the card is only a way in. */
function CloudComputerCard() {
  return (
    <section>
      <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 p-4">
        <span className="flex items-center gap-2 text-body text-foreground">
          <Cloud className="size-4 text-muted-foreground" aria-hidden />
          <Trans>Cloud computer</Trans>
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => window.open(BOX_COMPUTER_VIEW_URL, "_blank", "noopener,noreferrer")}
        >
          <Trans>Open live desktop</Trans>
        </Button>
      </div>
    </section>
  );
}

/** A bot's profile above its Model, Routines, Pages and Advanced tabs. */
export function BotSettings({
  bot,
  tab = "settings",
  onTabChange,
  routines,
  memoryProviderConfigured,
  onSave,
  onExport,
  onClear,
  focusModel = 0,
  onOpenConnections,
}: {
  bot: Bot;
  tab?: BotPanelTab;
  onTabChange?: (tab: BotPanelTab) => void;
  routines?: ReactNode;
  focusModel?: number;
  onOpenConnections?: () => void;
  /** Unused: the skill sections read and save the shared cached skill list. */
  onSkillsChange?: (skills: AgentSkillCatalogEntry[]) => void;
  memoryProviderConfigured: boolean;
  onSave: (patch: {
    name?: string;
    description?: string;
    instructions?: string;
    color?: string;
    avatarSet?: BotAvatarSet;
    notifyOnFinish?: boolean;
    computerMode?: ComputerMode;
    memoryScope?: "isolated" | "shared" | null;
    autoSpeak?: boolean;
    fleetManagement?: boolean;
    replyMode?: ReplyMode;
    crossSpaceCommunication?: boolean;
    dailyCheckIns?: boolean;
    voiceId?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
    disabledBuiltinTools?: string[];
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const modelRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(bot.name);
  const savedNameRef = useRef(bot.name);
  const [description, setDescription] = useState(bot.description);
  // A roster refresh can skip replacing bots while a reorder is in flight, so
  // this prop keeps the description from when the panel opened. Later saves
  // compare against the description last saved here; otherwise a model or
  // voice change treats that stale text as an edit and overwrites instructions.
  const savedDescriptionRef = useRef(bot.description ?? "");
  const [color, setColor] = useState(bot.color);
  const [avatarSet, setAvatarSet] = useState(() => resolveBotAvatarSet(bot.avatarSet));
  const [notifyOnFinish, setNotifyOnFinish] = useState(bot.notifyOnFinish ?? true);
  const acceptedAutomatic = useRef({
    color: bot.color,
    avatarSet: resolveBotAvatarSet(bot.avatarSet),
    notifyOnFinish: bot.notifyOnFinish ?? true,
  });
  const automaticRevision = useRef({ color: 0, avatarSet: 0, notifyOnFinish: 0 });
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [memoryScope, setMemoryScope] = useState(bot.memoryScope);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [crossSpaceCommunication, setCrossSpaceCommunication] = useState(
    bot.crossSpaceCommunication ?? true,
  );
  useEffect(
    () => setCrossSpaceCommunication(bot.crossSpaceCommunication ?? true),
    [bot.crossSpaceCommunication],
  );
  const [dailyCheckIns, setDailyCheckIns] = useState(bot.dailyCheckIns ?? true);
  useEffect(() => setDailyCheckIns(bot.dailyCheckIns ?? true), [bot.dailyCheckIns]);
  const [fleetManagement, setFleetManagement] = useState(bot.fleetManagement);
  useEffect(() => setFleetManagement(bot.fleetManagement), [bot.fleetManagement]);
  const [replyMode, setReplyMode] = useState(bot.replyMode);
  useEffect(() => setReplyMode(bot.replyMode), [bot.replyMode]);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [modelKey, setModelKey] = useState(
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");
  const [disabledBuiltinTools, setDisabledBuiltinTools] = useState<string[]>(
    bot.disabledBuiltinTools ?? [],
  );
  // The list on screen is updated before the save returns. This stays on the
  // last list the server accepted so a rejection can undo that preview.
  const persistedDisabledToolsRef = useRef(disabledBuiltinTools);
  const serverDisabledToolsRef = useRef(disabledBuiltinTools);
  const pendingSavesRef = useRef(0);
  useEffect(() => {
    const next = bot.disabledBuiltinTools ?? [];
    if (serverDisabledToolsRef.current === next) return;
    serverDisabledToolsRef.current = next;
    persistedDisabledToolsRef.current = next;
    if (pendingSavesRef.current === 0) setDisabledBuiltinTools(next);
  }, [bot.disabledBuiltinTools]);
  // Shared with the model and voice settings, so a revisit paints at once and refreshes behind.
  const queries = useSpaceQueries();
  const spaceRpc = useSpaceRpc();
  const refresh = { refetchOnMount: "always" } as const;
  const voices = useQuery({ ...queries.voice.voices.queryOptions({ input: {} }), ...refresh }).data;
  const credentialsQuery = useQuery({ ...queries.models.credentials.queryOptions(), ...refresh });
  const catalogQuery = useQuery({ ...queries.models.list.queryOptions(), ...refresh });
  const meQuery = useQuery({ ...queries.me.queryOptions(), ...refresh });
  const credentials = credentialsQuery.data ?? NO_CREDENTIALS;
  const catalog = catalogQuery.data ?? NO_CATALOG;
  const me = meQuery.data ?? null;
  // No scope: read and write the model list that applies in this Space, so a Space's
  // override is what the star shows and saves rather than a silently shadowed account copy.
  const mainRoleInput = {
    role: "main" as const,
    expectedUserId: me?.userId,
  };
  const mainRoleQuery = useQuery({
    queryKey: queries.models.role.queryKey({ input: mainRoleInput }),
    queryFn: () => spaceRpc.models.role(mainRoleInput),
    enabled: Boolean(me),
  });
  // A failed catalog load must not clear an existing thinkingLevel override on save.
  const modelMetaReady =
    credentialsQuery.data !== undefined &&
    catalogQuery.data !== undefined &&
    meQuery.data !== undefined;
  useEffect(() => {
    if (focusModel && tab === "computer" && modelMetaReady) {
      modelRef.current?.scrollIntoView?.({ block: "nearest" });
      modelRef.current?.querySelector<HTMLElement>('[id$="-model"]')?.focus();
    }
  }, [tab, focusModel, modelMetaReady]);
  const [saving, setSaving] = useState(false);
  const [savedAdvanced, setSavedAdvanced] = useState(() => JSON.stringify(advancedValues(bot)));
  const advancedSnapshot = JSON.stringify([
    modelKey,
    thinkingLevel,
    computerMode,
    memoryScope,
    autoSpeak,
    voiceId,
  ]);
  const dirty =
    name.trim() !== savedNameRef.current.trim() ||
    advancedSnapshot !== savedAdvanced ||
    description.trim() !== savedDescriptionRef.current;
  const [error, setError] = useState<string | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const executeSaveRef = useRef<
    (
      patchOverrides?: {
        name?: string;
        description?: string;
        color?: string;
        avatarSet?: BotAvatarSet;
        notifyOnFinish?: boolean;
        fleetManagement?: boolean;
        replyMode?: ReplyMode;
        crossSpaceCommunication?: boolean;
        dailyCheckIns?: boolean;
        disabledBuiltinTools?: string[];
        baseDisabledBuiltinTools?: string[];
      },
      revisions?: { color: number; avatarSet: number; notifyOnFinish: number },
    ) => Promise<void>
  >(async () => undefined);
  // The panel can open on a cached bot. When a newer copy arrives, every field not edited since
  // follows it, so a later save does not send the cached values back over it. A copy that is not
  // newer (a roster read from before a save) is ignored.
  const shownBotRef = useRef(bot);
  useEffect(() => {
    const revision = bot.settingsUpdatedAt ?? bot.updatedAt;
    const previous = shownBotRef.current;
    if (revision <= (previous.settingsUpdatedAt ?? previous.updatedAt)) return;
    shownBotRef.current = bot;
    if (name.trim() === savedNameRef.current.trim()) setName(bot.name);
    savedNameRef.current = bot.name;
    if (description.trim() === savedDescriptionRef.current) setDescription(bot.description);
    savedDescriptionRef.current = bot.description ?? "";
    const accepted = acceptedAutomatic.current;
    const nextNotify = bot.notifyOnFinish ?? true;
    if (color === accepted.color) setColor(bot.color);
    const nextAvatarSet = resolveBotAvatarSet(bot.avatarSet);
    if (avatarSet === accepted.avatarSet) setAvatarSet(nextAvatarSet);
    if (notifyOnFinish === accepted.notifyOnFinish) setNotifyOnFinish(nextNotify);
    acceptedAutomatic.current = {
      color: bot.color,
      avatarSet: nextAvatarSet,
      notifyOnFinish: nextNotify,
    };
    const saved = JSON.parse(savedAdvanced) as unknown[];
    const next = advancedValues(bot);
    if (modelKey === saved[0]) setModelKey(next[0]);
    if (thinkingLevel === saved[1]) setThinkingLevel(next[1]);
    if (computerMode === saved[2]) setComputerMode(next[2]);
    if (memoryScope === saved[3]) setMemoryScope(next[3]);
    if (autoSpeak === saved[4]) setAutoSpeak(next[4]);
    if (voiceId === saved[5]) setVoiceId(next[5]);
    setSavedAdvanced(JSON.stringify(next));
  }, [bot]);

  const connectedOptions = connectedModelChoices(credentials, catalog);
  const storedModel = modelKey ? parseModelOptionKey(modelKey) : null;
  const selectedModel = storedModel
    ? {
        provider: storedModel.provider,
        modelId: resolveSelectableModelId(catalog, storedModel.provider, storedModel.modelId),
      }
    : null;
  const selectedModelKey = selectedModel
    ? modelOptionKey(selectedModel.provider, selectedModel.modelId)
    : "";

  const defaultEntry = me?.defaultModel
    ? catalogEntry(catalog, me.defaultProvider, me.defaultModel)
    : undefined;
  const defaultModelKey =
    me?.defaultProvider && me?.defaultModel
      ? modelOptionKey(me.defaultProvider, me.defaultModel)
      : "";
  const modelChoices = chatModelChoices(
    connectedOptions,
    selectedModelKey || defaultModelKey,
    t`Space default`,
    defaultEntry?.images,
  ).filter((choice) => choice.key !== "");

  const [pendingDefault, setPendingDefault] = useState(false);

  // The starred model runs every bot that chose none; it is the space's main model.
  async function setDefaultModel(choice: ChatModelChoice) {
    if (!me || !choice.provider || !choice.modelId || pendingDefault) return;
    setPendingDefault(true);
    setError(null);
    try {
      await spaceRpc.models.setRole({
        role: "main",
        expectedUserId: me.userId,
        primary: { provider: choice.provider, modelId: choice.modelId },
      });
      // The star and the effort slider both read this list; without the refresh the
      // panel keeps painting the replaced model until it is reopened.
      await Promise.allSettled([mainRoleQuery.refetch(), meQuery.refetch()]);
    } catch (cause) {
      setError(errorText(cause, t`Could not save`));
    } finally {
      setPendingDefault(false);
    }
  }

  const [pendingEffort, setPendingEffort] = useState<ThinkingLevel | null>(null);
  const [pendingModel, setPendingModel] = useState(false);
  const [effortPreview, setEffortPreview] = useState<ThinkingLevel | null>(null);
  const effortColor = botLookState(color).color;

  async function setModel(key: string) {
    if (pendingModel || pendingEffort !== null || saving || !modelMetaReady) return;
    const next = parseModelOptionKey(key);
    if (!next) return;
    setPendingModel(true);
    setError(null);
    setModelKey(key);
    setThinkingLevel("");
    try {
      await onSave({
        modelProvider: next.provider,
        modelId: next.modelId,
        thinkingLevel: null,
      });
      setSavedAdvanced((previous) => {
        const saved = JSON.parse(previous) as unknown[];
        saved[0] = key;
        saved[1] = "";
        return JSON.stringify(saved);
      });
    } catch (cause) {
      setModelKey(modelKey);
      setThinkingLevel(thinkingLevel);
      setError(errorText(cause, t`Could not save`));
    } finally {
      setPendingModel(false);
    }
  }

  async function setEffort(level: ThinkingLevel) {
    const primary = mainRoleQuery.data?.primary;
    if (!me || pendingModel || pendingEffort !== null || !thinkingOptions.includes(level)) return;
    setPendingEffort(level);
    setError(null);
    try {
      if (selectedModel || thinkingLevel || !primary || !usesMainModel) {
        await onSave({
          modelProvider: selectedModel?.provider ?? null,
          modelId: selectedModel?.modelId ?? null,
          thinkingLevel: level,
        });
        setThinkingLevel(level);
        setSavedAdvanced((previous) => {
          const saved = JSON.parse(previous) as unknown[];
          saved[0] = modelKey;
          saved[1] = level;
          return JSON.stringify(saved);
        });
      } else {
        await spaceRpc.models.setRole({
          role: "main",
          expectedUserId: me.userId,
          primary: { ...primary, thinkingLevel: level },
        });
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      // A refresh that fails must not leave the picker and slider disabled: the save
      // already happened, and the next reopen refreshes the reads anyway.
      await Promise.allSettled([
        mainRoleQuery.refetch(),
        credentialsQuery.refetch(),
        catalogQuery.refetch(),
        meQuery.refetch(),
      ]);
      setPendingEffort(null);
      setEffortPreview(null);
    }
  }

  const effectiveProvider = selectedModel?.provider ?? me?.defaultProvider ?? null;
  const effectiveModelId = selectedModel?.modelId ?? me?.defaultModel ?? null;
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) =>
            entry.provider === effectiveProvider &&
            resolveSelectableModelId(catalog, entry.provider, entry.id) === effectiveModelId,
        )
      : undefined;
  const effectiveCredential =
    credentialForModel(credentials, effectiveProvider, effectiveModelId) ??
    credentials.find(
      (credential) =>
        credential.provider === effectiveProvider &&
        effectiveModelId &&
        credential.catalogSource?.unavailableModelIds.includes(effectiveModelId),
    );
  const modelUnavailable = Boolean(
    effectiveCredential?.catalogSource &&
      (!effectiveCredential.catalogSource.available ||
        (effectiveModelId &&
          effectiveCredential.catalogSource.unavailableModelIds.includes(effectiveModelId))),
  );
  const thinkingOptions: readonly ThinkingLevel[] = (
    effectiveEntry?.thinkingLevels ??
    effectiveCredential?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");
  const primary = mainRoleQuery.data?.primary;
  const usesMainModel =
    primary?.provider === effectiveProvider && primary?.modelId === effectiveModelId;
  const effortLevel =
    pendingEffort ??
    ((thinkingLevel || null) as ThinkingLevel | null) ??
    (usesMainModel ? primary?.thinkingLevel : null) ??
    effectiveCredential?.thinkingLevel ??
    "medium";
  const effectiveEffort = clampCatalogThinkingLevel(effortLevel, thinkingOptions);
  const glowLevel = effortPreview ?? (effectiveEffort as ThinkingLevel | null) ?? "off";

  async function executeSave(
    patchOverrides?: {
      name?: string;
      description?: string;
      color?: string;
      avatarSet?: BotAvatarSet;
      notifyOnFinish?: boolean;
      fleetManagement?: boolean;
      replyMode?: ReplyMode;
      crossSpaceCommunication?: boolean;
      dailyCheckIns?: boolean;
      disabledBuiltinTools?: string[];
      baseDisabledBuiltinTools?: string[];
    },
    revisions?: { color: number; avatarSet: number; notifyOnFinish: number },
  ) {
    try {
      setSaving(true);
      setError(null);
      if (patchOverrides?.crossSpaceCommunication !== undefined) {
        await onSave({ crossSpaceCommunication: patchOverrides.crossSpaceCommunication });
        return;
      }
      if (patchOverrides?.dailyCheckIns !== undefined) {
        await onSave({ dailyCheckIns: patchOverrides.dailyCheckIns });
        return;
      }
      if (patchOverrides?.fleetManagement !== undefined) {
        await onSave({ fleetManagement: patchOverrides.fleetManagement });
        return;
      }
      if (patchOverrides?.replyMode !== undefined) {
        await onSave({ replyMode: patchOverrides.replyMode });
        return;
      }
      const selected = selectedModel;
      const nextName = (patchOverrides?.name !== undefined ? patchOverrides.name : name).trim();
      const nextDescription = (
        patchOverrides?.description !== undefined ? patchOverrides.description : description
      ).trim();
      const nextColor = patchOverrides?.color !== undefined ? patchOverrides.color : color;
      const nextAvatarSet = patchOverrides?.avatarSet ?? avatarSet;
      const nextNotify =
        patchOverrides?.notifyOnFinish !== undefined
          ? patchOverrides.notifyOnFinish
          : notifyOnFinish;

      if (nextName) setName(nextName);
      setDescription(nextDescription);
      const patch = {
        ...(nextName && nextName !== savedNameRef.current.trim() ? { name: nextName } : {}),
        // Keep untouched profile fields off the wire.
        ...botProfilePatch(savedDescriptionRef.current, nextDescription),
        // Unchanged color stays off the wire so a legacy named value cannot fail a name save.
        ...(nextColor !== acceptedAutomatic.current.color ? { color: nextColor } : {}),
        ...(patchOverrides?.avatarSet !== undefined ||
        nextAvatarSet !== acceptedAutomatic.current.avatarSet
          ? { avatarSet: nextAvatarSet }
          : {}),
        notifyOnFinish: nextNotify,
        computerMode,
        memoryScope,
        autoSpeak,
        voiceId: voiceId || null,
        modelProvider: selected?.provider ?? null,
        modelId: selected?.modelId ?? null,
        ...(modelMetaReady &&
        (thinkingOptions.length > 0 ||
          (selected?.provider ?? null) !== bot.modelProvider ||
          (selected?.modelId ?? null) !== bot.modelId)
          ? {
              thinkingLevel: thinkingOptions.length
                ? ((thinkingLevel || null) as ThinkingLevel | null)
                : null,
            }
          : {}),
      };
      const requestedTools = patchOverrides?.disabledBuiltinTools;
      const baseTools = patchOverrides?.baseDisabledBuiltinTools ?? [];
      // Preserve this edit's additions/removals against any refreshed server list.
      // Retry if a refresh arrives while the request is in flight.
      for (;;) {
        const serverTools = serverDisabledToolsRef.current;
        const nextTools =
          requestedTools === undefined
            ? undefined
            : [
                ...persistedDisabledToolsRef.current.filter(
                  (name) => !baseTools.includes(name) || requestedTools.includes(name),
                ),
                ...requestedTools.filter(
                  (name) =>
                    !baseTools.includes(name) && !persistedDisabledToolsRef.current.includes(name),
                ),
              ];
        // Unrelated saves omit the list, preserving changes from other sessions.
        await onSave({
          ...patch,
          ...(nextTools !== undefined ? { disabledBuiltinTools: nextTools } : {}),
        });
        if (nextTools === undefined) break;
        if (
          serverTools !== serverDisabledToolsRef.current &&
          !sameStringList(nextTools, serverDisabledToolsRef.current)
        )
          continue;
        persistedDisabledToolsRef.current = nextTools;
        break;
      }
      acceptedAutomatic.current = {
        color: nextColor,
        avatarSet: nextAvatarSet,
        notifyOnFinish: nextNotify,
      };
      if (nextName) savedNameRef.current = nextName;
      savedDescriptionRef.current = nextDescription;
      setSavedAdvanced(
        JSON.stringify([modelKey, thinkingLevel, computerMode, memoryScope, autoSpeak, voiceId]),
      );
    } catch (err) {
      if (
        patchOverrides?.color !== undefined &&
        revisions?.color === automaticRevision.current.color
      )
        setColor(acceptedAutomatic.current.color);
      if (
        patchOverrides?.avatarSet !== undefined &&
        revisions?.avatarSet === automaticRevision.current.avatarSet
      )
        setAvatarSet(acceptedAutomatic.current.avatarSet);
      if (
        patchOverrides?.notifyOnFinish !== undefined &&
        revisions?.notifyOnFinish === automaticRevision.current.notifyOnFinish
      )
        setNotifyOnFinish(acceptedAutomatic.current.notifyOnFinish);
      if (patchOverrides?.crossSpaceCommunication !== undefined)
        setCrossSpaceCommunication(!patchOverrides.crossSpaceCommunication);
      if (patchOverrides?.dailyCheckIns !== undefined)
        setDailyCheckIns(!patchOverrides.dailyCheckIns);
      if (patchOverrides?.fleetManagement !== undefined)
        setFleetManagement(!patchOverrides.fleetManagement);
      if (patchOverrides?.replyMode !== undefined) setReplyMode(bot.replyMode);
      setError(errorText(err, t`Could not save`));
    } finally {
      pendingSavesRef.current -= 1;
      if (pendingSavesRef.current === 0) {
        setDisabledBuiltinTools([...persistedDisabledToolsRef.current]);
      }
      setSaving(pendingSavesRef.current > 0);
    }
  }
  executeSaveRef.current = executeSave;

  function disableBuiltinTool(raw: string) {
    const name = raw.trim();
    if (!name) return;
    if (!isBuiltinToolName(name)) return;
    setError(null);
    if (disabledBuiltinTools.includes(name)) return;
    const next = [...disabledBuiltinTools, name];
    setDisabledBuiltinTools(next);
    void enqueueSave({ disabledBuiltinTools: next });
  }

  function enqueueSave(patchOverrides?: {
    name?: string;
    description?: string;
    color?: string;
    avatarSet?: BotAvatarSet;
    notifyOnFinish?: boolean;
    fleetManagement?: boolean;
    replyMode?: ReplyMode;
    crossSpaceCommunication?: boolean;
    dailyCheckIns?: boolean;
    disabledBuiltinTools?: string[];
  }) {
    // Serialize full-object auto-saves so an older in-flight request cannot
    // finish after a newer one and clobber fields. Always call through a ref so
    // queued work reads the latest field values, not a stale render closure.
    pendingSavesRef.current += 1;
    if (patchOverrides?.color !== undefined) automaticRevision.current.color += 1;
    if (patchOverrides?.avatarSet !== undefined) automaticRevision.current.avatarSet += 1;
    if (patchOverrides?.notifyOnFinish !== undefined) automaticRevision.current.notifyOnFinish += 1;
    const revisions = { ...automaticRevision.current };
    const queuedPatch =
      patchOverrides?.disabledBuiltinTools === undefined
        ? patchOverrides
        : {
            ...patchOverrides,
            baseDisabledBuiltinTools: [...persistedDisabledToolsRef.current],
          };
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(() => executeSaveRef.current(queuedPatch, revisions));
    return saveQueueRef.current;
  }

  return (
    <div data-testid="bot-settings" style={{ "--effort-color": effortColor } as CSSProperties}>
      <div data-testid="bot-profile-header" className="flex flex-col items-center pb-5 text-center">
        <EffortAvatar color={effortColor} level={glowLevel} active={tab === "computer"}>
          <AvatarStudioPopover
            value={color}
            identity={bot.id}
            status={bot.status}
            size={76}
            avatarSet={avatarSet}
            onChange={(newColor, nextAvatarSet) => {
              setColor(newColor);
              if (nextAvatarSet !== undefined) setAvatarSet(nextAvatarSet);
              void enqueueSave({
                color: newColor,
                ...(nextAvatarSet !== undefined ? { avatarSet: nextAvatarSet } : {}),
              });
            }}
          />
        </EffortAvatar>
        <InlineProfileField
          label={t`Name`}
          editLabel={t`Edit name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          className="text-heading2 font-semibold"
          onCommit={(value) => {
            if (!value.trim()) return;
            setName(value.trim());
            void enqueueSave({ name: value });
          }}
        />
        <BotEmail bot={{ id: bot.id, name }} />
      </div>
      <Tabs value={tab} onValueChange={(next) => onTabChange?.(next as BotPanelTab)}>
        <TabsList className="w-full">
          <TabsTrigger value="computer">
            <Trans>Model</Trans>
          </TabsTrigger>
          <TabsTrigger value="routines">
            <Trans>Routines</Trans>
          </TabsTrigger>
          <TabsTrigger value="pages">
            <Trans>Pages</Trans>
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Trans>Advanced</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="computer" className="pt-4">
          <div className="space-y-4">
            <ModelSection
              ids={ids}
              containerRef={modelRef}
              onOpenConnections={onOpenConnections}
              choices={modelChoices}
              value={selectedModelKey || defaultModelKey}
              onModelChange={(key) => void setModel(key)}
              modelDisabled={pendingModel || pendingEffort !== null || saving || !modelMetaReady}
              modelSaving={pendingModel}
              modelLoading={!modelMetaReady}
              effortLevel={effortLevel}
              effortLevels={thinkingOptions}
              modelUnavailable={modelUnavailable}
              onEffortChange={(level) => void setEffort(level)}
              onEffortPreview={setEffortPreview}
              effortDisabled={pendingModel || pendingEffort !== null || !me || !modelMetaReady}
              defaultModelKey={defaultModelKey}
              onSetDefaultModel={(choice) => void setDefaultModel(choice)}
            />
            <CloudComputerCard />
          </div>
        </TabsContent>
        <TabsContent value="routines" className="pt-4">
          {routines}
        </TabsContent>
        <TabsContent value="pages" className="pt-4">
          {tab === "pages" ? <PagesList botId={bot.id} /> : null}
        </TabsContent>
        {/* Stays mounted so scratchpad and knowledge drafts survive a tab switch. */}
        <TabsContent value="settings" keepMounted data-testid="bot-settings-advanced">
          <NotificationsSection
            ids={ids}
            notifyOnFinish={notifyOnFinish}
            onNotifyOnFinishChange={(checked) => {
              setNotifyOnFinish(checked);
              void enqueueSave({ notifyOnFinish: checked });
            }}
          />
          <ErrorBoundary fallback={<SectionLoadFailed />}>
            <Suspense fallback={null}>
              <ScratchpadSection botId={bot.id} />
            </Suspense>
          </ErrorBoundary>
          <ErrorBoundary fallback={<SectionLoadFailed />}>
            <Suspense fallback={null}>
              <KnowledgeSection botId={bot.id} />
            </Suspense>
          </ErrorBoundary>
          <div className="space-y-6 pt-6">
            <ComputerGroup
              computerMode={computerMode}
              onComputerModeChange={setComputerMode}
              memoryProviderConfigured={memoryProviderConfigured}
              memoryScope={memoryScope}
              onMemoryScopeChange={setMemoryScope}
            />
            <VoiceGroup
              ids={ids}
              autoSpeak={autoSpeak}
              onAutoSpeakChange={setAutoSpeak}
              voices={voices}
              voiceId={voiceId}
              onVoiceIdChange={setVoiceId}
            />
            <PermissionsGroup
              ids={ids}
              saving={saving}
              dailyCheckIns={dailyCheckIns}
              onDailyCheckInsChange={(checked) => {
                setDailyCheckIns(checked);
                void enqueueSave({ dailyCheckIns: checked });
              }}
              crossSpaceCommunication={crossSpaceCommunication}
              onCrossSpaceCommunicationChange={(checked) => {
                setCrossSpaceCommunication(checked);
                void enqueueSave({ crossSpaceCommunication: checked });
              }}
              fleetManagement={fleetManagement}
              onFleetManagementChange={(checked) => {
                setFleetManagement(checked);
                void enqueueSave({ fleetManagement: checked });
              }}
            />
            <RepliesGroup
              ids={ids}
              saving={saving}
              replyMode={replyMode}
              onReplyModeChange={(next) => {
                setReplyMode(next);
                void enqueueSave({ replyMode: next });
              }}
            />
            <InstructionSettings key={bot.id} bot={bot} />
            <DescriptionGroup
              ids={ids}
              description={description}
              onDescriptionChange={setDescription}
              onCommit={() => void enqueueSave()}
            />
            <ToolsGroup
              ids={ids}
              disabledBuiltinTools={disabledBuiltinTools}
              onDisable={disableBuiltinTool}
              onEnable={(toolName) => {
                const next = disabledBuiltinTools.filter((entry) => entry !== toolName);
                setDisabledBuiltinTools(next);
                void enqueueSave({ disabledBuiltinTools: next });
              }}
            />
            <ExportAndClear
              onExport={() => {
                setError(null);
                onExport().catch((err: unknown) => setError(errorText(err)));
              }}
              onClear={onClear}
            />
          </div>
          {dirty ? (
            <Button
              className="sticky bottom-0 mt-5 w-full"
              disabled={saving}
              onClick={() => {
                void enqueueSave({
                  name,
                  description,
                  color,
                  notifyOnFinish,
                });
              }}
            >
              <Trans>Save</Trans>
            </Button>
          ) : null}
        </TabsContent>
      </Tabs>
      {error ? (
        <p className="mt-2 text-body-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const NO_CREDENTIALS: never[] = [];
const NO_CATALOG: ModelCatalogEntry[] = [];

function sameStringList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function catalogEntry(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId);
}

function InlineProfileField({
  label,
  editLabel,
  value,
  maxLength,
  className,
  onCommit,
}: {
  label: string;
  editLabel: string;
  value: string;
  maxLength: number;
  className: string;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  function commit() {
    if (cancelled.current) return;
    setEditing(false);
    if (draft.trim() !== value.trim()) onCommit(draft);
  }
  return editing ? (
    <Input
      autoFocus
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      className={`h-auto border-transparent bg-transparent p-0 text-center shadow-none ${className}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === "Escape") event.stopPropagation();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          cancelled.current = true;
          setEditing(false);
        }
      }}
    />
  ) : (
    <button
      type="button"
      aria-label={editLabel}
      className={`min-w-0 max-w-full cursor-text break-words rounded px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      onClick={() => {
        cancelled.current = false;
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </button>
  );
}

/** The bot's address under its name; on a server that receives email, offered until claimed. */
function BotEmail({ bot }: { bot: { id: string; name: string } }) {
  const queries = useSpaceQueries();
  const email = useQuery(queries.bots.emailAddress.queryOptions({ input: { botId: bot.id } })).data;
  const [claiming, setClaiming] = useState(false);
  if (!email) return null;
  if (!email.address && !claiming) {
    return (
      <Button
        variant="ghost"
        size="xs"
        className="mt-1 text-muted-foreground"
        onClick={() => setClaiming(true)}
      >
        <Mail />
        <Trans>Get an email address</Trans>
      </Button>
    );
  }
  return (
    <div data-testid="bot-email" className="mt-2 w-full max-w-sm text-left">
      <BotEmailAddressField bot={bot} domain={email.domain} address={email.address} />
    </div>
  );
}
