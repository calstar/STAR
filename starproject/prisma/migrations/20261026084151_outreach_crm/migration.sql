-- CreateTable
CREATE TABLE "OutreachOrg" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'company',
    "website" TEXT,
    "industry" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "formUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachOrg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachContact" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "altEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstName" TEXT,
    "lastName" TEXT,
    "title" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "country" TEXT,
    "affiliation" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "orgId" TEXT,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "bounced" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachReferral" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "ambassadorEmail" TEXT,
    "ambassadorName" TEXT,
    "campaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachDeal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'monetary',
    "stage" TEXT NOT NULL DEFAULT 'prospect',
    "ask" TEXT,
    "theirDeliverables" TEXT,
    "ourDeliverables" TEXT,
    "valueCents" INTEGER,
    "project" TEXT,
    "ownerId" TEXT,
    "responsibleEngineer" TEXT,
    "renewal" BOOLEAN NOT NULL DEFAULT false,
    "lastContactAt" TIMESTAMP(3),
    "nextFollowUpAt" TIMESTAMP(3),
    "taskId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'crowdfunding',
    "url" TEXT,
    "goalCents" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "thankYouDueAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachDonation" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "campaignId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "donatedAt" TIMESTAMP(3) NOT NULL,
    "perkName" TEXT,
    "perkStatus" TEXT NOT NULL DEFAULT 'none',
    "displayPref" TEXT,
    "ambassadorEmail" TEXT,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachDonation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachTouch" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactId" TEXT,
    "orgId" TEXT,
    "dealId" TEXT,
    "campaignId" TEXT,
    "templateId" TEXT,
    "subject" TEXT,
    "note" TEXT,
    "threadUrl" TEXT,
    "actorId" TEXT NOT NULL,

    CONSTRAINT "OutreachTouch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filter" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'sponsor_cold',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutreachOrg_name_key" ON "OutreachOrg"("name");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachContact_email_key" ON "OutreachContact"("email");

-- CreateIndex
CREATE INDEX "OutreachContact_orgId_idx" ON "OutreachContact"("orgId");

-- CreateIndex
CREATE INDEX "OutreachReferral_ambassadorEmail_idx" ON "OutreachReferral"("ambassadorEmail");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachReferral_contactId_ambassadorEmail_ambassadorName_key" ON "OutreachReferral"("contactId", "ambassadorEmail", "ambassadorName");

-- CreateIndex
CREATE INDEX "OutreachDeal_stage_idx" ON "OutreachDeal"("stage");

-- CreateIndex
CREATE INDEX "OutreachDeal_nextFollowUpAt_idx" ON "OutreachDeal"("nextFollowUpAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachDeal_orgId_season_key" ON "OutreachDeal"("orgId", "season");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachCampaign_name_key" ON "OutreachCampaign"("name");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachDonation_externalRef_key" ON "OutreachDonation"("externalRef");

-- CreateIndex
CREATE INDEX "OutreachDonation_campaignId_idx" ON "OutreachDonation"("campaignId");

-- CreateIndex
CREATE INDEX "OutreachDonation_contactId_idx" ON "OutreachDonation"("contactId");

-- CreateIndex
CREATE INDEX "OutreachTouch_at_idx" ON "OutreachTouch"("at");

-- CreateIndex
CREATE INDEX "OutreachTouch_contactId_idx" ON "OutreachTouch"("contactId");

-- CreateIndex
CREATE INDEX "OutreachTouch_orgId_idx" ON "OutreachTouch"("orgId");

-- CreateIndex
CREATE INDEX "OutreachTouch_dealId_idx" ON "OutreachTouch"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachList_name_key" ON "OutreachList"("name");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachTemplate_name_key" ON "OutreachTemplate"("name");

-- AddForeignKey
ALTER TABLE "OutreachContact" ADD CONSTRAINT "OutreachContact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "OutreachOrg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachReferral" ADD CONSTRAINT "OutreachReferral_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "OutreachContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachReferral" ADD CONSTRAINT "OutreachReferral_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDeal" ADD CONSTRAINT "OutreachDeal_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "OutreachOrg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDeal" ADD CONSTRAINT "OutreachDeal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDeal" ADD CONSTRAINT "OutreachDeal_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDonation" ADD CONSTRAINT "OutreachDonation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "OutreachContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDonation" ADD CONSTRAINT "OutreachDonation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachTouch" ADD CONSTRAINT "OutreachTouch_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "OutreachContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachTouch" ADD CONSTRAINT "OutreachTouch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "OutreachOrg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachTouch" ADD CONSTRAINT "OutreachTouch_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "OutreachDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachTouch" ADD CONSTRAINT "OutreachTouch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachTouch" ADD CONSTRAINT "OutreachTouch_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OutreachTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachTouch" ADD CONSTRAINT "OutreachTouch_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
