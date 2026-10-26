// A mailing list is a saved filter over contacts (OutreachList.filter). The same
// filter runs two ways: as a Prisma `where` for the page, and in memory for the
// tests and for previews of rows not yet saved. Keep the two in step: the test
// file runs both shapes against the same cases.

import type { Prisma } from "@prisma/client";
import { z } from "zod";

export const segmentFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  tagsAny: z.array(z.string()).optional(),
  tagsAll: z.array(z.string()).optional(),
  tagsNone: z.array(z.string()).optional(),
  affiliations: z.array(z.string()).optional(),
  orgKinds: z.array(z.string()).optional(),
  /** Gave to this campaign (id), or to any when "any". */
  donatedTo: z.string().optional(),
  /** Did not give to this campaign (id). */
  notDonatedTo: z.string().optional(),
  /** Their org has a deal in one of these stages. */
  dealStages: z.array(z.string()).optional(),
  dealSeason: z.string().optional(),
  /** Off by default: a list never includes do-not-contact or bounced people. */
  includeExcluded: z.boolean().optional(),
});
export type SegmentFilter = z.infer<typeof segmentFilterSchema>;

const has = (a: string[] | undefined) => !!a && a.length > 0;

export function segmentWhere(f: SegmentFilter): Prisma.OutreachContactWhereInput {
  const and: Prisma.OutreachContactWhereInput[] = [];
  if (!f.includeExcluded) and.push({ doNotContact: false, bounced: false });
  if (f.search) {
    const q = f.search;
    and.push({
      OR: [
        { email: { contains: q, mode: "insensitive" } },
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { notes: { contains: q, mode: "insensitive" } },
        { org: { name: { contains: q, mode: "insensitive" } } },
      ],
    });
  }
  if (has(f.tagsAny)) and.push({ tags: { hasSome: f.tagsAny } });
  if (has(f.tagsAll)) and.push({ tags: { hasEvery: f.tagsAll } });
  if (has(f.tagsNone)) and.push({ NOT: { tags: { hasSome: f.tagsNone } } });
  if (has(f.affiliations)) and.push({ affiliation: { in: f.affiliations } });
  if (has(f.orgKinds)) and.push({ org: { kind: { in: f.orgKinds } } });
  if (f.donatedTo) and.push({ donations: { some: f.donatedTo === "any" ? {} : { campaignId: f.donatedTo } } });
  if (f.notDonatedTo) and.push({ donations: { none: { campaignId: f.notDonatedTo } } });
  if (has(f.dealStages)) {
    and.push({
      org: { deals: { some: { stage: { in: f.dealStages }, ...(f.dealSeason ? { season: f.dealSeason } : {}) } } },
    });
  }
  return and.length ? { AND: and } : {};
}

/** The fields the in-memory matcher reads. */
export type SegmentRow = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  notes: string | null;
  tags: string[];
  affiliation: string | null;
  doNotContact: boolean;
  bounced: boolean;
  org: { name: string; kind: string; deals: { stage: string; season: string }[] } | null;
  donationCampaignIds: (string | null)[];
};

export function matchesSegment(f: SegmentFilter, c: SegmentRow): boolean {
  if (!f.includeExcluded && (c.doNotContact || c.bounced)) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = [c.email, c.firstName, c.lastName, c.notes, c.org?.name].map((v) => (v ?? "").toLowerCase());
    if (!hay.some((h) => h.includes(q))) return false;
  }
  if (has(f.tagsAny) && !f.tagsAny!.some((t) => c.tags.includes(t))) return false;
  if (has(f.tagsAll) && !f.tagsAll!.every((t) => c.tags.includes(t))) return false;
  if (has(f.tagsNone) && f.tagsNone!.some((t) => c.tags.includes(t))) return false;
  if (has(f.affiliations) && !f.affiliations!.includes(c.affiliation ?? "")) return false;
  if (has(f.orgKinds) && !(c.org && f.orgKinds!.includes(c.org.kind))) return false;
  if (f.donatedTo) {
    const ok = f.donatedTo === "any" ? c.donationCampaignIds.length > 0 : c.donationCampaignIds.includes(f.donatedTo);
    if (!ok) return false;
  }
  if (f.notDonatedTo && c.donationCampaignIds.includes(f.notDonatedTo)) return false;
  if (has(f.dealStages)) {
    const deals = c.org?.deals ?? [];
    if (!deals.some((d) => f.dealStages!.includes(d.stage) && (!f.dealSeason || d.season === f.dealSeason)))
      return false;
  }
  return true;
}

/** A one-line description of a filter, for list cards. */
export function describeSegment(f: SegmentFilter, campaignName: (id: string) => string = (id) => id): string {
  const parts: string[] = [];
  if (f.search) parts.push(`matching "${f.search}"`);
  if (has(f.tagsAny)) parts.push(`tagged ${f.tagsAny!.join(" or ")}`);
  if (has(f.tagsAll)) parts.push(`tagged ${f.tagsAll!.join(" and ")}`);
  if (has(f.tagsNone)) parts.push(`not tagged ${f.tagsNone!.join(", ")}`);
  if (has(f.affiliations)) parts.push(f.affiliations!.join(" / "));
  if (has(f.orgKinds)) parts.push(`at a ${f.orgKinds!.join(" / ")}`);
  if (f.donatedTo) parts.push(f.donatedTo === "any" ? "who have given" : `who gave to ${campaignName(f.donatedTo)}`);
  if (f.notDonatedTo) parts.push(`who haven't given to ${campaignName(f.notDonatedTo)}`);
  if (has(f.dealStages)) parts.push(`sponsor ${f.dealStages!.join(" / ")}${f.dealSeason ? ` (${f.dealSeason})` : ""}`);
  if (f.includeExcluded) parts.push("including do-not-contact");
  return parts.length ? `Everyone ${parts.join(", ")}` : "Everyone";
}
