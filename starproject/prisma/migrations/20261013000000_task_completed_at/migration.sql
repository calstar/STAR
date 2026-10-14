-- When a task last entered Done, so the board can keep it in its Done column
-- for a while before it is only in the archive.
ALTER TABLE "Task" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Backfill tasks already done: the last time the activity log saw them move to
-- Done, or their last update when the log has no such row.
UPDATE "Task" t
SET "completedAt" = COALESCE(
  (
    SELECT MAX(a."createdAt")
    FROM "Activity" a
    WHERE a."taskId" = t."id"
      AND a."kind" = 'updated'
      AND a."field" = 'status'
      AND a."toValue" = 'Done'
  ),
  t."updatedAt"
)
WHERE t."status" = 'done';

CREATE INDEX "Task_status_completedAt_idx" ON "Task"("status", "completedAt");
