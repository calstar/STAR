-- CreateTable
CREATE TABLE "TaskManufacturing" (
    "taskId" TEXT NOT NULL,
    "partName" TEXT,
    "onshapeUrl" TEXT,
    "drawingUrl" TEXT,
    "quantity" INTEGER,
    "material" TEXT,
    "designReId" TEXT,
    "mfgReId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskManufacturing_pkey" PRIMARY KEY ("taskId")
);

-- AddForeignKey
ALTER TABLE "TaskManufacturing" ADD CONSTRAINT "TaskManufacturing_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskManufacturing" ADD CONSTRAINT "TaskManufacturing_designReId_fkey" FOREIGN KEY ("designReId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskManufacturing" ADD CONSTRAINT "TaskManufacturing_mfgReId_fkey" FOREIGN KEY ("mfgReId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

