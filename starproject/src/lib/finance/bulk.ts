import type { ReimbursementStatus } from "@prisma/client";

// The status changes the Reimbursements list can apply to several at once. Each
// is one of the detail card's buttons, offered for exactly the rows that button
// would be; the server still checks every row through `canTransition`.
export type BulkAction = "approve" | "send" | "retry" | "reject" | "cancel";

type Who = { isAdmin: boolean; isPvp: boolean };

const RULES: Record<BulkAction, { from: ReimbursementStatus[]; pvpOnly: boolean }> = {
  approve: { from: ["pending_approval"], pvpOnly: false },
  send: { from: ["awaiting_send"], pvpOnly: true },
  retry: { from: ["failed"], pvpOnly: true },
  reject: { from: ["pending_approval", "awaiting_send"], pvpOnly: false },
  cancel: { from: ["pending_approval", "awaiting_send", "approved", "failed"], pvpOnly: false },
};

export const BULK_LABEL: Record<BulkAction, string> = {
  approve: "Approve",
  send: "Send to CalLink",
  retry: "Retry filing",
  reject: "Reject",
  cancel: "Cancel",
};

export const BULK_ACTIONS = Object.keys(RULES) as BulkAction[];

/** Whether staff `who` may apply `action` to a reimbursement in `status`. */
export function bulkApplies(action: BulkAction, status: ReimbursementStatus, who: Who): boolean {
  const rule = RULES[action];
  if (!rule.from.includes(status)) return false;
  return rule.pvpOnly ? who.isPvp : who.isAdmin || who.isPvp;
}
