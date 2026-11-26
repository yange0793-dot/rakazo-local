import { useLingui } from "@lingui/react/macro";
import type { PageSummary } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, Rows3 } from "lucide-react";
import { useCallback, useState } from "react";
import { useOpenPage, usePageDocument } from "../../lib/pages";
import { useSpaceQueries } from "../../lib/query";
import { PageFrame } from "./PageFrame";
import { PageLoading, PageNotice } from "./PageNotice";
import { hasPrivateBrowserPage, PrivateBrowserPage } from "./PrivateBrowserPage";

/** How tall the page draws before it reports its own height. */
const FIRST_HEIGHT = 480;

/**
 * A page drawn whole: the frame is as tall as the page reports, so the panel scrolls over the
 * entire document and nothing is cut off. The page is live — an animation plays and its controls
 * work — so it is seen here rather than only after opening it.
 */
export function PagePreviewPane({
  page,
  onOpenList,
}: {
  page: PageSummary;
  onOpenList: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const openPage = useOpenPage();
  const detail = useQuery(queries.pages.get.queryOptions({ input: { pageId: page.id } }));
  const viewer = usePageDocument(detail.data?.code);
  const [drawn, setDrawn] = useState(false);
  const [height, setHeight] = useState(0);
  // A newer version, a theme change or a reload has to draw again before it shows.
  const [shown, setShown] = useState(viewer.document);
  if (shown !== viewer.document) {
    setShown(viewer.document);
    setDrawn(false);
  }
  const onHeight = useCallback((next: number) => {
    setHeight(next);
    setDrawn(next > 0);
  }, []);
  const failed = detail.isError || viewer.failed;
  const title = detail.data?.title ?? page.title;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label={t`Pages`} onClick={onOpenList}>
          <Rows3 size={16} strokeWidth={1.8} />
        </Button>
        <span className="min-w-0 flex-1 truncate text-body text-foreground" dir="auto">
          {title}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Open full screen`}
          onClick={() => openPage(page.id)}
        >
          <Maximize2 size={15} strokeWidth={1.8} />
        </Button>
      </div>
      {hasPrivateBrowserPage(detail.data) ? (
        <PrivateBrowserPage key={page.id} pageId={page.id} />
      ) : (
        <div className="relative" style={{ height: height > 0 ? height : FIRST_HEIGHT }}>
          {viewer.document !== null ? (
            <div
              className={`h-full transition-opacity duration-200 motion-reduce:transition-none ${drawn ? "opacity-100" : "opacity-0"}`}
            >
              <PageFrame document={viewer.document} title={title} interactive onHeight={onHeight} />
            </div>
          ) : null}
          {!drawn && !failed ? <PageLoading /> : null}
          {failed ? (
            <PageNotice
              title={t`This page couldn't load`}
              detail={t`Check your connection and try again.`}
              onRetry={() => {
                if (detail.isError) void detail.refetch();
                else {
                  setDrawn(false);
                  viewer.retry();
                }
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
