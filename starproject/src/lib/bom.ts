// The bill of materials: what a line costs, how lines roll up through the
// project tree, and the rules for editing one. Prisma-free so the BOM tab (a
// client component), the server actions, the MCP tools and the tests share one
// set of rules.

import { formatCents, parseMoney } from "@/lib/finance/money";
import { type ProjectTree, ancestors, descendants, pathOf } from "@/lib/project-tree";

export const BOM_STATUSES = ["planned", "approved", "ordered", "received"] as const;
export type BomStatus = (typeof BOM_STATUSES)[number];
export type BomKind = "part" | "allowance";

export const BOM_STATUS_LABEL: Record<BomStatus, string> = {
  planned: "Planned",
  approved: "Approved",
  ordered: "Ordered",
  received: "Received",
};

/** The reimbursement a line was filed on, as much of it as the BOM shows. */
export type BomReimbursement = {
  id: string;
  number: number;
  status: string; // ReimbursementStatus
  callinkStatus: string | null;
  callinkDeletedOn: string | null;
};

/** One line as the BOM tab and the MCP tools see it. Dates are YYYY-MM-DD. */
export type BomLine = {
  id: string;
  projectId: string;
  kind: BomKind;
  name: string;
  partNumber: string | null;
  manufacturer: string | null;
  unitCostCents: number | null;
  quantity: number | null;
  shippingCents: number | null;
  realizedCents: number | null;
  supplier: string | null;
  url: string | null;
  spare: boolean;
  status: BomStatus;
  orderedAt: string | null;
  purchaserId: string | null;
  purchaserName: string | null;
  location: string | null;
  notes: string | null;
  taskId: string | null;
  taskNumber: number | null;
  /** The task's own project, which opening it in the task modal needs. */
  taskProjectId: string | null;
  reimbursement: BomReimbursement | null;
  reimbursedElsewhere: boolean;
  position: number;
};

type Costed = Pick<BomLine, "kind" | "unitCostCents" | "quantity" | "shippingCents">;

/**
 * What a line is expected to cost, in cents: unit x quantity + shipping for a
 * part (a part with no quantity is one of it), the lump sum for an allowance.
 * Shipping is always included -- the LE3 sheets disagreed on that, and this is
 * the one rule now.
 */
export function predictedCents(line: Costed): number {
  if (line.kind === "allowance") return line.unitCostCents ?? 0;
  const units = Math.round((line.unitCostCents ?? 0) * (line.quantity ?? 1));
  return units + (line.shippingCents ?? 0);
}

export type ReimbursedState = "none" | "filed" | "reimbursed";

/** Whether the money for a line has come back. Read from the reimbursement it
 * was filed on: CalLink saying Completed means paid. A filing that was
 * rejected, cancelled, denied or deleted leaves the line to be filed again. */
export function reimbursedState(
  line: Pick<BomLine, "reimbursement" | "reimbursedElsewhere">,
): ReimbursedState {
  if (line.reimbursedElsewhere) return "reimbursed";
  const r = line.reimbursement;
  if (!r) return "none";
  if (r.status === "rejected" || r.status === "cancelled") return "none";
  if (r.status === "submitted") {
    if (r.callinkDeletedOn) return "none";
    if (r.callinkStatus === "Completed") return "reimbursed";
    if (r.callinkStatus === "Denied" || r.callinkStatus === "Canceled") return "none";
  }
  return "filed";
}

export type BomSummary = {
  predictedCents: number;
  realizedCents: number;
  /** Predicted cost of every line past Planned: what the team has signed off on. */
  approvedCents: number;
  /** Parts (not allowances) ordered or received, out of all parts. */
  orderedParts: number;
  parts: number;
  /** Money a member paid that has not come back yet. */
  owedCents: number;
  lines: number;
};

export function summarize(lines: BomLine[], opts: { includeSpares?: boolean } = {}): BomSummary {
  const counted = opts.includeSpares === false ? lines.filter((l) => !l.spare) : lines;
  const s: BomSummary = {
    predictedCents: 0,
    realizedCents: 0,
    approvedCents: 0,
    orderedParts: 0,
    parts: 0,
    owedCents: 0,
    lines: counted.length,
  };
  for (const l of counted) {
    const p = predictedCents(l);
    s.predictedCents += p;
    s.realizedCents += l.realizedCents ?? 0;
    if (l.status !== "planned") s.approvedCents += p;
    if (l.kind === "part") {
      s.parts += 1;
      if (l.status === "ordered" || l.status === "received") s.orderedParts += 1;
    }
    if ((l.realizedCents ?? 0) > 0 && reimbursedState(l) !== "reimbursed") s.owedCents += l.realizedCents ?? 0;
  }
  return s;
}

export type BomSection = {
  /** The direct child the lines sit under, or null for the project's own lines. */
  projectId: string | null;
  title: string;
  color: string | null;
  lines: (BomLine & { subpath: string | null })[];
};

/**
 * Whether a project's BOM takes in the projects under it. Only a top-level
 * project (LE4, SSEP3) does; any project with a parent (LE4 Engine, Thrust
 * Chamber) shows only its own lines, even with subprojects of its own -- the
 * team's call, so a part list stays where it was written.
 */
export function bomRollsUp(tree: ProjectTree, id: string): boolean {
  return ancestors(tree, id).length === 0;
}

/**
 * The BOM tab's grouping on project `rootId`: its own lines first, then one
 * section per direct child holding that child's lines and everything below it
 * (in tree order). Within a section, a line deeper than the child carries its
 * path under the child ("Flight Computer"), so LE4 Avionics' section on the LE4
 * page reads like LE3's Avionics sheet. A project with a parent (see
 * bomRollsUp) gets just its own section. Sections with no lines are left out
 * unless `includeEmpty` (the BOM tab, so a subproject with nothing on it yet
 * still has a row to type into).
 */
export function sectionsFor(
  tree: ProjectTree,
  rootId: string,
  lines: BomLine[],
  opts: { includeEmpty?: boolean } = {},
): BomSection[] {
  const root = tree.byId.get(rootId);
  // Which direct child each project in the subtree rolls up to.
  const sectionOf = new Map<string, string | null>([[rootId, null]]);
  const children = bomRollsUp(tree, rootId) ? (tree.childrenOf.get(rootId) ?? []).filter((c) => !c.archived) : [];
  for (const c of children) {
    sectionOf.set(c.id, c.id);
    for (const d of descendants(tree, c.id)) sectionOf.set(d.id, c.id);
  }

  const order = [null, ...children.map((c) => c.id)];
  const byKey = new Map<string | null, BomSection>(
    order.map((key) => {
      const node = key ? tree.byId.get(key) : root;
      return [
        key,
        {
          projectId: key,
          title: key ? (node?.name ?? "") : `${root?.name ?? "This project"} (general)`,
          color: node?.color ?? null,
          lines: [],
        },
      ];
    }),
  );

  for (const l of lines) {
    if (!sectionOf.has(l.projectId)) continue; // not in this subtree (archived, or moved away)
    const key = sectionOf.get(l.projectId) ?? null;
    const subpath = key && l.projectId !== key ? pathOf(tree, l.projectId, key) : null;
    byKey.get(key)!.lines.push({ ...l, subpath });
  }
  const out = order.map((k) => byKey.get(k)!).filter((s) => opts.includeEmpty || s.lines.length > 0);
  for (const s of out) {
    s.lines.sort(
      (a, b) => (a.subpath ?? "").localeCompare(b.subpath ?? "") || a.position - b.position,
    );
  }
  return out;
}

/**
 * Moving a line into or out of Planned is a spending decision, so only a PVP
 * (src/lib/pvp.ts) may make it, normally by approving a purchase request.
 * Ordered <-> Received is bookkeeping anyone can do.
 */
export function statusChangeNeedsApprover(from: BomStatus, to: BomStatus): boolean {
  return from !== to && (from === "planned" || to === "planned");
}

// ---- Editing one field --------------------------------------------------------

export const BOM_FIELDS = [
  "name",
  "kind",
  "partNumber",
  "manufacturer",
  "unitCostCents",
  "quantity",
  "shippingCents",
  "realizedCents",
  "supplier",
  "url",
  "spare",
  "status",
  "orderedAt",
  "purchaserId",
  "purchaserName",
  "location",
  "notes",
  "taskNumber",
  "reimbursedElsewhere",
  "projectId",
] as const;

export type BomField = (typeof BOM_FIELDS)[number];

/** Field -> label, for the editor and the History sentence. */
export const BOM_FIELD_LABEL: Record<BomField, string> = {
  name: "name",
  kind: "kind",
  partNumber: "part number",
  manufacturer: "manufacturer",
  unitCostCents: "unit cost",
  quantity: "quantity",
  shippingCents: "shipping & tax",
  realizedCents: "realized cost",
  supplier: "supplier",
  url: "link",
  spare: "spare",
  status: "status",
  orderedAt: "order date",
  purchaserId: "purchaser",
  purchaserName: "purchaser",
  location: "location",
  notes: "notes",
  taskNumber: "task",
  reimbursedElsewhere: "reimbursed",
  projectId: "project",
};

export function isBomField(f: string): f is BomField {
  return (BOM_FIELDS as readonly string[]).includes(f);
}

const MAX_TEXT = 200;
const MAX_NOTES = 2000;
const MAX_URL = 2000;
const MAX_QUANTITY = 1_000_000;

export type BomValue = string | number | boolean | null;

/**
 * Parse a submitted value for one field. Blank clears it (null) except where a
 * value is required. Throws with a message fit to show the user.
 */
export function parseBomValue(field: BomField, raw: string): BomValue {
  const v = raw.trim();
  switch (field) {
    case "name":
      if (!v) throw new Error("Give the line a name.");
      if (v.length > MAX_TEXT) throw new Error(`Keep it under ${MAX_TEXT} characters.`);
      return v;
    case "kind":
      if (v !== "part" && v !== "allowance") throw new Error("Kind is part or allowance.");
      return v;
    case "status":
      if (!(BOM_STATUSES as readonly string[]).includes(v)) throw new Error("Unknown status.");
      return v;
    case "spare":
    case "reimbursedElsewhere":
      return v === "true" || v === "1" || v === "on" || v === "yes";
    case "unitCostCents":
    case "shippingCents":
    case "realizedCents": {
      if (!v) return null;
      const cents = parseMoney(v);
      if (cents === null) throw new Error("Enter an amount, like 12.34");
      return cents;
    }
    case "quantity": {
      if (!v) return null;
      if (!/^\d+(\.\d{1,3})?$/.test(v)) throw new Error("Quantity is a number, like 3 or 200 or 2.5");
      const n = Number(v);
      if (n <= 0 || n > MAX_QUANTITY) throw new Error(`Quantity is above 0 and at most ${MAX_QUANTITY.toLocaleString()}.`);
      return n;
    }
    case "url": {
      if (!v) return null;
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        throw new Error("Paste a full link, starting with https://");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("Paste a full link, starting with https://");
      if (v.length > MAX_URL) throw new Error("That link is too long.");
      return v;
    }
    case "orderedAt": {
      if (!v) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()))
        throw new Error("Pick a date.");
      return v;
    }
    case "taskNumber": {
      if (!v) return null;
      const m = /^#?(\d+)$/.exec(v);
      if (!m) throw new Error("Give a task number, like #412.");
      return Number(m[1]);
    }
    case "notes":
      if (v.length > MAX_NOTES) throw new Error(`Keep notes under ${MAX_NOTES} characters.`);
      return v || null;
    case "partNumber":
    case "manufacturer":
    case "supplier":
    case "purchaserName":
    case "location":
    case "purchaserId":
    case "projectId":
      if (v.length > MAX_TEXT) throw new Error(`Keep it under ${MAX_TEXT} characters.`);
      return v || null;
  }
}

/** A field's value as History shows it ("$12.34", "3", "—"). */
export function showBomValue(field: BomField, value: BomValue | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "unitCostCents" || field === "shippingCents" || field === "realizedCents")
    return formatCents(Number(value));
  if (field === "status") return BOM_STATUS_LABEL[value as BomStatus] ?? String(value);
  if (field === "taskNumber") return `#${value}`;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** "shop.fruitychutes.com" -- a long shop link, short enough for a table cell. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
