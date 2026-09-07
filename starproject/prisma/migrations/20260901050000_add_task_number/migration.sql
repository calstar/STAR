-- Add the global task number (#N).
-- Backfill existing rows in creation order (ROW_NUMBER over createdAt), then wire
-- up the sequence/default/unique index exactly as Prisma reconstructs them for
-- `number Int @unique @default(autoincrement())`, so `migrate status` shows no drift.

ALTER TABLE "Task" ADD COLUMN "number" INTEGER;

WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "Task"
)
UPDATE "Task" t SET "number" = o.rn FROM ordered o WHERE t."id" = o."id";

CREATE SEQUENCE "Task_number_seq" OWNED BY "Task"."number";
-- Point the sequence at MAX+1 (or 1 on an empty table) with is_called=false, so
-- the NEXT nextval() returns exactly that value. Using COALESCE(...,0)+1 avoids
-- setval(seq, 0), which Postgres rejects (sequence minvalue is 1) — that failed
-- `migrate deploy` on a fresh/empty database.
SELECT setval('"Task_number_seq"', COALESCE((SELECT MAX("number") FROM "Task"), 0) + 1, false);
ALTER TABLE "Task" ALTER COLUMN "number" SET DEFAULT nextval('"Task_number_seq"');
ALTER TABLE "Task" ALTER COLUMN "number" SET NOT NULL;

CREATE UNIQUE INDEX "Task_number_key" ON "Task"("number");
