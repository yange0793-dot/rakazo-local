-- The member's place in the group send it answers. Additive and nullable: the previous
-- release ignores it, and older group runs stay unordered.
ALTER TABLE "runs" ADD COLUMN "groupTurn" INTEGER;
