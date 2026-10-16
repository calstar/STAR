import { SidebarNav } from "@/components/SidebarNav";
import { isAdmin } from "@/lib/admins";
import { pendingCount } from "@/lib/purchase-request-data";
import { isPvp } from "@/lib/pvp";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getCurrentDbUser } from "@/lib/user";

// Rendered in the root layout. Calling getCurrentDbUser here also guarantees the
// viewer is upserted into the DB on any page they visit.
export async function Sidebar() {
  const user = await getCurrentDbUser();

  const [projects, subteams, admin, pvp] = await Promise.all([
    prisma.project.findMany({
      where: { archived: false, parentId: null },
      select: { id: true, name: true, color: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.subteam.findMany({
      select: { id: true, name: true, color: true },
      orderBy: { name: "asc" },
    }),
    isAdmin(user.email),
    isPvp(user.email),
  ]);
  // A PVP sees how many purchase requests are waiting on them.
  const waiting = pvp ? await pendingCount() : 0;

  return (
    <SidebarNav
      userName={displayNameOf(user)}
      userEmail={user.email}
      isAdmin={admin}
      purchaseBadge={waiting}
      projects={projects}
      subteams={subteams}
    />
  );
}
