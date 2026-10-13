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
