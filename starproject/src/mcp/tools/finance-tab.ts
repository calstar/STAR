import { z } from "zod";

import { createBudgetLine, deleteBudgetLine, updateBudgetLine } from "@/lib/actions/budget";
import {
  createAccount,
  createIncome,
  deleteAccount,
  deleteIncome,
  setIncomeReceived,
  updateAccount,
  updateIncome,
} from "@/lib/actions/finance-admin";
import { requireAdmin } from "@/lib/admins";
import { prisma } from "@/lib/db";
import { budgetYears, getBudget } from "@/lib/finance/budget-data";
import { schoolYearOf } from "@/lib/finance/ledger";
import { getFinanceOverview } from "@/lib/finance/overview";

import { DESTRUCTIVE, READ, WRITE, defineTool, guardedDefine, type ToolModule } from "./_shared";

// The Finance tab (/finance: balances, the year's spending, planned income) and
// subteam budgets (Subteams -> Budget). Writes call the page's server actions in
// src/lib/actions/finance-admin.ts and budget.ts, so their checks are the page's.
// The Finance tab is admins only; a subteam's budget is kept by any member, as
// its page is open to every member.

type Result = { ok: true } | { error: string; fieldErrors?: Record<string, string> };

/** Throw an action's refusal, its field errors included, as the tool's error. */
export function check(result: Result): void {
  if (!("error" in result)) return;
  const fields = Object.entries(result.fieldErrors ?? {}).map(([k, v]) => `${k}: ${v}`);
  throw new Error(fields.length ? `${result.error} (${fields.join("; ")})` : result.error);
}

/** 1234.5 -> "1234.50", the text the page's money fields parse. */
export function dollars(n: number): string {
  return n.toFixed(2);
}

/** Cents back to the form's text, for fields an update leaves alone. */
export function centsText(cents: number): string {
  return (cents / 100).toFixed(2);
}

const yearSchema = z
  .number()
  .int()
  .min(2000)
  .max(2100)
  .describe("School year by the year it starts: 2026 is 2026-27");
const money = (what: string) => z.number().finite().describe(`${what}, in dollars (e.g. 1234.56)`);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const financeTabTools: ToolModule = (server) => {
  const admin = guardedDefine(server, requireAdmin);

  // ---- the Finance tab ------------------------------------------------------------

  admin(
    "get_finance_overview",
    {
      description:
        "Admins only. The Finance tab for a school year: the CalLink SUMMARY balance (the STAR total) and CalLink's " +
        "other accounts, accounts kept by hand, the year's spending (paid and pending, by month, subteam and project), " +
        "planned income, and every subteam's budget. Amounts are in cents. `years` lists the years with data; a year " +
        "outside it falls back to this one.",
      inputSchema: { schoolYear: yearSchema.optional() },
      annotations: READ,
    },
    async ({ schoolYear }) => getFinanceOverview(schoolYear ?? null),
  );

  admin(
    "create_finance_account",
    {
      description:
        "Admins only. Add an account kept by hand (one CalLink doesn't report) to the Finance tab, with its balance " +
        "as of now. A balance may be negative (overdrawn).",
      inputSchema: {
        name: z.string().trim().min(1).max(120),
        balance: money("The balance"),
        note: z.string().max(500).optional(),
      },
      annotations: WRITE,
    },
    async ({ name, balance, note }) => {
      check(await createAccount({ name, balance: dollars(balance), note }));
      return { ok: true };
    },
  );

  admin(
    "update_finance_account",
    {
      description:
        "Admins only. Change an account on the Finance tab (ids from get_finance_overview); fields left out stay. For " +
        "an account added by hand, name, balance and note, and the balance is re-dated to now. For a CalLink account " +
        "only the note: its name and balance are CalLink's, and name/balance are ignored.",
      inputSchema: {
        id: z.string().min(1),
        name: z.string().trim().min(1).max(120).optional(),
        balance: money("The balance").optional(),
        note: z.string().max(500).optional().describe("Empty clears it"),
      },
      annotations: WRITE,
    },
    async ({ id, name, balance, note }) => {
      const a = await prisma.financeAccount.findUnique({ where: { id }, select: { name: true, balanceCents: true, note: true } });
      if (!a) throw new Error("That account no longer exists.");
      check(
        await updateAccount(id, {
          name: name ?? a.name,
          balance: balance != null ? dollars(balance) : centsText(a.balanceCents),
          note: note ?? a.note ?? undefined,
        }),
      );
      return { ok: true };
    },
  );

  admin(
    "delete_finance_account",
    {
      description: "Admins only. Delete an account added by hand. CalLink's accounts come from CalLink and can't be deleted.",
      inputSchema: { id: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      check(await deleteAccount(id));
      return { deleted: id };
    },
  );

  admin(
    "create_planned_income",
    {
      description:
        "Admins only. Add expected income to a school year on the Finance tab: where it comes from, how much, " +
        "optionally when (YYYY-MM-DD) and whether it has already arrived.",
      inputSchema: {
        schoolYear: yearSchema,
        source: z.string().trim().min(1).max(200),
        amount: money("The amount (more than zero)"),
        expectedOn: dateSchema.optional(),
        received: z.boolean().optional(),
        note: z.string().max(500).optional(),
      },
      annotations: WRITE,
    },
    async ({ amount, ...rest }) => {
      check(await createIncome({ ...rest, amount: dollars(amount) }));
      return { ok: true };
    },
  );

  admin(
    "update_planned_income",
    {
      description:
        "Admins only. Change a planned income entry (ids from get_finance_overview's `income`); fields left out stay. " +
        "An empty expectedOn or note clears it.",
      inputSchema: {
        id: z.string().min(1),
        schoolYear: yearSchema.optional(),
        source: z.string().trim().min(1).max(200).optional(),
        amount: money("The amount (more than zero)").optional(),
        expectedOn: z.union([dateSchema, z.literal("")]).optional(),
        received: z.boolean().optional(),
        note: z.string().max(500).optional(),
      },
      annotations: WRITE,
    },
    async ({ id, schoolYear, source, amount, expectedOn, received, note }) => {
      const i = await prisma.plannedIncome.findUnique({ where: { id } });
      if (!i) throw new Error("That entry no longer exists.");
      check(
        await updateIncome(id, {
          schoolYear: schoolYear ?? i.schoolYear,
          source: source ?? i.source,
          amount: amount != null ? dollars(amount) : centsText(i.amountCents),
          expectedOn: expectedOn ?? (i.expectedOn ? i.expectedOn.toISOString().slice(0, 10) : undefined),
          received: received ?? i.received,
          note: note ?? i.note ?? undefined,
        }),
      );
      return { ok: true };
    },
  );

  admin(
    "set_income_received",
    {
      description: "Admins only. Mark a planned income entry received (or not yet), as its checkbox on the Finance tab does.",
      inputSchema: { id: z.string().min(1), received: z.boolean() },
      annotations: WRITE,
    },
    async ({ id, received }) => {
      check(await setIncomeReceived(id, received));
      return { ok: true };
    },
  );

  admin(
    "delete_planned_income",
    {
      description: "Admins only. Delete a planned income entry.",
      inputSchema: { id: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      check(await deleteIncome(id));
      return { deleted: id };
    },
  );

  // ---- subteam budgets ------------------------------------------------------------

  defineTool(
    server,
    "get_subteam_budget",
    {
      description:
        "A subteam's budget for a school year (default this one), as Subteams -> Budget shows it: each line's id, name, " +
        "project, planned amount, and what purchase requests have approved and have waiting against it. Amounts in " +
        "cents. `years` lists this year, next year and any year with lines; a year outside it falls back to this one.",
      inputSchema: { subteamId: z.string().min(1), schoolYear: yearSchema.optional() },
      annotations: READ,
    },
    async ({ subteamId, schoolYear }) => {
      const subteam = await prisma.subteam.findUnique({ where: { id: subteamId }, select: { id: true, name: true } });
      if (!subteam) throw new Error("That subteam no longer exists.");
      const current = schoolYearOf(new Date());
      const years = [...new Set([current + 1, current, ...(await budgetYears())])].sort((a, b) => b - a);
      const year = schoolYear != null && years.includes(schoolYear) ? schoolYear : current;
      return { subteam, years, budget: await getBudget(year, subteam.id) };
    },
  );

  defineTool(
    server,
    "create_budget_line",
    {
      description:
        "Add a line to a subteam's budget for a school year (Subteams -> Budget): what it's for, the planned amount, " +
        "optionally the project it belongs to. The subteam and year are fixed once made. Any member may.",
      inputSchema: {
        subteamId: z.string().min(1),
        schoolYear: yearSchema,
        name: z.string().trim().min(1).max(150),
        amount: money("The planned amount (more than zero)"),
        projectId: z.string().min(1).optional(),
        note: z.string().max(500).optional(),
      },
      annotations: WRITE,
    },
    async ({ subteamId, schoolYear, name, amount, projectId, note }) => {
      check(await createBudgetLine(subteamId, schoolYear, { name, amount: dollars(amount), projectId, note }));
      return { ok: true };
    },
  );

  defineTool(
    server,
    "update_budget_line",
    {
      description:
        "Change a budget line's name, planned amount, project or note (ids from get_subteam_budget or " +
        "list_budget_lines); fields left out stay, and an empty projectId or note clears it. Any member may.",
      inputSchema: {
        id: z.string().min(1),
        name: z.string().trim().min(1).max(150).optional(),
        amount: money("The planned amount (more than zero)").optional(),
        projectId: z.string().optional(),
        note: z.string().max(500).optional(),
      },
      annotations: WRITE,
    },
    async ({ id, name, amount, projectId, note }) => {
      const l = await prisma.budgetLine.findUnique({ where: { id } });
      if (!l) throw new Error("That budget line no longer exists.");
      check(
        await updateBudgetLine(id, {
          name: name ?? l.name,
          amount: amount != null ? dollars(amount) : centsText(l.plannedCents),
          projectId: projectId ?? l.projectId ?? undefined,
          note: note ?? l.note ?? undefined,
        }),
      );
      return { ok: true };
    },
  );

  defineTool(
    server,
    "delete_budget_line",
    {
      description:
        "Delete a budget line. Refused while any purchase request spends it, so what was approved against it stays " +
        "on the record; change its amount instead. Any member may.",
      inputSchema: { id: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      check(await deleteBudgetLine(id));
      return { deleted: id };
    },
  );
};
