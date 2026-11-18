#!/usr/bin/env node
// End-to-end check of uploading receipts directly (create_receipt_upload +
// PUT /api/mcp/uploads/<id>) and filing with them, against a running app, as a
// real MCP client. Files one "[mcp-receipts]" reimbursement, then cancels it.
// Needs an admin's or PVP's token; exits 1 if any check fails.
//
//   MCP_URL=http://localhost:3000/api/mcp MCP_TOKEN=sp_… node scripts/mcp-receipt-upload-e2e.mjs
//
// The upload links come back on the app's APP_BASE_URL, so run the app with it
// pointing at itself (APP_BASE_URL=http://localhost:3000).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:3000/api/mcp";
const token = process.env.MCP_TOKEN;
if (!token) {
  console.error("MCP_TOKEN is required (mint one: node scripts/mcp-token.mjs you@berkeley.edu)");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  -- ${detail}` : ""}`);
  return ok;
};

const client = new Client({ name: "starproject-receipts-e2e", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { ok: !res.isError, data, text };
}

// A minimal real PDF and a 1x1 PNG: what checkReceipt accepts.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const put = (u, body) => fetch(u, { method: "PUT", body });

let number = null;
try {
  const minted = await call("create_receipt_upload", { count: 3 });
  check("create_receipt_upload mints 3 links", minted.ok && minted.data.uploads?.length === 3, minted.ok ? "" : minted.text);
  const [a, b, c] = minted.data.uploads;

  const upA = await put(`${a.uploadUrl}&name=Home%20Depot.pdf`, PDF);
  const bodyA = await upA.json();
  check("PUT a PDF with a name", upA.status === 200 && bodyA.fileName === "Home Depot.pdf" && bodyA.mimeType === "application/pdf", JSON.stringify(bodyA));
  const upB = await put(b.uploadUrl, PNG);
  const bodyB = await upB.json();
  check("PUT a PNG with no name gets receipt.png", upB.status === 200 && bodyB.fileName === "receipt.png", JSON.stringify(bodyB));

  check("a second PUT to a used link is 409", (await put(a.uploadUrl, PDF)).status === 409);
  check("a wrong key is 404", (await put(c.uploadUrl.replace(/key=.*/, "key=nope"), PDF)).status === 404);
  check("HTML is refused", (await put(c.uploadUrl, Buffer.from("<html>hi</html>"))).status === 400);
  check("over 4 MB is 413", (await put(c.uploadUrl, Buffer.alloc(4 * 1024 * 1024 + 1, 0x25))).status === 413);

  const notYet = await call("file_reimbursement", payload([{ uploadId: c.uploadId }]));
  check("filing with an empty upload is refused", !notYet.ok && /nothing uploaded/.test(notYet.text), notYet.text.slice(0, 160));
  const both = await call("file_reimbursement", payload([{ uploadId: a.uploadId, base64: PNG.toString("base64"), fileName: "x.png", mimeType: "image/png" }]));
  check("uploadId and base64 together are refused", !both.ok);

  const filed = await call("file_reimbursement", payload([{ uploadId: a.uploadId }, { uploadId: b.uploadId }], 2));
  check("file_reimbursement takes uploadIds", filed.ok && Number.isInteger(filed.data.number), filed.ok ? "" : filed.text.slice(0, 300));
  number = filed.data?.number ?? null;
  if (number) {
    const items = await call("get_reimbursement_receipts", { number });
    const names = (items.data?.items ?? []).flatMap((it) => it.receipts.map((r) => r.fileName));
    check("the filing holds both receipts under their names", JSON.stringify(names) === JSON.stringify(["Home Depot.pdf", "receipt.png"]), JSON.stringify(names));
  }
  const reuse = await call("file_reimbursement", payload([{ uploadId: a.uploadId }]));
  check("a filed upload can't be used again", !reuse.ok && /no such upload/.test(reuse.text), reuse.text.slice(0, 160));

  const draft = await call("draft_reimbursement", { subject: "[mcp-receipts] draft", receipts: [{ item: 0, uploadId: c.uploadId }] });
  check("a draft refuses an empty upload too", !draft.ok);
} finally {
  if (number) {
    const gone = await call("cancel_reimbursement", { number });
    check(`cleanup: cancelled R-${number}`, gone.ok, gone.ok ? "" : gone.text);
  }
  await client.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

function payload(receipts, n = receipts.length) {
  return {
    subject: "[mcp-receipts] upload test",
    payee: { firstName: "Test", lastName: "Payee", street: "1 Test St", city: "Berkeley", state: "CA", zip: "94720" },
    uid: "1234567",
    email: "test-payee@berkeley.edu",
    phone: "5105550100",
    items: Array.from({ length: n }, (_, i) => ({ date: "2026-11-01", vendor: `Vendor ${i}`, amount: "1.00" })),
    saveProfile: false,
    receipts,
  };
}
