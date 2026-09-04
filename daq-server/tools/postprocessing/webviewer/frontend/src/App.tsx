import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type uPlot from 'uplot';
import { api } from './api';
import starWordmark from './assets/star-wordmark.png';
import type { Component, Run, RunIndex, RunSummary, Series, SeriesMeta, TimeSource } from './types';
import { fmtBytes, fmtDuration } from './util';
import RunList from './components/RunList';
import SensorPicker from './components/SensorPicker';
import TimeRange from './components/TimeRange';
import Chart from './components/Chart';
import ConfigView from './components/ConfigView';
import RunDescription from './components/RunDescription';
import RunSummaryPanel from './components/RunSummaryPanel';

const MAX_POINTS = 4000;

type Tab = 'plot' | 'config';

// Showing roles instead of Elodin identities is a viewing preference, not a property of
// the run, so it lives per browser rather than in any saved state. Default on: the
// numbers are what nobody could read.
const NAMES_KEY = 'webviewer.showNames';
const DB_CLOCK_KEY = 'webviewer.dbClock';
const loadPref = (key: string, dflt: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch {
    return dflt; // storage blocked (private window, site data off) — use the default
  }
};
const savePref = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch { /* the preference simply doesn't persist */ }
};

export default function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  const [runId, setRunId] = useState<string | null>(null);
  const [index, setIndex] = useState<RunIndex | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexErr, setIndexErr] = useState<string | null>(null);
  // What the run says about itself before any export. Selecting a run costs only this.
  const [summary, setSummary] = useState<RunSummary | null>(null);

  const [tab, setTab] = useState<Tab>('plot');
  const [showNames, setShowNames] = useState(() => loadPref(NAMES_KEY, true));
  // Off by default: elodin-db's write time bunches each UDP packet's samples into
  // microseconds, so it is the wrong axis. Kept because it is what every run recorded so
  // far was read on, and it is the only way to see the raw arrival pattern.
  const [dbClock, setDbClock] = useState(() => loadPref(DB_CLOCK_KEY, false));
  const timeSource: TimeSource = dbClock ? 'db' : 'sensor';
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

  // The expensive step, on request. Synchronous on the server; this holds a busy state
  // for the duration and marks the run cached in the list when it lands.
  const runIndex = useCallback(() => {
    if (!runId) return;
    setIndexBusy(true);
    setIndexErr(null);
    api
      .index(runId)
      .then((idx) => {
        setIndex(idx);
        setSummary((s) => (s ? { ...s, cached: true } : s));
        setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, cached: true } : r)));
      })
      .catch((e) => setIndexErr(String(e.message || e)))
      .finally(() => setIndexBusy(false));
  }, [runId]);

  const toggleNames = (on: boolean) => {
    setShowNames(on);
    savePref(NAMES_KEY, on);
  };

  // Switching clocks moves every point, so the old window means nothing on the new axis.
  const toggleDbClock = (on: boolean) => {
    setDbClock(on);
    savePref(DB_CLOCK_KEY, on);
    setWin({ start: null, end: null });
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
    setSummary(null);
    // Cheap either way: the summary never exports, and the index is only fetched when one
    // already exists. A run is indexed on request (runIndex), not by being clicked.
    api
      .summary(id)
      .then((sum) => {
        setSummary(sum);
        // Runs predating the snapshot have no config; asking anyway just logs a 404.
        if (sum.has_config) {
          api.config(id).then(setConfigText).catch((e) => setConfigErr(String(e.message || e)));
        } else {
          setConfigText(null);
        }
        if (!sum.cached) return;
        api.components(id).then(setIndex).catch((e) => setIndexErr(String(e.message || e)));
      })
      .catch((e) => setIndexErr(String(e.message || e)));
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
        .series(runId, names, win.start, win.end, MAX_POINTS, timeSource)
        .then((r) => {
          if (req === seriesReq.current) setSeries(r.series);
        })
        .catch((e) => console.error(e))
        .finally(() => {
          if (req === seriesReq.current) setSeriesBusy(false);
        });
    }, 200);
    return () => clearTimeout(h);
  }, [runId, selected, win, timeSource]);

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

  // The run's full extent, and the window actually being shown. The chart draws the
  // window it was asked for rather than the extent of whatever data came back for it,
  // so these have to be resolved here, where `win`'s nulls mean "the whole run".
  const bounds = useMemo<[number, number]>(
    () =>
      dbClock
        ? [index?.t_min ?? 0, index?.t_max ?? 0]
        : [index?.sensor_t_min ?? index?.t_min ?? 0, index?.sensor_t_max ?? index?.t_max ?? 0],
    [index, dbClock],
  );
  const view = useMemo<[number, number]>(
    () => [win.start ?? bounds[0], win.end ?? bounds[1]],
    [win, bounds],
  );
  const zoomed = win.start != null || win.end != null;
  const resetView = useCallback(() => setWin({ start: null, end: null }), []);

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
        const cs = cur.start ?? bounds[0];
        const ce = cur.end ?? bounds[1];
        if (Math.abs(cs - start) < 1e-3 && Math.abs(ce - end) < 1e-3) return cur;
        return { start, end };
      });
    },
    [bounds],
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
  const run = runs.find((r) => r.id === runId);

  return (
    <div className="app">
      <header className="topbar">
        {/* Wordmark, divider, title — the header the other STAR apps use
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
                {run?.simulated && (
                  <span className="sim-badge" title="Simulated data, not from the test stand">SIM</span>
                )}
                {indexErr && <span className="error">Error: {indexErr}</span>}
                {index ? (
                  <span className="run-meta">
                    {index.n_components} components · {fmtDuration(bounds[1] - bounds[0])} · {fmtBytes(index.size_bytes)} on disk
                  </span>
                ) : (
                  summary && (
                    <span className="run-meta">
                      <span title="Every component the DB holds. Indexing reports a smaller number: the export only resolves the ones it can name, and the rest stay bare numeric ids.">
                        {summary.n_components} components
                      </span>
                      {' · '}
                      <span title="Estimated from when the run's files were written, so it runs a fraction of a second short. The exact figure appears once indexed.">
                        ~{fmtDuration(summary.duration_s)}
                      </span>
                      {' · '}
                      {fmtBytes(summary.size_bytes)} on disk · not indexed
                    </span>
                  )
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

              {run && (
                <RunDescription
                  runId={run.id}
                  value={run.description}
                  onSaved={(text) =>
                    setRuns((rs) => rs.map((r) => (r.id === run.id ? { ...r, description: text } : r)))
                  }
                />
              )}

              {(index || summary) && (
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
                      renames the picker tree, the chart legend and the state axis at once.
                      Both toggles describe plotted data, so they appear with it. */}
                  {index && (
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
                  )}
                  {index && (
                  <label
                    className="picker-toggle"
                    title={
                      'Plot on elodin-db\u2019s write time instead of each row\u2019s own sample time. ' +
                      'The DB stamps a whole UDP packet of samples microseconds apart and then nothing ' +
                      'for ~100 ms, so a steady channel draws as bursts. Off unless you want to see ' +
                      'that arrival pattern.'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={dbClock}
                      onChange={(e) => toggleDbClock(e.target.checked)}
                    />
                    DB write time
                  </label>
                  )}
                  {index && !dbClock && index.n_reanchored > 0 && (
                    <span
                      className="tabs-note"
                      title={
                        'The sequencer (ACT_CMD, SEQUENCER.state) and the board-heartbeat router ' +
                        '(BOARD.HB_*) stamp steady_clock: monotonic since boot, not a wall ' +
                        'clock. It is still a good clock, so it is shifted onto the epoch by the ' +
                        'median of (DB write time \u2212 stamp). Relative timing on these channels ' +
                        'is exact; their absolute position carries a few ms of write latency as ' +
                        'bias. Without this they would sit on the DB write time, which adds up to ' +
                        '~60 ms of jitter to a valve command.'
                      }
                    >
                      · {index.n_reanchored} channels re-anchored
                    </span>
                  )}
                  {index && !dbClock && index.n_db_only > 0 && (
                    <span className="tabs-note" title="No per-row timestamp at all, so these keep elodin-db's write time.">
                      · {index.n_db_only} on DB time
                    </span>
                  )}
                </div>
              )}

              {tab === 'config' && (
                <ConfigView runId={runId} text={configText} error={configErr} />
              )}

              {/* Not indexed: what the run directory knows, and the button that pays for
                  the rest. Selecting a run must not itself cost a multi-second export. */}
              {!index && tab === 'plot' && (
                <RunSummaryPanel busy={indexBusy} error={indexErr} onIndex={runIndex} />
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
                          t0={bounds[0]}
                          tEnd={bounds[1]}
                          start={win.start}
                          end={win.end}
                          onChange={(s, e) => setWin({ start: s, end: e })}
                        />
                      )}
                      {/* Sits with the window it resets, not with the exports — and keeps
                          the export cluster to the three buttons that fit on one row. */}
                      <button className="btn" onClick={resetView} disabled={!zoomed}>
                        Reset view
                      </button>
                      <div className="spacer" />
                      <a className="btn" href={api.downloadUrl(runId, [], null, null, timeSource)}>
                        Download run CSV
                      </a>
                      <a
                        className={`btn${selArr.length ? '' : ' disabled'}`}
                        href={selArr.length ? api.downloadUrl(runId, selArr, win.start, win.end, timeSource) : undefined}
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
                          view={view}
                          bounds={bounds}
                          onViewChange={onViewChange}
                          onResetView={resetView}
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
