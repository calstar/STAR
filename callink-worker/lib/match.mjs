// After a filing, CalLink redirects to its list without saying which request it made.
// Find it there. STARProject's subjects end in a [STAR R-n] tag, so its match is exact.

/**
 * @param rows   CalLink list rows, newest first ({id, requestNumber, name, submittedAmount, submittedOn})
 * @param want   {subject, totalCents, since} - since: when we started filing (Date)
 * @returns the one row that is ours, or null when there is not exactly one.
 */
export function findNewRequest(rows, { subject, totalCents, since }) {
  const earliest = since.getTime() - 2 * 60_000; // clock skew between us and CalLink
  const hits = rows.filter(r =>
    typeof r.name === 'string' && r.name.trim() === subject.trim()
    && Math.round(Number(r.submittedAmount) * 100) === totalCents
    && new Date(r.submittedOn).getTime() >= earliest);
  return hits.length === 1 ? hits[0] : null;
}

/** Any request on CalLink carrying this tag, whenever it was filed. */
export function findByTag(rows, tag) {
  return rows.filter(r => typeof r.name === 'string' && r.name.trim().endsWith(tag));
}
