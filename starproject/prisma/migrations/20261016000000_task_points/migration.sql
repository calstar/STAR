-- Points an admin puts on a task. When the task is done they split evenly
-- between its non-admin assignees on the Leaderboard. NULL = no points.
ALTER TABLE "Task" ADD COLUMN "points" INTEGER;
