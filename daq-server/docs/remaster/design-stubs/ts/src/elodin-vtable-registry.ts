/**
 * elodin-vtable-registry — DELTA ONLY of the existing registry (the backend's Elodin
 * subscription state and passes). WP5 commit 5.7 (LEDGER D42(d), research
 * `subscription-robustness.md` Idea 5) extracts the "which pairs are due" decision from
 * `subscribeVTables` (`elodin-vtable-registry.ts:386-401`) as a pure function. Nothing else in
 * the registry changes: the fence, the batch cap, the logging, `notePairDelivered`,
 * `noteSubscriptionRejected`, `clearSubscriptionState`, the generation guard.
 *
 * Must not know about: WebSocket, board status, the server modules. Pure: no clock (the caller
 * passes `now`, taken once from `nowFn()` as today), no I/O, no logging, no mutation of `state`.
 *
 * Guarded by the existing, unedited `__tests__/vtable-subscriptions.test.ts`,
 * `subscription-fence.test.ts`, `elodin-reconnect.test.ts`; mutation: drop the `subscribed`
 * clause → `vtable-subscriptions.test.ts` red. `test/test_duplicate_subscription.ts` (C6-2
 * reproducer, parked by WP4, D42(e)) is not touched.
 *
 * Future (PROPOSALS only, D-SUB / D-ECHO): a `stale-bound` or `no-delivery` clause is one more
 * line here plus one unit test, instead of an edit to the 120-line I/O pass.
 */

/** A subscription pair `[high, low]` as the subscription list builds it. */
export type VTablePair = [number, number];

/** The registry's observed state, read-only, as `duePairs` needs it. Keys are `"<high>,<low>"`. */
export interface PairState {
  /** Pairs sent and not refused since the last disconnect. */
  readonly subscribed: ReadonlySet<string>;
  /** Pairs that exhausted `MAX_PAIR_ATTEMPTS`. */
  readonly parked: ReadonlySet<string>;
  /** Refused pairs with their backoff deadline. */
  readonly rejected: ReadonlyMap<string, { attempts: number; nextAttemptMs: number }>;
}

/**
 * Split the desired pairs into those due this pass and a count of those skipped.
 *
 * Today's three clauses, in today's order: subscribed or parked → skipped; refused with
 * `nextAttemptMs > now` → skipped; otherwise due. `due` keeps `desired`'s order (the batch is
 * its first `SUBSCRIPTION_REQ_ID_SPACE` entries, as today). `skipped` feeds the
 * `📡 VTableStream: sent N new, skipped M …` log line unchanged (STYLE-S15).
 */
export function duePairs(
  desired: ReadonlyArray<VTablePair>,
  state: PairState,
  now: number,
): { due: VTablePair[]; skipped: number } {
  throw new Error('stub');
}
