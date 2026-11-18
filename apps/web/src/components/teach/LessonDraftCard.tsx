import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { BuiCard } from "../ai/primitives";

type LessonDraftBlock = Extract<MessageBlock, { kind: "lesson_draft" }>;

/**
 * A lesson the host wrote after reviewing a run but did not apply on its own. The text is
 * read-only here: the server saves the stored draft, never anything this card sends back.
 */
export function LessonDraftCard({
  botId,
  block,
  onRefresh,
}: {
  botId: string;
  block: LessonDraftBlock;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHere, setSavedHere] = useState(false);
  const saved = savedHere || block.status === "saved";

  async function save() {
    if (busy || saved) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.memory.saveLesson({ botId, lessonId: block.lessonId });
      setSavedHere(true);
    } catch (err) {
      setError(
        errorText(
          err,
          t({ id: "Could not save experience", message: "Could not save experience" }),
        ),
      );
      setBusy(false);
      return;
    }
    // The save already succeeded, so a failed thread refresh is not reported as its failure.
    await onRefresh().catch(() => undefined);
    setBusy(false);
  }

  return (
    <BuiCard data-testid="lesson-draft-card" className="w-[520px] max-w-full px-5 py-4">
      <div className="text-body-lg font-medium text-foreground">
        <Trans id="Draft experience">Draft experience</Trans>
      </div>
      <div className="mt-3 text-body-sm text-muted-foreground">
        <Trans id="Situation">Situation</Trans>
      </div>
      <div className="mt-0.5 text-body text-foreground" dir="auto">
        {block.cue}
      </div>
      <div className="mt-3 text-body-sm text-muted-foreground">
        <Trans id="Lesson">Lesson</Trans>
      </div>
      <div className="mt-0.5 text-body text-foreground" dir="auto">
        {block.lesson}
      </div>
      <blockquote
        className="mt-3 whitespace-pre-wrap break-words border-s-2 border-border ps-3 text-body-sm text-muted-foreground"
        dir="auto"
      >
        {block.evidence.quote}
      </blockquote>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy || saved} onClick={() => void save()}>
          {saved ? <Trans>Saved</Trans> : busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
      {error ? <p className="mt-2 text-label text-destructive">{error}</p> : null}
    </BuiCard>
  );
}
