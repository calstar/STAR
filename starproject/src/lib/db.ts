import { PrismaClient } from "@prisma/client";

// Reuse a single client across hot-reloads in dev (Next re-evaluates modules on
// every change, which would otherwise open a new connection pool each time).
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
