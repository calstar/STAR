import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { draftProblems, mergeDraft, type DraftPatch, type DraftPayload } from "@/lib/finance/drafts";
import { fileReimbursement, type Filer } from "@/lib/finance/file";
import { checkReceipt, safeFileName } from "@/lib/finance/receipts";

// Reimbursement drafts in the database: private to whoever made them. Filing one
// builds the web form's FormData from it and runs the form's own code.

export type DraftReceiptIn = { item: number; file: File };

export type DraftView = {
  number: number;
  createdAt: string;
  updatedAt: string;
  fields: DraftPayload;
  receipts: { item: number; fileName: string; mimeType: string; size: number }[];
  /** What still stands between the draft and filing it; empty when ready. */
  problems: string[];
  ready: boolean;
};

const VIEW_INCLUDE = {
  receipts: { select: { item: true, fileName: true, mimeType: true, size: true }, orderBy: { item: "asc" } },
} satisfies Prisma.ReimbursementDraftInclude;

type Row = Prisma.ReimbursementDraftGetPayload<{ include: typeof VIEW_INCLUDE }>;

function toView(d: Row): DraftView {
  const fields = d.payload as DraftPayload;
  const problems = draftProblems(
    fields,
    d.receipts.map((r) => r.item),
  );
  return {
    number: d.number,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    fields,
    receipts: d.receipts,
    problems,
    ready: problems.length === 0,
  };
}

/** The receipt as stored, or why it can't be: the form's checks on name, size and bytes. */
async function readReceipt(r: DraftReceiptIn) {
  const data = new Uint8Array(await r.file.arrayBuffer());
  const check = checkReceipt(r.file.name, data.length, data.subarray(0, 8));
  if (!check.ok) throw new Error(`Receipt for item ${r.item}: ${check.error}`);
  return { item: r.item, fileName: safeFileName(r.file.name), mimeType: check.mime, size: data.length, data };
}

async function own(userId: string, number: number) {
  const d = await prisma.reimbursementDraft.findUnique({ where: { number }, select: { id: true, createdById: true, payload: true } });
  // Someone else's draft is as good as missing.
  if (!d || d.createdById !== userId) throw new Error(`You have no draft D-${number}.`);
  return d;
}

async function view(id: string): Promise<DraftView> {
  return toView(await prisma.reimbursementDraft.findUniqueOrThrow({ where: { id }, include: VIEW_INCLUDE }));
}

export async function listDrafts(userId: string): Promise<DraftView[]> {
  const rows = await prisma.reimbursementDraft.findMany({
    where: { createdById: userId },
    include: VIEW_INCLUDE,
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toView);
}

export async function getDraft(userId: string, number: number): Promise<DraftView> {
  return view((await own(userId, number)).id);
}

export async function createDraft(userId: string, patch: DraftPatch, receipts: DraftReceiptIn[]): Promise<DraftView> {
  const files = await Promise.all(receipts.map(readReceipt));
  const d = await prisma.reimbursementDraft.create({
    data: {
      createdById: userId,
      payload: mergeDraft({}, patch) as Prisma.InputJsonValue,
      receipts: { create: files },
    },
    select: { id: true },
  });
  return view(d.id);
}

/** Apply a patch, set receipts by item index (replacing any there), and drop the ones in `removeItems`. */
export async function updateDraft(
  userId: string,
  number: number,
  patch: DraftPatch,
  receipts: DraftReceiptIn[],
  removeItems: number[],
): Promise<DraftView> {
  const d = await own(userId, number);
  const files = await Promise.all(receipts.map(readReceipt));
  await prisma.$transaction(async (tx) => {
    await tx.reimbursementDraft.update({
      where: { id: d.id },
      data: { payload: mergeDraft(d.payload as DraftPayload, patch) as Prisma.InputJsonValue },
    });
    const drop = [...removeItems, ...files.map((f) => f.item)];
    if (drop.length) await tx.reimbursementDraftReceipt.deleteMany({ where: { draftId: d.id, item: { in: drop } } });
    if (files.length) await tx.reimbursementDraftReceipt.createMany({ data: files.map((f) => ({ ...f, draftId: d.id })) });
  });
  return view(d.id);
}

export async function deleteDraft(userId: string, number: number): Promise<void> {
  const d = await own(userId, number);
  await prisma.reimbursementDraft.delete({ where: { id: d.id } });
}

/**
 * File the draft exactly as the web form would, then delete it. Refused with
 * the draft's problems while it has any; the form's own checks still run.
 */
export async function fileDraft(user: Filer, number: number): Promise<{ number: number }> {
  const d = await own(user.id, number);
  const full = await prisma.reimbursementDraft.findUniqueOrThrow({
    where: { id: d.id },
    include: { receipts: { orderBy: { item: "asc" } } },
  });
  const payload = full.payload as DraftPayload;
  const problems = draftProblems(
    payload,
    full.receipts.map((r) => r.item),
  );
  if (problems.length) throw new Error(`D-${number} isn't ready to file: ${problems.join("; ")}`);

  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  for (const r of full.receipts) {
    const bytes = new Uint8Array(r.data.byteLength);
    bytes.set(r.data);
    form.set(`receipt-${r.item}`, new File([bytes], r.fileName, { type: r.mimeType }));
  }
  const result = await fileReimbursement(user, form);
  if ("error" in result) {
    const fields = Object.entries(result.fieldErrors ?? {}).map(([k, v]) => `${k}: ${v}`);
    throw new Error([result.error, ...fields].join(" -- "));
  }
  await prisma.reimbursementDraft.delete({ where: { id: d.id } });
  return { number: result.number };
}
