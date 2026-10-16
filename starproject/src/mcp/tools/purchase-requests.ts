import { z } from "zod";

import { addPvp, removePvp } from "@/lib/actions/pvp";
import {
  approvePurchaseRequest,
  cancelPurchaseRequest,
  createPurchaseRequest,
  rejectPurchaseRequest,
} from "@/lib/actions/purchase-requests";
import { getPurchaseRequest, listPurchaseRequests } from "@/lib/purchase-request-data";
import { MAX_NOTE, MAX_REQUEST_LINES, PR_STATUSES } from "@/lib/purchase-requests";
import { isPvp, listPvps, SEED_PVP_EMAILS } from "@/lib/pvp";
import { getCurrentDbUser } from "@/lib/user";

import { classifyAdmins } from "./admins";
import { DESTRUCTIVE, READ, WRITE, defineTool, type ToolModule } from "./_shared";

// Purchase requests and the PVPs who approve them: what the Purchase Requests
// page and Workspace setup → PVPs do. Every write calls the same server action
// as the page, so "only a PVP approves" and History are the same.

const numberSchema = z.number().int().positive().describe("The request's PR number, e.g. 12 for PR-12");

async function byNumber(number: number) {
  const r = await getPurchaseRequest({ number });
  if (!r) throw new Error(`There is no PR-${number}.`);
  return r;
}

async function check(res: { error?: string }, number: number) {
  if (res.error) throw new Error(res.error);
  return byNumber(number);
}

export const purchaseRequestTools: ToolModule = (server) => {
  defineTool(
    server,
    "list_purchase_requests",
    {
      description:
        "Purchase requests, newest first, as the Purchase Requests page lists them: PR number, status " +
        `(${PR_STATUSES.join(", ")}), project, who made it and when, who decided and when, the note and decision ` +
        "note, the total, and each line as requested (with the live BOM line and whether it changed since).",
      inputSchema: { status: z.enum(PR_STATUSES).optional().describe("Only this status; omit for all") },
      annotations: READ,
    },
    async ({ status }) => listPurchaseRequests(status),
  );

  defineTool(
    server,
    "get_purchase_request",
    {
      description: "One purchase request by its PR number, with every line as requested and as it is on the BOM now.",
      inputSchema: { number: numberSchema },
      annotations: READ,
    },
    async ({ number }) => byNumber(number),
  );

  defineTool(
    server,
    "create_purchase_request",
    {
      description:
        "Ask a PVP to approve buying BOM lines (ids from list_bom), as the BOM tab's Request purchase does. Every " +
        "line must still be Planned and not already on a request waiting for a PVP. projectId is the project " +
        "whose BOM it is made from. Returns the new request.",
      inputSchema: {
        projectId: z.string().min(1),
        bomItemIds: z.array(z.string().min(1)).min(1).max(MAX_REQUEST_LINES),
        note: z.string().max(MAX_NOTE).optional().describe("What it's for, when it's needed"),
      },
      annotations: WRITE,
    },
    async ({ projectId, bomItemIds, note }) => {
      const res = await createPurchaseRequest(projectId, bomItemIds, note);
      if (res.error || !res.number) throw new Error(res.error ?? "Not created");
      return byNumber(res.number);
    },
  );

  defineTool(
    server,
    "approve_purchase_request",
    {
      description:
        "PVPs only. Approve a waiting purchase request, all of it or some lines: itemIds (the request's item ids " +
        "from get_purchase_request) picks the lines approved; omit it to approve every line. Approved lines still " +
        "Planned become Approved (each logged on the BOM); lines left out are recorded as not approved and stay " +
        "Planned, free to be requested again. Optional note.",
      inputSchema: {
        number: numberSchema,
        itemIds: z.array(z.string().min(1)).min(1).optional().describe("Only these request items; omit for all"),
        note: z.string().max(MAX_NOTE).optional(),
      },
      annotations: WRITE,
    },
    async ({ number, itemIds, note }) =>
      check(await approvePurchaseRequest((await byNumber(number)).id, note, itemIds), number),
  );

  defineTool(
    server,
    "reject_purchase_request",
    {
      description: "PVPs only. Reject a waiting purchase request with a reason; its lines stay Planned and can be requested again.",
      inputSchema: { number: numberSchema, reason: z.string().min(1).max(MAX_NOTE) },
      annotations: WRITE,
    },
    async ({ number, reason }) => check(await rejectPurchaseRequest((await byNumber(number)).id, reason), number),
  );

  defineTool(
    server,
    "cancel_purchase_request",
    {
      description: "Withdraw a waiting purchase request (whoever made it, or a PVP). Its lines stay Planned.",
      inputSchema: { number: numberSchema },
      annotations: WRITE,
    },
    async ({ number }) => check(await cancelPurchaseRequest((await byNumber(number)).id), number),
  );

  defineTool(
    server,
    "list_pvps",
    {
      description:
        "The PVPs (purchase approvers), as Workspace setup → PVPs shows them, each marked seed (built in) or added, " +
        "and whether you are one.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      const [pvps, me] = await Promise.all([listPvps(), getCurrentDbUser()]);
      return { pvps: classifyAdmins(pvps, SEED_PVP_EMAILS), isPvp: await isPvp(me.email) };
    },
  );

  defineTool(
    server,
    "add_pvp",
    {
      description: "PVPs only. Make someone a PVP by their email.",
      inputSchema: { email: z.string().email() },
      annotations: WRITE,
    },
    async ({ email }) => {
      await addPvp(email);
      return { added: email.trim().toLowerCase(), pvps: await listPvps() };
    },
  );

  defineTool(
    server,
    "remove_pvp",
    {
      description: "PVPs only. Remove a PVP. The last PVP can't be removed.",
      inputSchema: { email: z.string().email() },
      annotations: DESTRUCTIVE,
    },
    async ({ email }) => {
      await removePvp(email);
      return { removed: email.trim().toLowerCase(), pvps: await listPvps() };
    },
  );
};
