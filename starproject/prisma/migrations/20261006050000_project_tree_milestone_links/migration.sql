-- Homepage cards now follow the real project tree (a tracked parent brings
-- its subprojects along), so the free-text group label is retired.
ALTER TABLE "Project" DROP COLUMN "trackGroup";

-- A milestone can open a link (review slides, a test plan). http(s) only,
-- checked in the app on save.
ALTER TABLE "Milestone" ADD COLUMN "url" TEXT;
