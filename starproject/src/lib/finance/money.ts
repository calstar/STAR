// Money is integer cents everywhere. CalLink and members type amounts as text
// ("505.51", "$505.51", "1,411.09"), and floats would drift when items are summed.

/** "$1,411.09" → 141109. Anything that is not an amount ("N/A", "£78.57", "") → null. */
export function parseMoney(text: string | null | undefined): number | null {
  const s = String(text ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** 141109 → "$1,411.09". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** 141109 → "1411.09", the plain form CalLink's fields take. */
export function centsToPlain(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Sum of the amounts that parsed; unparseable ones count as nothing. */
export function sumCents(amounts: (number | null | undefined)[]): number {
  return amounts.reduce<number>((s, c) => s + (c ?? 0), 0);
}
