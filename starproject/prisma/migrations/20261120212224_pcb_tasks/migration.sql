-- CreateEnum
CREATE TYPE "PcbStage" AS ENUM ('components', 'schematic', 'layout', 'review', 'solder', 'bringup');

-- CreateEnum
CREATE TYPE "PcbStageStatus" AS ENUM ('open', 'done', 'skipped');

-- CreateTable
CREATE TABLE "TaskPcb" (
    "taskId" TEXT NOT NULL,
    "altiumUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskPcb_pkey" PRIMARY KEY ("taskId")
);

-- CreateTable
CREATE TABLE "TaskPcbStage" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "stage" "PcbStage" NOT NULL,
    "status" "PcbStageStatus" NOT NULL DEFAULT 'open',
    "dueDate" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskPcbStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PcbStageAssignee" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PcbStageAssignee_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskPcbStage_taskId_stage_key" ON "TaskPcbStage"("taskId", "stage");

-- CreateIndex
CREATE INDEX "_PcbStageAssignee_B_index" ON "_PcbStageAssignee"("B");

-- AddForeignKey
ALTER TABLE "TaskPcb" ADD CONSTRAINT "TaskPcb_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPcbStage" ADD CONSTRAINT "TaskPcbStage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TaskPcb"("taskId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PcbStageAssignee" ADD CONSTRAINT "_PcbStageAssignee_A_fkey" FOREIGN KEY ("A") REFERENCES "TaskPcbStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PcbStageAssignee" ADD CONSTRAINT "_PcbStageAssignee_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
