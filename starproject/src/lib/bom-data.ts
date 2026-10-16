import type { Prisma } from "@prisma/client";

import type { BomLine } from "@/lib/bom";
import { prisma } from "@/lib/db";
import { descendants } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";

// Loading BOM lines in the shape src/lib/bom.ts works on. Shared by the BOM tab,
// the export route and the MCP tools so they can never disagree on a total.

export const BOM_INCLUDE = {
  task: { select: { number: true, projectId: true } },
  reimbursement: {
    select: { id: true, number: true, status: true, callinkStatus: true, callinkDeletedOn: true },
  },
} satisfies Prisma.BomItemInclude;

type Row = Prisma.BomItemGetPayload<{ include: typeof BOM_INCLUDE }>;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function toBomLine(r: Row): BomLine {
  return {
    id: r.id,
    projectId: r.projectId,
    kind: r.kind,
    name: r.name,
    partNumber: r.partNumber,
    manufacturer: r.manufacturer,
    unitCostCents: r.unitCostCents,
    quantity: r.quantity,
    shippingCents: r.shippingCents,
    realizedCents: r.realizedCents,
    supplier: r.supplier,
    url: r.url,
    spare: r.spare,
    status: r.status,
    orderedAt: day(r.orderedAt),
    purchaserId: r.purchaserId,
    purchaserName: r.purchaserName,
    location: r.location,
    notes: r.notes,
    taskId: r.taskId,
    taskNumber: r.task?.number ?? null,
    taskProjectId: r.task?.projectId ?? null,
    reimbursement: r.reimbursement
      ? {
          id: r.reimbursement.id,
          number: r.reimbursement.number,
          status: r.reimbursement.status,
          callinkStatus: r.reimbursement.callinkStatus,
          callinkDeletedOn: day(r.reimbursement.callinkDeletedOn),
        }
      : null,
    reimbursedElsewhere: r.reimbursedElsewhere,
    position: r.position,
  };
}

/** Every line on a project and the projects under it (archived ones left out). */
export async function loadBomLines(projectId: string): Promise<BomLine[]> {
  const tree = await getProjectTree();
  const ids = [projectId, ...descendants(tree, projectId).map((d) => d.id)];
  const rows = await prisma.bomItem.findMany({
    where: { projectId: { in: ids } },
    include: BOM_INCLUDE,
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toBomLine);
}
