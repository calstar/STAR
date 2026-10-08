// STAR's CalLink account balances. CalLink shows an account's live balance on every
// request's detail (`financeAccount`), so the newest request on each account is a
// window onto it; the SUMMARY account (the STAR total) only appears on a few old
// requests, which is why the probes are remembered from the last full scrape.
// (No CalLink import here, so this stays testable without a browser.)

/** { accountId: requestId } — the newest request on each account in a scrape. */
export function accountProbes(records) {
  const newest = new Map();
  for (const r of records) {
    const a = r.detail?.financeAccount;
    if (!a || !Number.isInteger(a.id)) continue;
    const prev = newest.get(a.id);
    if (!prev || r.list.submittedOn > prev.submittedOn) newest.set(a.id, { id: r.list.id, submittedOn: r.list.submittedOn });
  }
  return Object.fromEntries([...newest].map(([acct, req]) => [acct, req.id]));
}
