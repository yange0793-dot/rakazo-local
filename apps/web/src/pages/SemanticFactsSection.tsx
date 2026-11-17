import { Trans, useLingui } from "@lingui/react/macro";
import type { SemanticFact } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Spinner,
  Textarea,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, MoreHorizontal, Search } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorCode, errorText } from "../lib/user-error";

type MemoryScope = SemanticFact["scope"];

/** Managed records are separate from the Markdown notes above them. */
export function SemanticFactsSection({
  disabled = false,
  onBusyChange,
}: {
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [expanded, setExpanded] = useState(false);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [scope, setScope] = useState<MemoryScope>("isolated");
  const [busy, setBusy] = useState(false);
  const [recordEditing, setRecordEditing] = useState(false);
  const botSelectId = useId();
  const scopeSelectId = useId();
  const botsQuery = useQuery({ ...queries.bots.list.queryOptions(), enabled: expanded });
  const bots = botsQuery.data ?? [];
  const botId = bots.find((bot) => bot.id === selectedBotId)?.id;

  const markBusy = useCallback(
    (next: boolean) => {
      setBusy(next);
      onBusyChange?.(next);
    },
    [onBusyChange],
  );

  return (
    <div className="mt-4 border-t border-border pt-3" data-testid="semantic-facts-section">
      <Button
        variant="ghost"
        type="button"
        disabled={disabled || busy || recordEditing}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="-mx-2 h-auto w-[calc(100%+1rem)] justify-between px-2 py-2 text-body font-normal"
      >
        <Trans>Saved facts</Trans>
        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
      </Button>
      {expanded ? (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={botSelectId}>
                <Trans>Bot</Trans>
              </FieldLabel>
              <NativeSelect
                id={botSelectId}
                value={botId ?? ""}
                disabled={disabled || busy || recordEditing || botsQuery.isPending}
                onChange={(event) => {
                  setSelectedBotId(event.target.value);
                  setScope("isolated");
                }}
              >
                <NativeSelectOption value="">{t`Choose bot`}</NativeSelectOption>
                {bots.map((bot) => (
                  <NativeSelectOption key={bot.id} value={bot.id}>
                    {bot.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={scopeSelectId}>
                <Trans>Scope</Trans>
              </FieldLabel>
              <NativeSelect
                id={scopeSelectId}
                value={scope}
                disabled={disabled || busy || recordEditing || !botId}
                onChange={(event) => setScope(event.target.value as MemoryScope)}
              >
                <NativeSelectOption value="isolated">{t`Isolated`}</NativeSelectOption>
                <NativeSelectOption value="shared">{t`Shared`}</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          {botsQuery.isError ? (
            <p role="alert" className="text-body-sm text-destructive">
              {errorText(botsQuery.error, t`Could not load bots`)}
            </p>
          ) : !botsQuery.isPending && bots.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">{t`No bots available`}</p>
          ) : null}
          {botId ? (
            <SemanticFactsBrowser
              key={`${botId}:${scope}`}
              botId={botId}
              scope={scope}
              disabled={disabled}
              onBusyChange={markBusy}
              onEditingChange={setRecordEditing}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SemanticFactsBrowser({
  botId,
  scope,
  disabled,
  onBusyChange,
  onEditingChange,
}: {
  botId: string;
  scope: MemoryScope;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [opened, setOpened] = useState<SemanticFact | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const list = useInfiniteQuery(
    queries.memory.facts.infiniteOptions({
      input: (cursor: string | undefined) => ({
        botId,
        scope,
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 20,
        includeHistory,
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const supported = list.data?.pages[0]?.supported === true;
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const locked = disabled || busy;
  const dirty = editing && draft !== opened?.content;

  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    onEditingChange(editing);
    return () => onEditingChange(false);
  }, [editing, onEditingChange]);

  function markBusy(next: boolean) {
    setBusy(next);
    onBusyChange(next);
  }

  function closeRecord() {
    setOpened(null);
    setEditing(false);
    setDraft("");
    setConflicted(false);
    setConfirmForget(false);
    setError(null);
  }

  function openRecord(fact: SemanticFact) {
    closeRecord();
    setOpened(fact);
    setDraft(fact.content);
  }

  async function correct() {
    if (!opened || locked || conflicted || !draft.trim()) return;
    markBusy(true);
    setError(null);
    try {
      await rpc.memory.correctFact({
        id: opened.id,
        botId,
        scope,
        content: draft,
        expectedRevision: opened.revision,
      });
      closeRecord();
      await queryClient.invalidateQueries({ queryKey: queries.memory.facts.key() });
    } catch (reason) {
      if (errorCode(reason) === "CONFLICT") setConflicted(true);
      setError(errorText(reason, t`Could not correct memory`));
    } finally {
      markBusy(false);
    }
  }

  async function forget() {
    if (!opened || locked || conflicted) return;
    markBusy(true);
    setError(null);
    try {
      await rpc.memory.forgetFact({
        id: opened.id,
        botId,
        scope,
        expectedRevision: opened.revision,
      });
      closeRecord();
      await queryClient.invalidateQueries({ queryKey: queries.memory.facts.key() });
    } catch (reason) {
      setConfirmForget(false);
      if (errorCode(reason) === "CONFLICT") setConflicted(true);
      setError(errorText(reason, t`Could not forget memory`));
    } finally {
      markBusy(false);
    }
  }

  async function reload() {
    markBusy(true);
    try {
      await list.refetch({ throwOnError: true });
      closeRecord();
    } catch (reason) {
      setError(errorText(reason, t`Could not load memory`));
    } finally {
      markBusy(false);
    }
  }

  async function exportFacts() {
    if (locked) return;
    markBusy(true);
    setError(null);
    try {
      const exported = await rpc.memory.exportFacts({ botId, scope });
      downloadArtifactBytes(
        "memory.json",
        "application/json",
        new TextEncoder().encode(JSON.stringify(exported, null, 2)),
      );
    } catch (reason) {
      setError(errorText(reason, t`Could not export memory`));
    } finally {
      markBusy(false);
    }
  }

  return (
    <div data-testid="semantic-facts-browser" className="space-y-3">
      {list.isPending ? <Spinner aria-label={t`Loading memory…`} /> : null}
      {list.isError ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(list.error, t`Could not load memory`)}
        </p>
      ) : null}
      {list.isError && !list.data ? (
        <Button variant="ghost" size="sm" disabled={locked} onClick={() => void reload()}>
          <Trans>Retry</Trans>
        </Button>
      ) : null}
      {list.data && !supported ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>This provider does not support managing saved facts.</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      {conflicted ? (
        <div className="space-y-2">
          <p role="alert" className="text-body-sm text-destructive">
            <Trans>Record changed. Reload to discard your edit and use the latest version.</Trans>
          </p>
          <Button variant="outline" size="sm" disabled={locked} onClick={() => void reload()}>
            <Trans>Reload</Trans>
          </Button>
        </div>
      ) : null}
      {supported ? (
        <>
          <div className="flex items-center gap-2">
            <form
              className="flex min-w-0 flex-1 items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (locked || dirty) return;
                closeRecord();
                setQuery(search.trim());
              }}
            >
              <Input
                type="search"
                aria-label={t`Search`}
                placeholder={t`Search`}
                maxLength={500}
                value={search}
                disabled={locked || dirty}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                type="submit"
                aria-label={t`Search`}
                disabled={locked || dirty}
              >
                <Search className="size-4" />
              </Button>
            </form>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label={t`Memory actions`}
                disabled={locked || dirty}
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void exportFacts()}>
                  <Trans>Export</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    closeRecord();
                    setIncludeHistory(!includeHistory);
                  }}
                >
                  {includeHistory ? <Trans>Hide history</Trans> : <Trans>Show history</Trans>}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {!items.length && !list.isError ? (
            <p className="text-body-sm text-muted-foreground">
              {query ? <Trans>No matching records</Trans> : <Trans>Nothing remembered yet</Trans>}
            </p>
          ) : null}
          <div className="divide-y divide-border">
            {items.map((fact) => (
              <div key={fact.id}>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={locked || dirty}
                  aria-expanded={opened?.id === fact.id}
                  onClick={() => (opened?.id === fact.id ? closeRecord() : openRecord(fact))}
                  className="-mx-2 h-auto min-h-11 w-[calc(100%+1rem)] justify-between whitespace-normal px-2 py-2.5 text-start text-body font-normal"
                >
                  <span
                    className={`min-w-0 flex-1 break-words ${opened?.id === fact.id && !editing ? "whitespace-pre-wrap" : "line-clamp-2"}`}
                    dir="auto"
                  >
                    {(opened?.id === fact.id && !editing ? opened.content : fact.content) ||
                      t`Forgotten`}
                  </span>
                  <ChevronRight className="ms-2 size-4 shrink-0 text-muted-foreground" />
                </Button>
                {opened?.id === fact.id ? (
                  <div className="space-y-3 pb-3">
                    {editing ? (
                      <Textarea
                        aria-label={t`Correction`}
                        value={draft}
                        disabled={locked || conflicted}
                        maxLength={20_000}
                        rows={5}
                        dir="auto"
                        onChange={(event) => setDraft(event.target.value)}
                      />
                    ) : null}
                    <SemanticFactSource fact={opened} />
                    <div className="flex flex-wrap gap-2">
                      {editing ? (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={locked || conflicted || !draft.trim() || !dirty}
                            onClick={() => void correct()}
                          >
                            <Trans>Save correction</Trans>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={locked}
                            onClick={() => {
                              setDraft(opened.content);
                              setEditing(false);
                            }}
                          >
                            <Trans>Cancel</Trans>
                          </Button>
                        </>
                      ) : opened.status === "active" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={locked || conflicted}
                          onClick={() => setEditing(true)}
                        >
                          <Trans>Correct</Trans>
                        </Button>
                      ) : null}
                      {!editing && opened.status !== "forgotten" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={locked || conflicted}
                          className="ms-auto text-destructive"
                          onClick={() => setConfirmForget(true)}
                        >
                          <Trans>Forget</Trans>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {list.hasNextPage ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={locked || dirty || list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              <Trans>Show more</Trans>
            </Button>
          ) : null}
        </>
      ) : null}
      <AlertDialog
        open={confirmForget}
        onOpenChange={(open) => {
          if (!busy) setConfirmForget(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Forget this record?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>It will no longer be recalled.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void forget()}>
              <Trans>Forget</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
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
    { label: t`Source`, value: kinds[source.kind] },
    ...(source.sourcePath ? [{ label: t`Path`, value: source.sourcePath }] : []),
    ...(source.sourceId ? [{ label: t`Source ID`, value: source.sourceId }] : []),
    ...(source.runId ? [{ label: t`Run`, value: source.runId }] : []),
    ...(source.threadId ? [{ label: t`Thread`, value: source.threadId }] : []),
    ...(source.messageId ? [{ label: t`Message`, value: source.messageId }] : []),
    { label: t`Version`, value: String(fact.revision) },
    { label: t`Created`, value: fact.createdAt },
    { label: t`Updated`, value: fact.updatedAt },
    ...(source.observedAt ? [{ label: t`Observed`, value: source.observedAt }] : []),
    ...(source.validFrom ? [{ label: t`Valid from`, value: source.validFrom }] : []),
    ...(source.validTo ? [{ label: t`Valid to`, value: source.validTo }] : []),
    ...(fact.status === "historical" ? [{ label: t`Status`, value: t`Historical` }] : []),
    ...(fact.status === "forgotten" ? [{ label: t`Status`, value: t`Forgotten` }] : []),
  ];
  return (
    <details className="space-y-2 text-body-sm text-muted-foreground">
      <summary className="w-fit cursor-pointer">
        <Trans>Source</Trans>
      </summary>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {details.map(({ label, value }) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="break-words" dir="auto">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {source.quote ? (
        <blockquote
          className="whitespace-pre-wrap break-words border-s-2 border-border ps-3"
          dir="auto"
        >
          {source.quote}
        </blockquote>
      ) : null}
    </details>
  );
}
