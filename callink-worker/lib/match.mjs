// After a filing, CalLink redirects to its list without saying which request it made.
// Find it there. STARProject's subjects end in a [STAR R-n] tag, so its match is exact.

/**
 * @param rows   CalLink list rows, newest first ({id, requestNumber, name, submittedAmount, submittedOn})
 * @param want   {subject, totalCents, since} - since: when we started filing (Date)
 * @returns the one row that is ours, or null when there is not exactly one.
 */
export function findNewRequest(rows, { subject, totalCents, since }) {
  // CalLink's list stamps Eastern time as UTC ("07:59:59+00:00" for a request filed at
  // 12:00Z), so its times run hours early. The subject (tagged) does the matching; the
  // time only has to rule out old requests.
  const earliest = since.getTime() - 24 * 3600_000;
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
