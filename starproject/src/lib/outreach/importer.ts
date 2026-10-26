// Turning the outreach team's spreadsheets into contacts, donations and sponsor
// deals. Pure: the Import page hands the pasted text here, shows the plan it
// returns (new / merged / rejected / flagged), and only then the action writes
// it (actions/outreach.ts commitImport). Columns are found by header, not by
// position, and the header row need not be the first (the Current Sponsors
// sheet has four rows of banner above it).
//
// Presets, each matching a sheet the team actually keeps:
//   contacts     any sheet with an email column (Alumni, Friends & Family, ...)
//   member_list  NAME | EMAILS, where NAME is the STAR member who supplied the
//                contact and is only written on the first row of their block
//   scalefunder  the campus crowdfunding "fulfill" export (sf_id, amount, perk_name, ...)
//   sponsors     the Current Sponsors List master sheet

import { parseMoney } from "@/lib/finance/money";

import { AFFILIATIONS, type Affiliation, type DealStage, type DealType, type OrgKind } from "./constants";
import { checkEmail, splitEmails } from "./emails";

export const IMPORT_PRESETS = ["auto", "contacts", "member_list", "scalefunder", "sponsors"] as const;
export type ImportPreset = (typeof IMPORT_PRESETS)[number];
export type ResolvedPreset = Exclude<ImportPreset, "auto">;

export const PRESET_LABEL: Record<ImportPreset, string> = {
  auto: "Detect from the headers",
  contacts: "Contact list (any sheet with an Email column)",
  member_list: "Member contact list (NAME | EMAILS, ambassador per block)",
  scalefunder: "ScaleFunder donations export",
  sponsors: "Current Sponsors List (master sheet)",
};

export type ImportOptions = {
  preset: ImportPreset;
  /** Tags put on every contact in this import ("crowdfunding-2026", "alumni"). */
  tags: string[];
  /** Affiliation for contacts whose row doesn't say. */
  affiliation: Affiliation | null;
  /** Campaign the donations / referrals belong to (its id; resolved by the action). */
  campaignId: string | null;
  /** Season the sponsor deals are for ("2026–27"). */
  season: string;
  /** Accept the suggested fix for a mistyped domain (berkeley.efu → berkeley.edu). */
  applyFixes: boolean;
  /** Free text recorded as each new contact's source. */
  source: string;
};

export type ContactDraft = {
  email: string | null;
  altEmails: string[];
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  affiliation: Affiliation | null;
  tags: string[];
  orgName: string | null;
  notes: string | null;
  /** Who brought them in: STAR members, by email when known, else by name. */
  ambassadors: { email: string | null; name: string | null }[];
  /** Spreadsheet rows (1-based) this draft came from, for the preview. */
  rows: number[];
};

export type DonationDraft = {
  email: string;
  amountCents: number;
  donatedAt: string; // ISO
  perkName: string | null;
  displayPref: string | null;
  ambassadorEmail: string | null;
  externalRef: string;
};

export type DealDraft = {
  orgName: string;
  orgKind: OrgKind;
  type: DealType;
  stage: DealStage;
  renewal: boolean;
  project: string | null;
  responsibleEngineer: string | null;
  theirDeliverables: string | null;
  ourDeliverables: string | null;
  valueCents: number | null;
  notes: string | null;
};

export type ImportPlan = {
  preset: ResolvedPreset;
  headerRow: number; // 1-based, 0 when there is none
  contacts: ContactDraft[];
  donations: DonationDraft[];
  deals: DealDraft[];
  rejected: { row: number; reason: string }[];
  flagged: { row: number; email: string; suggestion: string; applied: boolean }[];
  /** Addresses that appeared on more than one row and were merged. */
  merged: number;
};

// ---- headers ---------------------------------------------------------------

type Field =
  | "email"
  | "altEmail"
  | "emails"
  | "firstName"
  | "lastName"
  | "fullName"
  | "title"
  | "phone"
  | "address"
  | "address2"
  | "city"
  | "state"
  | "zip"
  | "country"
  | "affiliation"
  | "tags"
  | "org"
  | "notes"
  | "ambassador"
  | "ambassadorFirst"
  | "ambassadorLast"
  | "ambassadorEmail"
  | "amount"
  | "date"
  | "perk"
  | "display"
  | "sfId"
  | "serviceRef"
  | "sponsorType"
  | "project"
  | "engineer"
  | "contact"
  | "theirs"
  | "ours"
  | "status"
  | "info";

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Header text (normalized) → field. Order matters only within a preset's
// columns: the first header that maps to a field wins.
const ALIASES: Record<string, Field> = {
  email: "email",
  "email address": "email",
  "e mail": "email",
  "primary email": "email",
  "alternate email address": "altEmail",
  "alternate email": "altEmail",
  "alt email": "altEmail",
  "secondary email": "altEmail",
  emails: "emails",
  "first name": "firstName",
  "first name s": "firstName",
  first: "firstName",
  "last name": "lastName",
  last: "lastName",
  surname: "lastName",
  "full name": "fullName",
  title: "title",
  role: "title",
  phone: "phone",
  "phone number": "phone",
  address: "address",
  "street address": "address",
  address2: "address2",
  "address 2": "address2",
  city: "city",
  state: "state",
  zip: "zip",
  zipcode: "zip",
  "zip code": "zip",
  "postal code": "zip",
  country: "country",
  affiliation: "affiliation",
  "affiliation current": "affiliation",
  tags: "tags",
  segment: "tags",
  company: "org",
  organization: "org",
  org: "org",
  employer: "org",
  notes: "notes",
  note: "notes",
  comments: "notes",
  "referred by": "ambassador",
  ambassador: "ambassador",
  "contact first name": "ambassadorFirst",
  "contact last name": "ambassadorLast",
  "ambassador first name": "ambassadorFirst",
  "ambassador last name": "ambassadorLast",
  "ambassador email": "ambassadorEmail",
  amount: "amount",
  "date created": "date",
  date: "date",
  "perk name": "perk",
  "donor display": "display",
  "sf id": "sfId",
  "service ref": "serviceRef",
  "sponsorship type": "sponsorType",
  project: "project",
  "res engineer": "engineer",
  "responsible engineer": "engineer",
  contact: "contact",
  "their deliverables": "theirs",
  "our deliverables": "ours",
  status: "status",
  satus: "status",
  "addt info": "info",
  "additional info": "info",
};

// ScaleFunder's own snake_case names normalize to the same keys as above
// ("first_name" → "first name", "proj_name" is ignored, "zipcode" maps).

type Columns = Partial<Record<Field, number>>;

function mapHeader(row: string[]): Columns {
  const cols: Columns = {};
  row.forEach((h, i) => {
    const f = ALIASES[norm(h)];
    if (f && cols[f] === undefined) cols[f] = i;
  });
  // A sheet whose only person column is "Name": a full name, unless it is the
  // member-list layout (NAME | EMAILS), where Name is the ambassador.
  const nameIdx = row.findIndex((h) => norm(h) === "name");
  if (nameIdx >= 0) {
    if (cols.emails !== undefined && cols.email === undefined) cols.ambassador ??= nameIdx;
    else if (cols.sponsorType !== undefined || cols.contact !== undefined) cols.org ??= nameIdx;
    else cols.fullName ??= nameIdx;
  }
  return cols;
}

/** The first of the top rows that looks like a header (two or more known columns). */
function findHeader(rows: string[][]): { index: number; cols: Columns } | null {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cols = mapHeader(rows[i]);
    if (Object.keys(cols).length >= 2) return { index: i, cols };
  }
  return null;
}

export function detectPreset(cols: Columns): ResolvedPreset {
  if (cols.sfId !== undefined || (cols.amount !== undefined && cols.perk !== undefined)) return "scalefunder";
  if (cols.sponsorType !== undefined || (cols.contact !== undefined && cols.theirs !== undefined)) return "sponsors";
  if (cols.emails !== undefined && cols.email === undefined) return "member_list";
  return "contacts";
}

// ---- helpers ---------------------------------------------------------------

const cell = (row: string[], i: number | undefined) => (i === undefined ? "" : (row[i] ?? "").trim());
const orNull = (s: string) => (s ? s : null);

function splitName(full: string): { first: string | null; last: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  // "B… and J… Smith": a couple keeps the whole front as the first name.
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

function asAffiliation(s: string): Affiliation | null {
  const v = s.toLowerCase();
  if (!v) return null;
  if (v.startsWith("alum")) return "alumni";
  if (v.includes("parent") || v.includes("family")) return "family";
  if (v.includes("faculty") || v.includes("staff") || v.includes("professor")) return "faculty";
  if (v.includes("student")) return "student";
  if (v.includes("friend")) return "friend";
  return (AFFILIATIONS as readonly string[]).includes(v) ? (v as Affiliation) : "other";
}

export function parseTags(s: string): string[] {
  return [
    ...new Set(
      s
        .split(/[,;|]/)
        .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
        .filter(Boolean),
    ),
  ];
}

/** "2025-10-14 09:12:00", "10/14/2025", "Oct 14, 2025" → ISO, or null. */
export function parseDate(s: string): string | null {
  if (!s) return null;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    const y = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const d = new Date(Date.UTC(y, Number(us[1]) - 1, Number(us[2])));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s.includes(" ") && /^\d{4}-/.test(s) ? s.replace(" ", "T") + "Z" : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sponsorType(s: string): DealType {
  const v = s.toLowerCase();
  if (v.startsWith("discount")) return "discount";
  if (v.startsWith("monet") || v.includes("cash")) return "monetary";
  if (v.includes("service") || v.includes("license")) return "services";
  return "in_kind";
}

function emptyContact(): ContactDraft {
  return {
    email: null,
    altEmails: [],
    firstName: null,
    lastName: null,
    title: null,
    phone: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    country: null,
    affiliation: null,
    tags: [],
    orgName: null,
    notes: null,
    ambassadors: [],
    rows: [],
  };
}

/** Fold `b` into `a`: a's values win, lists are unioned. */
export function mergeContact(a: ContactDraft, b: ContactDraft): ContactDraft {
  const pick = <K extends keyof ContactDraft>(k: K) => (a[k] ?? b[k]) as ContactDraft[K];
  const amb = [...a.ambassadors];
  for (const x of b.ambassadors) {
    if (!amb.some((y) => (y.email ?? y.name) === (x.email ?? x.name))) amb.push(x);
  }
  return {
    email: a.email ?? b.email,
    altEmails: [...new Set([...a.altEmails, ...b.altEmails])].filter((e) => e !== (a.email ?? b.email)),
    firstName: pick("firstName"),
    lastName: pick("lastName"),
    title: pick("title"),
    phone: pick("phone"),
    address: pick("address"),
    city: pick("city"),
    state: pick("state"),
    zip: pick("zip"),
    country: pick("country"),
    affiliation: pick("affiliation"),
    tags: [...new Set([...a.tags, ...b.tags])],
    orgName: pick("orgName"),
    notes: a.notes && b.notes && a.notes !== b.notes ? `${a.notes}\n${b.notes}` : pick("notes"),
    ambassadors: amb,
    rows: [...a.rows, ...b.rows],
  };
}

// ---- the plan --------------------------------------------------------------

export function planImport(rows: string[][], options: ImportOptions): ImportPlan {
  const header = findHeader(rows);
  const cols = header?.cols ?? {};
  const preset: ResolvedPreset = options.preset === "auto" ? detectPreset(cols) : options.preset;
  const plan: ImportPlan = {
    preset,
    headerRow: header ? header.index + 1 : 0,
    contacts: [],
    donations: [],
    deals: [],
    rejected: [],
    flagged: [],
    merged: 0,
  };
  if (!header) {
    plan.rejected.push({ row: 0, reason: "No header row found: the sheet needs a column named Email (or Emails)." });
    return plan;
  }

  const byEmail = new Map<string, ContactDraft>();
  const nameOnly: ContactDraft[] = [];
  const add = (c: ContactDraft) => {
    if (!c.email) {
      nameOnly.push(c);
      return;
    }
    const prev = byEmail.get(c.email);
    if (prev) {
      plan.merged++;
      byEmail.set(c.email, mergeContact(prev, c));
    } else byEmail.set(c.email, c);
  };

  /** A cell → a usable address, recording a rejection or a typo flag. */
  const take = (raw: string, rowNo: number, required: boolean): string | null => {
    const chk = checkEmail(raw);
    if (!chk.ok) {
      if (required && chk.reason !== "empty") plan.rejected.push({ row: rowNo, reason: chk.reason });
      else if (required) plan.rejected.push({ row: rowNo, reason: "no email" });
      return null;
    }
    if (chk.suggestion) {
      plan.flagged.push({ row: rowNo, email: chk.email, suggestion: chk.suggestion, applied: options.applyFixes });
      return options.applyFixes ? chk.suggestion : chk.email;
    }
    return chk.email;
  };

  const baseTags = options.tags;
  let lastAmbassador = "";

  for (let i = header.index + 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = i + 1;
    if (!row.some((v) => v.trim())) continue;

    if (preset === "sponsors") {
      const org = cell(row, cols.org);
      if (!org || norm(org) === "name") continue;
      const status = cell(row, cols.status).toLowerCase();
      const theirs = cell(row, cols.theirs);
      const info = cell(row, cols.info);
      const contactCell = cell(row, cols.contact);
      const emails = splitEmails(contactCell);
      const allCampus = emails.length > 0 && emails.every((e) => e.endsWith("berkeley.edu"));
      const kind: OrgKind = allCampus ? "campus" : "company";
      const ghosted = /gh[os]{2}t/i.test(info); // "ghosted", and the sheet's "ghsoted"
      plan.deals.push({
        orgName: org,
        orgKind: kind,
        type: sponsorType(cell(row, cols.sponsorType)),
        // "Current" on last season's sheet means a renewal to ask for this
        // season; "Planned" is a prospect we never closed.
        stage: ghosted ? "ghosted" : "prospect",
        renewal: status === "current",
        project: orNull(cell(row, cols.project)),
        responsibleEngineer: orNull(cell(row, cols.engineer)),
        theirDeliverables: orNull(theirs),
        ourDeliverables: orNull(cell(row, cols.ours)),
        valueCents: parseMoney(theirs),
        notes: orNull([info, !emails.length && contactCell ? `Contact: ${contactCell}` : ""].filter(Boolean).join("\n")),
      });
      for (const e of emails) {
        const email = take(e, rowNo, false);
        if (!email) continue;
        add({ ...emptyContact(), email, orgName: org, affiliation: "industry", tags: [...baseTags, "sponsor-contact"], rows: [rowNo] });
      }
      continue;
    }

    if (preset === "member_list") {
      const amb = cell(row, cols.ambassador);
      if (amb) lastAmbassador = amb;
      const raw = cell(row, cols.emails);
      if (!raw) continue; // the blank rows of a member's block of five
      const emails = splitEmails(raw);
      if (!emails.length) {
        plan.rejected.push({ row: rowNo, reason: `not an address: "${raw}"` });
        continue;
      }
      for (const e of emails) {
        const email = take(e, rowNo, true);
        if (!email) continue;
        add({
          ...emptyContact(),
          email,
          affiliation: options.affiliation,
          tags: [...baseTags],
          ambassadors: lastAmbassador ? [{ email: null, name: lastAmbassador }] : [],
          rows: [rowNo],
        });
      }
      continue;
    }

    // contacts and scalefunder share the person columns.
    const rawEmail = cell(row, cols.email);
    const email = take(rawEmail, rowNo, preset === "scalefunder" || (!cell(row, cols.fullName) && !cell(row, cols.firstName)));
    let first = orNull(cell(row, cols.firstName));
    let last = orNull(cell(row, cols.lastName));
    if (!first && !last && cols.fullName !== undefined) {
      const n = splitName(cell(row, cols.fullName));
      first = n.first;
      last = n.last;
    }
    if (!email && !first && !last) continue;
    const alt = splitEmails(cell(row, cols.altEmail)).filter((e) => e !== email);
    const ambEmail = splitEmails(cell(row, cols.ambassadorEmail))[0] ?? null;
    const ambName =
      [cell(row, cols.ambassadorFirst), cell(row, cols.ambassadorLast)].filter(Boolean).join(" ") || cell(row, cols.ambassador);
    // ScaleFunder credits the campus office when no member is named.
    const realAmbassador = ambName && !/cal student philanthropy/i.test(ambName) ? ambName : "";
    const address = [cell(row, cols.address), cell(row, cols.address2)].filter(Boolean).join(", ");
    const draft: ContactDraft = {
      ...emptyContact(),
      email,
      altEmails: alt,
      firstName: first,
      lastName: last,
      title: orNull(cell(row, cols.title)),
      phone: orNull(cell(row, cols.phone)),
      address: orNull(address),
      city: orNull(cell(row, cols.city)),
      state: orNull(cell(row, cols.state)),
      zip: orNull(cell(row, cols.zip)),
      country: orNull(cell(row, cols.country)),
      affiliation: asAffiliation(cell(row, cols.affiliation)) ?? options.affiliation,
      tags: [...new Set([...baseTags, ...parseTags(cell(row, cols.tags))])],
      orgName: orNull(cell(row, cols.org)),
      notes: orNull(cell(row, cols.notes)),
      ambassadors: ambEmail || realAmbassador ? [{ email: ambEmail, name: orNull(realAmbassador) }] : [],
      rows: [rowNo],
    };

    if (preset === "scalefunder") {
      if (!email) continue; // rejected above
      const amount = parseMoney(cell(row, cols.amount));
      const date = parseDate(cell(row, cols.date));
      if (amount == null || !date) {
        plan.rejected.push({ row: rowNo, reason: amount == null ? "no amount" : "no date" });
        continue;
      }
      draft.tags = [...new Set([...draft.tags, "donor"])];
      plan.donations.push({
        email,
        amountCents: amount,
        donatedAt: date,
        perkName: orNull(cell(row, cols.perk)),
        displayPref: orNull(cell(row, cols.display)),
        ambassadorEmail: ambEmail,
        externalRef:
          cell(row, cols.sfId) || cell(row, cols.serviceRef) || `${email}|${date.slice(0, 10)}|${amount}`,
      });
    }
    add(draft);
  }

  plan.contacts = [...byEmail.values(), ...nameOnly];
  return plan;
}

/** Counts for the preview header. */
export function planSummary(plan: ImportPlan) {
  return {
    contacts: plan.contacts.length,
    withEmail: plan.contacts.filter((c) => c.email).length,
    donations: plan.donations.length,
    donationCents: plan.donations.reduce((s, d) => s + d.amountCents, 0),
    deals: plan.deals.length,
    rejected: plan.rejected.length,
    flagged: plan.flagged.length,
    merged: plan.merged,
  };
}
