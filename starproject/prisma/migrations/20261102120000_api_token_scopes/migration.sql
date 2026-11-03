-- AlterTable: which MCP servers a token opens. Existing tokens keep exactly the
-- access they had (this app's /api/mcp), so the default backfills them.
ALTER TABLE "ApiToken" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY['starproject']::TEXT[];
