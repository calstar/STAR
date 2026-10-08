import { z } from "zod";

import { parseMoney } from "@/lib/finance/money";

// What admins type on the Finance tab: accounts kept by hand and planned income.

/** "1,234.56" or "-80" → cents; an account can be overdrawn. null if it isn't an amount. */
export function parseSignedMoney(text: string): number | null {
  const s = text.trim();
  const neg = s.startsWith("-");
  const cents = parseMoney(neg ? s.slice(1) : s);
  return cents == null ? null : neg ? -cents : cents;
}

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(max).optional());

export const accountInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name the account").max(120),
    balance: z
      .string()
      .transform((s, ctx) => {
        const c = parseSignedMoney(s);
        if (c == null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter the balance, like 1234.56" });
        return c ?? 0;
      }),
    note: optionalText(500),
  })
  .strict();

export const incomeInputSchema = z
  .object({
    schoolYear: z.number().int().min(2000).max(2100),
    source: z.string().trim().min(1, "Say where it comes from").max(200),
    amount: z.string().transform((s, ctx) => {
      const c = parseMoney(s);
      if (c == null || c === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter the amount, like 5000" });
      return c ?? 0;
    }),
    expectedOn: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date").optional(),
    ),
    received: z.boolean().default(false),
    note: optionalText(500),
  })
  .strict();

export type AccountInput = z.input<typeof accountInputSchema>;
export type IncomeInput = z.input<typeof incomeInputSchema>;

/** The first message per field, keyed by field name. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[issue.path.join(".")] ??= issue.message;
  return out;
}
