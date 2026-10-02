import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { toCallinkDate, toWorkerRequest } from "@/lib/finance/serialize";

const ours = () => ({
  number: 42,
  subject: "Motor casings",
  description: null,
  eventDetails: null,
  specialInstructions: "",
  expenditureAction: "Direct Deposit",
  directDepositSignedUp: true,
  payeeFirstName: "Ada",
  payeeLastName: "Lovelace",
  payeeEmail: "ada@berkeley.edu",
  pii: { street: "1 Analytical Way", street2: null as string | null, city: "Berkeley", state: "CA", zip: "94704", phone: "5105550100", uid: "7654321" as string | null },
  items: [
    { position: 2, date: "2026-10-02", vendor: "Swagelok", amountCents: 2345, comment: null, receipts: [{ id: "rb", fileName: "swage lok.pdf" }] },
    { position: 1, date: "2026-09-30", vendor: "McMaster-Carr", amountCents: 10000, comment: "tax incl.", receipts: [{ id: "ra", fileName: "../mc.pdf" }] },
  ],
});

// The keys callink-worker/request.mjs accepts; anything else makes it refuse the file.
// Read from the worker's own source, so the two can't drift apart unnoticed.
const workerSource = fs.readFileSync(path.join(__dirname, "../../../../callink-worker/request.mjs"), "utf8");
const keyList = (name: string) => {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(workerSource);
  if (!m) throw new Error(`${name} not found in callink-worker/request.mjs`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((k) => k[1]);
};
const REQUEST_KEYS = keyList("REQUEST_KEYS");
const ITEM_KEYS = keyList("ITEM_KEYS");

describe("toWorkerRequest", () => {
  const { request, receipts } = toWorkerRequest(ours());

  it("tags the subject so the filing can be found on CalLink", () => {
    expect(request.subject).toBe("Motor casings [STAR R-42]");
  });

  it("reads the worker's key lists", () => {
    expect(REQUEST_KEYS).toContain("subject");
    expect(ITEM_KEYS).toEqual(["date", "vendor", "total", "comment", "file"]);
  });

  it("uses only keys the worker accepts, with every optional answer filled in", () => {
    const full = ours();
    Object.assign(full, { description: "d", eventDetails: "e", specialInstructions: "s" });
    full.items[0].comment = "c";
    full.pii.street2 = "Apt 2";
    const json = JSON.parse(JSON.stringify(toWorkerRequest(full).request));
    expect(Object.keys(json).sort()).toEqual([...REQUEST_KEYS].sort());
    for (const k of Object.keys(json)) expect(REQUEST_KEYS).toContain(k);
    for (const it of json.items) for (const k of Object.keys(it)) expect(ITEM_KEYS).toContain(k);
  });

  it("orders items, formats dates and totals, and names files uniquely", () => {
    expect(request.items).toEqual([
      { date: "09/30/2026", vendor: "McMaster-Carr", total: "100.00", comment: "tax incl.", file: "1-mc.pdf" },
      { date: "10/02/2026", vendor: "Swagelok", total: "23.45", comment: undefined, file: "2-swage lok.pdf" },
    ]);
    expect(receipts).toEqual([
      { receiptId: "ra", fileName: "1-mc.pdf" },
      { receiptId: "rb", fileName: "2-swage lok.pdf" },
    ]);
  });

  it("drops empty optional answers", () => {
    expect(request.specialInstructions).toBeUndefined();
    expect(request.description).toBeUndefined();
  });

  it("refuses to build a request CalLink would reject", () => {
    expect(() => toWorkerRequest({ ...ours(), pii: null })).toThrow(/address/);
    expect(() => toWorkerRequest({ ...ours(), pii: { ...ours().pii, uid: null } })).toThrow(/UID/);
    const twoFiles = ours();
    twoFiles.items[0].receipts.push({ id: "rc", fileName: "x.pdf" });
    expect(() => toWorkerRequest(twoFiles)).toThrow(/exactly one receipt/);
  });
});

describe("toCallinkDate", () => {
  it("converts and refuses junk", () => {
    expect(toCallinkDate("2026-01-05")).toBe("01/05/2026");
    expect(() => toCallinkDate("1/5/2026")).toThrow();
  });
});
