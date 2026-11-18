-- Additive for a rolling deployment. Do not invent source checks or revisions for older runs.
ALTER TABLE "runs" ADD COLUMN "learningSourceChecked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "lesson_usage" ADD COLUMN "firstRevision" INTEGER;
