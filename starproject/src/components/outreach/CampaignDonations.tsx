"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setPerkStatus } from "@/lib/actions/outreach";
import type { CampaignDetail } from "@/lib/outreach/queries";

import { dollars, shortDate } from "./format";
import { BTN_SMALL, CARD, MUTED, TD, TH } from "./ui";

/** The gifts, with a perk checklist: tick what's been mailed. */
export function CampaignDonations({ donations }: { donations: CampaignDetail["donations"] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [onlyPending, setOnlyPending] = useState(false);
  const rows = onlyPending ? donations.filter((d) => d.perkStatus === "pending") : donations;
  const mark = (ids: string[], status: "pending" | "sent") =>
    start(async () => {
      await setPerkStatus(ids, status);
      router.refresh();
    });
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 p-3 dark:border-neutral-800">
        <h3 className="font-semibold">Gifts</h3>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> Perks still to send
        </label>
      </div>
      {rows.length === 0 ? (
        <p className={`p-3 text-sm ${MUTED}`}>No gifts yet. Import the ScaleFunder export with this campaign selected.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Donor</th>
                <th className={`${TH} text-right`}>Amount</th>
                <th className={TH}>Date</th>
                <th className={TH}>Perk</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className={TD}>
                    <Link className="font-medium hover:text-blue-600" href={`/outreach/people/${d.contact.id}`}>
                      {d.contact.name || d.contact.email}
                    </Link>
                    {d.displayPref && d.displayPref !== "display" && <div className="text-xs text-amber-700">{d.displayPref.replace("_", " ")}</div>}
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>{dollars(d.amountCents)}</td>
                  <td className={`${TD} whitespace-nowrap`}>{shortDate(d.donatedAt)}</td>
                  <td className={TD}>
                    {d.perkName ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <span>{d.perkName}</span>
                        {!d.contact.hasAddress && d.perkStatus === "pending" && <span className="text-xs text-amber-700">no address</span>}
                        <button
                          className={BTN_SMALL}
                          disabled={pending}
                          onClick={() => mark([d.id], d.perkStatus === "sent" ? "pending" : "sent")}
                        >
                          {d.perkStatus === "sent" ? "✓ sent" : "mark sent"}
                        </button>
                      </div>
                    ) : (
                      <span className={MUTED}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
