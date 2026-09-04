import { useEffect, useState } from 'react';
import { fmtDuration } from '../util';

interface Props {
  t0: number; // run start (epoch seconds), used as the 0 reference
  tEnd: number; // run end (epoch seconds)
  start: number | null; // current window start (epoch seconds) or null = run start
  end: number | null; // current window end (epoch seconds) or null = run end
  onChange: (start: number | null, end: number | null) => void;
}

// The window is edited as seconds relative to run start (T+), which is how test
// data is usually discussed. null start/end mean the run's own bounds.
export default function TimeRange({ t0, tEnd, start, end, onChange }: Props) {
  const relStart = ((start ?? t0) - t0).toFixed(2);
  const relEnd = ((end ?? tEnd) - t0).toFixed(2);
  const [s, setS] = useState(relStart);
  const [e, setE] = useState(relEnd);

  useEffect(() => setS(relStart), [relStart]);
  useEffect(() => setE(relEnd), [relEnd]);

  const apply = () => {
    const sv = parseFloat(s);
    const ev = parseFloat(e);
    onChange(
      isFinite(sv) ? t0 + sv : null,
      isFinite(ev) ? t0 + ev : null,
    );
  };

  return (
    <div className="timerange">
      <span className="tr-label">Window (T+ s):</span>
      <input className="tr-input" value={s} onChange={(ev) => setS(ev.target.value)}
             onBlur={apply} onKeyDown={(ev) => ev.key === 'Enter' && apply()} />
      <span className="tr-dash">→</span>
      <input className="tr-input" value={e} onChange={(ev) => setE(ev.target.value)}
             onBlur={apply} onKeyDown={(ev) => ev.key === 'Enter' && apply()} />
      <span className="tr-total">of {fmtDuration(tEnd - t0)}</span>
    </div>
  );
}
