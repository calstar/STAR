/**
 * The rows of the config editor's Pressure Limits section, derived from the config's CURRENT
 * pressure sensors rather than from whatever [pressure_limits.*] keys the file happens to hold.
 *
 * The section used to list Object.keys(config.pressure_limits): names written for an older stand,
 * with no way to add one for a new PT, so a renamed or added PT had no limits row at all and its
 * gauge silently used generic thresholds. Now every PT role has a row (key = the role with spaces
 * as underscores, the convention the gauge picker links by), whether or not the file has an entry
 * for it yet; typing a value creates it.
 */

/** [pressure_limits] key for a PT role: "GN2 High" -> "GN2_High". */
export const pressureLimitKeyForRole = (role: string): string => role.trim().replace(/\s+/g, '_');

export type PressureLimitRow = {
  /** [pressure_limits.<key>] */
  key: string;
  /** What the row is called in the editor. */
  label: string;
  /**
   * pt:     a current PT role's own limits
   * gauge:  not a PT's own key, but a top-bar gauge points at it (e.g. "Chamber", shared by the
   *         chamber gauge that averages several PTs)
   * orphan: in the file, but no current PT and no gauge uses it (left from an older config)
   */
  kind: 'pt' | 'gauge' | 'orphan';
  /** The file has an entry for it already. */
  defined: boolean;
  /** Labels of the top-bar gauges that use this key. */
  gauges: string[];
};

/** PT-board role names, from each PT board's [sensor_roles_<boardKey>]. */
export function pressureRolesOf(config: any): string[] {
  const boards: Record<string, any> = config?.boards ?? {};
  return Array.from(new Set(
    Object.entries(boards)
      .filter(([, b]) => b?.type === 'PT')
      .flatMap(([boardKey]) => Object.keys(config?.[`sensor_roles_${boardKey}`] ?? {})),
  )).sort();
}

export function pressureLimitRows(config: any): PressureLimitRow[] {
  const limits: Record<string, unknown> = config?.pressure_limits ?? {};
  const bars: any[] = Array.isArray(config?.gui?.pressure_bars) ? config.gui.pressure_bars : [];
  const gaugesUsing = (key: string) =>
    bars.filter((b) => b?.limits === key).map((b) => String(b?.label || b?.role || key));

  const rows: PressureLimitRow[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string, kind: PressureLimitRow['kind']) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    rows.push({ key, label, kind, defined: key in limits, gauges: gaugesUsing(key) });
  };

  for (const role of pressureRolesOf(config)) push(pressureLimitKeyForRole(role), role, 'pt');
  for (const b of bars) if (typeof b?.limits === 'string') push(b.limits, b.limits, 'gauge');
  for (const key of Object.keys(limits).sort()) push(key, key, 'orphan');
  return rows;
}
