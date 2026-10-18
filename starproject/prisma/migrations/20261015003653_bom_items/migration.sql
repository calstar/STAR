-- CreateEnum
CREATE TYPE "BomStatus" AS ENUM ('planned', 'approved', 'ordered', 'received');

-- CreateEnum
CREATE TYPE "BomKind" AS ENUM ('part', 'allowance');

-- CreateTable
CREATE TABLE "BomItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "BomKind" NOT NULL DEFAULT 'part',
    "name" TEXT NOT NULL,
    "partNumber" TEXT,
    "unitCostCents" INTEGER,
    "quantity" DOUBLE PRECISION,
    "shippingCents" INTEGER,
    "realizedCents" INTEGER,
    "supplier" TEXT,
    "url" TEXT,
    "spare" BOOLEAN NOT NULL DEFAULT false,
    "status" "BomStatus" NOT NULL DEFAULT 'planned',
    "approvedAt" TIMESTAMP(3),
    "orderedAt" TIMESTAMP(3),
    "purchaserId" TEXT,
    "purchaserName" TEXT,
    "location" TEXT,
    "notes" TEXT,
    "taskId" TEXT,
    "reimbursementId" TEXT,
    "reimbursedElsewhere" BOOLEAN NOT NULL DEFAULT false,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BomItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BomItem_projectId_idx" ON "BomItem"("projectId");

-- CreateIndex
CREATE INDEX "BomItem_reimbursementId_idx" ON "BomItem"("reimbursementId");

-- AddForeignKey
ALTER TABLE "BomItem" ADD CONSTRAINT "BomItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomItem" ADD CONSTRAINT "BomItem_purchaserId_fkey" FOREIGN KEY ("purchaserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomItem" ADD CONSTRAINT "BomItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomItem" ADD CONSTRAINT "BomItem_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomItem" ADD CONSTRAINT "BomItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
