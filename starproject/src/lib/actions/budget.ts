"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { fieldErrors } from "@/lib/finance/admin-schema";
import { budgetLineInputSchema, type BudgetLineInput } from "@/lib/finance/budget";
import { getBudgetOptions } from "@/lib/finance/budget-data";
import { getCurrentDbUser } from "@/lib/user";

// Budget lines: any member keeps their subteam's (Subteams → Budget), admins see
// them all on the Finance tab. A line's subteam and year are set when it is made;
// one with purchase requests on it can't be deleted, so what was approved against
// it stays on the record.

type Result = { ok: true } | { error: string; fieldErrors?: Record<string, string> };

function revalidate() {
  revalidatePath("/finance");
  revalidatePath("/subteams/[id]/budget", "page");
}

async function projectProblem(projectId: string | undefined): Promise<Result | null> {
  if (!projectId) return null;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  return p ? null : { error: "Some fields need fixing.", fieldErrors: { projectId: "That project no longer exists" } };
}

export async function createBudgetLine(subteamId: string, schoolYear: number, input: BudgetLineInput): Promise<Result> {
  const user = await getCurrentDbUser();
  if (!Number.isInteger(schoolYear) || schoolYear < 2000 || schoolYear > 2100) return { error: "That isn't a school year." };
  const subteam = await prisma.subteam.findUnique({ where: { id: subteamId }, select: { id: true } });
  if (!subteam) return { error: "That subteam no longer exists." };
  const parsed = budgetLineInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Some fields need fixing.", fieldErrors: fieldErrors(parsed.error) };
  const l = parsed.data;
  const bad = await projectProblem(l.projectId);
  if (bad) return bad;
  await prisma.budgetLine.create({
    data: {
      schoolYear,
      subteamId,
      projectId: l.projectId ?? null,
      name: l.name,
      plannedCents: l.amount,
      note: l.note ?? null,
      createdById: user.id,
    },
  });
  revalidate();
  return { ok: true };
}

export async function updateBudgetLine(id: string, input: BudgetLineInput): Promise<Result> {
  await getCurrentDbUser();
  const parsed = budgetLineInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Some fields need fixing.", fieldErrors: fieldErrors(parsed.error) };
  const l = parsed.data;
  const bad = await projectProblem(l.projectId);
  if (bad) return bad;
  const done = await prisma.budgetLine.updateMany({
    where: { id },
    data: { name: l.name, plannedCents: l.amount, projectId: l.projectId ?? null, note: l.note ?? null },
  });
  if (done.count === 0) return { error: "That budget line no longer exists." };
  revalidate();
  return { ok: true };
}

export async function deleteBudgetLine(id: string): Promise<Result> {
  await getCurrentDbUser();
  const used = await prisma.purchaseRequest.count({ where: { budgetLineId: id } });
  if (used > 0) {
    return { error: `${used} purchase request${used === 1 ? " spends" : "s spend"} this line, so it stays. Set its amount instead.` };
  }
  await prisma.budgetLine.deleteMany({ where: { id } });
  revalidate();
  return { ok: true };
}

/** The request dialog's choices: subteams and this school year's lines, with what's left on each. */
export async function budgetOptions() {
  await getCurrentDbUser();
  return getBudgetOptions();
}
