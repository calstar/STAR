"use server";

import { getFinanceDetail, getViewer, type FinanceDetail } from "@/lib/finance/queries";

/** The reimbursement modal's data, redacted for the viewer on the server. */
export async function loadReimbursement(number: number): Promise<FinanceDetail | null> {
  if (!Number.isInteger(number) || number < 1) return null;
  return getFinanceDetail(number, await getViewer());
}
