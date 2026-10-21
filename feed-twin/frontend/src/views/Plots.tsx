/**
 * Pressure against time, the way the DAQ plots it.
 *
 * Channels silenced from the top bar are silenced here — same click, same
 * rescale. That is the behaviour on the real software and it is the reason the
 * bars are buttons. What the console's ⋯ hides is off here too -- the cart's
 * transducers, until someone shows them; a click here shows one again.
 */

import { useMemo, useState } from 'react';
import { channelColor, channelPalette, fixed, sessionHistory } from '../api';
import { DaqPlot, type Channel } from '../components/DaqPlot';
import { PRESSURE_UNIT, isPressureChannel, toPsia, unitLabel } from '../lib/pressure';
import { ordered } from '../lib/shown';
import { useStand } from '../stand';

/** What a channel plots in, as a person reads it: pressure (gauge on the
 *  wire, psia here) or temperature. Thrust, O/F and flows are the Engine
 *  page's. */
const shownUnit = (c: { unit?: string }) => (isPressureChannel(c) ? PRESSURE_UNIT : unitLabel(c.unit ?? ''));
/** A channel's samples, in its shown unit. */
const shownValues = (c: { unit?: string; values: number[] }) =>
  isPressureChannel(c) ? c.values.map(toPsia) : c.values;

const PLOTTED = [PRESSURE_UNIT, 'K'];

/** A temperature channel the twin has nothing to read for: the node its
 *  thermocouple sits on carries no temperature, and the wire sends 0 K --
 *  which no sensor reads. Plotted, it was a flat line at absolute zero. */
const unread = (c: { unit?: string; values: number[] }) =>
  !isPressureChannel(c) && c.unit === 'K' && c.values.every((v) => !(v > 0));

export function Plots() {
  const {
    history: result,
    live,
    hidden: silenced,
    toggleChannel,
    nameOf,
    consoleHidden,
    hideOnConsole,
    consoleOrder,
  } = useStand();
  // The console's order (dragged on its strip), here too.
  const channels = ordered(result?.channels ?? [], consoleOrder.pts, (c) => c.id);
  const hidden: Record<string, boolean> = {};
  for (const c of result?.channels ?? []) {
    hidden[c.id] = Boolean(silenced[c.id]) || Boolean(consoleHidden[c.id]);
  }
  // A chip hidden from the console is put back on it; otherwise it mutes the
  // trace, as the console's bar does.
  const flip = (id: string) => (consoleHidden[id] ? hideOnConsole([id], false) : toggleChannel(id));
  const [showOff, setShowOff] = useState(false);
  const eventsKey = (result?.events ?? []).map((e) => `${e.t}:${e.label}`).join('|');
  const marks = useMemo(() => result?.events ?? [], [eventsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const offConsole = channels.filter((c) => PLOTTED.includes(shownUnit(c)) && consoleHidden[c.id]);

  // The whole trace at full rate, not the plot's thinned copy: what someone
  // takes into a spreadsheet or a notebook.
  const downloadCsv = async () => {
    if (!live?.id) return;
    const full = await sessionHistory(live.id, 3600, 0);
    const cols = full.channels;
    const states = full.events ?? [];
    let at = 0;
    let state = states.length ? '' : live.state;
    const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [
      ['t_s', 'state', ...cols.map((c) => `${nameOf(c.id, c.tag)} [${shownUnit(c)}]`)].map(quote).join(','),
      ...full.times_s.map((t, i) => {
        while (at < states.length && states[at].t <= t) state = states[at++].label;
        // Pressures in psia, as the column says: 3 places keeps the wire's
        // hundredths of a psi.
        return [
          t.toFixed(3),
          quote(state),
          ...cols.map((c) => {
            const v = c.values[i];
            if (v === undefined || v === null) return '';
            return isPressureChannel(c) ? toPsia(v).toFixed(3) : String(v);
          }),
        ].join(',');
      }),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `feed-twin-${live.id}-${Math.round(live.t)}s.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!result) return <p className="p-6 text-sm text-text-muted">Nothing solved yet.</p>;

  // Grouped by unit, one panel each -- never one axis carrying both.
  //
  // Thermocouples and RTDs arrive in kelvin now, and 250 K plotted against
  // 550 psi on a shared axis is a dual-axis chart wearing a disguise: the two
  // traces cross wherever the scales happen to put them and the crossing means
  // nothing. Two measures of different scale get two charts.
  // The engine's own channels (thrust, O/F, flows) are on the Engine page;
  // chamber pressure is a pressure and plots here with the tanks.
  const groups = PLOTTED.flatMap((unit) => {
    const inUnit = channels.filter((c) => shownUnit(c) === unit && !unread(c));
    const blind = channels.filter((c) => shownUnit(c) === unit && unread(c));
    if (inUnit.length === 0 && blind.length === 0) return [];
    // One colour per line on a panel: the DAQ's own where it has one, else
    // the next unused shade -- the tags alone gave every thermocouple blue.
    const colors = channelPalette(inUnit.map((c) => c.tag));
    return [{
      unit,
      label: unit === 'K' ? 'Temperature (K)' : `Pressure (${PRESSURE_UNIT})`,
      all: inUnit,
      blind,
      shown: inUnit
        .filter((c) => !hidden[c.id])
        .map((c): Channel => ({
          key: c.id,
          tag: nameOf(c.id, c.tag),
          values: shownValues(c),
          color: colors[c.tag] ?? channelColor(c.tag),
        })),
    }];
  });

  const single = result.times_s.length < 2;

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="caps">
          Channel history
        </h2>
        <span className="text-[11.5px] text-gray-600">{result.message}</span>
        <button
          type="button"
          onClick={() => void downloadCsv()}
          className="ml-auto rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:text-[var(--ink)]"
          title="Every channel the stand records, at full rate, over the last hour of stand time: one column per channel (by its console name), time in the first, and the state."
        >
          Download CSV
        </button>
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
                <span style={{ color: channelColor(c.tag) }}>{nameOf(c.id, c.tag)}</span>{' '}
                <span className="text-text">{fixed(shownValues(c)[0] ?? 0, 1)}</span>
                <span className="text-gray-600"> {shownUnit(c)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {groups.map((g) => (
            <div
              key={g.unit}
              className={`bg-card flex flex-col rounded-lg border border-gray-800 p-3 ${g.all.length ? 'min-h-[220px] flex-1' : ''}`}
            >
              {g.all.length > 0 && (
                <DaqPlot
                  times={result.times_s}
                  channels={g.shown}
                  yLabel={g.label}
                  xLabel="stand time (s)"
                  fill={g.unit === PRESSURE_UNIT}
                  allowLog={g.unit === PRESSURE_UNIT}
                  floor={g.unit === PRESSURE_UNIT ? 0 : undefined}
                  marks={marks}
                />
              )}
              {g.blind.length > 0 && (
                <p
                  className="mt-1 font-mono text-[11px] text-[var(--ink-3)]"
                  title="The twin models no temperature where these sit, so there is nothing to plot. The real stand's sensors read here."
                >
                  no sensor reading: {g.blind.map((c) => nameOf(c.id, c.tag)).join(', ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The channels on the plots have their own pills, with readings, under
          each plot. Only what the console hides needs a way back -- folded,
          it used to be thirty chips under every view. */}
      {offConsole.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowOff((v) => !v)}
            className="font-mono text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]"
            title="Channels the console hides (its ⋯ or the P&ID's Symbols panel). Click one to put it back on the console and here."
          >
            {showOff ? '−' : '+'} {offConsole.length} hidden from the console
          </button>
          {showOff &&
            offConsole.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => flip(c.id)}
                className="flex items-center gap-1.5 rounded border border-gray-800 px-2 py-0.5 font-mono text-[11px] opacity-60 hover:border-gray-600 hover:opacity-100"
              >
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: channelColor(c.tag) }} />
                {nameOf(c.id, c.tag)}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
