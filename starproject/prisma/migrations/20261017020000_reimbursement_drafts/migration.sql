-- CreateTable
CREATE TABLE "ReimbursementDraft" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "createdById" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReimbursementDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursementDraftReceipt" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "item" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReimbursementDraftReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementDraft_number_key" ON "ReimbursementDraft"("number");

-- CreateIndex
CREATE INDEX "ReimbursementDraft_createdById_idx" ON "ReimbursementDraft"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementDraftReceipt_draftId_item_key" ON "ReimbursementDraftReceipt"("draftId", "item");

-- AddForeignKey
ALTER TABLE "ReimbursementDraft" ADD CONSTRAINT "ReimbursementDraft_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementDraftReceipt" ADD CONSTRAINT "ReimbursementDraftReceipt_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ReimbursementDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
