/**
 * Single source of truth for the app's navigable views.
 *
 * Drives the tab bar (common items inline), the "All Views" page (every item),
 * the popup button (canonical path per view), and the legacy `/window/:view`
 * redirect (id → canonical path). Previously this information was split across
 * `WindowLauncher.multiEntries` and the `windowViews` registry in `pages.tsx`.
 *
 * `id` matches the historical `/window/<id>` key so old popup URLs / operator
 * bookmarks can be redirected to `path`. Reorder freely — the tab bar renders
 * in array order, and `common` controls inline-vs-overflow.
 */
export interface NavItem {
  /** Historical window key (kept for `/window/:view` redirects). */
  id: string;
  /** Display label in the tab bar / All Views grid. */
  name: string;
  /** Canonical route. This is what the tab links to and the popup opens. */
  path: string;
  /** One-line description shown on the All Views grid. */
  description: string;
  /** Accent colour (left rail on cards, tab indicator). */
  accent: string;
  /** Inline in the tab bar when true; only under All Views when false. */
  common?: boolean;
  /** Retired view — kept reachable only under the All Views "Deprecated" section. */
  deprecated?: boolean;
}

/**
 * Single Pane is pinned first — it is by far the most-used view.
 * The `common` flags below are a sensible starting split; reorder / retag at will.
 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'unified', name: 'Single Pane', path: '/single-pane', accent: '#EC4899', common: true,
    description: 'State machine · Pressure graphs · Actuators · Controller all in one window' },

  { id: 'fuel', name: 'Fuel', path: '/fuel', accent: '#3498DB', common: true,
    description: 'Upstream / downstream pressure & actuators' },
  { id: 'lox', name: 'LOX', path: '/lox', accent: '#E74C3C', common: true,
    description: 'Oxidizer pressure & actuators' },
  { id: 'chamber', name: 'Chamber', path: '/chamber', accent: '#F97316', common: true,
    description: 'PT / TC / LC measurements in one pane' },
  { id: 'copv', name: 'COPV / GN2', path: '/copv', accent: '#27AE60', common: true,
    description: 'High-pressure bottle & regulator' },
  { id: 'controller', name: 'Controller', path: '/controller', accent: '#F87171', common: true,
    description: 'PWM duty cycle & valve states' },
  { id: 'boards', name: 'Boards', path: '/boards', accent: '#10B981', common: true,
    description: 'Discovered boards and heartbeat status' },
  { id: 'session', name: 'Session', path: '/session', accent: '#64748B', common: true,
    description: 'Recording session controls & history' },

  // ── Less-used views (reachable via the All Views tab) ────────────────────────
  { id: 'gse', name: 'GSE', path: '/gse', accent: '#F39C12',
    description: 'Ground support equipment pressures' },
  { id: 'lcs-tcs-rtd', name: 'LCS / TCS / RTD', path: '/lcs-tcs-rtd', accent: '#F59E0B',
    description: 'Thermocouples, RTDs, load cell — voltage and temperature' },
  { id: 'sensor-info', name: 'Sensor Info', path: '/sensor-info', accent: '#22D3EE',
    description: 'ADC code · converted value · data rate per channel' },
  { id: 'controller-controls', name: 'Controls', path: '/controls', accent: '#F472B6',
    description: 'Manual actuator & state controls' },
  { id: 'calibration', name: 'Calibration', path: '/calibration', accent: '#A3E635',
    description: 'Per-PT cubic / robust / physics — model per sensor, shared points, live curve previews' },
  { id: 'calibration-cubic', name: 'Cubic Calibration', path: '/calibration-cubic', accent: '#84CC16', deprecated: true,
    description: 'Merged into Calibration — redirects there' },
  { id: 'feed-char', name: 'Feed System Char', path: '/feed-char', accent: '#3B82F6',
    description: 'CdA, MDOT, Reynolds number characterization' },
  { id: 'solenoid-char', name: 'Solenoid Characterization', path: '/solenoid-char', accent: '#F59E0B',
    description: 'PWM duty cycle & frequency for solenoid performance' },
  { id: 'encoders', name: 'Encoders', path: '/encoders', accent: '#7C3AED',
    description: 'Encoder board angles and connection status' },
  { id: 'self-tests', name: 'Board Self Tests', path: '/self-tests', accent: '#A855F7',
    description: 'Detailed pass/fail diagnostics per hotfire frame' },
  { id: 'boards-flash', name: 'Ethernet OTA Flash', path: '/flash', accent: '#06B6D4',
    description: 'Flash firmware to boards over Ethernet' },
  { id: 'config', name: 'Config', path: '/config', accent: '#FBBF24',
    description: 'System & board configuration editor' },
  { id: 'livestream', name: 'Livestream Stats', path: '/livestream', accent: '#38BDF8',
    description: 'Broadcast pane with state, mission timer, and selectable PT dials' },
  { id: 'raw', name: 'Raw Plots', path: '/raw', accent: '#94A3B8', deprecated: true,
    description: 'Unprocessed per-channel plots' },
  { id: 'all', name: 'All Plots', path: '/plots/all', accent: '#A3A3A3', deprecated: true,
    description: 'Every pressure plot on one page' },
  { id: 'ipad', name: 'iPad View', path: '/ipad', accent: '#8B5CF6',
    description: 'Scrollable layout tuned for iPad' },
  { id: 'mobile-gui', name: 'Mobile', path: '/mobile', accent: '#8B5CF6',
    description: 'Compact phone control layout' },

  // ── Deprecated — reachable only via the All Views "Deprecated" section ───────
  { id: 'status', name: 'Status', path: '/status', accent: '#34D399', deprecated: true,
    description: 'Tabular real-time sensor values' },
];

/** Tab-bar items rendered inline, in order (never deprecated). */
export const COMMON_NAV_ITEMS = NAV_ITEMS.filter((i) => i.common && !i.deprecated);

/** Active (non-deprecated) views — the main All Views grid + dropdown source. */
export const ACTIVE_NAV_ITEMS = NAV_ITEMS.filter((i) => !i.deprecated);

/** Retired views — shown only under the All Views "Deprecated" section. */
export const DEPRECATED_NAV_ITEMS = NAV_ITEMS.filter((i) => i.deprecated);

/** Legacy `/window/<id>` key → canonical path, for redirecting old popup URLs. */
export const VIEW_ID_TO_PATH: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.map((i) => [i.id, i.path]),
);

/** Find the nav item whose canonical path matches `pathname` (exact match). */
export function navItemByPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.path === pathname);
}

/** Find the nav item with the given id. */
export function navItemById(id: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.id === id);
}

/**
 * Resolve the ordered list of pinned tab-bar items.
 * `configTabIds` comes from config.toml [gui].tabs (via useGuiConfig). When it
 * lists any known non-deprecated views, that order wins; otherwise fall back to
 * the `common` flags in this catalog.
 */
export function resolveTabItems(configTabIds: string[]): NavItem[] {
  const resolved = configTabIds
    .map((id) => navItemById(id))
    .filter((i): i is NavItem => !!i && !i.deprecated);
  return resolved.length ? resolved : COMMON_NAV_ITEMS;
}
