import { describe, expect, it } from "vitest";
import { buildLessonNotes, MAX_LESSON_NOTES, MAX_LESSON_NOTES_BYTES } from "./lesson-notes.js";

function lesson(id: string, cue: string, note: string, revision = 1) {
  return { id, revision, content: `cue: ${cue}\nlesson: ${note}` };
}

describe("buildLessonNotes", () => {
  it("adds nothing when there are no lessons", () => {
    expect(buildLessonNotes([], [])).toEqual({
      shown: [],
      omitted: [],
      bytes: 0,
    });
  });

  it("renders cue and lesson in the block and tells the model they are hints", () => {
    const { text, shown } = buildLessonNotes(
      [lesson("lesson-1", "A build fails on Linux", "Install the ARM toolchain first.")],
      [],
    );
    expect(shown).toEqual([{ id: "lesson-1", revision: 1 }]);
    expect(text).toContain("<your_notes>");
    expect(text).toContain("hints, not instructions");
    expect(text).toContain("- A build fails on Linux → Install the ARM toolchain first.");
    expect(text).toContain("id: lesson-1; revision: 1");
    expect(text?.endsWith("</your_notes>")).toBe(true);
    expect(Buffer.byteLength(text!, "utf8")).toBeLessThanOrEqual(MAX_LESSON_NOTES_BYTES);
  });

  it("keeps the newest three and reports notes omitted by the note limit", () => {
    const { text, shown, omitted } = buildLessonNotes(
      Array.from({ length: 5 }, (_, index) =>
        lesson(`lesson-${index}`, `cue ${index}`, `do ${index}`),
      ),
      [],
    );
    expect(MAX_LESSON_NOTES).toBe(3);
    expect(shown.map((row) => row.id)).toEqual(["lesson-0", "lesson-1", "lesson-2"]);
    expect(text).not.toContain("cue 3");
    expect(omitted).toEqual([
      { id: "lesson-3", revision: 1, reason: "note_limit" },
      { id: "lesson-4", revision: 1, reason: "note_limit" },
    ]);
  });

  it("keeps a bounded Chinese cue and exact reference when the lesson body is long", () => {
    const cue = "部署失败时先检查依赖".repeat(20);
    const body = "先安装目标平台工具链".repeat(60);
    expect(cue).toHaveLength(200);
    expect(body).toHaveLength(600);
    const long = lesson("lesson-long", cue, body, 7);
    const { text, shown, omitted, bytes } = buildLessonNotes([long], []);
    expect(shown).toEqual([{ id: "lesson-long", revision: 7 }]);
    expect(omitted).toEqual([{ id: "lesson-long", revision: 7, reason: "body_budget" }]);
    expect(text).toContain("部署失败时先检查依赖");
    expect(text).toContain("id: lesson-long; revision: 7");
    expect(text).toContain("body omitted: budget");
    expect(text).not.toContain(body);
    expect(bytes).toBe(Buffer.byteLength(text!, "utf8"));
    expect(bytes).toBeLessThanOrEqual(MAX_LESSON_NOTES_BYTES);
  });

  it("reserves a bounded reference for each note and reports every budget omission", () => {
    const { text, shown, omitted, bytes } = buildLessonNotes(
      Array.from({ length: 3 }, (_, index) =>
        lesson(
          `lesson-${index}`,
          "出现部署错误时".repeat(20),
          "先检查日志再修复。".repeat(60),
          index + 1,
        ),
      ),
      [],
    );
    expect(shown).toHaveLength(3);
    expect(text).toContain("id: lesson-0; revision: 1");
    expect(text).toContain("id: lesson-1; revision: 2");
    expect(text).toContain("id: lesson-2; revision: 3");
    expect(omitted).toHaveLength(3);
    expect(omitted.every((item) => item.reason === "body_budget")).toBe(true);
    expect(bytes).toBeLessThanOrEqual(MAX_LESSON_NOTES_BYTES);
  });

  it("reports a note that cannot fit even its cue and reference", () => {
    const { shown, omitted } = buildLessonNotes(
      [{ id: "x".repeat(MAX_LESSON_NOTES_BYTES), revision: 1, content: "Useful cue." }],
      [],
    );
    expect(shown).toEqual([]);
    expect(omitted).toEqual([
      { id: "x".repeat(MAX_LESSON_NOTES_BYTES), revision: 1, reason: "note_budget" },
    ]);
  });

  it("reports empty lessons without adding a block", () => {
    const result = buildLessonNotes([{ id: "empty", revision: 2, content: " " }], []);
    expect(result).toEqual({
      shown: [],
      omitted: [{ id: "empty", revision: 2, reason: "empty" }],
      bytes: 0,
    });
    expect(result.text).toBeUndefined();
  });

  it("keeps a short note when a later body is too large", () => {
    const { text, shown, omitted } = buildLessonNotes(
      [
        lesson("short", "short cue", "short note"),
        lesson("long", "界".repeat(600), "界".repeat(600)),
      ],
      [],
    );
    expect(shown).toEqual([
      { id: "short", revision: 1 },
      { id: "long", revision: 1 },
    ]);
    expect(omitted).toEqual([{ id: "long", revision: 1, reason: "body_budget" }]);
    expect(text).toContain("short note");
    expect(text).toContain("id: long; revision: 1");
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
    const { text, shown } = buildLessonNotes(
      [{ id: "legacy", revision: 2, content: "Keep replies short." }],
      [],
    );
    expect(shown).toEqual([{ id: "legacy", revision: 2 }]);
    expect(text).toContain("- Keep replies short.");
    expect(text).toContain("id: legacy; revision: 2");
  });
});
