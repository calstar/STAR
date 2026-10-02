ALTER TABLE "WorkerStatus" ADD COLUMN "loginState" TEXT,
ADD COLUMN "loginRequestedAt" TIMESTAMP(3),
ADD COLUMN "loginRequestedBy" TEXT,
ADD COLUMN "loginUpdatedAt" TIMESTAMP(3),
ADD COLUMN "loginNote" TEXT;
