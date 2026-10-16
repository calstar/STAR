import Link from "next/link";

import { PAGE_CONTAINER } from "@/components/EntityRow";
import { ReimbursementForm, type ReimbursementPrefill } from "@/components/finance/ReimbursementForm";
import { predictedCents } from "@/lib/bom";
import { BOM_INCLUDE, toBomLine } from "@/lib/bom-data";
import { prisma } from "@/lib/db";
import { centsToPlain } from "@/lib/finance/money";
import { getProfileDefaults } from "@/lib/finance/queries";
import { MAX_ITEMS } from "@/lib/finance/schema";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

/**
 * The form's items filled in from BOM lines (`?bom=<id>,<id>`, the BOM tab's
 * "File reimbursement"): one item per line, at what was paid if it was entered,
 * else the predicted cost.
 */
async function prefillFromBom(ids: string[]): Promise<ReimbursementPrefill | undefined> {
  if (ids.length === 0) return undefined;
  const rows = await prisma.bomItem.findMany({
    where: { id: { in: ids.slice(0, MAX_ITEMS) } },
    include: { ...BOM_INCLUDE, project: { select: { name: true } } },
    orderBy: { position: "asc" },
  });
  if (rows.length === 0) return undefined;
  const suppliers = [...new Set(rows.map((r) => r.supplier).filter(Boolean))];
  const project = rows[0].project.name;
  return {
    subject: `${project} parts${suppliers.length ? ` (${suppliers.join(", ")})` : ""}`.slice(0, 150),
    items: rows.map((r) => {
      const l = toBomLine(r);
      return {
        date: l.orderedAt ?? "",
        vendor: l.supplier ?? "",
        amount: centsToPlain(l.realizedCents ?? predictedCents(l)),
        comment: [l.name, l.partNumber].filter(Boolean).join(", ").slice(0, 500),
      };
    }),
    bomItemIds: rows.map((r) => r.id),
  };
}

export default async function NewReimbursementPage({
  searchParams,
}: {
  searchParams: Promise<{ bom?: string }>;
}) {
  const user = await getCurrentDbUser();
  const { bom } = await searchParams;
  const [profile, prefill] = await Promise.all([
    getProfileDefaults(user),
    prefillFromBom((bom ?? "").split(",").filter(Boolean)),
  ]);

  return (
    <main className={PAGE_CONTAINER}>
      <div className="mx-auto max-w-3xl">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        <Link href="/finance" className="hover:underline">
          Finance
        </Link>{" "}
        / New reimbursement
      </p>
      <h1 className="mt-2 text-2xl font-semibold">New reimbursement</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        An admin reviews it, then it is filed on CalLink for you. Up to six receipts per request.
      </p>
      <ReimbursementForm
        defaults={profile.values}
        seededFrom={profile.seededFrom}
        accountEmail={user.email}
        prefill={prefill}
      />
      </div>
    </main>
  );
}
