/**
 * The connection badge's dot colour, label and tooltip — one copy, shared by
 * TopBar and MobileDashboard.
 *
 * This used to be a nested ternary duplicated verbatim in both components, which
 * is how the two would have drifted the moment a state was added. Everything it
 * reads is backend-observed (see backend connectionStatusPayload): the frontend
 * decides nothing here except which string to draw.
 */

export interface ConnectionBadgeInput {
  /** This socket is open. The one fact the client observes itself. */
  connected: boolean;
  /** Session-enabled deployment with no active run: the pipeline is down on
   *  purpose, so say so rather than raising an alarm. */
  sessionStopped: boolean;
  /** Backend-authoritative "we really are ingesting rows right now". */
  dataFresh: boolean;
  /** Incoming data is synthetic. */
  simulated: boolean;
  /** Backend is shedding resolution to keep this client current. */
  throttled?: boolean;
  /** Percentage of produced points this client received (0-100). */
  resolutionPct?: number;
  /** Age of the newest delivered sample at the last flush, ms. */
  lagMs?: number;
}

export interface ConnectionBadge {
  dotClass: string;
  label: string;
  title: string;
}

/**
 * Precedence matters and is asserted in tests:
 *
 *  - `throttled` ranks BELOW `!connected` and `!dataFresh`. A throttled feed is
 *    still live and trustworthy, just coarser — it must never hide a dead socket
 *    or a stopped pipeline.
 *  - `throttled` ranks ABOVE `simulated`/`Connected`, because an operator
 *    reading a decimated trace has to know it is decimated.
 *  - Orange, not yellow: yellow already means "Data Pipeline Down", and the two
 *    must not read as the same condition at a glance.
 */
export function connectionBadge(s: ConnectionBadgeInput): ConnectionBadge {
  if (!s.connected) {
    return { dotClass: 'bg-red-500', label: 'Disconnected', title: 'No WebSocket connection to the backend.' };
  }
  if (s.sessionStopped) {
    return { dotClass: 'bg-gray-500', label: 'Session Stopped', title: 'No run is active, so the pipeline is intentionally idle.' };
  }
  if (!s.dataFresh) {
    return { dotClass: 'bg-yellow-500', label: 'Data Pipeline Down', title: 'Connected, but the backend has not ingested data recently.' };
  }
  if (s.throttled) {
    const pct = Math.max(0, Math.min(100, Math.round(s.resolutionPct ?? 0)));
    const lagS = ((s.lagMs ?? 0) / 1000).toFixed(1);
    return {
      dotClass: 'bg-orange-500',
      label: `Throttled · ${pct}%`,
      // The last sentence is the operationally important one: it tells the
      // operator the trace is decimated but that a pressure spike is still on it.
      title: `Slow connection — showing ~${pct}% of samples, ${lagS} s behind. Peaks are preserved.`,
    };
  }
  if (s.simulated) {
    return { dotClass: 'bg-purple-500', label: 'Simulated Data', title: 'Incoming data is synthetic (board simulator).' };
  }
  return { dotClass: 'bg-green-500', label: 'Connected', title: 'Live data at full resolution.' };
}
