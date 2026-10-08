"use client";

import { useRouter } from "next/navigation";

import { schoolYearLabel } from "@/lib/finance/ledger";

export function YearPicker({ year, years }: { year: number; years: number[] }) {
  const router = useRouter();
  return (
    <select
      aria-label="School year"
      value={year}
      onChange={(e) => router.push(`/finance?year=${e.target.value}`)}
      className="min-h-11 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm sm:min-h-0"
    >
      {years.map((y) => (
        <option key={y} value={y}>
          {schoolYearLabel(y)}
        </option>
      ))}
    </select>
  );
}
