import { describe, expect, it } from "vitest";

import type { FinanceRow } from "@/lib/finance/queries";
import { checkReceipt } from "@/lib/finance/receipts";

import { buildFilingForm, filterFinanceRows, receiptToFile, stripBase64 } from "./finance";

// The pure half of the finance tools: the FinanceWorkspace filters and the
// base64 -> File mapping the filing tool feeds to fileReimbursement.

const row = (over: Partial<FinanceRow>): FinanceRow => ({
  id: over.number ? `id-${over.number}` : "id",
  number: 1,
  subject: "Fittings",
  payeeName: "Ada Lovelace",
  submitterName: null,
  amountCents: 1234,
  date: "2026-10-01T00:00:00.000Z",
  status: { key: "pending_approval", label: "Pending approval", tone: "amber" },
  callinkRequestNumber: null,
  vendors: "",
  mine: false,
  needsAdmin: false,
  ...over,
});

const rows: FinanceRow[] = [
  row({ number: 1, subject: "Fittings", vendors: "McMaster-Carr", mine: true, needsAdmin: true }),
  row({
    number: 2,
    subject: "Hotel",
    payeeName: "Grace Hopper",
    submitterName: "Roshan T.",
    status: { key: "callink:Approved", label: "Approved on CalLink", tone: "green" },
    callinkRequestNumber: "10696355",
  }),
  row({
    number: 3,
    subject: "Propellant",
    status: { key: "needs_check", label: "Needs check", tone: "red" },
    needsAdmin: true,
  }),
];

describe("filterFinanceRows", () => {
  it("returns everything with no filters", () => {
    expect(filterFinanceRows(rows, {})).toEqual(rows);
    expect(filterFinanceRows(rows, { search: "   " })).toEqual(rows);
  });

  it("matches the display-status key exactly", () => {
    expect(filterFinanceRows(rows, { status: "pending_approval" }).map((r) => r.number)).toEqual([1]);
    expect(filterFinanceRows(rows, { status: "callink:Approved" }).map((r) => r.number)).toEqual([2]);
    expect(filterFinanceRows(rows, { status: "approved" })).toEqual([]);
  });

  it("mine and review narrow like the chips", () => {
    expect(filterFinanceRows(rows, { mine: true }).map((r) => r.number)).toEqual([1]);
    expect(filterFinanceRows(rows, { review: true }).map((r) => r.number)).toEqual([1, 3]);
    expect(filterFinanceRows(rows, { mine: true, review: true }).map((r) => r.number)).toEqual([1]);
  });

  it("searches number, subject, payee, submitter, vendors and CalLink #, case-insensitively", () => {
    const hits = (search: string) => filterFinanceRows(rows, { search }).map((r) => r.number);
    expect(hits("r-2")).toEqual([2]);
    expect(hits("FITT")).toEqual([1]);
    expect(hits("hopper")).toEqual([2]);
    expect(hits("roshan")).toEqual([2]);
    expect(hits("mcmaster")).toEqual([1]);
    expect(hits("10696355")).toEqual([2]);
    expect(hits("nothing like this")).toEqual([]);
  });

  it("combines filters with AND", () => {
    expect(filterFinanceRows(rows, { review: true, search: "prop" }).map((r) => r.number)).toEqual([3]);
    expect(filterFinanceRows(rows, { review: true, search: "hotel" })).toEqual([]);
  });
});

// A 1x1 PNG: the smallest real receipt the checker accepts.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("receiptToFile", () => {
  it("decodes base64 into a File with the given name and type", async () => {
    const file = receiptToFile({ fileName: "receipt.png", mimeType: "image/png", base64: PNG_B64 });
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("receipt.png");
    expect(file.type).toBe("image/png");
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(bytes.length).toBe(Buffer.from(PNG_B64, "base64").length);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // What fileReimbursement will run on it.
    expect(checkReceipt(file.name, file.size, bytes.subarray(0, 8))).toEqual({ ok: true, mime: "image/png" });
  });

  it("tolerates a data: URL prefix and MIME line wrapping", async () => {
    const plain = receiptToFile({ fileName: "r.png", mimeType: "image/png", base64: PNG_B64 });
    const url = receiptToFile({ fileName: "r.png", mimeType: "image/png", base64: `data:image/png;base64,${PNG_B64}` });
    const wrapped = receiptToFile({ fileName: "r.png", mimeType: "image/png", base64: PNG_B64.replace(/(.{20})/g, "$1\r\n") });
    expect(new Uint8Array(await url.arrayBuffer())).toEqual(new Uint8Array(await plain.arrayBuffer()));
    expect(new Uint8Array(await wrapped.arrayBuffer())).toEqual(new Uint8Array(await plain.arrayBuffer()));
    expect(stripBase64(`data:image/png;base64,${PNG_B64.replace(/(.{20})/g, "$1\n")}`)).toBe(PNG_B64);
  });

  it("leaves a fake file for checkReceipt to refuse", async () => {
    const file = receiptToFile({ fileName: "fake.pdf", mimeType: "application/pdf", base64: Buffer.from("hello").toString("base64") });
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(checkReceipt(file.name, file.size, bytes.subarray(0, 8))).toMatchObject({ ok: false });
  });
});

describe("buildFilingForm", () => {
  it("lays the body out as ReimbursementForm.tsx does: payload JSON plus receipt-<i>", () => {
    const payload = { subject: "Fittings", items: [{ vendor: "A" }, { vendor: "B" }] };
    const form = buildFilingForm(payload, [
      { fileName: "a.png", mimeType: "image/png", base64: PNG_B64 },
      { fileName: "b.png", mimeType: "image/png", base64: PNG_B64 },
    ]);
    expect(JSON.parse(String(form.get("payload")))).toEqual(payload);
    expect((form.get("receipt-0") as File).name).toBe("a.png");
    expect((form.get("receipt-1") as File).name).toBe("b.png");
    expect(form.get("receipt-2")).toBeNull();
  });
});
