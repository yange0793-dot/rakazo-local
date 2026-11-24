import type { MemorySourceFact } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { memoryDerivationsForEdit, memorySourceFactsArgument } from "./memory-derivation.js";
import { editMemory } from "./memory-tools.js";

const source: MemorySourceFact = {
  id: "fact-a",
  revision: 3,
  scope: "isolated",
  kind: "durable",
  botId: "bot-a",
};

describe("memory tool derivation annotations", () => {
  it("binds the host bot and validates exact citations without accepting caller source identities", () => {
    const { botId: _botId, ...citation } = source;
    expect(memorySourceFactsArgument({ source_facts: [citation] }, "bot-a")).toEqual({
      sources: [source],
    });
    expect(memorySourceFactsArgument({}, "bot-a")).toEqual({ sources: [] });
    for (const invalid of [
      [],
      [source],
      [{ ...citation, revision: 0 }],
      [{ ...citation, kind: "lesson", scope: "shared" }],
      [{ ...citation, kind: "history" }],
      [{ ...citation, content: "caller text" }],
      Array.from({ length: 33 }, () => citation),
    ])
      expect(memorySourceFactsArgument({ source_facts: invalid }, "bot-a")).toHaveProperty("error");
  });

  it("requires both history coordinates and rejects them for ordinary facts", () => {
    const { botId: _botId, ...citation } = source;
    expect(
      memorySourceFactsArgument(
        {
          source_facts: [
            { ...citation, kind: "history", threadId: "thread-a", historyGeneration: 0 },
          ],
        },
        "bot-a",
      ),
    ).toHaveProperty("sources");
    expect(
      memorySourceFactsArgument(
        { source_facts: [{ ...citation, threadId: "thread-a", historyGeneration: 0 }] },
        "bot-a",
      ),
    ).toHaveProperty("error");
  });

  it("annotates the actual edited entry and leaves neighboring handwriting unmarked", () => {
    const before = "# Notes\nManual line.\n- Old fact.\n";
    const edit = editMemory(before, "- New fact.", "Old fact.");
    if ("error" in edit) throw new Error(edit.error);
    const spans = memoryDerivationsForEdit(before, edit.content, [source]);
    expect(spans).toEqual([
      {
        start: "# Notes\nManual line.\n".length,
        end: edit.content.length,
        sources: [source],
      },
    ]);
    expect(memoryDerivationsForEdit(before, before, [source])).toEqual([]);
    expect(memoryDerivationsForEdit(before, edit.content, [])).toEqual([]);
  });

  it("preserves moved and repeated existing lines and marks only new occurrences", () => {
    const before = "Manual.\nSame.\n";
    const after = "Same.\nManual.\nSame.\nNew.\n";
    expect(memoryDerivationsForEdit(before, after, [source])).toEqual([
      { start: "Same.\nManual.\n".length, end: after.length, sources: [source] },
    ]);
  });

  it("does not relabel handwritten lines when newline encoding or the trailing newline changes", () => {
    expect(
      memoryDerivationsForEdit("Handwritten.\r\nTail", "Handwritten.\nTail\nNew.\n", [source]),
    ).toEqual([
      {
        start: "Handwritten.\nTail\n".length,
        end: "Handwritten.\nTail\nNew.\n".length,
        sources: [source],
      },
    ]);
  });
});
