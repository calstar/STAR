"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordActivity, userLabel } from "@/lib/activity";
import { isPvp } from "@/lib/pvp";
import {
  BOM_STATUSES,
  type BomField,
  type BomStatus,
  type BomValue,
  isBomField,
  parseBomValue,
  showBomValue,
  statusChangeNeedsApprover,
} from "@/lib/bom";
import { type BomDraft, parseSheet, suggestProject } from "@/lib/bom-import";
import { readWorkbook } from "@/lib/bom-xlsx";
import { prisma } from "@/lib/db";
import { descendants, pathOf } from "@/lib/project-tree";
import { getProjectTree } from "@/lib/projects";
import { getCurrentDbUser } from "@/lib/user";

// Every change to a BOM line goes to Activity (kind bom_*, the line's name as
// the title, field "bom.<field>"). A line shows on its own project's BOM tab and
// every ancestor's, so a change revalidates every project page.

const PVP_ONLY = "Only a PVP can approve a line, or move it back to Planned. Request a purchase instead.";

function revalidate() {
  revalidatePath("/projects/[id]", "page");
  revalidatePath("/activity");
}

async function projectFor(projectId: string) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, archived: true } });
  if (!p || p.archived) throw new Error("Project not found");
  return p;
}

const today = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

/** The columns a status implies: approvedAt the first time it leaves Planned,
 * orderedAt (today, if nobody gave one) the first time it is ordered. */
function statusStamps(
  to: BomStatus,
  old: { approvedAt: Date | null; orderedAt: Date | null } | null,
): Prisma.BomItemUncheckedUpdateInput {
  const out: Prisma.BomItemUncheckedUpdateInput = {};
  if (to !== "planned" && !old?.approvedAt) out.approvedAt = new Date();
  if (to === "planned") out.approvedAt = null;
  if ((to === "ordered" || to === "received") && !old?.orderedAt) out.orderedAt = today();
  return out;
}

/** A parsed field value -> the column(s) it sets. taskNumber is resolved to a
 * task id; the caller has checked purchaser and project exist. */
async function columnsFor(field: BomField, value: BomValue): Promise<Prisma.BomItemUncheckedUpdateInput> {
  switch (field) {
    case "taskNumber": {
      if (value === null) return { taskId: null };
      const task = await prisma.task.findUnique({ where: { number: value as number }, select: { id: true } });
      if (!task) throw new Error(`There is no task #${value}.`);
      return { taskId: task.id };
    }
    case "orderedAt":
      return { orderedAt: value === null ? null : new Date(`${value}T00:00:00Z`) };
    case "purchaserId": {
      if (value !== null && !(await prisma.user.count({ where: { id: value as string } })))
        throw new Error("That person isn't on the team.");
      return { purchaserId: value as string | null };
    }
    case "projectId": {
      if (value === null) throw new Error("A line has to be on a project.");
      await projectFor(value as string);
      return { projectId: value as string };
    }
    default:
      return { [field]: value };
  }
}

// ---- Adding -------------------------------------------------------------------

export type AddBomInput = Partial<Record<BomField, string>>;

/**
 * Add one line to a project. `input` is the add form's raw strings, parsed by
 * the same rules as an edit. A line that starts past Planned needs a PVP.
 * Returns the new id, or an error message the form can show.
 */
export async function addBomLine(projectId: string, input: AddBomInput): Promise<{ id?: string; error?: string }> {
  const user = await getCurrentDbUser();
  const project = await projectFor(projectId);
  const data: Prisma.BomItemUncheckedCreateInput = { projectId, name: "", createdById: user.id };
  try {
    for (const [field, raw] of Object.entries(input)) {
      if (!isBomField(field) || raw === undefined || field === "projectId") continue;
      Object.assign(data, await columnsFor(field, parseBomValue(field, raw)));
    }
    if (!data.name) throw new Error("Give the line a name.");
  } catch (e) {
    return { error: (e as Error).message };
  }
  const status = (data.status ?? "planned") as BomStatus;
  if (status !== "planned" && !(await isPvp(user.email))) return { error: PVP_ONLY };
  Object.assign(data, statusStamps(status, null));
  const last = await prisma.bomItem.aggregate({ where: { projectId }, _max: { position: true } });
  data.position = (last._max.position ?? 0) + 1;

  const created = await prisma.bomItem.create({ data, select: { id: true, name: true } });
  await recordActivity({
    actorId: user.id,
    taskId: null,
    projectId,
    taskTitle: created.name,
    kind: "bom_added",
    to: project.name,
  });
  revalidate();
  return { id: created.id };
}

// ---- Editing ------------------------------------------------------------------

const userSelect = { select: { name: true, email: true, displayName: true } } as const;

/** Save one field of a line; blank clears it. Returns an error message for a
 * value the user should fix rather than throwing, so the editor can show it. */
export async function updateBomField(id: string, field: string, raw: string): Promise<{ error?: string }> {
  const user = await getCurrentDbUser();
  if (!isBomField(field)) throw new Error(`Unknown field: ${field}`);
  const old = await prisma.bomItem.findUnique({
    where: { id },
    include: { purchaser: userSelect, task: { select: { number: true } }, project: { select: { name: true } } },
  });
  if (!old) return { error: "That line is gone." };

  let value: BomValue;
  let data: Prisma.BomItemUncheckedUpdateInput;
  try {
    value = parseBomValue(field, raw);
    data = await columnsFor(field, value);
  } catch (e) {
    return { error: (e as Error).message };
  }

  if (field === "status") {
    const to = value as BomStatus;
    if (to === old.status) return {};
    if (statusChangeNeedsApprover(old.status, to) && !(await isPvp(user.email))) return { error: PVP_ONLY };
    Object.assign(data, statusStamps(to, old));
  }

  // What History shows, before and after.
  let from: string;
  let to: string;
  if (field === "purchaserId") {
    const next = value ? await prisma.user.findUnique({ where: { id: value as string }, ...userSelect }) : null;
    from = old.purchaser ? userLabel(old.purchaser) : (old.purchaserName ?? "—");
    to = next ? userLabel(next) : "—";
    if (old.purchaserId === value) return {};
  } else if (field === "projectId") {
    const next = await prisma.project.findUnique({ where: { id: value as string }, select: { name: true } });
    from = old.project.name;
    to = next?.name ?? "—";
    if (old.projectId === value) return {};
  } else if (field === "taskNumber") {
    from = showBomValue(field, old.task?.number ?? null);
    to = showBomValue(field, value);
    if ((old.task?.number ?? null) === value) return {};
  } else if (field === "orderedAt") {
    const was = old.orderedAt ? old.orderedAt.toISOString().slice(0, 10) : null;
    if (was === value) return {};
    from = showBomValue(field, was);
    to = showBomValue(field, value);
  } else {
    const was = old[field as keyof typeof old] as BomValue;
    if (was === value) return {};
    from = showBomValue(field, was);
    to = showBomValue(field, value);
  }

  const updated = await prisma.bomItem.update({ where: { id }, data, select: { name: true, projectId: true } });
  await recordActivity({
    actorId: user.id,
    taskId: null,
    projectId: updated.projectId,
    taskTitle: field === "name" ? old.name : updated.name,
    kind: "bom_updated",
    field: `bom.${field}`,
    from,
    to,
  });
  revalidate();
  return {};
}

/** Remove a line. Takes FormData so it can sit behind ConfirmButton. */
export async function deleteBomLine(formData: FormData) {
  const user = await getCurrentDbUser();
  const id = String(formData.get("id"));
  const line = await prisma.bomItem.findUnique({ where: { id }, include: { project: { select: { name: true } } } });
  if (!line) return;
  // Taking an approved line off the list is the same spending decision as
  // un-approving it.
  if (line.status !== "planned" && !(await isPvp(user.email))) throw new Error(PVP_ONLY);
  await prisma.bomItem.delete({ where: { id } });
  await recordActivity({
    actorId: user.id,
    taskId: null,
    projectId: line.projectId,
    taskTitle: line.name,
    kind: "bom_removed",
    to: line.project.name,
  });
  revalidate();
}

// ---- Importing a spreadsheet --------------------------------------------------

export type ImportPreviewSheet = {
  sheet: string;
  lines: BomDraft[];
  warnings: string[];
  /** The project the sheet's name suggests, else the project imported into. */
  suggestedProjectId: string;
};

const MAX_IMPORT_BYTES = 900 * 1024; // under the 1 MB server-action body limit

/** Read an uploaded .xlsx into per-sheet line lists, saving nothing. */
export async function previewBomImport(
  projectId: string,
  formData: FormData,
): Promise<{ sheets?: ImportPreviewSheet[]; error?: string }> {
  await getCurrentDbUser();
  await projectFor(projectId);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an .xlsx file." };
  if (file.size > MAX_IMPORT_BYTES) return { error: "That file is over 900 KB; split it or remove images." };
  if (!/\.xlsx$/i.test(file.name)) return { error: "Only .xlsx files (save as Excel Workbook)." };

  let book: Awaited<ReturnType<typeof readWorkbook>>;
  try {
    book = await readWorkbook(await file.arrayBuffer());
  } catch {
    return { error: "That file couldn't be read as an Excel workbook." };
  }
  const tree = await getProjectTree();
  const candidates = descendants(tree, projectId).map((d) => ({ id: d.id, name: d.name }));
  return {
    sheets: book.map(({ sheet, rows }) => {
      const parsed = parseSheet(sheet, rows);
      return { ...parsed, suggestedProjectId: suggestProject(sheet, candidates) ?? projectId };
    }),
  };
}

const draftSchema = z.object({
  kind: z.enum(["part", "allowance"]),
  name: z.string().trim().min(1).max(200),
  partNumber: z.string().max(200).nullable(),
  manufacturer: z.string().max(200).nullable(),
  unitCostCents: z.number().int().min(0).max(100_000_000).nullable(),
  quantity: z.number().positive().max(1_000_000).nullable(),
  shippingCents: z.number().int().min(0).max(100_000_000).nullable(),
  realizedCents: z.number().int().min(0).max(100_000_000).nullable(),
  supplier: z.string().max(200).nullable(),
  url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u)).nullable(),
  spare: z.boolean(),
  status: z.enum(BOM_STATUSES),
  orderedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  purchaserName: z.string().max(200).nullable(),
  location: z.string().max(200).nullable(),
  notes: z.string().max(2000).nullable(),
  reimbursedElsewhere: z.boolean(),
});

const importSchema = z.object({
  fileName: z.string().max(200),
  sheets: z
    .array(z.object({ sheet: z.string().max(100), projectId: z.string(), lines: z.array(draftSchema).max(1000) }))
    .max(50),
});

export type BomImport = z.input<typeof importSchema>;

/**
 * Save the sheets the user kept from a preview, each onto the project they
 * picked (which must be the project imported into or under it). A non-PVP's
 * rows marked approved or ordered in the sheet come in as Planned, since
 * approving is a PVP's call; the result says how many.
 */
export async function commitBomImport(
  rootProjectId: string,
  input: BomImport,
): Promise<{ added?: number; demoted?: number; error?: string }> {
  const user = await getCurrentDbUser();
  await projectFor(rootProjectId);
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) return { error: "The import didn't make sense; read the file again." };
  const { fileName, sheets } = parsed.data;

  const tree = await getProjectTree();
  const allowed = new Set([rootProjectId, ...descendants(tree, rootProjectId).map((d) => d.id)]);
  if (sheets.some((s) => !allowed.has(s.projectId))) return { error: "Pick a project under this one for every sheet." };
  const pvp = await isPvp(user.email);

  let added = 0;
  let demoted = 0;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const s of sheets) {
      const last = await tx.bomItem.aggregate({ where: { projectId: s.projectId }, _max: { position: true } });
      let position = last._max.position ?? 0;
      const rows = s.lines.map((l) => {
        let status = l.status;
        if (status !== "planned" && !pvp) {
          status = "planned";
          demoted++;
        }
        return {
          ...l,
          status,
          orderedAt: l.orderedAt ? new Date(`${l.orderedAt}T00:00:00Z`) : null,
          approvedAt: status !== "planned" ? now : null,
          projectId: s.projectId,
          createdById: user.id,
          position: ++position,
        };
      });
      if (rows.length) await tx.bomItem.createMany({ data: rows });
      added += rows.length;
    }
  });

  for (const s of sheets.filter((x) => x.lines.length)) {
    await recordActivity({
      actorId: user.id,
      taskId: null,
      projectId: s.projectId,
      taskTitle: `${s.lines.length} line${s.lines.length === 1 ? "" : "s"} from ${fileName} (${s.sheet})`,
      kind: "bom_added",
      field: "bom.import",
      to: pathOf(tree, s.projectId) || undefined,
    });
  }
  revalidate();
  return { added, demoted };
}
