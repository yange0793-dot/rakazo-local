import type { PageSummary } from "@rakazo/contracts";
import { useCallback } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";
import { PrivateTabFrames } from "./PrivateTabFrames";

export function hasPrivateBrowserPage(page: PageSummary | undefined): boolean {
  return Boolean(
    page?.visibility === "private" && page.botId && page.title.trim().toLowerCase() === "gemini",
  );
}

export function PrivateBrowserPage({ pageId }: { pageId: string }) {
  const rpc = useSpaceRpc();
  const readFrame = useCallback(
    async (signal: AbortSignal) => {
      const response = await rpc.pages.frame({ pageId }, { signal });
      if (!response.image) throw new Error("frame unavailable");
      const bytes = Uint8Array.from(atob(response.image), (value) => value.charCodeAt(0));
      return new Blob([bytes.buffer], { type: "image/png" });
    },
    [rpc, pageId],
  );
  return <PrivateTabFrames readFrame={readFrame} />;
}
