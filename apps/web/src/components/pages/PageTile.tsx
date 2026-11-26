import { Trans, useLingui } from "@lingui/react/macro";
import { PageIcon } from "@rakazo/chat-ui/web";
import type { PageSummary } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePageDocument } from "../../lib/pages";
import { useSpaceQueries } from "../../lib/query";
import { formatRelativeTime } from "../../lib/relative-time";
import { PagePreview } from "./PagePreview";

/** How far outside the panel a tile's page is read before it scrolls into view. */
const NEAR_MARGIN = "400px 0px";

/**
 * A page as a card: its top drawn live above a footer naming it. The page is read and drawn only
 * once the tile nears view, so a long list neither fetches nor runs every page.
 */
export function PageTile({ page, onOpen }: { page: PageSummary; onOpen: () => void }) {
  const { t } = useLingui();
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: NEAR_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={box}
      data-testid="page-tile"
      className="relative overflow-hidden rounded-xl bg-card ring-[0.5px] ring-border transition-[box-shadow] hover:ring-1 hover:ring-ring/40 has-focus-visible:ring-2 has-focus-visible:ring-ring"
    >
      {near ? (
        <PageThumb pageId={page.id} title={page.title} />
      ) : (
        <PagePreview document={null} title={page.title} failed={false} />
      )}
      <div className="flex items-center gap-2.5 border-t border-foreground/[0.04] px-3 py-2">
        <PageIcon className="h-5 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body text-foreground" dir="auto">
            {page.title}
          </div>
          <div className="flex items-center gap-1 text-label text-muted-foreground">
            {page.visibility === "link" ? (
              <>
                <Globe aria-hidden="true" className="size-3" strokeWidth={1.8} />
                <Trans>Shared</Trans>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <span>{formatRelativeTime(page.updatedAt)}</span>
          </div>
        </div>
      </div>
      <button
        type="button"
        aria-label={t`Open ${page.title}`}
        onClick={onOpen}
        className="absolute inset-0 rounded-xl outline-none"
      />
    </div>
  );
}

/** The page itself, read once the tile nears view. */
function PageThumb({ pageId, title }: { pageId: string; title: string }) {
  const queries = useSpaceQueries();
  const detail = useQuery(queries.pages.get.queryOptions({ input: { pageId } }));
  const viewer = usePageDocument(detail.data?.code);
  return (
    <PagePreview
      document={viewer.document}
      title={title}
      failed={detail.isError || viewer.failed}
    />
  );
}
