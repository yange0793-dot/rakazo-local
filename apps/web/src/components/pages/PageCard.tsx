import { Trans, useLingui } from "@lingui/react/macro";
import { formatRelativeTime } from "../../lib/relative-time";
import { PagePreview } from "./PagePreview";
import { PageTileIcon } from "./page-icon";

/** A page in the chat: its live top and a footer naming it. The whole card opens the page. */
export function PageCard({
  title,
  document,
  onOpen,
  updated = false,
  updatedAt,
  shared = false,
  failed = false,
}: {
  title: string;
  /** When the page last changed, said under its title. */
  updatedAt?: string;
  /** Anyone with the link can open it. */
  shared?: boolean;
  document: string | null;
  /** The page could not be read, so its preview stops looking like it is loading. */
  failed?: boolean;
  /** Absent once the page is deleted: the card stays in the chat and opens nothing. */
  onOpen?: () => void;
  /** A newer version of this page appears further down the chat. */
  updated?: boolean;
}) {
  const { t } = useLingui();
  const when = updatedAt ? formatRelativeTime(updatedAt) : "";
  return (
    <div
      data-testid="page-card"
      data-deleted={onOpen === undefined || undefined}
      className="relative w-full max-w-[561px] overflow-hidden pointer-coarse:min-[900px]:max-w-[639px] rounded-[24px] bg-card ring-[0.5px] ring-border has-focus-visible:ring-2 has-focus-visible:ring-ring data-deleted:bg-transparent data-deleted:opacity-70"
    >
      {onOpen ? <PagePreview document={document} title={title} failed={failed} /> : null}
      <div className="flex h-[73px] items-center gap-[14px] border-t border-foreground/[0.04] px-5">
        <PageTileIcon />
        <div className="min-w-0">
          <div className="relative top-[1px] truncate text-body-lg leading-[21px] text-foreground">
            {title}
          </div>
          <div className="truncate text-body text-muted-foreground">
            {onOpen === undefined ? (
              <Trans>Page · Deleted</Trans>
            ) : updated ? (
              <Trans>Page · Updated below</Trans>
            ) : when ? (
              shared ? (
                <Trans>Page · Shared · {when}</Trans>
              ) : (
                <Trans>Page · {when}</Trans>
              )
            ) : (
              <Trans>Page</Trans>
            )}
          </div>
        </div>
      </div>
      {onOpen ? (
        <button
          type="button"
          aria-label={t`Open ${title}`}
          onClick={onOpen}
          className="absolute inset-0 rounded-[24px] outline-none"
        />
      ) : null}
    </div>
  );
}
