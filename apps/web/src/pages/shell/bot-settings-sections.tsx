import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerMode, ReplyMode, ThinkingLevel } from "@rakazo/contracts";
import {
  BOT_COMPUTER_MODES,
  BOT_DESCRIPTION_MAX_LENGTH,
  BUILTIN_TOOL_NAMES,
} from "@rakazo/contracts";
import type { ChatModelChoice } from "@rakazo/core";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import {
  Button,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Switch,
  Textarea,
  Toggle,
} from "@rakazo/ui-web";
import { Bell, Download, Loader2, Settings, X } from "lucide-react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { requestBrowserNotificationPermission } from "../../lib/browser-notifications";
import { thinkingLevelLabel } from "../../lib/model-catalog";
import { ChatModelPicker } from "./chat-model-picker";
import "./effort-bar.css";

const rowLabelClass = "text-body text-foreground";

type MemoryScope = "isolated" | "shared" | null;

export function ComputerModePicker({
  value,
  onChange,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {BOT_COMPUTER_MODES.map((mode) => (
        <Toggle
          key={mode}
          variant="outline"
          pressed={value === mode}
          onPressedChange={(pressed) => {
            if (pressed) onChange(mode);
          }}
          className="capitalize aria-pressed:border-foreground/40 aria-pressed:text-foreground"
        >
          {mode === "team" ? <Trans>Team</Trans> : <Trans>Private</Trans>}
        </Toggle>
      ))}
    </div>
  );
}

/** `plain` drops the card for a section whose single control already draws its own frame. */
function BotPanelGroup({
  label,
  plain = false,
  children,
}: {
  label: string;
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <SectionHeading variant="label" className="mb-2">
        {label}
      </SectionHeading>
      <div className={`space-y-3 [&>*]:mt-0 ${plain ? "" : "rounded-xl bg-muted/50 p-4"}`}>
        {children}
      </div>
    </section>
  );
}

function humanizeTool(name: string) {
  const words = name.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function NotificationsSection({
  ids,
  notifyOnFinish,
  onNotifyOnFinishChange,
}: {
  ids: string;
  notifyOnFinish: boolean;
  onNotifyOnFinishChange: (checked: boolean) => void;
}) {
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? undefined : Notification.permission,
  );
  const [requesting, setRequesting] = useState(false);
  useEffect(() => {
    const refresh = () =>
      setPermission(typeof Notification === "undefined" ? undefined : Notification.permission);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  return (
    <section className="mt-6">
      <SectionHeading variant="label" className="mb-2">
        <Trans>Notifications</Trans>
      </SectionHeading>
      <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 p-4">
        <div>
          <label
            htmlFor={`${ids}-notify-finish`}
            id={`${ids}-notify-finish-label`}
            className="text-body"
          >
            <Trans>When it finishes or needs input</Trans>
          </label>
        </div>
        <Switch
          id={`${ids}-notify-finish`}
          checked={notifyOnFinish}
          aria-labelledby={`${ids}-notify-finish-label`}
          onCheckedChange={onNotifyOnFinishChange}
        />
      </div>
      {notifyOnFinish && permission === "default" ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          disabled={requesting}
          onClick={async () => {
            setRequesting(true);
            setPermission(await requestBrowserNotificationPermission());
            setRequesting(false);
          }}
        >
          <Bell className="size-4" aria-hidden />
          <Trans>Enable browser notifications</Trans>
        </Button>
      ) : null}
      {notifyOnFinish && permission === "denied" ? (
        <p className="mt-2 text-caption text-muted-foreground">
          <Trans>Notifications are blocked in your browser's site settings.</Trans>
        </p>
      ) : null}
    </section>
  );
}

/** Preview while adjusting; persist only the released or keyboard-confirmed value. */
export function EffortBar({
  level,
  levels,
  onChange,
  onPreview,
  disabled = false,
}: {
  level: ThinkingLevel;
  levels: readonly ThinkingLevel[];
  onChange: (level: ThinkingLevel) => void;
  onPreview?: (level: ThinkingLevel | null) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const id = useId();
  const available: readonly ThinkingLevel[] = levels.filter((option) => option !== "off");
  const effectiveLevel = clampCatalogThinkingLevel(level, available) as ThinkingLevel | null;
  const [draft, setDraft] = useState(effectiveLevel);
  const [dragging, setDragging] = useState(false);
  const committed = useRef(level);
  useEffect(() => {
    setDraft(effectiveLevel);
    committed.current = level;
  }, [level, effectiveLevel]);
  const shownLevel = draft && available.includes(draft) ? draft : effectiveLevel;
  const activeIndex = shownLevel ? available.indexOf(shownLevel) : 0;

  function preview(index: number) {
    setDraft(available[index]!);
    onPreview?.(available[index]!);
  }

  function commit(index: number) {
    const next = available[index]!;
    setDraft(next);
    if (committed.current !== next) {
      committed.current = next;
      onChange(next);
    }
  }

  if (!shownLevel) {
    return (
      <p className="text-body-sm text-muted-foreground">
        <Trans>Effort unavailable for this model</Trans>
      </p>
    );
  }
  const adjusted = effectiveLevel !== level;
  const requestedLabel = thinkingLevelLabel(level);
  const effectiveLabel = effectiveLevel ? thinkingLevelLabel(effectiveLevel) : "";
  return (
    <div
      className="effort-bar pt-1"
      data-dragging={dragging}
      data-disabled={disabled}
      style={
        {
          "--effort-count": available.length,
          "--effort-step": `${100 / available.length}%`,
          "--effort-inset": `${50 / available.length}%`,
        } as CSSProperties
      }
    >
      <label htmlFor={id} className="text-label font-medium text-muted-foreground">
        <Trans>Effort</Trans>
      </label>
      <div className="effort-axis text-caption text-muted-foreground" aria-hidden="true">
        <span>
          <Trans>Faster</Trans>
        </span>
        <span>
          <Trans>Smarter</Trans>
        </span>
      </div>
      <div className="effort-control">
        <div className="effort-track" aria-hidden="true" />
        <div
          className="effort-cursor"
          style={{ transform: `translateX(${activeIndex * 100}%)` }}
          aria-hidden="true"
        >
          <span className="effort-pointer" />
        </div>
        <input
          id={id}
          type="range"
          min={0}
          max={available.length - 1}
          step={1}
          value={activeIndex}
          disabled={disabled || available.length === 1}
          aria-label={t`Effort`}
          aria-valuetext={thinkingLevelLabel(shownLevel)}
          aria-describedby={adjusted ? `${id}-effective` : undefined}
          onChange={(event) => preview(event.currentTarget.valueAsNumber)}
          onFocus={() => onPreview?.(available[activeIndex]!)}
          onPointerDown={() => {
            setDragging(true);
            onPreview?.(available[activeIndex]!);
          }}
          onPointerUp={(event) => {
            commit(event.currentTarget.valueAsNumber);
            setDragging(false);
            onPreview?.(null);
          }}
          onPointerCancel={() => {
            setDraft(effectiveLevel);
            setDragging(false);
            onPreview?.(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(effectiveLevel);
              onPreview?.(null);
            }
          }}
          onKeyUp={(event) => {
            if (event.key === "Enter") commit(event.currentTarget.valueAsNumber);
          }}
          onBlur={(event) => {
            if (draft !== effectiveLevel) commit(event.currentTarget.valueAsNumber);
            setDragging(false);
            onPreview?.(null);
          }}
        />
      </div>
      <div className="effort-stops">
        {available.map((option, index) => (
          <button
            key={option}
            type="button"
            tabIndex={available.length === 1 ? 0 : -1}
            disabled={disabled}
            aria-label={thinkingLevelLabel(option)}
            aria-pressed={option === shownLevel}
            onPointerEnter={() => {
              if (!disabled) onPreview?.(option);
            }}
            onPointerLeave={() => onPreview?.(null)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              preview(index);
              commit(index);
            }}
          >
            <span className="effort-stop-hit" aria-hidden="true">
              <span className="effort-stop-dot" />
            </span>
            <span className="text-caption font-mono">{option}</span>
          </button>
        ))}
      </div>
      {adjusted ? (
        <p id={`${id}-effective`} className="mt-2 text-body-sm text-warning" role="status">
          <Trans>
            Saved {requestedLabel}; using {effectiveLabel}.
          </Trans>
        </p>
      ) : null}
    </div>
  );
}

/** The model picker and the effort every model runs at. */
export function ModelSection({
  ids,
  containerRef,
  onOpenConnections,
  choices,
  value,
  onModelChange,
  modelDisabled = false,
  modelSaving = false,
  modelLoading = false,
  effortLevel,
  effortLevels = [],
  onEffortChange,
  onEffortPreview,
  effortDisabled = false,
  modelUnavailable = false,
  defaultModelKey,
  onSetDefaultModel,
}: {
  ids: string;
  containerRef: RefObject<HTMLDivElement | null>;
  onOpenConnections?: () => void;
  choices: readonly ChatModelChoice[];
  value: string;
  onModelChange: (key: string) => void;
  modelDisabled?: boolean;
  modelSaving?: boolean;
  modelLoading?: boolean;
  effortLevel: ThinkingLevel;
  effortLevels?: readonly ThinkingLevel[];
  onEffortChange: (level: ThinkingLevel) => void;
  onEffortPreview?: (level: ThinkingLevel | null) => void;
  effortDisabled?: boolean;
  modelUnavailable?: boolean;
  defaultModelKey?: string;
  onSetDefaultModel?: (choice: ChatModelChoice) => void;
}) {
  const { t } = useLingui();
  const thinking = (
    <EffortBar
      key={`${value}:${effortLevels.join(":")}`}
      level={effortLevel}
      levels={effortLevels}
      onChange={onEffortChange}
      onPreview={onEffortPreview}
      disabled={effortDisabled}
    />
  );
  return (
    <div ref={containerRef}>
      <div className="mb-2 flex items-center justify-between text-label font-medium text-muted-foreground pe-1">
        <Trans>Model</Trans>
        {onOpenConnections ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t`Model connections`}
            onClick={onOpenConnections}
          >
            <Settings className="size-4" />
          </Button>
        ) : null}
      </div>
      <div className="rounded-xl bg-muted/50 p-4 space-y-3">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <label htmlFor={`${ids}-model`} className="sr-only">
            <Trans>Model</Trans>
          </label>
          <div className="min-w-0 w-full [&>div]:mt-0 [&>button]:mt-0">
            <ChatModelPicker
              id={`${ids}-model`}
              choices={choices}
              value={value}
              onChange={onModelChange}
              disabled={modelDisabled}
              saving={modelSaving}
              defaultKey={defaultModelKey}
              onSetDefault={onSetDefaultModel}
              unavailableKey={modelUnavailable ? value : undefined}
            />
          </div>
        </div>
        {modelLoading ? (
          <div className="flex min-h-20 items-center justify-center" role="status">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            <span className="sr-only">
              <Trans>Loading</Trans>
            </span>
          </div>
        ) : modelUnavailable ? null : (
          thinking
        )}
      </div>
    </div>
  );
}

export function ComputerGroup({
  computerMode,
  onComputerModeChange,
  memoryProviderConfigured,
  memoryScope,
  onMemoryScopeChange,
}: {
  computerMode: ComputerMode;
  onComputerModeChange: (mode: ComputerMode) => void;
  memoryProviderConfigured: boolean;
  memoryScope: MemoryScope;
  onMemoryScopeChange: (scope: MemoryScope) => void;
}) {
  const { t } = useLingui();
  return (
    <BotPanelGroup label={t`Computer`} plain>
      <ComputerModePicker value={computerMode} onChange={onComputerModeChange} />
      {memoryProviderConfigured ? (
        <div className="mt-4 text-body text-foreground">
          <Trans>Memory scope</Trans>
          <div className="mt-2 flex gap-2">
            {(
              [
                { value: null, label: t`Inherit default` },
                { value: "isolated" as const, label: t`Isolated` },
                { value: "shared" as const, label: t`Shared` },
              ] satisfies Array<{ value: "isolated" | "shared" | null; label: string }>
            ).map((option) => (
              <Toggle
                key={option.label}
                variant="outline"
                size="sm"
                pressed={memoryScope === option.value}
                onPressedChange={(pressed) => {
                  if (pressed) onMemoryScopeChange(option.value);
                }}
                className="flex-1 aria-pressed:border-foreground/40 aria-pressed:text-foreground"
              >
                {option.label}
              </Toggle>
            ))}
          </div>
        </div>
      ) : null}
    </BotPanelGroup>
  );
}

export function VoiceGroup({
  ids,
  autoSpeak,
  onAutoSpeakChange,
  voices,
  voiceId,
  onVoiceIdChange,
}: {
  ids: string;
  autoSpeak: boolean;
  onAutoSpeakChange: (checked: boolean) => void;
  voices: ReadonlyArray<{ id: string; label: string }> | undefined;
  voiceId: string;
  onVoiceIdChange: (voiceId: string) => void;
}) {
  const { t } = useLingui();
  return (
    <BotPanelGroup label={t`Voice`}>
      <label
        htmlFor={`${ids}-auto-speak`}
        className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-body text-foreground"
      >
        <span className={rowLabelClass}>
          <Trans>Read replies aloud</Trans>
        </span>
        <Switch
          id={`${ids}-auto-speak`}
          checked={autoSpeak}
          onCheckedChange={(checked) => onAutoSpeakChange(checked)}
        />
      </label>
      {voices?.length ? (
        <label
          htmlFor={`${ids}-voice`}
          className="flex min-h-11 items-center justify-between gap-3 text-body text-foreground"
        >
          <Trans>Voice</Trans>
          <NativeSelect
            id={`${ids}-voice`}
            className="max-w-2/3"
            value={voiceId}
            onChange={(event) => onVoiceIdChange(event.target.value)}
          >
            <NativeSelectOption value="">{t`Account default`}</NativeSelectOption>
            {voices.map((voice) => (
              <NativeSelectOption key={voice.id} value={voice.id}>
                {voice.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
    </BotPanelGroup>
  );
}

export function PermissionsGroup({
  ids,
  saving,
  dailyCheckIns,
  onDailyCheckInsChange,
  crossSpaceCommunication,
  onCrossSpaceCommunicationChange,
  fleetManagement,
  onFleetManagementChange,
}: {
  ids: string;
  saving: boolean;
  dailyCheckIns: boolean;
  onDailyCheckInsChange: (checked: boolean) => void;
  crossSpaceCommunication: boolean;
  onCrossSpaceCommunicationChange: (checked: boolean) => void;
  fleetManagement: boolean;
  onFleetManagementChange: (checked: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <BotPanelGroup label={t`Permissions`}>
      <div className="flex min-h-11 items-center justify-between gap-3 text-body">
        <label htmlFor={`${ids}-daily-check-ins`} className={rowLabelClass}>
          <Trans>Daily check-ins on unfinished work</Trans>
        </label>
        <Switch
          id={`${ids}-daily-check-ins`}
          checked={dailyCheckIns}
          disabled={saving}
          onCheckedChange={onDailyCheckInsChange}
        />
      </div>
      <div className="flex min-h-11 items-center justify-between gap-3 text-body">
        <label htmlFor={`${ids}-cross-space`} className={rowLabelClass}>
          <Trans>Allow cross-space bot communication</Trans>
        </label>
        <Switch
          id={`${ids}-cross-space`}
          checked={crossSpaceCommunication}
          disabled={saving}
          onCheckedChange={onCrossSpaceCommunicationChange}
        />
      </div>
      <div className="flex min-h-11 items-center justify-between gap-3 text-body">
        <label htmlFor={`${ids}-fleet-management`} className={rowLabelClass}>
          <Trans>Manage other bots</Trans>
        </label>
        <Switch
          id={`${ids}-fleet-management`}
          checked={fleetManagement}
          disabled={saving}
          onCheckedChange={onFleetManagementChange}
        />
      </div>
    </BotPanelGroup>
  );
}

export function RepliesGroup({
  ids,
  saving,
  replyMode,
  onReplyModeChange,
}: {
  ids: string;
  saving: boolean;
  replyMode: ReplyMode;
  onReplyModeChange: (mode: ReplyMode) => void;
}) {
  const { t } = useLingui();
  return (
    <BotPanelGroup label={t`Replies`} plain>
      <NativeSelect
        id={`${ids}-reply-mode`}
        aria-label={t`Replies`}
        className="w-full"
        value={replyMode}
        disabled={saving}
        onChange={(event) => onReplyModeChange(event.target.value as ReplyMode)}
      >
        <NativeSelectOption value="chat">{t`Chat`}</NativeSelectOption>
        <NativeSelectOption value="messages">{t`Messages`}</NativeSelectOption>
      </NativeSelect>
    </BotPanelGroup>
  );
}

export function DescriptionGroup({
  ids,
  description,
  onDescriptionChange,
  onCommit,
}: {
  ids: string;
  description: string;
  onDescriptionChange: (description: string) => void;
  /** Saves the description when the field loses focus. */
  onCommit: () => void;
}) {
  const { t } = useLingui();
  return (
    <BotPanelGroup label={t`How other bots see it`} plain>
      <Textarea
        id={`${ids}-description`}
        aria-label={t`How other bots see it`}
        value={description}
        maxLength={BOT_DESCRIPTION_MAX_LENGTH}
        onChange={(e) => onDescriptionChange(e.target.value)}
        onBlur={onCommit}
        placeholder={t`What this bot is for`}
        rows={2}
        className="min-h-16 max-h-96 resize-none field-sizing-content"
      />
    </BotPanelGroup>
  );
}

export function ToolsGroup({
  ids,
  disabledBuiltinTools,
  onDisable,
  onEnable,
}: {
  ids: string;
  disabledBuiltinTools: string[];
  onDisable: (name: string) => void;
  onEnable: (name: string) => void;
}) {
  const { t } = useLingui();
  return (
    <BotPanelGroup label={t`Tools`} plain>
      <section data-testid="bot-settings-tools">
        <div className="space-y-2 [&>*]:mt-0">
          <div>
            <NativeSelect
              id={`${ids}-disabled-tools`}
              aria-label={t`Disable a tool`}
              value=""
              onChange={(event) => onDisable(event.target.value)}
              className="w-full"
            >
              <NativeSelectOption value="">{t`Disable a tool`}</NativeSelectOption>
              {BUILTIN_TOOL_NAMES.filter((name) => !disabledBuiltinTools.includes(name)).map(
                (name) => (
                  <NativeSelectOption key={name} value={name}>
                    {humanizeTool(name)}
                  </NativeSelectOption>
                ),
              )}
            </NativeSelect>
          </div>
          {disabledBuiltinTools.map((toolName) => (
            <div
              key={toolName}
              className="flex min-h-11 items-center justify-between gap-3 text-body"
            >
              <span>{humanizeTool(toolName)}</span>
              <Button
                id={`${ids}-disabled-${toolName}`}
                variant="ghost"
                size="icon-xs"
                aria-label={t`Enable ${humanizeTool(toolName)}`}
                title={t`Enable ${humanizeTool(toolName)}`}
                onClick={() => onEnable(toolName)}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      </section>
    </BotPanelGroup>
  );
}

export function ExportAndClear({
  onExport,
  onClear,
}: {
  onExport: () => void;
  onClear: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl bg-muted/50 px-4">
      <button
        type="button"
        className="flex min-h-12 w-full items-center justify-between text-body"
        onClick={onExport}
      >
        <Trans>Export</Trans>
        <Download className="size-4 text-muted-foreground" />
      </button>
      <button
        type="button"
        className="min-h-12 w-full border-t border-border text-start text-body text-destructive"
        onClick={onClear}
      >
        <Trans>Clear conversation</Trans>
      </button>
    </div>
  );
}
