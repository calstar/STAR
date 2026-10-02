import { z } from "zod";

import { parseMoney } from "@/lib/finance/money";

// What a member fills in on the reimbursement form. This mirrors
// callink-worker/request.mjs: everything CalLink asks that STAR always answers the
// same way (account, category, item type/location/invoice, "UC Berkeley member?")
// is not an input here, and the requested amount is the sum of the items.

export const MAX_ITEMS = 6;
export const EXPENDITURE_ACTIONS = ["Direct Deposit", "Mail to Payee", "Hold for Pickup", "Other"] as const;

const text = (max: number) => z.string().trim().max(max);
const required = (label: string, max = 200) => text(max).min(1, `${label} is required`);
const optional = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), text(max).optional());

// A Berkeley UID is 7-8 digits. Student IDs (SIDs) start with 303 and are what
// people most often type by mistake; CalLink's form says never to use them.
export const uidSchema = z
  .string()
  .trim()
  .regex(/^\d{7,8}$/, "A UID is 7 or 8 digits")
  .refine((s) => !s.startsWith("303"), "That is a student ID (starts with 303), not a UID");

export const payeeSchema = z.object({
  firstName: required("First name", 100),
  lastName: required("Last name", 100),
  street: required("Street", 200),
  street2: optional(200),
  city: required("City", 100),
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use the 2-letter state code")
    .transform((s) => s.toUpperCase()),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a 5-digit ZIP code"),
});

export const phoneSchema = z
  .string()
  .trim()
  .refine((s) => s.replace(/\D/g, "").length >= 10, "Enter a phone number with area code");

export const itemSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date on the receipt")
    .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), "Pick the date on the receipt"),
  vendor: required("Vendor", 200),
  amount: z
    .string()
    .trim()
    .refine((s) => (parseMoney(s) ?? 0) > 0, "Enter the receipt total, like 12.34"),
  comment: optional(500),
});

export const reimbursementInputSchema = z
  .object({
    subject: required("Subject", 150),
    description: optional(2000),
    payee: payeeSchema,
    uid: uidSchema,
    email: z.string().trim().toLowerCase().email("Enter the payee's email"),
    phone: phoneSchema,
    expenditureAction: z.enum(EXPENDITURE_ACTIONS).default("Direct Deposit"),
    directDepositSignedUp: z.boolean().default(true),
    specialInstructions: optional(1000),
    items: z.array(itemSchema).min(1, "Add at least one item").max(MAX_ITEMS, `At most ${MAX_ITEMS} items`),
    saveProfile: z.boolean().default(true),
  })
  .strict()
  .refine((r) => r.expenditureAction !== "Other" || !!r.specialInstructions, {
    message: "Say how the payee should be paid",
    path: ["specialInstructions"],
  });

export type ReimbursementInput = z.infer<typeof reimbursementInputSchema>;

export const payeeProfileSchema = payeeSchema.extend({
  phone: phoneSchema,
  uid: uidSchema,
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().toLowerCase().email().optional(),
  ),
  directDepositSignedUp: z.boolean().default(true),
});

export type PayeeProfileInput = z.infer<typeof payeeProfileSchema>;
