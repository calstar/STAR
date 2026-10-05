import { SidebarNav } from "@/components/SidebarNav";
import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getCurrentDbUser } from "@/lib/user";

// Rendered in the root layout. Calling getCurrentDbUser here also guarantees the
// viewer is upserted into the DB on any page they visit.
export async function Sidebar() {
  const user = await getCurrentDbUser();

  const [projects, subteams, admin] = await Promise.all([
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
  ]);

  return (
    <SidebarNav
      userName={displayNameOf(user)}
      userEmail={user.email}
      isAdmin={admin}
      projects={projects}
      subteams={subteams}
    />
  );
}
