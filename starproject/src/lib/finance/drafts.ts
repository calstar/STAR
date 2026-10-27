import { z } from "zod";

import { itemSchema, MAX_ITEMS, payeeSchema, reimbursementInputSchema } from "@/lib/finance/schema";

// Reimbursement drafts: the form's fields as far as they are known, checked for
// type but not for completeness, and what is still missing before the draft can
// be filed. Pure, so the MCP tools and the tests share it.

const full = reimbursementInputSchema.innerType().shape;

/**
 * What a draft may hold: every field of the filing form, each optional, with an
 * item or the payee allowed to be half filled in. A value is checked as it
 * would be on filing (an email must look like one) once it is given.
 */
export const draftPatchShape = {
  subject: full.subject.optional(),
  description: full.description,
  projectId: full.projectId,
  subteamId: full.subteamId,
  payee: payeeSchema.partial().optional(),
  uid: full.uid.optional(),
  email: full.email.optional(),
  phone: full.phone.optional(),
  expenditureAction: full.expenditureAction.removeDefault().optional(),
  directDepositSignedUp: full.directDepositSignedUp.removeDefault().optional(),
  specialInstructions: full.specialInstructions,
  items: z.array(itemSchema.partial()).max(MAX_ITEMS, `At most ${MAX_ITEMS} items`).optional(),
  saveProfile: full.saveProfile.removeDefault().optional(),
  bomItemIds: full.bomItemIds.removeDefault().optional(),
};

export const draftPatchSchema = z.object(draftPatchShape).strict();
export type DraftPatch = z.infer<typeof draftPatchSchema>;
export type DraftPayload = DraftPatch;

/**
 * The draft after a patch: fields given replace the draft's (the payee merges
 * field by field), `items` replaces the whole list, and fields left out stay.
 */
export function mergeDraft(prev: DraftPayload, patch: DraftPatch): DraftPayload {
  const next: DraftPayload = { ...prev };
  for (const [k, v] of Object.entries(patch) as [keyof DraftPatch, unknown][]) {
    if (v === undefined) continue;
    if (k === "payee") next.payee = { ...(prev.payee ?? {}), ...(v as DraftPatch["payee"]) };
    else (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

/**
 * Everything standing between the draft and filing it, as "field: problem"
 * lines in the form's own words: the form's checks, plus one receipt per item.
 * Empty means it can be filed.
 */
export function draftProblems(payload: DraftPayload, receiptItems: number[]): string[] {
  const out: string[] = [];
  const parsed = reimbursementInputSchema.safeParse(payload);
  if (!parsed.success) {
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".") || "draft";
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(`${path}: ${issue.message}`);
    }
  }
  const items = payload.items?.length ?? 0;
  const have = new Set(receiptItems);
  for (let i = 0; i < items; i++) if (!have.has(i)) out.push(`items.${i}.receipt: Attach the receipt`);
  for (const i of [...have].sort((a, b) => a - b)) {
    if (i >= items) out.push(`receipts.${i}: A receipt is attached for item ${i}, which the draft doesn't have`);
  }
  return out;
}
