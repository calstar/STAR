// Display helpers shared by the outreach client components (no Prisma here).

export { formatCents } from "@/lib/finance/money";

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const days = Math.round((now - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  if (days < 0) return `in ${-days} days`;
  if (days < 60) return `${days} days ago`;
  return shortDate(iso);
}

/** "$3,000" for whole dollars, "$12.50" otherwise. */
export function dollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const whole = cents % 100 === 0;
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

export const titleCase = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
