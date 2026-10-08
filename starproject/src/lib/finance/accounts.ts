// The CalLink accounts callink-worker reports. CalLink shows an account's live
// balance on every request's detail (`financeAccount`); the worker reads the newest
// request on each account it knows and sends what it saw.

export type CallinkAccount = {
  callinkAccountId: number;
  name: string;
  balanceCents: number;
  availableCents: number | null;
  deleted: boolean;
};

const MAX_ACCOUNTS = 50;
// No STAR account holds ten million dollars; anything bigger is a misread.
const MAX_BALANCE_CENTS = 1_000_000_000;

const cents = (v: unknown): number | null => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const c = Math.round(v * 100);
  return Math.abs(c) <= MAX_BALANCE_CENTS ? c : null;
};

/** CalLink's `financeAccount` objects → accounts, or the reason the batch is refused. */
export function parseCallinkAccounts(raw: unknown): CallinkAccount[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "accounts must be a non-empty list";
  if (raw.length > MAX_ACCOUNTS) return `send at most ${MAX_ACCOUNTS} accounts`;
  const out: CallinkAccount[] = [];
  for (const a of raw as Record<string, unknown>[]) {
    const balance = cents(a?.balance);
    if (!a || !Number.isInteger(a.id) || typeof a.name !== "string" || !a.name.trim() || balance == null) {
      return "each account needs an integer id, a name and a numeric balance";
    }
    out.push({
      callinkAccountId: a.id as number,
      name: a.name.trim().slice(0, 200),
      balanceCents: balance,
      availableCents: cents(a.availableFunds),
      deleted: a.deleted === true,
    });
  }
  return out;
}
