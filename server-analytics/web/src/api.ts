import { useCallback, useEffect, useRef, useState } from "react";

export type Latest = {
  ts: number;
  cpu: number;
  cores: number;
  mem_used: number;
  mem_total: number;
  swap_used: number;
  swap_total: number;
  load1: number;
  disk_used: number;
  disk_total: number;
  net_rx: number;
  net_tx: number;
  uptime: number;
};

export type HostSummary = {
  host: string;
  last_seen: number;
  up: boolean;
  deploy_commit: string | null;
  deploy_at: string | null;
  latest: Latest | null;
  containers: { running: number; total: number; unhealthy: number };
};

/** Column arrays, one per field, as uPlot draws them. */
export type Columns = Record<string, (number | null)[]>;
export type Series = { bucket_ms: number; series: Columns };

export type Container = {
  name: string;
  ts: number;
  image: string;
  state: string;
  health: string;
  restarts: number;
  cpu: number;
  mem_used: number;
  mem_limit: number;
  spark: Columns;
};

export type LogRow = {
  id: number;
  host: string;
  source: string;
  ts: number;
  stream: string;
  line: string;
};

export type LogSource = { host: string; source: string };

export const RANGES = ["1h", "6h", "24h", "7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];
export const RANGE_MS: Record<Range, number> = {
  "1h": 3600e3,
  "6h": 6 * 3600e3,
  "24h": 24 * 3600e3,
  "7d": 7 * 86400e3,
  "30d": 30 * 86400e3,
  "90d": 90 * 86400e3,
};

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(`${r.status} ${msg}`);
  }
  return r.json();
}

export const POLL_MS = 15_000;

/**
 * Fetches `path` now and every `every` ms -- but only while the tab is visible,
 * so a panel left open in a background tab costs the hub nothing.
 */
export function usePoll<T>(path: string | null, every = POLL_MS) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    try {
      const d = await get<T>(path);
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(String((e as Error).message));
    }
  }, [path]);

  useEffect(() => {
    setData(null);
    load();
    let t: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(t);
      t = setInterval(load, every);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        load();
        start();
      } else clearInterval(t);
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load, every]);

  return { data, error, reload: load };
}
