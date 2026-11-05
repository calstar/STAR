-- AlterTable
ALTER TABLE "ReceiptFile" ADD COLUMN     "fetchError" TEXT,
ADD COLUMN     "fetchFailedAt" TIMESTAMP(3),
ADD COLUMN     "fetchRequestedAt" TIMESTAMP(3);
