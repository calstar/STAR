// Is this the same organization under another name? The sponsor sheet says
// "Dassault Systems" and "MJG", the task board "Dassault Systemes / SolidWorks"
// and "MJG Technologies / electricmatch". Pure, so the rules can be tested.

const STOP = new Set(["inc", "llc", "corp", "corporation", "co", "company", "the", "ltd"]);

export function normalizeOrg(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w))
    .join(" ");
}

/** The names an org goes by: the whole name, and each side of a "/" ("Onshape / PTC"). */
export function orgAliases(name: string): string[] {
  const parts = [name, ...name.split("/")].map(normalizeOrg).filter(Boolean);
  return [...new Set(parts)];
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** One alias starts the other's words ("mjg" / "mjg technologies"), or they differ by a typo or two. */
function close(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.startsWith(`${short} `) && short.length >= 3) return true;
  return short.length >= 8 && distance(a, b) <= 2;
}

export function sameOrg(a: string, b: string): boolean {
  const as = orgAliases(a);
  const bs = orgAliases(b);
  return as.some((x) => bs.some((y) => close(x, y)));
}
