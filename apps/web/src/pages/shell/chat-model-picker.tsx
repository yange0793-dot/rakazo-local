import { Trans, useLingui } from "@lingui/react/macro";
import type { ChatModelChoice } from "@rakazo/core";
import { groupModelChoices, modelChoiceSearchText } from "@rakazo/core";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  ListSearchInput,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { ChevronDownIcon, LoaderCircle, Star } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { TextOnlyMark } from "../../components/TextOnlyMark";
import { useListSearch } from "../../lib/use-list-search";

/** A chat's model: a native select, or a searchable list once there are too many to scan. */
export function ChatModelPicker({
  id,
  choices,
  value,
  onChange,
  defaultKey,
  onSetDefault,
  unavailableKey,
  disabled = false,
  saving = false,
}: {
  id: string;
  choices: readonly ChatModelChoice[];
  value: string;
  onChange: (key: string) => void;
  /** The model run by bots that picked none; its row carries the filled star. */
  defaultKey?: string;
  onSetDefault?: (choice: ChatModelChoice) => void;
  /** A saved choice kept visible after its source stopped offering it. */
  unavailableKey?: string;
  disabled?: boolean;
  saving?: boolean;
}) {
  const { t } = useLingui();
  const imagesHintId = useId();
  const [open, setOpen] = useState(false);
  const { query, setQuery, showSearch, visible } = useListSearch(choices, {
    text: modelChoiceSearchText,
  });
  const sections = useMemo(() => groupModelChoices(visible, ""), [visible]);
  const selected = choices.find((choice) => choice.key === value) ?? choices[0];
  const textOnly = selected?.images === false;
  const imagesHint = <span id={imagesHintId} hidden>{t`Can't read images`}</span>;

  if (!showSearch) {
    return (
      <div className="mt-2 flex items-center gap-2">
        {imagesHint}
        <NativeSelect
          id={id}
          className="w-full"
          aria-describedby={textOnly ? imagesHintId : undefined}
          value={value}
          disabled={disabled}
          aria-busy={saving || undefined}
          aria-invalid={value === unavailableKey || undefined}
          onChange={(event) => onChange(event.target.value)}
        >
          {choices.map((choice) => (
            <NativeSelectOption
              key={choice.key}
              value={choice.key}
              disabled={choice.key === unavailableKey}
            >
              {choice.key === unavailableKey ? t`${choice.label} (Unavailable)` : choice.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {textOnly ? (
          <span className="text-muted-foreground">
            <TextOnlyMark />
          </span>
        ) : null}
      </div>
    );
  }

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      {imagesHint}
      <PopoverTrigger
        id={id}
        aria-describedby={textOnly ? imagesHintId : undefined}
        aria-invalid={value === unavailableKey || undefined}
        disabled={disabled}
        aria-busy={saving || undefined}
        className="mt-2 flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent pr-2.5 pl-2.5 text-start text-body text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
      >
        <span className="min-w-0 truncate">
          {selected?.key === unavailableKey ? t`${selected?.label} (Unavailable)` : selected?.label}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {textOnly ? <TextOnlyMark /> : null}
          {saving ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="size-4" aria-hidden="true" />
          )}
        </span>
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          align="start"
          side="bottom"
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          className="w-(--anchor-width) max-h-(--available-height) gap-0 overflow-hidden bg-popover p-0 opacity-100 animate-none! backdrop-filter-none"
        >
          <Command
            shouldFilter={false}
            className="h-auto min-h-0 max-h-(--available-height) rounded-none bg-popover *:data-[slot=command-input-wrapper]:shrink-0"
          >
            <ListSearchInput
              command
              query={query}
              setQuery={setQuery}
              label={t`Search models`}
              placeholder={t`Search`}
            />
            <CommandList className="min-h-0 max-h-80 flex-1 overflow-y-auto">
              <CommandEmpty>
                <Trans>No matching models</Trans>
              </CommandEmpty>
              {sections.map((section) => (
                <CommandGroup key={section.key} heading={section.heading}>
                  {section.data.map((choice) => (
                    <CommandItem
                      key={choice.key}
                      aria-label={choice.label}
                      disabled={choice.key === unavailableKey}
                      // cmdk falls back to the row's text for an empty value.
                      value={choice.key || "space-default"}
                      data-checked={choice.key === value}
                      aria-describedby={choice.images === false ? imagesHintId : undefined}
                      onSelect={() => {
                        onChange(choice.key);
                        openChange(false);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {choice.key === unavailableKey
                          ? t`${choice.title ?? choice.label} (Unavailable)`
                          : (choice.title ?? choice.label)}
                      </span>
                      {onSetDefault &&
                      choice.provider &&
                      choice.modelId &&
                      choice.key !== unavailableKey ? (
                        <button
                          type="button"
                          aria-label={t`Default model for all bots`}
                          aria-pressed={choice.key === defaultKey}
                          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSetDefault(choice);
                          }}
                        >
                          <Star
                            className={
                              choice.key === defaultKey
                                ? "size-4 fill-current text-foreground"
                                : "size-4"
                            }
                            aria-hidden="true"
                          />
                        </button>
                      ) : null}
                      {choice.images === false ? (
                        <span className="shrink-0 text-muted-foreground">
                          <TextOnlyMark />
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
