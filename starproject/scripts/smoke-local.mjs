#!/usr/bin/env node
// End-to-end check of the BOM against a running local STARProject
// (npm run dev:local in another terminal, then npm run smoke:local).
//
// It drives the real app the ways people and Claude do -- the pages, the .xlsx
// export, and the MCP tools (which call the same server actions as the tab) --
// and checks the money against SQL written here, not against src/lib/bom.ts:
// a total the app computes is checked by arithmetic the app doesn't share.
// Leaves the demo data as it found it, apart from History rows.

import { createHash, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
process.env.DATABASE_URL ??= "postgresql://starproject:starproject@localhost:54329/starproject?schema=public";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)) {
  console.error("smoke-local: DATABASE_URL is not a localhost database; refusing to run.");
  process.exit(1);
}
const prisma = new PrismaClient();

let failures = 0;
function check(ok, what, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${!ok && detail ? `\n          ${detail}` : ""}`);
  if (!ok) failures++;
}
const dollars = (cents) =>
  `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;

/** Predicted total under a project, by SQL: the subtree by recursive CTE, the
 * line cost by the rule as written in the plan (unit x qty + shipping; an
 * allowance is its amount; a part with no quantity is one). */
async function sqlPredicted(projectId, { spares = true } = {}) {
  const [row] = await prisma.$queryRaw`
    WITH RECURSIVE sub AS (
      SELECT id FROM "Project" WHERE id = ${projectId}
      UNION ALL
      SELECT p.id FROM "Project" p JOIN sub ON p."parentId" = sub.id WHERE NOT p.archived
    )
    SELECT COALESCE(SUM(
      CASE WHEN b.kind = 'allowance' THEN COALESCE(b."unitCostCents", 0)
           ELSE ROUND(COALESCE(b."unitCostCents", 0) * COALESCE(b.quantity, 1)) + COALESCE(b."shippingCents", 0)
      END), 0)::bigint AS total
    FROM "BomItem" b JOIN sub ON b."projectId" = sub.id
    WHERE ${spares} OR NOT b.spare`;
  return Number(row.total);
}

async function mintToken(email) {
  const user = await prisma.user.upsert({ where: { email }, create: { email, name: email.split("@")[0] }, update: {} });
  const token = "sp_" + randomBytes(32).toString("base64url");
  const row = await prisma.apiToken.create({
    data: { userId: user.id, name: "smoke-local", tokenHash: createHash("sha256").update(token).digest("hex"), prefix: token.slice(0, 8) },
  });
  return { token, id: row.id };
}

async function mcp(token) {
  const client = new Client({ name: "smoke-local", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return {
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content?.map((c) => c.text ?? "").join("") ?? "";
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {}
      return { isError: !!res.isError, text, data };
    },
    close: () => client.close(),
  };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(120_000) });
  return res;
}

const tokens = [];
try {
  try {
    await get("/health");
  } catch {
    console.error(`smoke-local: nothing answering at ${BASE}. Start it first: npm run dev:local`);
    process.exit(2);
  }

  const byName = async (name) => {
    const p = await prisma.project.findFirst({ where: { name } });
    if (!p) throw new Error(`No project "${name}": run npm run dev:local -- --reset for the demo data.`);
    return p;
  };
  const le4 = await byName("LE4");
  const fc = await byName("Flight Computer");
  const recovery = await byName("LE4 Recovery");
  const le4Total = await sqlPredicted(le4.id);

  console.log("\nPages");
  {
    const res = await get(`/projects/${le4.id}?view=bom`);
    const html = await res.text();
    check(res.status === 200, "LE4's BOM tab loads");
    check(html.includes("LE4 Recovery") && html.includes("LE4 Avionics") && html.includes("LE4 (general)"), "LE4 shows its own lines and a section per subproject");
    check(html.includes(dollars(le4Total)), `LE4's predicted total is ${dollars(le4Total)} (SQL)`, "not found on the page");
    check(html.includes("Flight Computer"), "a Flight Computer line is labelled with its path inside LE4 Avionics");

    const fcHtml = await (await get(`/projects/${fc.id}?view=bom`)).text();
    check(fcHtml.includes("STM32H723ZGT6") && !fcHtml.includes("Main Parachute"), "Flight Computer's own BOM shows its parts and nothing from Recovery");
    check(fcHtml.includes(dollars(await sqlPredicted(fc.id))), "Flight Computer's total matches SQL");

    const list = await get(`/projects/${le4.id}`);
    check(list.status === 200 && (await list.text()).includes("Timeline"), "the List tab still loads, with Timeline and BOM tabs");
  }

  console.log("\nExport");
  {
    const res = await get(`/api/bom/export?project=${le4.id}`);
    check(res.status === 200 && (res.headers.get("content-type") ?? "").includes("spreadsheetml"), "the export downloads as .xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const names = wb.worksheets.map((w) => w.name);
    check(names[0] === "Summary" && names.includes("LE4 Recovery") && names.includes("LE4 Avionics"), "one sheet per section after a Summary", names.join(", "));
    const summary = wb.getWorksheet("Summary");
    let exported = null;
    summary.eachRow((row) => {
      if (row.getCell(1).value === "Total") exported = row.getCell(3).value?.result ?? row.getCell(3).value;
    });
    check(Math.round(Number(exported) * 100) === le4Total, `the Summary total matches SQL (${dollars(le4Total)})`, `got ${exported}`);
    const rec = wb.getWorksheet("LE4 Recovery");
    const header = rec.getRow(1).values.slice(1);
    check(header[0] === "Item" && header.includes("Unit Cost") && header.includes("Approved?") && header.includes("Notes & Alternate Parts"), "sheets carry the LE3 columns");
  }

  console.log("\nMCP: add, request, approve, order, remove (the tab's and the page's own server actions)");
  const devEmail = (process.env.DEV_AUTH_EMAIL ?? "dev@berkeley.edu").toLowerCase();
  const pvpTok = await mintToken(devEmail); // the seed makes the dev user an admin and a PVP
  const memberTok = await mintToken("alex.kim@berkeley.edu"); // neither
  const adminTok = await mintToken("inez9@berkeley.edu"); // a seed admin who is not a PVP
  tokens.push(pvpTok.id, memberTok.id, adminTok.id);
  const asPvp = await mcp(pvpTok.token);
  const asMember = await mcp(memberTok.token);
  const asAdmin = await mcp(adminTok.token);
  try {
    const me = await asPvp.call("whoami", {});
    check(me.data?.isPvp === true && (await asMember.call("whoami", {})).data?.isPvp === false, "whoami says who is a PVP");

    const listed = await asPvp.call("list_bom", { projectId: le4.id });
    check(!listed.isError && listed.data.totals.predictedCents === le4Total, "list_bom's LE4 total matches SQL", listed.text.slice(0, 200));

    const name = `Smoke test part ${Date.now()}`;
    const added = await asMember.call("add_bom_items", {
      projectId: fc.id,
      lines: [{ name, unitCostCents: "$2.50", quantity: "4", shippingCents: "1.25", supplier: "Digikey" }, { name: "Bad quantity", quantity: "abc" }],
    });
    const line = added.data?.added?.[0];
    check(!added.isError && line?.predictedCents === 1125, "a member adds a line: $2.50 x 4 + $1.25 = $11.25", added.text.slice(0, 300));
    check(added.data?.errors?.length === 1, "a line with a bad quantity is refused and the rest still go in");
    check((await sqlPredicted(le4.id)) === le4Total + 1125, "the new line counts once in LE4's total (it's on Flight Computer)");

    const refused = await asMember.call("update_bom_item", { id: line.id, status: "approved" });
    check(refused.isError && /PVP/.test(refused.text), "a member can't approve a line", refused.text);
    const adminRefused = await asAdmin.call("update_bom_item", { id: line.id, status: "approved" });
    check(adminRefused.isError && /PVP/.test(adminRefused.text), "an admin who isn't a PVP can't either", adminRefused.text);

    console.log("\nPurchase requests");
    const pr = await asMember.call("create_purchase_request", { projectId: fc.id, bomItemIds: [line.id], note: "smoke test" });
    const prNumber = pr.data?.number;
    check(!pr.isError && pr.data.status === "pending" && pr.data.totalCents === 1125 && pr.data.createdBy?.name, "a member requests it: PR pending, $11.25, with who made it", pr.text.slice(0, 200));
    const twice = await asMember.call("create_purchase_request", { projectId: fc.id, bomItemIds: [line.id] });
    check(twice.isError && /already on a request/.test(twice.text), "the same line can't be requested twice");
    const memberApprove = await asMember.call("approve_purchase_request", { number: prNumber });
    check(memberApprove.isError && /PVP/.test(memberApprove.text), "a member can't approve the request");
    const adminApprove = await asAdmin.call("approve_purchase_request", { number: prNumber });
    check(adminApprove.isError && /PVP/.test(adminApprove.text), "an admin who isn't a PVP can't approve it");
    const approvedPr = await asPvp.call("approve_purchase_request", { number: prNumber });
    const live = await prisma.bomItem.findUnique({ where: { id: line.id } });
    check(!approvedPr.isError && approvedPr.data.status === "approved" && approvedPr.data.decidedBy?.name && live?.status === "approved", "a PVP approves it, and the line turns Approved", approvedPr.text.slice(0, 200));
    const again = await asPvp.call("reject_purchase_request", { number: prNumber, reason: "late" });
    check(again.isError && /already decided/.test(again.text), "a decided request can't be decided again");

    const ordered = await asMember.call("update_bom_item", { id: line.id, status: "ordered" });
    const today = new Date().toISOString().slice(0, 10);
    check(!ordered.isError && ordered.data.orderedAt === today, "a member marks it ordered; the order date fills in as today", ordered.text.slice(0, 200));
    const moved = await asPvp.call("update_bom_item", { id: line.id, projectId: recovery.id, quantity: "abc" });
    check(moved.isError && /quantity/i.test(moved.text), "a bad quantity is refused with the field named");

    // Reject, then ask again, then cancel.
    const second = (await asMember.call("add_bom_items", { projectId: fc.id, lines: [{ name: `${name} B`, unitCostCents: "3" }] })).data.added[0];
    const pr2 = (await asMember.call("create_purchase_request", { projectId: fc.id, bomItemIds: [second.id] })).data.number;
    const noReason = await asPvp.call("reject_purchase_request", { number: pr2, reason: " " });
    check(noReason.isError, "rejecting needs a reason");
    const rejected = await asPvp.call("reject_purchase_request", { number: pr2, reason: "Use the spare from LE3" });
    const stillPlanned = await prisma.bomItem.findUnique({ where: { id: second.id } });
    check(!rejected.isError && rejected.data.status === "rejected" && stillPlanned?.status === "planned", "a PVP rejects one; its line stays Planned");
    const pr3 = await asMember.call("create_purchase_request", { projectId: fc.id, bomItemIds: [second.id] });
    check(!pr3.isError, "a rejected line can be requested again");
    const otherCancel = await asAdmin.call("cancel_purchase_request", { number: pr3.data.number });
    check(otherCancel.isError, "someone else can't cancel it");
    const cancelled = await asMember.call("cancel_purchase_request", { number: pr3.data.number });
    check(!cancelled.isError && cancelled.data.status === "cancelled", "whoever made it can cancel it");

    // Partial approval: two lines asked for, one approved.
    const [pa, pb] = (await asMember.call("add_bom_items", {
      projectId: fc.id,
      lines: [{ name: `${name} P1`, unitCostCents: "10" }, { name: `${name} P2`, unitCostCents: "20" }],
    })).data.added;
    const pr4 = (await asMember.call("create_purchase_request", { projectId: fc.id, bomItemIds: [pa.id, pb.id] })).data;
    const itemP1 = pr4.items.find((i) => i.name === `${name} P1`).id;
    const part = await asPvp.call("approve_purchase_request", { number: pr4.number, itemIds: [itemP1] });
    const [la, lb] = await Promise.all([pa.id, pb.id].map((id) => prisma.bomItem.findUnique({ where: { id } })));
    check(
      !part.isError && part.data.status === "approved" && part.data.approvedCount === 1 && part.data.approvedCents === 1000 && la?.status === "approved" && lb?.status === "planned",
      "a PVP approves 1 of 2 lines: that one turns Approved, the other stays Planned",
      part.text.slice(0, 200),
    );
    check(part.data?.items.find((i) => i.name === `${name} P2`)?.approved === false, "the line left out is recorded as not approved");
    const reask = await asMember.call("create_purchase_request", { projectId: fc.id, bomItemIds: [pb.id] });
    check(!reask.isError, "the line left out can be requested again");
    await asMember.call("cancel_purchase_request", { number: reask.data.number });
    const none = await asPvp.call("approve_purchase_request", { number: pr4.number, itemIds: [] });
    check(none.isError, "approving with no lines picked is refused");
    await asPvp.call("delete_bom_item", { id: pa.id });
    await asPvp.call("delete_bom_item", { id: pb.id });

    // React separates adjacent text with <!-- --> in server HTML ("PR-<!-- -->12").
    const html = (await (await get(`/purchase-requests?pr=${prNumber}`)).text()).replaceAll("<!-- -->", "");
    check(html.includes(`PR-${prNumber}`) && html.includes(name), "the Purchase Requests page shows it with its lines");

    console.log("\nRemoving");
    const keep = await asMember.call("delete_bom_item", { id: line.id });
    check(keep.isError, "a member can't remove an ordered line");
    const gone = await asPvp.call("delete_bom_item", { id: line.id });
    await asPvp.call("delete_bom_item", { id: second.id });
    check(!gone.isError && !(await prisma.bomItem.findUnique({ where: { id: line.id } })), "a PVP removes it");
    check((await sqlPredicted(le4.id)) === le4Total, "LE4's total is back where it started");
    const kept = await asPvp.call("get_purchase_request", { number: prNumber });
    check(!kept.isError && kept.data.items[0].name === name && kept.data.items[0].live === null, "the approved request keeps its record after the line is deleted");

    const history = await prisma.activity.findMany({ where: { taskTitle: name }, orderBy: { createdAt: "asc" } });
    const kinds = history.map((a) => `${a.kind}${a.field ? `:${a.field}` : ""}`);
    check(
      kinds.includes("bom_added") && kinds.includes("bom_updated:bom.status") && kinds.includes("bom_removed"),
      "History has the add, the status changes and the removal",
      kinds.join(", "),
    );
    check(history.filter((a) => a.field === "bom.status").map((a) => a.toValue).join(",") === "Approved,Ordered", "History records Approved then Ordered (the refused approvals left no row)");
    const prRows = await prisma.activity.count({ where: { kind: { in: ["pr_created", "pr_approved", "pr_rejected", "pr_cancelled"] }, taskTitle: { startsWith: `PR-${prNumber} ` } } });
    check(prRows === 2, "History has the request and its approval");
  } finally {
    await asPvp.close();
    await asMember.close();
    await asAdmin.close();
  }
} catch (err) {
  console.error(`\nsmoke-local stopped: ${err.message}`);
  failures++;
} finally {
  if (tokens.length) await prisma.apiToken.deleteMany({ where: { id: { in: tokens } } });
  // The requests this run made (History keeps its rows).
  await prisma.purchaseRequest.deleteMany({ where: { items: { some: { name: { startsWith: "Smoke test part" } } } } });
  await prisma.$disconnect();
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
