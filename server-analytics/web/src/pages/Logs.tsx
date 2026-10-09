import { useCallback, useEffect, useRef, useState } from "react";

import { get, type LogRow, type LogSource, usePoll } from "../api";
import { clock } from "../format";
import { BUTTON, INPUT, MUTED, PAGE_CONTAINER, TABLE_WRAP } from "../ui";

const PAGE = 200;
const TAIL_MS = 5000;
const KEEP = 2000; // lines held in the page; older ones fall off the bottom

// journald priorities say "error" outright. Docker's stderr does not: most of
// the stack (Go's log, Python's logging) writes every line there, so it is
// marked, not alarmed.
const ERROR_LEVELS = new Set(["emerg", "alert", "crit", "err"]);

function streamClass(s: string) {
  if (ERROR_LEVELS.has(s)) return "text-red-600 dark:text-red-400";
  if (s === "warning" || s === "stderr") return "text-amber-600 dark:text-amber-400";
  return "text-neutral-400 dark:text-neutral-500";
}

export function Logs() {
  const params = new URLSearchParams(location.search);
  const [host, setHost] = useState(params.get("host") ?? "");
  const [source, setSource] = useState(params.get("source") ?? "");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [query, setQuery] = useState(q); // debounced copy of q
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [live, setLive] = useState(true);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const newest = useRef(0);
  const { data: sources } = usePoll<LogSource[]>("/api/log-sources", 60_000);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Keep the filters in the URL, so a view can be linked from a container row.
  useEffect(() => {
    const p = new URLSearchParams();
    if (host) p.set("host", host);
    if (source) p.set("source", source);
    if (query) p.set("q", query);
    const qs = p.toString();
    history.replaceState(null, "", "/logs" + (qs ? `?${qs}` : ""));
  }, [host, source, query]);

  const url = useCallback(
    (extra: Record<string, string>) => {
      const p = new URLSearchParams({ limit: String(PAGE), ...extra });
      if (host) p.set("host", host);
      if (source) p.set("source", source);
      if (query) p.set("q", query);
      if (errorsOnly) p.set("stream", "errors");
      return `/api/logs?${p}`;
    },
    [host, source, query, errorsOnly],
  );

  // A filter change starts the list over.
  useEffect(() => {
    let stale = false;
    get<LogRow[]>(url({})).then(
      (r) => {
        if (stale) return;
        setRows(r);
        setMore(r.length === PAGE);
        newest.current = r[0]?.id ?? 0;
        setError(null);
      },
      (e) => !stale && setError(String(e.message)),
    );
    return () => {
      stale = true;
    };
  }, [url]);

  // Tail: ask only for lines newer than the newest one shown.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await get<LogRow[]>(url({ after: String(newest.current) }));
        if (r.length) {
          newest.current = r[0].id;
          setRows((old) => [...r, ...old].slice(0, KEEP));
        }
      } catch {
        /* the next tick retries */
      }
    }, TAIL_MS);
    return () => clearInterval(t);
  }, [live, url]);

  const older = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    const r = await get<LogRow[]>(url({ before: String(last.id) }));
    setRows((old) => [...old, ...r]);
    setMore(r.length === PAGE);
  };

  const hosts = [...new Set((sources ?? []).map((s) => s.host))];
  const hostSources = (sources ?? []).filter((s) => !host || s.host === host);

  return (
    <main className={PAGE_CONTAINER}>
      <h1 className="text-2xl font-semibold">Logs</h1>
      <p className={`mt-1 text-sm ${MUTED}`}>
        Container output from both boxes, plus the DAQ server's systemd units. Kept for 3 days.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select value={host} onChange={(e) => (setHost(e.target.value), setSource(""))} className={INPUT} aria-label="Host">
          <option value="">All hosts</option>
          {hosts.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={INPUT} aria-label="Source">
          <option value="">All sources</option>
          {hostSources.map((s) => (
            <option key={s.host + s.source} value={s.source}>
              {host ? s.source : `${s.host} · ${s.source}`}
            </option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className={`${INPUT} min-w-[12rem] flex-1`} />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
          stderr &amp; errors only
        </label>
        <button onClick={() => setLive((v) => !v)} className={BUTTON}>
          {live ? "❚❚ Pause" : "▶ Live"}
        </button>
      </div>

      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className={`${TABLE_WRAP} mt-4`}>
        <div className="font-mono text-xs leading-5">
          {rows.map((r) => (
            <div key={r.id} className="flex gap-3 border-b border-neutral-100 px-3 py-0.5 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-800/40">
              <span className={`shrink-0 tabular-nums ${MUTED}`}>{clock(r.ts)}</span>
              <span className="w-40 shrink-0 truncate text-neutral-600 dark:text-neutral-300" title={`${r.host} · ${r.source}`}>
                {host ? "" : `${r.host} · `}
                {r.source.replace(/^docker:|^journal:/, "")}
              </span>
              <span className={`w-12 shrink-0 ${streamClass(r.stream)}`}>{r.stream}</span>
              <span className="min-w-0 whitespace-pre-wrap break-all">{r.line}</span>
            </div>
          ))}
          {rows.length === 0 && !error && <p className={`p-4 font-sans text-sm ${MUTED}`}>No lines match.</p>}
        </div>
      </div>
      {more && rows.length > 0 && (
        <button onClick={older} className={`${BUTTON} mt-3`}>
          Load older
        </button>
      )}
    </main>
  );
}
