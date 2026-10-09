// Finance dates read in Berkeley time on the server and in every browser alike,
// so a server-rendered date never disagrees with the client's (hydration) and a
// receipt dated the 1st never shows as the 30th.
const TZ = "America/Los_Angeles";

/** "Oct 2, 2026" */
export const formatDay = (iso: string | Date) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" });

/** "Oct 2, 2026, 4:13 AM" */
export const formatWhen = (iso: string | Date) =>
  new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** A receipt date: ours are YYYY-MM-DD (a calendar day, no time); imported ones are as typed. */
export const formatItemDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatDay(`${s}T12:00:00-08:00`) : s || "—";
