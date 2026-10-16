import { NextResponse } from "next/server";

import { sectionsFor } from "@/lib/bom";
import { loadBomLines } from "@/lib/bom-data";
import { buildWorkbook } from "@/lib/bom-xlsx";
import { prisma } from "@/lib/db";
import { displayNameOf } from "@/lib/names";
import { getProjectTree } from "@/lib/projects";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

// GET /api/bom/export?project=<id>: the project's BOM (its own lines and every
// subproject's) as an .xlsx laid out like LE3 BOM.xlsx, one sheet per section.
// Behind the same Caddy gate as every page; nothing here is public.
export async function GET(req: Request) {
  await getCurrentDbUser();
  const id = new URL(req.url).searchParams.get("project") ?? "";
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const [tree, lines, users] = await Promise.all([
    getProjectTree(),
    loadBomLines(project.id),
    prisma.user.findMany({ select: { id: true, name: true, email: true, displayName: true } }),
  ]);
  const byId = new Map(users.map((u) => [u.id, displayNameOf(u)]));
  const data = await buildWorkbook(project.name, sectionsFor(tree, project.id, lines), (uid) =>
    uid ? (byId.get(uid) ?? null) : null,
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const file = `${project.name.replace(/[^\w .-]+/g, "").trim() || "Project"} BOM ${stamp}.xlsx`;
  return new NextResponse(data, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "no-store",
    },
  });
}
