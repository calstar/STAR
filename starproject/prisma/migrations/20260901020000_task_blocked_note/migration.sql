-- A free-text, task-level "why is this blocked" comment, auto-saved like the
-- description (replaces the per-blocker note that used to sit next to the
-- add-a-blocker dropdown).
ALTER TABLE "Task" ADD COLUMN "blockedNote" TEXT;
