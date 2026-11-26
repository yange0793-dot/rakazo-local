import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";

/** Trusted app chrome, never serialized into a Page document. readFrame must be an
 * authenticated, tab-scoped reader, not a URL or callback supplied by Page content. */
export function PrivateTabFrames({
  readFrame,
}: {
  readFrame: (signal: AbortSignal) => Promise<Blob>;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let ended = false;
    let failures = 0;
    let url: string | null = null;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function clear() {
      clearTimeout(timer);
      request?.abort();
      if (url) URL.revokeObjectURL(url);
      url = null;
      if (!ended) setFrame(null);
    }
    async function tick() {
      if (ended || document.hidden) return;
      const current = new AbortController();
      request = current;
      try {
        const blob = await readFrame(current.signal);
        if (current.signal.aborted || ended) return;
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(blob.type) ||
          blob.size === 0 ||
          blob.size > 8 * 1024 * 1024
        )
          throw new Error("invalid frame");
        const old = url;
        url = URL.createObjectURL(blob);
        setFrame(url);
        setFailed(false);
        failures = 0;
        if (old) URL.revokeObjectURL(old);
        timer = setTimeout(tick, 750);
      } catch {
        if (current.signal.aborted || ended) return;
        clear();
        failures += 1;
        if (failures < 2) timer = setTimeout(tick, 750);
        else setFailed(true);
      }
    }
    function visibility() {
      clear();
      if (!document.hidden) void tick();
    }
    setFrame(null);
    setFailed(false);
    document.addEventListener("visibilitychange", visibility);
    void tick();
    return () => {
      ended = true;
      clear();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [readFrame, attempt]);
  return frame ? (
    <img
      src={frame}
      alt="机器人正在操作的 Gemini 标签页"
      className="w-full object-contain print:hidden"
    />
  ) : failed ? (
    <div className="flex items-center gap-2">
      <p role="status">标签页连接已中断。</p>
      <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  ) : (
    <p role="status">正在连接 Gemini 标签页…</p>
  );
}
