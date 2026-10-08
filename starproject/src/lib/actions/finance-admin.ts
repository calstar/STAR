"use server";

import { revalidatePath } from "next/cache";

import { isAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { accountInputSchema, fieldErrors, incomeInputSchema, type AccountInput, type IncomeInput } from "@/lib/finance/admin-schema";
import { getCurrentDbUser } from "@/lib/user";

// The Finance tab's edits. Admins only; every action checks again here, since a
// server action can be called without the page.

type Result = { ok: true } | { error: string; fieldErrors?: Record<string, string> };

async function admin() {
  const user = await getCurrentDbUser();
  return (await isAdmin(user.email)) ? user : null;
}

const ADMINS_ONLY = { error: "Admins only." } as const;

// ---- accounts kept by hand ---------------------------------------------------------

export async function createAccount(input: AccountInput): Promise<Result> {
  const user = await admin();
  if (!user) return ADMINS_ONLY;
  const parsed = accountInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Some fields need fixing.", fieldErrors: fieldErrors(parsed.error) };
  const a = parsed.data;
  await prisma.financeAccount.create({
    data: { name: a.name, balanceCents: a.balance, note: a.note ?? null, balanceAsOf: new Date(), updatedById: user.id },
  });
  revalidatePath("/finance");
  return { ok: true };
}

/** A CalLink account's balance is CalLink's; only its note is ours to change. */
export async function updateAccount(id: string, input: AccountInput): Promise<Result> {
  const user = await admin();
  if (!user) return ADMINS_ONLY;
  const existing = await prisma.financeAccount.findUnique({ where: { id }, select: { callinkAccountId: true, balanceCents: true } });
  if (!existing) return { error: "That account no longer exists." };
  const parsed = accountInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Some fields need fixing.", fieldErrors: fieldErrors(parsed.error) };
  const a = parsed.data;
  if (existing.callinkAccountId != null) {
    await prisma.financeAccount.update({ where: { id }, data: { note: a.note ?? null } });
  } else {
    await prisma.financeAccount.update({
      where: { id },
      data: {
        name: a.name,
        note: a.note ?? null,
        balanceCents: a.balance,
        // "As of" is when the balance was last checked, so re-entering the same number counts.
        balanceAsOf: new Date(),
        updatedById: user.id,
      },
    });
  }
  revalidatePath("/finance");
  return { ok: true };
}

export async function deleteAccount(id: string): Promise<Result> {
  if (!(await admin())) return ADMINS_ONLY;
  const gone = await prisma.financeAccount.deleteMany({ where: { id, callinkAccountId: null } });
  if (gone.count === 0) return { error: "Only accounts added here can be deleted; CalLink's come from CalLink." };
  revalidatePath("/finance");
  return { ok: true };
}

// ---- planned income ---------------------------------------------------------------

const incomeData = (i: ReturnType<typeof incomeInputSchema.parse>) => ({
  schoolYear: i.schoolYear,
  source: i.source,
  amountCents: i.amount,
  expectedOn: i.expectedOn ? new Date(`${i.expectedOn}T00:00:00Z`) : null,
  received: i.received,
  note: i.note ?? null,
});

export async function createIncome(input: IncomeInput): Promise<Result> {
  const user = await admin();
  if (!user) return ADMINS_ONLY;
  const parsed = incomeInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Some fields need fixing.", fieldErrors: fieldErrors(parsed.error) };
  await prisma.plannedIncome.create({ data: { ...incomeData(parsed.data), createdById: user.id } });
  revalidatePath("/finance");
  return { ok: true };
}

export async function updateIncome(id: string, input: IncomeInput): Promise<Result> {
  if (!(await admin())) return ADMINS_ONLY;
  const parsed = incomeInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Some fields need fixing.", fieldErrors: fieldErrors(parsed.error) };
  const done = await prisma.plannedIncome.updateMany({ where: { id }, data: incomeData(parsed.data) });
  if (done.count === 0) return { error: "That entry no longer exists." };
  revalidatePath("/finance");
  return { ok: true };
}

export async function setIncomeReceived(id: string, received: boolean): Promise<Result> {
  if (!(await admin())) return ADMINS_ONLY;
  const done = await prisma.plannedIncome.updateMany({ where: { id }, data: { received } });
  if (done.count === 0) return { error: "That entry no longer exists." };
  revalidatePath("/finance");
  return { ok: true };
}

export async function deleteIncome(id: string): Promise<Result> {
  if (!(await admin())) return ADMINS_ONLY;
  await prisma.plannedIncome.deleteMany({ where: { id } });
  revalidatePath("/finance");
  return { ok: true };
}
