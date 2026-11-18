import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setupI18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const labels = [
  "Facts",
  "Experience",
  "Domain",
  "Draft experience",
  "Situation",
  "Lesson",
  "Could not save experience",
];

// A production build keeps only each message's id, so a label with no catalog entry would
// render that id. Until the catalog workflow lists these labels, they set their English text
// as the explicit id, which is also what an id-only lookup falls back to.
describe("labels newer than the committed catalogs", () => {
  it("use their English text as an explicit id", () => {
    const facts = source("../pages/SemanticFactsSection.tsx");
    const lesson = source("../components/teach/LessonDraftCard.tsx");
    for (const [file, text] of [
      [facts, 't({ id: "Facts", message: "Facts" })'],
      [facts, 't({ id: "Experience", message: "Experience" })'],
      [facts, 't({ id: "Domain", message: "Domain" })'],
      [lesson, '<Trans id="Draft experience">Draft experience</Trans>'],
      [lesson, '<Trans id="Situation">Situation</Trans>'],
      [lesson, '<Trans id="Lesson">Lesson</Trans>'],
      [lesson, 't({ id: "Could not save experience", message: "Could not save experience" })'],
    ]) {
      expect(file).toContain(text);
    }
  });

  it("render their English text without a catalog entry", () => {
    const i18n = setupI18n({ locale: "de" });
    for (const label of labels) expect(i18n._({ id: label })).toBe(label);
  });
});
