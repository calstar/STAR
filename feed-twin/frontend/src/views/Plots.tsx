/**
 * Pressure against time, the way the DAQ plots it.
 *
 * Channels silenced from the top bar are silenced here — same click, same
 * rescale. That is the behaviour on the real software and it is the reason the
 * bars are buttons.
 */

import { channelColor, fixed } from '../api';
import { DaqPlot, type Channel } from '../components/DaqPlot';
import { useStand } from '../stand';

export function Plots() {
  const { history: result, live, hidden, toggleChannel } = useStand();

  if (!result) return <p className="p-6 text-sm text-text-muted">Nothing solved yet.</p>;

  // Grouped by unit, one panel each -- never one axis carrying both.
  //
  // Thermocouples and RTDs arrive in kelvin now, and 250 K plotted against
  // 550 psi on a shared axis is a dual-axis chart wearing a disguise: the two
  // traces cross wherever the scales happen to put them and the crossing means
  // nothing. Two measures of different scale get two charts.
  const groups = ['psig', 'K'].flatMap((unit) => {
    const inUnit = result.channels.filter((c) => (c.unit || 'psig') === unit);
    if (inUnit.length === 0) return [];
    return [{
      unit,
      label: unit === 'K' ? 'Temperature (K)' : 'Pressure (psig)',
      all: inUnit,
      shown: inUnit
        .filter((c) => !hidden[c.id])
        .map((c): Channel => ({
          key: c.id,
          tag: c.tag,
          values: c.values,
          color: channelColor(c.tag),
        })),
    }];
  });

  const single = result.times_s.length < 2;

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-text-muted">
          Channel history
        </h2>
        <span className="text-[11.5px] text-gray-600">{result.message}</span>
      </div>

      {single ? (
        <div className="bg-card flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-gray-800 p-8 text-center">
          <p className="text-sm text-text-muted">
            The trace starts as soon as the stand is running.
          </p>
          <p className="max-w-md text-[12.5px] text-gray-600">
            The stand is in{' '}
            <span className="font-mono text-text">{live?.state ?? '—'}</span>.
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            {result.channels.map((c) => (
              <span key={c.id} className="font-mono text-xs tabular-nums">
                <span style={{ color: channelColor(c.tag) }}>{c.tag}</span>{' '}
                <span className="text-text">{fixed(c.values[0] ?? 0, 1)}</span>
                <span className="text-gray-600"> {c.unit || 'psig'}</span>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {groups.map((g) => (
            <div
              key={g.unit}
              className="bg-card min-h-[220px] flex-1 rounded-lg border border-gray-800 p-3"
            >
              <DaqPlot
                times={result.times_s}
                channels={g.shown}
                yLabel={g.label}
                fill={g.unit === 'psig'}
                allowLog={g.unit === 'psig'}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {result.channels.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => toggleChannel(c.id)}
            className={`flex items-center gap-1.5 rounded border border-gray-800 px-2 py-1 font-mono text-[11px] transition-opacity hover:border-gray-600 ${
              hidden[c.id] ? 'opacity-40' : ''
            }`}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: channelColor(c.tag) }}
            />
            {c.tag}
          </button>
        ))}
      </div>
    </div>
  );
}
