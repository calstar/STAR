import { BOM_FIELD_LABEL } from "@/lib/bom";

// Field → label for the "changed {field}" activity sentence. Kept in its own
// prisma-free module so both the server (feed, digest) and the client (task-popup
// history via ActivityLine) can import it without pulling PrismaClient into the
// client bundle.
export const FIELD_LABEL: Record<string, string> = {
  assignee: "assignee", // legacy rows only; assignee changes are now assigned/unassigned kinds
  status: "status",
  priority: "priority",
  due: "due date",
  title: "title",
  subteam: "subteam",
  project: "project",
  points: "points",
  // Manufacturing details (see lib/manufacturing.ts).
  manufacturing: "manufacturing part",
  partName: "part name",
  onshapeUrl: "Onshape link",
  drawingUrl: "drawing link",
  quantity: "quantity",
  material: "material",
  designReId: "Design RE",
  mfgReId: "Manufacturing RE",
};

/** A BOM activity row as a sentence. `toValue` on bom_added/bom_removed names
 * where the line was ("LE4 Avionics" or "12 lines from LE3 BOM.xlsx"). */
export function bomSentence(
  who: string,
  a: { kind: string; field: string | null; fromValue: string | null; toValue: string | null; taskTitle: string },
): string {
  const where = a.toValue ? ` on ${a.toValue}` : "";
  // An import is one row: taskTitle says what came in ("12 lines from LE3 BOM.xlsx").
  if (a.kind === "bom_added" && a.field === "bom.import") return `${who} imported ${a.taskTitle} into the BOM${where}`;
  if (a.kind === "bom_added") return `${who} added BOM line “${a.taskTitle}”${where}`;
  if (a.kind === "bom_removed") return `${who} removed BOM line “${a.taskTitle}”${where}`;
  const f = (a.field ?? "").replace(/^bom\./, "");
  return `${who} changed ${(BOM_FIELD_LABEL as Record<string, string>)[f] ?? f} of BOM line “${a.taskTitle}” from ${a.fromValue ?? "—"} to ${a.toValue ?? "—"}`;
}

/** A purchase-request activity row as a sentence. */
export function prSentence(
  who: string,
  a: { kind: string; toValue: string | null; taskTitle: string },
): string {
  const why = a.toValue ? `: “${a.toValue}”` : "";
  switch (a.kind) {
    case "pr_created":
      return `${who} requested a purchase, ${a.taskTitle}${why}`;
    case "pr_approved":
      return `${who} approved purchase ${a.taskTitle}${why}`;
    case "pr_rejected":
      return `${who} rejected purchase ${a.taskTitle}${why}`;
    default:
      return `${who} cancelled purchase request ${a.taskTitle}`;
  }
}
