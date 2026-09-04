import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type uPlot from 'uplot';
import { api } from './api';
import starWordmark from './assets/star-wordmark.png';
import type { Component, Run, RunIndex, Series, SeriesMeta } from './types';
import { fmtBytes, fmtDuration } from './util';
import RunList from './components/RunList';
import SensorPicker from './components/SensorPicker';
import TimeRange from './components/TimeRange';
import Chart from './components/Chart';
import ConfigView from './components/ConfigView';

const MAX_POINTS = 4000;

type Tab = 'plot' | 'config';

// Showing roles instead of Elodin identities is a viewing preference, not a property of
// the run, so it lives per browser rather than in any saved state. Default on: the
// numbers are what nobody could read.
const NAMES_KEY = 'webviewer.showNames';
const loadShowNames = () => {
  try {
    return localStorage.getItem(NAMES_KEY) !== '0';
  } catch {
    return true; // storage blocked (private window, site data off), just use the default
  }
};

export default function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  const [runId, setRunId] = useState<string | null>(null);
  const [index, setIndex] = useState<RunIndex | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexErr, setIndexErr] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('plot');
  const [showNames, setShowNames] = useState(loadShowNames);
  // undefined = not fetched yet, null = this run has no snapshot.
  const [configText, setConfigText] = useState<string | null | undefined>(undefined);
  const [configErr, setConfigErr] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [win, setWin] = useState<{ start: number | null; end: number | null }>({ start: null, end: null });

  const [series, setSeries] = useState<Series[]>([]);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const uplotRef = useRef<uPlot | null>(null);
  const seriesReq = useRef(0);

  useEffect(() => {
    api.runs().then(setRuns).catch((e) => console.error(e)).finally(() => setLoadingRuns(false));
  }, []);

  const toggleNames = (on: boolean) => {
    setShowNames(on);
    try {
      localStorage.setItem(NAMES_KEY, on ? '1' : '0');
    } catch { /* preference simply doesn't persist */ }
  };

  const selectRun = useCallback((id: string) => {
    setRunId(id);
    setIndex(null);
    setIndexErr(null);
    setSelected(new Set());
    setWin({ start: null, end: null });
    setSeries([]);
    setTab('plot');
    setConfigText(undefined);
    setConfigErr(null);
    setIndexBusy(true);
    api
      .components(id)
      .then((idx) => {
        setIndex(idx);
        setRuns((rs) => rs.map((r) => (r.id === id ? { ...r, cached: true } : r)));
      })
      .catch((e) => setIndexErr(String(e.message || e)))
      .finally(() => setIndexBusy(false));
    // The snapshot is small (~30 KB) and wanted by both tabs: the Config tab shows it,
    // and it is where the names come from, so fetch it once with the index.
    api
      .config(id)
      .then(setConfigText)
      .catch((e) => setConfigErr(String(e.message || e)));
  }, []);

  // Fetch series whenever the selection or window changes (debounced).
  useEffect(() => {
    if (!runId || selected.size === 0) {
      setSeries([]);
      return;
    }
    const names = Array.from(selected);
    const req = ++seriesReq.current;
    setSeriesBusy(true);
    const h = setTimeout(() => {
      api
        .series(runId, names, win.start, win.end, MAX_POINTS)
        .then((r) => {
          if (req === seriesReq.current) setSeries(r.series);
        })
        .catch((e) => console.error(e))
        .finally(() => {
          if (req === seriesReq.current) setSeriesBusy(false);
        });
    }, 200);
    return () => clearTimeout(h);
  }, [runId, selected, win]);

  const byName = useMemo(() => {
    const m = new Map<string, Component>();
    index?.components.forEach((c) => m.set(c.name, c));
    return m;
  }, [index]);

  // One descriptor per plotted series: what to call it, and how to read its values.
  const meta = useMemo<SeriesMeta[]>(
    () =>
      series.map((s) => {
        const c = byName.get(s.name);
        const entity = s.name.replace(/\.[^.]+$/, '');
        const field = c?.field ?? s.name.split('.').pop() ?? '';
        return {
          label: (showNames && c?.label) || entity,
          unit: c?.unit ?? '',
          field,
          valueNames:
            showNames && index?.state_fields.includes(field) ? index.states : null,
        };
      }),
    [series, byName, showNames, index],
  );

  const toggle = (name: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });

  // Group select-all: if every name is already selected, clear them; else add all.
  const toggleMany = (names: string[]) =>
    setSelected((prev) => {
      const n = new Set(prev);
      const allOn = names.every((x) => n.has(x));
      names.forEach((x) => (allOn ? n.delete(x) : n.add(x)));
      return n;
    });

  const onViewChange = useCallback(
    (start: number, end: number) => {
      // Only refetch if the zoom window differs meaningfully from the current one.
      setWin((cur) => {
        const cs = cur.start ?? index?.t_min ?? start;
        const ce = cur.end ?? index?.t_max ?? end;
        if (Math.abs(cs - start) < 1e-3 && Math.abs(ce - end) < 1e-3) return cur;
        return { start, end };
      });
    },
    [index],
  );

  const savePng = () => {
    const u = uplotRef.current;
    if (!u) return;
    u.ctx.canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${runId}_plot.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  };

  const selArr = Array.from(selected);

  return (
    <div className="app">
      <header className="topbar">
        {/* Wordmark, divider, title, the header the other STAR apps use
            (star-openrocket/frontend/src/App.tsx). The asset is synced from
            assets/brand by scripts/sync-brand.sh; do not hand-edit the copy. */}
        <img className="topbar-logo" src={starWordmark} alt="STAR" />
        <div className="topbar-divider" />
        <h1>DAQ Run Viewer</h1>
      </header>

      <div className="body">
        <aside className="sidebar">
          <RunList runs={runs} selected={runId} onSelect={selectRun} loading={loadingRuns} />
        </aside>

        <main className="content">
          {!runId && <div className="placeholder">Select a run to begin.</div>}

          {runId && (
            <>
              <div className="run-header">
                <div className="run-title">{runId}</div>
                {runs.find((r) => r.id === runId)?.simulated && (
                  <span className="sim-badge" title="Simulated data — not from the test stand">SIM</span>
                )}
                {indexBusy && <span className="busy">exporting &amp; indexing… (first open of a run)</span>}
                {indexErr && <span className="error">Error: {indexErr}</span>}
                {index && (
                  <span className="run-meta">
                    {index.n_components} components · {fmtDuration(index.duration_s)} · {fmtBytes(index.size_bytes)} on disk
                  </span>
                )}
                {index && !index.has_config && (
                  <span
                    className="run-meta"
                    title="No <run>.toml beside the DB: this run predates the config snapshot. Channels keep their raw Elodin names; state names come from the built-in table."
                  >
                    · no config snapshot
                  </span>
                )}
              </div>

              {index && (
                <div className="tabs">
                  <button
                    className={`tab${tab === 'plot' ? ' active' : ''}`}
                    onClick={() => setTab('plot')}
                  >
                    Plot
                  </button>
                  <button
                    className={`tab${tab === 'config' ? ' active' : ''}`}
                    onClick={() => setTab('config')}
                  >
                    Config
                  </button>
                  <div className="spacer" />
                  {/* View-wide, hence its place on the strip that spans both panes: it
                      renames the picker tree, the chart legend and the state axis at once. */}
                  <label
                    className="picker-toggle"
                    title="Show config roles (Ox Upstream, LOX Main, Fire) instead of the raw Elodin identities"
                  >
                    <input
                      type="checkbox"
                      checked={showNames}
                      onChange={(e) => toggleNames(e.target.checked)}
                    />
                    names
                  </label>
                </div>
              )}

              {index && tab === 'config' && (
                <ConfigView runId={runId} text={configText} error={configErr} />
              )}

              {index && tab === 'plot' && (
                <div className="workspace">
                  <div className="pane-left">
                    <SensorPicker
                      components={index.components}
                      selected={selected}
                      showNames={showNames}
                      onToggle={toggle}
                      onToggleMany={toggleMany}
                      onClear={() => setSelected(new Set())}
                    />
                  </div>

                  <div className="pane-right">
                    <div className="toolbar">
                      {index.t_min != null && index.t_max != null && (
                        <TimeRange
                          t0={index.t_min}
                          tEnd={index.t_max}
                          start={win.start}
                          end={win.end}
                          onChange={(s, e) => setWin({ start: s, end: e })}
                        />
                      )}
                      <div className="spacer" />
                      <a className="btn" href={api.downloadUrl(runId, [], null, null)}>
                        Download run CSV
                      </a>
                      <a
                        className={`btn${selArr.length ? '' : ' disabled'}`}
                        href={selArr.length ? api.downloadUrl(runId, selArr, win.start, win.end) : undefined}
                      >
                        Export plot CSV
                      </a>
                      <button className="btn" onClick={savePng} disabled={series.length === 0}>
                        Save image
                      </button>
                    </div>

                    <div className="chart-wrap">
                      {series.length > 0 ? (
                        <Chart
                          series={series}
                          meta={meta}
                          onViewChange={onViewChange}
                          onReady={(u) => (uplotRef.current = u)}
                        />
                      ) : (
                        <div className="placeholder">
                          {seriesBusy ? 'Loading…' : 'Pick one or more sensors to plot.'}
                        </div>
                      )}
                      {series.length > 0 && seriesBusy && <div className="chart-busy">updating…</div>}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
