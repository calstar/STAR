-- The Finance tab: what each reimbursement was for, the team's accounts, and the
-- income planned for each school year.

-- AlterTable
ALTER TABLE "Reimbursement" ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "subteamId" TEXT;

-- CreateTable
CREATE TABLE "FinanceAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "callinkAccountId" INTEGER,
    "balanceCents" INTEGER NOT NULL,
    "availableCents" INTEGER,
    "balanceAsOf" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedIncome" (
    "id" TEXT NOT NULL,
    "schoolYear" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "expectedOn" DATE,
    "received" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannedIncome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceAccount_callinkAccountId_key" ON "FinanceAccount"("callinkAccountId");

-- CreateIndex
CREATE INDEX "PlannedIncome_schoolYear_idx" ON "PlannedIncome"("schoolYear");

-- CreateIndex
CREATE INDEX "Reimbursement_projectId_idx" ON "Reimbursement"("projectId");

-- CreateIndex
CREATE INDEX "Reimbursement_subteamId_idx" ON "Reimbursement"("subteamId");

-- AddForeignKey
ALTER TABLE "Reimbursement" ADD CONSTRAINT "Reimbursement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reimbursement" ADD CONSTRAINT "Reimbursement_subteamId_fkey" FOREIGN KEY ("subteamId") REFERENCES "Subteam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAccount" ADD CONSTRAINT "FinanceAccount_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedIncome" ADD CONSTRAINT "PlannedIncome_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

