-- Outreach CRM trimmed to a Gmail <-> tasks go-between: no ambassadors
-- (referrals), no deal owner / project / engineer / our-deliverables, and no
-- stored link from a deal to a task (the "Add task" button just creates one).

-- DropForeignKey
ALTER TABLE "OutreachDeal" DROP CONSTRAINT "OutreachDeal_ownerId_fkey";

-- DropForeignKey
ALTER TABLE "OutreachDeal" DROP CONSTRAINT "OutreachDeal_taskId_fkey";

-- DropForeignKey
ALTER TABLE "OutreachReferral" DROP CONSTRAINT "OutreachReferral_campaignId_fkey";

-- DropForeignKey
ALTER TABLE "OutreachReferral" DROP CONSTRAINT "OutreachReferral_contactId_fkey";

-- AlterTable
ALTER TABLE "OutreachDeal" DROP COLUMN "ourDeliverables",
DROP COLUMN "ownerId",
DROP COLUMN "project",
DROP COLUMN "responsibleEngineer",
DROP COLUMN "taskId";

-- AlterTable
ALTER TABLE "OutreachDonation" DROP COLUMN "ambassadorEmail";

-- DropTable
DROP TABLE "OutreachReferral";

