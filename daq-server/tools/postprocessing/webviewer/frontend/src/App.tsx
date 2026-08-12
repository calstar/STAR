import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type uPlot from 'uplot';
import { api } from './api';
import type { Component, Run, RunIndex, Series } from './types';
import { fmtBytes, fmtDuration } from './util';
import RunList from './components/RunList';
import SensorPicker from './components/SensorPicker';
import TimeRange from './components/TimeRange';
import Chart from './components/Chart';

const MAX_POINTS = 4000;

export default function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  const [runId, setRunId] = useState<string | null>(null);
  const [index, setIndex] = useState<RunIndex | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexErr, setIndexErr] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [win, setWin] = useState<{ start: number | null; end: number | null }>({ start: null, end: null });

  const [series, setSeries] = useState<Series[]>([]);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const uplotRef = useRef<uPlot | null>(null);
  const seriesReq = useRef(0);

  useEffect(() => {
    api.runs().then(setRuns).catch((e) => console.error(e)).finally(() => setLoadingRuns(false));
  }, []);

  const selectRun = useCallback((id: string) => {
    setRunId(id);
    setIndex(null);
    setIndexErr(null);
    setSelected(new Set());
    setWin({ start: null, end: null });
    setSeries([]);
    setIndexBusy(true);
    api
      .components(id)
      .then((idx) => {
        setIndex(idx);
        setRuns((rs) => rs.map((r) => (r.id === id ? { ...r, cached: true } : r)));
      })
      .catch((e) => setIndexErr(String(e.message || e)))
      .finally(() => setIndexBusy(false));
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

  const units = useMemo(
    () => series.map((s) => byName.get(s.name)?.unit ?? ''),
    [series, byName],
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
        <h1>DAQ Run Viewer</h1>
        <span className="sub">past-run reconstruction · read-only</span>
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
                {indexBusy && <span className="busy">exporting &amp; indexing… (first open of a run)</span>}
                {indexErr && <span className="error">Error: {indexErr}</span>}
                {index && (
                  <span className="run-meta">
                    {index.n_components} components · {fmtDuration(index.duration_s)} · {fmtBytes(index.size_bytes)} on disk
                  </span>
                )}
              </div>

              {index && (
                <div className="workspace">
                  <div className="pane-left">
                    <SensorPicker
                      components={index.components}
                      selected={selected}
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
                          units={units}
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
