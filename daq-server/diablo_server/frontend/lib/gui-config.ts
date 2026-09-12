/**
 * GUI-driven config lists pulled from config.toml [gui] via /api/gui-config:
 *   - pressure_bars: the ordered top-bar pressure gauges
 *   - tabs:          the ordered tab-bar view ids (index into nav-items)
 *
 * Mirrors lib/sensor-config.ts: one module-scoped fetch shared by all
 * components, invalidated + refetched on the CONFIG_UPDATED WebSocket message so
 * edits in the Config editor reflect live with no reload/restart.
 */

import { useEffect, useState } from 'react';
import { getApiBaseUrl, getWebSocketClient } from './websocket';
import { MessageType } from './types';

// ── Types ──────────────────────────────────────────────────────────────────────

/** One top-bar pressure gauge, as authored in [[gui.pressure_bars]]. */
export interface PressureBarConfig {
  /** Text shown on the gauge. */
  label: string;
  /** Sensor role name → resolved to its calibrated entity via /api/sensor-config. */
  role?: string;
  /** Gauge value = mean of these roles' pressures (e.g. the two chamber mids). */
  avg_roles?: string[];
  /** Key into [pressure_limits.*] supplying NOP/MEOP (single source of truth). */
  limits?: string;
  /** Gauge accent colour. */
  color?: string;
}

export interface GuiConfig {
  pressureBars: PressureBarConfig[];
  /** Ordered tab-bar view ids (index into lib/nav-items). Empty → use defaults. */
  tabs: string[];
  /** [gui.groups]: page/group name → ordered list of sensor role names. Explicit sensor→page
   *  membership (replaces role-name substring parsing). Array order = display order. */
  groups: Record<string, string[]>;
}

const EMPTY: GuiConfig = { pressureBars: [], tabs: [], groups: {} };

// ── Module-level cache so all components share one fetch ───────────────────────

let _cache: GuiConfig | null = null;
let _fetchPromise: Promise<GuiConfig> | null = null;

export async function fetchGuiConfig(): Promise<GuiConfig> {
  if (_cache !== null) return _cache;
  if (_fetchPromise) return _fetchPromise;

  _fetchPromise = fetch(`${getApiBaseUrl()}/api/gui-config`)
    .then((res) => {
      if (!res.ok) throw new Error(`gui-config fetch failed: ${res.status}`);
      return res.json();
    })
    .then((data: { pressure_bars?: PressureBarConfig[]; tabs?: string[]; groups?: Record<string, string[]> }) => {
      _cache = { pressureBars: data.pressure_bars ?? [], tabs: data.tabs ?? [], groups: data.groups ?? {} };
      return _cache;
    })
    .catch((err) => {
      console.error('[gui-config] Failed to fetch gui config:', err);
      _fetchPromise = null; // allow retry
      return EMPTY;
    });

  return _fetchPromise;
}

export function invalidateGuiConfigCache(): void {
  _cache = null;
  _fetchPromise = null;
}

// ── React hook ─────────────────────────────────────────────────────────────────

/** Live GUI config. Returns empty lists while loading; refetches on CONFIG_UPDATED. */
export function useGuiConfig(): GuiConfig {
  const [cfg, setCfg] = useState<GuiConfig>(_cache ?? EMPTY);

  useEffect(() => {
    let cancelled = false;
    fetchGuiConfig().then((c) => { if (!cancelled) setCfg(c); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const ws = getWebSocketClient();
    const unsub = ws.on(MessageType.CONFIG_UPDATED, () => {
      invalidateGuiConfigCache();
      fetchGuiConfig().then((c) => setCfg(c));
    });
    return unsub;
  }, []);

  return cfg;
}
