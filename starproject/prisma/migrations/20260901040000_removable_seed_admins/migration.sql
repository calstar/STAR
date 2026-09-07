-- CreateTable
CREATE TABLE "RemovedSeedAdmin" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemovedSeedAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RemovedSeedAdmin_email_key" ON "RemovedSeedAdmin"("email");
