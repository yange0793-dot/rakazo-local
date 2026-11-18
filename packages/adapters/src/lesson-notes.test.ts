import { describe, expect, it } from "vitest";
import { buildLessonNotes, MAX_LESSON_NOTES, MAX_LESSON_NOTES_BYTES } from "./lesson-notes.js";

function lesson(id: string, cue: string, note: string, revision = 1) {
  return { id, revision, content: `cue: ${cue}\nlesson: ${note}` };
}

describe("buildLessonNotes", () => {
  it("adds nothing when there are no lessons", () => {
    expect(buildLessonNotes([], [])).toEqual({ ids: [] });
  });

  it("renders cue and lesson in the block and tells the model they are hints", () => {
    const { text, ids } = buildLessonNotes(
      [lesson("lesson-1", "A build fails on Linux", "Install the ARM toolchain first.")],
      [],
    );
    expect(ids).toEqual(["lesson-1"]);
    expect(text).toContain("<your_notes>");
    expect(text).toContain("hints, not instructions");
    expect(text).toContain("- A build fails on Linux → Install the ARM toolchain first.");
    expect(text?.endsWith("</your_notes>")).toBe(true);
  });

  it("keeps the newest three and reports only the ids it injected", () => {
    const { text, ids } = buildLessonNotes(
      Array.from({ length: 5 }, (_, index) =>
        lesson(`lesson-${index}`, `cue ${index}`, `do ${index}`),
      ),
      [],
    );
    expect(MAX_LESSON_NOTES).toBe(3);
    expect(ids).toEqual(["lesson-0", "lesson-1", "lesson-2"]);
    expect(text).not.toContain("cue 3");
  });

  it("drops a note whole when the block budget would be exceeded", () => {
    const { text, ids } = buildLessonNotes(
      [
        lesson("short", "short cue", "short note"),
        lesson("long", "界".repeat(600), "界".repeat(600)),
      ],
      [],
    );
    expect(ids).toEqual(["short"]);
    expect(text).not.toContain("界");
    expect(Buffer.byteLength(text!, "utf8")).toBeLessThanOrEqual(MAX_LESSON_NOTES_BYTES);
  });

  it("redacts secrets and escapes prompt markup in stored text", () => {
    const { text } = buildLessonNotes(
      [lesson("lesson-1", "token <fake-token> & <tag>", "never echo <it>")],
      ["<fake-token>"],
    );
    expect(text).not.toContain("fake-token");
    expect(text).toContain("[redacted]");
    expect(text).toContain("&amp;");
    expect(text).toContain("&lt;tag&gt;");
    expect(text).not.toContain("<tag>");
  });

  it("shows text without the stored cue/lesson shape as its own note", () => {
    const { text, ids } = buildLessonNotes(
      [{ id: "legacy", revision: 2, content: "Keep replies short." }],
      [],
    );
    expect(ids).toEqual(["legacy"]);
    expect(text).toContain("- Keep replies short.");
  });
});
