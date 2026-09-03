-- Convert Task.assigneeId (a single assignee) into a many-to-many "TaskAssignee"
-- relation (Task.assignees <-> User.assignedTasks). Existing assignments are
-- preserved: they are copied into the join table before the old column is dropped.

-- CreateTable: implicit many-to-many join table
CREATE TABLE "_TaskAssignee" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_TaskAssignee_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_TaskAssignee_B_index" ON "_TaskAssignee"("B");

-- AddForeignKey
ALTER TABLE "_TaskAssignee" ADD CONSTRAINT "_TaskAssignee_A_fkey" FOREIGN KEY ("A") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskAssignee" ADD CONSTRAINT "_TaskAssignee_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: move each task's existing single assignee into the join table.
INSERT INTO "_TaskAssignee" ("A", "B")
SELECT "id", "assigneeId" FROM "Task" WHERE "assigneeId" IS NOT NULL;

-- Drop the old single-assignee column (its foreign key is dropped with it).
ALTER TABLE "Task" DROP COLUMN "assigneeId";
