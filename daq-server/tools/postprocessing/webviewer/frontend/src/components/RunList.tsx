import type { Run } from '../types';

interface Props {
  runs: Run[];
  selected: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}

function fmtStarted(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function RunList({ runs, selected, onSelect, loading }: Props) {
  return (
    <div className="runlist">
      <div className="runlist-head">Runs {loading ? '…' : `(${runs.length})`}</div>
      <div className="runlist-scroll">
        {runs.map((r) => (
          <button
            key={r.id}
            className={`run-item${r.id === selected ? ' active' : ''}`}
            onClick={() => onSelect(r.id)}
          >
            <span className="run-date">{fmtStarted(r.started)}</span>
            <span className="run-idline">
              <span className="run-id">{r.id}</span>
              {r.simulated && <span className="sim-badge" title="Simulated data — not from the test stand">SIM</span>}
            </span>
            {r.cached && <span className="run-cached" title="Exported & cached">●</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
