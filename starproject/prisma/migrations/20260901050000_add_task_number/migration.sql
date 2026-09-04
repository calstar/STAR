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
SELECT setval('"Task_number_seq"', COALESCE((SELECT MAX("number") FROM "Task"), 0));
ALTER TABLE "Task" ALTER COLUMN "number" SET DEFAULT nextval('"Task_number_seq"');
ALTER TABLE "Task" ALTER COLUMN "number" SET NOT NULL;

CREATE UNIQUE INDEX "Task_number_key" ON "Task"("number");
