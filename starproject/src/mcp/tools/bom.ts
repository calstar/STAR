import { z } from "zod";

import { addBomLine, deleteBomLine, updateBomField } from "@/lib/actions/bom";
import { BOM_FIELDS, BOM_STATUSES, type BomField, isBomField, parseBomValue, predictedCents, reimbursedState, sectionsFor, summarize } from "@/lib/bom";
import { BOM_INCLUDE, loadBomLines, toBomLine } from "@/lib/bom-data";
import { formatCents } from "@/lib/finance/money";
import { prisma } from "@/lib/db";
import { getProjectTree } from "@/lib/projects";

import { DESTRUCTIVE, READ, WRITE, defineTool, toFormData, type ToolModule } from "./_shared";

// The bill of materials: what a project's BOM tab shows and its editor changes.
// Every write calls the same server action as the tab (src/lib/actions/bom.ts),
// so approval rules and History are the same.

// The fields a line takes, as the add form and the editor do: text, parsed by
// the same rules (money like "12.34" or "$1,539.65", quantity like "200").
const FIELD_DOC =
  "Money fields (unitCostCents, shippingCents, realizedCents) take text like \"12.34\" or \"$1,539.65\", not cents. " +
  "quantity is a number (\"200\" feet is fine); kind is part (unit x qty + shipping) or allowance (unitCostCents is the lump sum); " +
  `status is one of ${BOM_STATUSES.join(", ")} (leaving or returning to planned needs a PVP; normally done by approving a purchase request); orderedAt is YYYY-MM-DD; ` +
  "taskNumber is a task #N; purchaserId is a user id (list_users); spare and reimbursedElsewhere are \"true\"/\"false\". " +
  "Blank clears a field.";

const lineFields = Object.fromEntries(
  BOM_FIELDS.filter((f) => f !== "projectId").map((f) => [f, z.string().max(2000).optional()]),
) as Record<Exclude<BomField, "projectId">, z.ZodOptional<z.ZodString>>;

async function lineById(id: string) {
  const row = await prisma.bomItem.findUnique({ where: { id }, include: BOM_INCLUDE });
  if (!row) throw new Error("BOM line not found.");
  return describe(toBomLine(row));
}

function describe(l: ReturnType<typeof toBomLine>) {
  return { ...l, predictedCents: predictedCents(l), predicted: formatCents(predictedCents(l)), reimbursed: reimbursedState(l) };
}

export const bomTools: ToolModule = (server) => {
  defineTool(
    server,
    "list_bom",
    {
      description:
        "A project's bill of materials as its BOM tab shows it: its own lines plus every subproject's, grouped into " +
        "sections (the project's own lines, then one per direct subproject with everything under it). Each line has " +
        "predicted cost (unit x qty + shipping, or the allowance), realized cost, status, and reimbursed state " +
        "(none/filed/reimbursed, read from its linked reimbursement). Totals are in cents and formatted. " +
        "includeSpares (default true) counts backup lines in the totals.",
      inputSchema: {
        projectId: z.string().min(1),
        includeSpares: z.boolean().default(true),
      },
      annotations: READ,
    },
    async ({ projectId, includeSpares }) => {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
      if (!project) throw new Error("Project not found.");
      const tree = await getProjectTree();
      const sections = sectionsFor(tree, projectId, await loadBomLines(projectId));
      const total = summarize(sections.flatMap((s) => s.lines), { includeSpares });
      return {
        project,
        totals: {
          ...total,
          predicted: formatCents(total.predictedCents),
          realized: formatCents(total.realizedCents),
          approved: formatCents(total.approvedCents),
          owed: formatCents(total.owedCents),
        },
        sections: sections.map((s) => {
          const sum = summarize(s.lines, { includeSpares });
          return {
            projectId: s.projectId,
            title: s.title,
            predicted: formatCents(sum.predictedCents),
            realized: formatCents(sum.realizedCents),
            lines: s.lines.map((l) => ({ ...describe(l), subpath: l.subpath })),
          };
        }),
      };
    },
  );

  defineTool(
    server,
    "add_bom_items",
    {
      description:
        "Add one or more lines to a project's BOM (put a part on the project it belongs to, e.g. Flight Computer, " +
        "not LE4; it shows on every BOM above). Each line needs a name; everything else is optional. " +
        FIELD_DOC +
        " Lines are added in order; one that fails validation is reported and the rest still go in. Returns the new lines and any errors.",
      inputSchema: {
        projectId: z.string().min(1),
        lines: z.array(z.object(lineFields).extend({ name: z.string().min(1).max(200) })).min(1).max(100),
      },
      annotations: WRITE,
    },
    async ({ projectId, lines }) => {
      const added = [];
      const errors: { index: number; name: string; error: string }[] = [];
      for (const [index, line] of lines.entries()) {
        const res = await addBomLine(projectId, line);
        if (res.error || !res.id) errors.push({ index, name: line.name, error: res.error ?? "Not added" });
        else added.push(await lineById(res.id));
      }
      return { added, errors };
    },
  );

  defineTool(
    server,
    "update_bom_item",
    {
      description:
        "Change fields of one BOM line, as the line editor does; each field is saved and logged to History on its " +
        "own. projectId moves the line to another project. " +
        FIELD_DOC +
        " Every value is checked before any is saved, so a bad one changes nothing; a rule the server enforces (approval) " +
        "can still stop partway, and the error names the field. Returns the updated line.",
      inputSchema: {
        id: z.string().min(1),
        ...lineFields,
        projectId: z.string().optional(),
      },
      annotations: WRITE,
    },
    async ({ id, ...fields }) => {
      // Check every value first, so a bad one leaves the line untouched rather
      // than half-changed.
      for (const [field, raw] of Object.entries(fields)) {
        if (raw === undefined || !isBomField(field)) continue;
        try {
          parseBomValue(field, raw);
        } catch (e) {
          throw new Error(`${field}: ${(e as Error).message}`);
        }
      }
      for (const [field, raw] of Object.entries(fields)) {
        if (raw === undefined) continue;
        const res = await updateBomField(id, field, raw);
        if (res.error) throw new Error(`${field}: ${res.error}`);
      }
      return lineById(id);
    },
  );

  defineTool(
    server,
    "delete_bom_item",
    {
      description:
        "Remove a BOM line. A line past Planned (approved, ordered, received) can only be removed by a PVP. " +
        "History keeps a record.",
      inputSchema: { id: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      const before = await lineById(id);
      await deleteBomLine(toFormData({ id }));
      return { deleted: true, line: { id: before.id, name: before.name, projectId: before.projectId } };
    },
  );
};
