-- CreateEnum
CREATE TYPE "ReimbursementSource" AS ENUM ('callink', 'starproject');

-- CreateEnum
CREATE TYPE "ReimbursementStatus" AS ENUM ('pending_approval', 'approved', 'submitting', 'submitted', 'failed', 'rejected', 'cancelled');

-- CreateTable
CREATE TABLE "Reimbursement" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "source" "ReimbursementSource" NOT NULL,
    "status" "ReimbursementStatus" NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "eventDetails" TEXT,
    "specialInstructions" TEXT,
    "expenditureAction" TEXT NOT NULL DEFAULT 'Direct Deposit',
    "directDepositSignedUp" BOOLEAN,
    "category" TEXT,
    "amountCents" INTEGER NOT NULL,
    "payeeFirstName" TEXT NOT NULL,
    "payeeLastName" TEXT NOT NULL,
    "payeeEmail" TEXT,
    "submitterName" TEXT,
    "submitterEmail" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "needsCheck" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "callinkId" INTEGER,
    "callinkRequestNumber" TEXT,
    "callinkStatus" TEXT,
    "callinkStage" TEXT,
    "submittedAmountCents" INTEGER,
    "approvedAmountCents" INTEGER,
    "submittedOn" TIMESTAMP(3),
    "callinkDeletedOn" TIMESTAMP(3),
    "scrapedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reimbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursementPii" (
    "reimbursementId" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "street2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "phone" TEXT,
    "uid" TEXT,

    CONSTRAINT "ReimbursementPii_pkey" PRIMARY KEY ("reimbursementId")
);

-- CreateTable
CREATE TABLE "ReimbursementItem" (
    "id" TEXT NOT NULL,
    "reimbursementId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "amountCents" INTEGER,
    "amountText" TEXT,
    "comment" TEXT,
    "type" TEXT,
    "location" TEXT,
    "invoice" TEXT,

    CONSTRAINT "ReimbursementItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptFile" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "callinkDocumentId" TEXT,
    "callinkHref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptBlob" (
    "receiptId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "ReceiptBlob_pkey" PRIMARY KEY ("receiptId")
);

-- CreateTable
CREATE TABLE "ReimbursementEvent" (
    "id" TEXT NOT NULL,
    "reimbursementId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "note" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReimbursementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayeeProfile" (
    "userId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "street2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "email" TEXT,
    "directDepositSignedUp" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayeeProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "WorkerStatus" (
    "id" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastScrapeAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "WorkerStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Reimbursement_number_key" ON "Reimbursement"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Reimbursement_callinkId_key" ON "Reimbursement"("callinkId");

-- CreateIndex
CREATE INDEX "Reimbursement_status_idx" ON "Reimbursement"("status");

-- CreateIndex
CREATE INDEX "Reimbursement_payeeEmail_idx" ON "Reimbursement"("payeeEmail");

-- CreateIndex
CREATE INDEX "Reimbursement_submitterEmail_idx" ON "Reimbursement"("submitterEmail");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementItem_reimbursementId_position_key" ON "ReimbursementItem"("reimbursementId", "position");

-- CreateIndex
CREATE INDEX "ReimbursementEvent_reimbursementId_createdAt_idx" ON "ReimbursementEvent"("reimbursementId", "createdAt");

-- AddForeignKey
ALTER TABLE "Reimbursement" ADD CONSTRAINT "Reimbursement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reimbursement" ADD CONSTRAINT "Reimbursement_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementPii" ADD CONSTRAINT "ReimbursementPii_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementItem" ADD CONSTRAINT "ReimbursementItem_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptFile" ADD CONSTRAINT "ReceiptFile_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ReimbursementItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptBlob" ADD CONSTRAINT "ReceiptBlob_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "ReceiptFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementEvent" ADD CONSTRAINT "ReimbursementEvent_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "Reimbursement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementEvent" ADD CONSTRAINT "ReimbursementEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayeeProfile" ADD CONSTRAINT "PayeeProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

