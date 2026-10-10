/**
 * What feed-twin pulled from the drawing, and what it did to it.
 *
 * Every symbol and line, every number on it, and for each number which of
 * three things the model is using: what the drawing says, what the library
 * filled in because the drawing said nothing, or what somebody here typed over
 * it. A typed number is an override kept by feed-twin, not an edit to the
 * drawing -- pid-designer never sees it -- and it carries a source, a reference,
 * a name and a time like every other number on the stand.
 *
 * Overrides and console visibility are the team's, kept on the server under the
 * drawing's name, so they survive a re-import and read the same in every
 * browser. An override made before the drawing changed the number underneath
 * it is flagged rather than quietly winning.
 *
 * It is also the hookup, symbol by symbol (hookup method A; the DAQ box
 * beside it is method B, the same hookup drawn as the box): which board and
 * connector a valve or transducer is wired to, the name that connector goes
 * by -- the console's name and, for a valve, its row in the state table --
 * and the states that open it. One draft with the DAQ box, the State machine
 * tab and the Hookup page (lib/useHookup), saved from the bar at the top.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  clearOverride,
  getDrawingData,
  setOverride,
  type BoardId,
  type ChannelDef,
  type DrawingElement,
  type DrawingParam,
  type DrawingData,
  type HookupSymbol,
  type ParamValue,
} from '../api';
import {
  PER_ROW,
  channelAt,
  channelOf,
  move,
  nameTaken,
  opensIn,
  rename,
  rowNamed,
  rowsOf,
  setAlias,
  tableIssues,
  unwire,
  unwiredRows,
  wire,
} from '../lib/hookupDraft';
import { dropFreshRow, type FreshRow } from '../lib/daqDrag';
import { useHookup } from '../lib/useHookup';
import { useStand } from '../stand';
import { HookupSaveBar } from './HookupSaveBar';

/** Another operator's override should show up without a reload. */
const POLL_MS = 10000;

const SOURCE_STYLE: Record<string, string> = {
  measured: 'text-green-400 border-green-900/70',
  manufacturer: 'text-sky-300 border-sky-900/70',
  estimated: 'text-amber-300 border-amber-900/70',
  default: 'text-red-300 border-red-900/70',
  resolved: 'text-gray-300 border-gray-700',
};

function num(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(3);
  return String(Number(v.toPrecision(5)));
}

function Source({ source, override = false }: { source: string; override?: boolean }) {
  return (
    <span
      className={`rounded border px-1 py-px font-mono text-[9px] uppercase tracking-wider ${
        override ? 'border-blue-800 text-blue-300' : (SOURCE_STYLE[source] ?? 'border-gray-700 text-gray-400')
      }`}
    >
      {override ? `override · ${source}` : source}
    </span>
  );
}

function Value({ v }: { v: ParamValue }) {
  return (
    <span className="font-mono tabular-nums">
      {num(v.value)} <span className="text-gray-500">{v.unit}</span>
    </span>
  );
}

function EditForm({
  param,
  sources,
  onSave,
  onCancel,
}: {
  param: DrawingParam;
  sources: string[];
  onSave: (v: { value: number; unit: string; source: string; reference: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const start = param.override ?? param.effective;
  const [value, setValue] = useState(start ? String(start.value) : '');
  const [unit, setUnit] = useState(start?.unit ?? param.units[0] ?? '');
  // No source is preselected: there is no default provenance, on purpose.
  const [source, setSource] = useState(param.override?.source ?? '');
  const [reference, setReference] = useState(param.override?.reference ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const n = Number(value);
  // Every number on the stand says where it came from: no default source.
  const missing = [
    !(value.trim() !== '' && Number.isFinite(n)) && 'a value',
    !source && 'a source',
    !reference.trim() && 'a reference',
  ].filter(Boolean) as string[];
  const ready = missing.length === 0 && Boolean(unit);

  async function save() {
    if (!ready) return;
    setSaving(true);
    setError('');
    try {
      await onSave({ value: n, unit, source, reference: reference.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const field =
    'rounded-md border border-gray-700 bg-black/60 px-2 py-1 text-[12px] text-white focus:border-blue-500 focus:outline-none';
  return (
    <div className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-blue-900/60 bg-blue-950/20 p-2">
      <div className="flex gap-1.5">
        <input
          autoFocus
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') onCancel();
          }}
          className={`${field} min-w-0 flex-1 font-mono tabular-nums`}
          aria-label={`${param.name} value`}
        />
        <select value={unit} onChange={(e) => setUnit(e.target.value)} className={`${field} w-24`} aria-label="unit">
          {param.units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className={`mr-1 text-[10px] uppercase tracking-wider ${source ? 'text-gray-500' : 'text-amber-300'}`}>
          source
        </span>
        {sources.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSource(s)}
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
              source === s ? (SOURCE_STYLE[s] ?? '') + ' bg-white/5' : 'border-[var(--line)] text-gray-500 hover:text-gray-300'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={reference}
        placeholder="Reference: the datasheet, the gauge, the reasoning"
        onChange={(e) => setReference(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') onCancel();
        }}
        className={`${field} ${reference.trim() ? '' : 'border-amber-900/70'}`}
        aria-label="reference"
      />
      {error && <p className="text-[11px] text-red-300">{error}</p>}
      <div className="flex items-center justify-end gap-1.5">
        {missing.length > 0 && (
          <span className="mr-auto text-[11px] text-amber-300">Needs {missing.join(', ')}</span>
        )}
        <button type="button" onClick={onCancel} className="rounded px-2 py-0.5 text-[11px] text-gray-400 hover:text-white">
          Cancel
        </button>
        <button
          type="button"
          disabled={!ready || saving}
          onClick={() => void save()}
          className="rounded bg-blue-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ParamRow({
  param,
  sources,
  locked,
  onSave,
  onRevert,
}: {
  param: DrawingParam;
  sources: string[];
  locked: boolean;
  onSave: (v: { value: number; unit: string; source: string; reference: string }) => Promise<void>;
  onRevert: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const { override, drawing, assumed, effective } = param;
  const under = drawing ?? assumed;

  // Where the number came from, on hover: a sentence under every number
  // buried the numbers.
  const why = override
    ? ''
    : !drawing && assumed
      ? `Not on the drawing; the library filled it in. ${assumed.reference}`
      : (drawing?.reference ?? '');
  return (
    <li className="border-t border-[var(--line)]/60 px-2 py-1.5 text-[12px]" title={why || undefined}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gray-300" title={param.name}>
          {param.name}
        </span>
        {effective && <Value v={effective} />}
        {effective && <Source source={effective.source} override={Boolean(override) && !param.locked} />}
        {!editing && !param.locked && !locked && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded px-1 font-mono text-[10px] text-gray-500 hover:bg-white/5 hover:text-blue-300"
          >
            edit
          </button>
        )}
      </div>

      {override && under && (
        <div className="mt-0.5 flex items-baseline gap-1.5 pl-2 text-[11px] text-gray-500">
          <span>{drawing ? 'drawing says' : 'library default'}</span>
          <Value v={under} />
          <Source source={under.source} />
        </div>
      )}
      {override && (
        <div className="mt-0.5 pl-2 text-[11px] leading-snug text-gray-500">
          <span className="text-gray-400">{override.by || 'someone'}</span>
          {override.at && <span> · {new Date(override.at).toLocaleString()}</span>}
          {override.reference && <span> · {override.reference}</span>}
          {!editing && !locked && (
            <button
              type="button"
              onClick={() => void onRevert()}
              className="ml-1.5 rounded px-1 font-mono text-[10px] text-blue-300 hover:bg-blue-900/40"
            >
              revert
            </button>
          )}
        </div>
      )}
      {param.stale && override && (
        <p className="mt-0.5 pl-2 text-[11px] leading-snug text-amber-300">
          The drawing changed underneath this override
          {override.was ? (
            <>
              {' '}— it said {num(override.was.value)} {override.was.unit} when the override was made
            </>
          ) : (
            ' — it said nothing when the override was made'
          )}
          . Keep it, or revert to the drawing.
        </p>
      )}
      {param.locked && <p className="mt-0.5 pl-2 text-[11px] text-gray-600">{param.locked}</p>}

      {editing && (
        <EditForm
          param={param}
          sources={sources}
          onCancel={() => setEditing(false)}
          onSave={async (v) => {
            await onSave(v);
            setEditing(false);
          }}
        />
      )}
    </li>
  );
}

/** A board's short name, for a badge. */
const SHORT: Record<BoardId, string> = {
  sol12: 'S12',
  sol24: 'S24',
  pt_low: 'PT-L',
  pt_high: 'PT-H',
  rtd: 'RTD',
  tc: 'TC',
};

/** Where a symbol's cable goes on the DAQ box, or that it has none. */
function ConnectorBadge({ channel, label }: { channel: ChannelDef | undefined; label?: string }) {
  if (!channel) {
    return (
      <span
        className="shrink-0 rounded border border-amber-900/60 px-1 font-mono text-[9.5px] text-amber-300/80"
        title="Not on the DAQ box: no state moves it and the console does not show it."
      >
        not wired
      </span>
    );
  }
  return (
    <span
      className="shrink-0 rounded border border-[var(--line-strong)] px-1 font-mono text-[9.5px] text-gray-300"
      title={`On the DAQ box: ${label ?? channel.board}, connector ${channel.slot}`}
    >
      {SHORT[channel.board]}·{channel.slot}
    </span>
  );
}

/** A field of the hookup section: a label column and the control. */
function Field({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-gray-500" title={title}>
      <span className="w-[4.5rem] shrink-0">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

const control =
  'min-w-0 rounded border border-gray-700 bg-black/60 px-1.5 py-0.5 text-[12px] text-white placeholder:text-gray-600 disabled:opacity-50';

/** A connector name, typed freely and committed on Enter or leaving the
 *  field: a name another connector has is refused, in red. */
function NameInput({
  value,
  taken,
  rows,
  disabled,
  autoFocus,
  onCommit,
}: {
  value: string;
  taken: (name: string) => boolean;
  /** The state table's rows nothing is wired to, offered as names. */
  rows?: string[];
  disabled: boolean;
  autoFocus?: boolean;
  onCommit: (name: string) => void;
}) {
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  const clash = typed.trim() !== '' && typed.trim().toLowerCase() !== value.toLowerCase() && taken(typed);
  const listId = useMemo(() => `rows-${Math.random().toString(36).slice(2)}`, []);
  const commit = () => {
    if (!typed.trim() || clash) return setTyped(value);
    if (typed.trim() !== value) onCommit(typed.trim());
  };
  return (
    <>
      <input
        type="text"
        value={typed}
        autoFocus={autoFocus}
        disabled={disabled}
        list={rows ? listId : undefined}
        onChange={(e) => setTyped(e.target.value)}
        // Selected on the way in: a fresh connector's tag is there to be
        // typed over ("Lox Main"), not appended to.
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setTyped(value);
        }}
        title={clash ? 'Another connector already has this name' : undefined}
        className={`${control} flex-1 ${clash ? 'border-red-500' : ''}`}
      />
      {rows && (
        <datalist id={listId}>
          {rows.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      )}
    </>
  );
}

/** The symbol's place on the DAQ box: which board and connector, its name,
 *  and -- for a valve -- the states that open it. */
function DaqSection({ symbol, cut }: { symbol: HookupSymbol; cut: boolean }) {
  const hookup = useHookup();
  const { draft } = hookup;
  const [justWired, setJustWired] = useState(false);
  // Plugged from here a moment ago and named by the twin's guess: the first
  // rename corrects the guess (the guessed row stays the table's), and a
  // blank row made for the tag goes if nothing uses it.
  const [fresh, setFresh] = useState<FreshRow | null>(null);
  if (!draft) return null;
  const channel = channelOf(draft, symbol.id);
  const boards = hookup.boards.filter((b) => b.kind === symbol.kind);
  const locked = hookup.locked;
  const isValve = symbol.kind === 'valve';
  const row = channel && isValve ? rowNamed(draft.machine, channel.name) : undefined;
  const opens = row ? opensIn(draft.machine, row) : [];
  const slots = channel ? Math.max(rowsOf(draft, channel.board) * PER_ROW, channel.slot) : 0;

  return (
    <div className="flex flex-col gap-1 border-t border-[var(--line)]/60 px-2 py-1.5">
      <Field
        label="DAQ"
        title="The board and connector its cable goes to. 12 V and 24 V, low and high pressure, are yours to tell apart: either takes it."
      >
        <select
          value={channel?.board ?? ''}
          disabled={locked}
          onChange={(e) => {
            const board = e.target.value as BoardId | '';
            if (!board) {
              setFresh(null);
              return hookup.update((d) => dropFreshRow(unwire(d, symbol.id), fresh));
            }
            const name = channel?.name ?? hookup.suggestedName(symbol.id);
            if (!channel) {
              const made = wire(draft, symbol, board, undefined, name).machine.actuators.find(
                (a) => !draft.machine.actuators.includes(a),
              );
              setFresh({ symbol: symbol.id, row: made ?? null });
            }
            setJustWired(!channel);
            hookup.update((d) => wire(d, symbol, board, undefined, name));
          }}
          className={`${control} flex-1`}
        >
          <option value="">Not wired</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
        {channel && (
          <select
            value={channel.slot}
            disabled={locked}
            aria-label="connector"
            onChange={(e) =>
              hookup.update((d) => move(d, channel, { board: channel.board, slot: Number(e.target.value) }))
            }
            className={`${control} w-[4.5rem]`}
            title="Connector number. Picking a taken one swaps the two."
          >
            {Array.from({ length: slots }, (_, i) => i + 1).map((n) => {
              const there = channelAt(draft, channel.board, n);
              return (
                <option key={n} value={n}>
                  #{n}
                  {there && there.symbol !== symbol.id ? ` · ${there.name}` : ''}
                </option>
              );
            })}
          </select>
        )}
      </Field>
      {channel ? (
        <Field
          label="Name"
          title={
            isValve
              ? 'What the console calls it, and its row in the state table: the states that open this name open this valve. Pick a row the table already has to take its states.'
              : 'What the console calls it.'
          }
        >
          <NameInput
            value={channel.name}
            disabled={locked}
            autoFocus={justWired}
            rows={isValve ? unwiredRows(draft) : undefined}
            taken={(n) => nameTaken(draft, n, symbol.id)}
            onCommit={(n) => {
              const guessed = fresh?.symbol === symbol.id;
              hookup.update((d) => {
                const next = rename(d, symbol.id, n, !guessed);
                return guessed ? dropFreshRow(next, fresh) : next;
              });
              setFresh(null);
            }}
          />
        </Field>
      ) : (
        <p className="text-[11px] text-gray-500">
          {isValve
            ? 'Not on the DAQ: no state moves it and the console does not show it. Pick a board to wire it.'
            : 'Not on the DAQ: the console does not show it. Pick a board to wire it.'}
        </p>
      )}
      {channel && isValve && (
        <Field label="Opens in" title="The states whose column opens this name. Change them on the State machine tab.">
          {opens.length ? (
            <span className="flex min-w-0 flex-wrap gap-1">
              {opens.map((s) =>
                s.toLowerCase() === 'idle' ? (
                  <span
                    key={s}
                    className="rounded px-1 font-mono text-[10.5px] text-gray-500 line-through"
                    title="The table opens it in Idle, but the twin holds Idle shut: a de-energised stand has nothing open."
                  >
                    {s}
                  </span>
                ) : (
                  <span key={s} className="rounded bg-[#0b140e] px-1 font-mono text-[10.5px] text-[var(--color-success)]">
                    {s}
                  </span>
                ),
              )}
            </span>
          ) : (
            <span className="text-amber-300/80">{row ? 'no state yet' : 'not a row in the state table'}</span>
          )}
          <Link to="/statemachine" className="ml-auto shrink-0 text-[10.5px] text-blue-400 hover:underline">
            Edit →
          </Link>
        </Field>
      )}
      {cut && <p className="text-[11px] text-gray-500">On the cart, which is not simulated while the drawn GSE is ignored.</p>}
    </div>
  );
}

function ElementCard({
  el,
  open,
  onOpen,
  sources,
  locked,
  symbol,
  consoleHidden,
  onConsole,
  cut,
  focused,
  onSave,
  onRevert,
}: {
  el: DrawingElement;
  open: boolean;
  onOpen: () => void;
  sources: string[];
  locked: boolean;
  /** The symbol as the DAQ box knows it, when one can be wired. */
  symbol: HookupSymbol | undefined;
  consoleHidden: boolean;
  onConsole: (hide: boolean) => void;
  /** Off the stand: the cart, with the drawn GSE ignored. */
  cut: boolean;
  focused: boolean;
  onSave: (p: DrawingParam, v: { value: number; unit: string; source: string; reference: string }) => Promise<void>;
  onRevert: (p: DrawingParam) => Promise<void>;
}) {
  const hookup = useHookup();
  const overridden = el.params.filter((p) => p.override).length;
  const stale = el.params.some((p) => p.stale);
  const assumed = el.params.filter((p) => !p.override && !p.drawing && p.assumed).length;
  const channel = symbol && hookup.draft ? channelOf(hookup.draft, symbol.id) : undefined;
  const alias = hookup.draft?.aliases?.[el.id] ?? '';
  const name = channel?.name ?? alias;
  // On the console: what is on the DAQ box, and what the twin shows of its
  // own (a tank, a bottle, a gauge). Not a hand valve: a hand turns it.
  const consoleable = el.on_console && !cut && (symbol ? Boolean(channel) : el.type !== 'MAN');
  const named = el.on_console && !symbol && el.type !== 'MAN';

  return (
    <li
      id={`symbol-${el.id}`}
      className={`rounded-md border bg-black/20 ${focused ? 'border-blue-500/70' : 'border-[var(--line)]'}`}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
          <span className="w-2 shrink-0 font-mono text-[10px] text-gray-600">{open ? '−' : '+'}</span>
          <span className={`truncate text-[12.5px] ${consoleable && consoleHidden ? 'text-gray-500' : 'text-gray-100'}`}>
            {el.tag}
          </span>
          {name && name !== el.tag && (
            <span className="truncate text-[11.5px] text-gray-400" title="Its name on the console">
              “{name}”
            </span>
          )}
          <span className="shrink-0 font-mono text-[10px] text-gray-600">{el.type}</span>
          {symbol && <ConnectorBadge channel={channel} label={channel && hookup.board(channel.board)?.label} />}
          {overridden > 0 && (
            <span className="shrink-0 rounded bg-blue-950/60 px-1 font-mono text-[9px] text-blue-300">
              {overridden} override{overridden > 1 ? 's' : ''}
            </span>
          )}
          {stale && <span className="shrink-0 font-mono text-[9px] text-amber-300">changed</span>}
          {assumed > 0 && (
            <span
              className="shrink-0 font-mono text-[9px] text-red-300/80"
              title="Numbers the drawing did not give; the library filled them in"
            >
              {assumed} filled in
            </span>
          )}
        </button>
        {consoleable && (
          <label
            className="flex shrink-0 cursor-pointer items-center gap-1 text-[10.5px] text-gray-400"
            title={
              consoleHidden
                ? `Not on the Console tab${el.hidden_by ? ` (hidden by ${el.hidden_by})` : ''}. Tick to show it there, for everyone on this drawing.`
                : 'On the Console tab, for everyone on this drawing. Untick to hide it.'
            }
          >
            <input
              type="checkbox"
              checked={!consoleHidden}
              onChange={(e) => onConsole(!e.target.checked)}
              className="accent-blue-500"
            />
            console
          </label>
        )}
      </div>
      {open && (
        <div className="pb-1">
          {symbol && <DaqSection symbol={symbol} cut={cut} />}
          {!symbol && el.type === 'MAN' && (
            <p className="border-t border-[var(--line)]/60 px-2 py-1.5 text-[11px] text-gray-500">
              A hand valve: not on the DAQ. Click it on the drawing to turn it.
            </p>
          )}
          {named && hookup.draft && !cut && (
            <div className="border-t border-[var(--line)]/60 px-2 py-1.5">
              <Field label="Console name" title="What the console calls it. Not on the DAQ box: the twin shows it of its own.">
                <input
                  type="text"
                  value={alias}
                  placeholder={el.tag}
                  disabled={hookup.locked}
                  onChange={(e) => hookup.update((d) => setAlias(d, el.id, e.target.value))}
                  className={`${control} flex-1`}
                />
              </Field>
            </div>
          )}
          {el.segments > 0 && (
            <p className="px-2 pb-1 text-[11px] text-gray-500">
              Itemised run: {el.segments} segment{el.segments > 1 ? 's' : ''}, read from the drawing.
            </p>
          )}
          {Object.keys(el.options).length > 0 && (
            <p className="px-2 pb-1 font-mono text-[10.5px] text-gray-500">
              {Object.entries(el.options)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')}
            </p>
          )}
          {el.params.length === 0 ? (
            <p className="border-t border-[var(--line)]/60 px-2 py-1.5 text-[11.5px] text-gray-600">
              No numbers on this one — the drawing places it and the model reads nothing else.
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {el.params.map((p) => (
                <ParamRow
                  key={p.name}
                  param={p}
                  sources={sources}
                  locked={locked}
                  onSave={(v) => onSave(p, v)}
                  onRevert={() => onRevert(p)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** A card, with its group's heading above it when it is the group's first. */
function ElementGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      {title && (
        <li className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500">{title}</li>
      )}
      {children}
    </>
  );
}

type Filter = 'all' | 'unwired' | 'changed' | 'filled';

const GROUP_TITLES = [
  'Valves the DAQ can drive',
  'Transducers, RTDs & TCs',
  'Tanks, gauges & hand valves',
  'Other symbols',
  'Cart — not simulated (rocket only)',
];

export function DrawingPanel({
  focus = null,
  onFocus = () => undefined,
}: {
  /** The symbol to open: clicked on the drawing, or opened here. */
  focus?: string | null;
  onFocus?: (id: string | null) => void;
} = {}) {
  const { where, live, consoleHidden, hideOnConsole, restart, model } = useStand();
  const hookup = useHookup();
  const [view, setView] = useState<DrawingData | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showLines, setShowLines] = useState(false);

  const load = useCallback(async () => {
    if (!where.diagram) return;
    try {
      setView(await getDrawingData(where.diagram, where.engine, where.fluidSet));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [where.diagram, where.engine, where.fluidSet]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // A symbol clicked on the drawing opens here, in view, whatever the list
  // was filtered to.
  const scrollTo = useRef<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen({ [focus]: true });
    setQuery('');
    setFilter('all');
    scrollTo.current = focus;
  }, [focus]);
  useEffect(() => {
    if (!scrollTo.current) return;
    const el = document.getElementById(`symbol-${scrollTo.current}`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      scrollTo.current = null;
    }
  });

  const draft = hookup.draft;
  const shown = useMemo(() => {
    if (!view) return [];
    const q = query.trim().toLowerCase();
    return view.elements.filter((el) => {
      // Lines and junctions only on request: a junction carries nothing to set.
      if ((el.kind === 'line' || el.type === 'JUNCTION') && !showLines && filter !== 'changed' && el.id !== focus)
        return false;
      const name = (draft && channelOf(draft, el.id)?.name) ?? draft?.aliases?.[el.id] ?? '';
      if (q && !`${el.tag} ${name} ${el.type} ${el.id} ${el.params.map((p) => p.name).join(' ')}`.toLowerCase().includes(q))
        return false;
      if (filter === 'unwired') return Boolean(hookup.symbol(el.id)) && !(draft && channelOf(draft, el.id));
      if (filter === 'changed') return el.params.some((p) => p.override);
      if (filter === 'filled') return el.params.some((p) => !p.override && !p.drawing && p.assumed);
      return true;
    });
  }, [view, query, filter, showLines, focus, draft, hookup]);

  if (!view) {
    return <p className="p-3 text-[12px] text-gray-500">{error || 'Reading the drawing…'}</p>;
  }

  const locked = Boolean(live?.tripped);
  const pending = live !== null && (live.overrides_hash ?? '') !== view.overrides_hash;
  const total = view.elements.reduce((n, e) => n + e.params.filter((p) => p.override).length, 0);

  // With the drawn GSE ignored the stand is the rocket alone: the cart's
  // symbols are not in it, so nothing set on them shows on the console.
  const rocketOnly = Boolean(live?.setup?.ignore_gse) && Boolean(model?.pages);
  const isCut = (el: DrawingElement) => rocketOnly && el.kind === 'symbol' && !(el.id in (model?.pages ?? {}));
  // What a person comes here for first -- the valves and sensors on the DAQ
  // box -- then what the twin shows of its own, everything else, the cart.
  const groupOf = (el: DrawingElement) => {
    const sym = hookup.symbol(el.id);
    if (isCut(el)) return 4;
    if (sym) return sym.kind === 'valve' ? 0 : 1;
    return el.on_console ? 2 : 3;
  };
  const grouped = [...shown].sort((a, b) => groupOf(a) - groupOf(b));

  // How much of the drawing is on the box, and which rows drive nothing.
  const count = (kind: 'valve' | 'sensor') => {
    const all = hookup.symbols.filter((s) => (kind === 'valve' ? s.kind === 'valve' : s.kind !== 'valve'));
    return [all.filter((s) => draft && channelOf(draft, s.id)).length, all.length];
  };
  const [vw, vt] = count('valve');
  const [sw, st] = count('sensor');
  const issues = draft ? tableIssues(draft) : { unwired: [], rowless: [] };

  const save = async (el: DrawingElement, p: DrawingParam, v: { value: number; unit: string; source: string; reference: string }) => {
    await setOverride({ diagram: view.diagram_id, element: el.id, parameter: p.name, ...v });
    await load();
  };
  const revert = async (el: DrawingElement, p: DrawingParam) => {
    try {
      await clearOverride(view.diagram_id, el.id, p.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await load();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 border-b border-[var(--line)] px-3 py-2">
        <div className="flex items-baseline gap-2">
          <h2
            className="text-[11px] font-bold uppercase tracking-widest text-text-muted"
            title="Every symbol on the drawing: where it is wired on the DAQ box, what the console calls it, the states that open it, and the numbers the model uses. Overrides stay in feed-twin and never touch the drawing in pid-designer; they're shared with everyone and follow the drawing when it's re-imported."
          >
            Symbols
          </h2>
          {hookup.data && (
            <span
              className={`rounded px-1.5 py-px text-[10px] font-semibold ${
                hookup.data.saved ? 'bg-emerald-900/40 text-emerald-300' : 'bg-gray-800 text-gray-300'
              }`}
              title={
                hookup.data.saved
                  ? hookup.onStand
                    ? 'The stand’s own hookup.'
                    : 'Saved for this drawing.'
                  : 'The twin’s suggestion, matched by name: not saved. Until it is, the console shows every valve and transducer.'
              }
            >
              {hookup.data.saved ? 'Saved' : 'Suggested'}
            </span>
          )}
          <span className="ml-auto truncate font-mono text-[10px] text-gray-600" title={view.source}>
            {view.key}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-gray-500" title="Valves on a solenoid board are opened by the states that open their name (State machine tab). Transducers on a PT board show on the console under their name.">
          On the DAQ: {vw}/{vt} valves · {sw}/{st} sensors.
          {issues.unwired.length > 0 && (
            <>
              {' '}
              <Link
                to="/statemachine"
                className="text-amber-300/80 hover:underline"
                title={`State-table rows no connector goes by, so they command nothing: ${issues.unwired.join(', ')}`}
              >
                {issues.unwired.length} row{issues.unwired.length > 1 ? 's' : ''} wired to nothing
              </Link>
            </>
          )}
        </p>
        <HookupSaveBar compact />
        {pending && (
          <div className="mt-1.5 flex items-center gap-2 rounded-md border border-blue-900/70 bg-blue-950/30 px-2 py-1">
            <span className="flex-1 text-[11px] text-blue-200">
              The running stand was built with different overrides. They take effect on Reset.
            </span>
            <button
              type="button"
              onClick={restart}
              className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-500"
            >
              Reset
            </button>
          </div>
        )}
        {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a symbol, a name or a parameter"
          className="mt-2 w-full rounded-md border border-gray-700 bg-black/60 px-2 py-1 text-[12px] text-white focus:border-blue-500 focus:outline-none"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {(
            [
              ['all', 'All'],
              ['unwired', `Not wired · ${vt - vw + (st - sw)}`],
              ['changed', `Overridden${total ? ` · ${total}` : ''}`],
              ['filled', 'Filled in'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              title={
                {
                  all: 'Every symbol',
                  unwired: 'Valves and sensors not on the DAQ box',
                  changed: 'Numbers somebody overrode here',
                  filled: 'Numbers the drawing left blank and the library filled in',
                }[k]
              }
              className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${
                filter === k ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1 text-[10.5px] text-gray-500">
            <input
              type="checkbox"
              checked={showLines}
              onChange={(e) => setShowLines(e.target.checked)}
              className="accent-blue-500"
            />
            lines & junctions
          </label>
        </div>
      </div>

      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-auto p-2">
        {shown.length === 0 && <li className="p-2 text-[12px] text-gray-600">Nothing matches.</li>}
        {grouped.map((el, i) => (
          <ElementGroup key={el.id} title={i === 0 || groupOf(grouped[i - 1]) !== groupOf(el) ? GROUP_TITLES[groupOf(el)] : ''}>
            <ElementCard
              el={el}
              open={Boolean(open[el.id])}
              onOpen={() => {
                // One open at a time: it is the one ringed on the drawing.
                const opening = !open[el.id];
                setOpen(opening ? { [el.id]: true } : {});
                if (opening) onFocus(el.id);
                else if (focus === el.id) onFocus(null);
              }}
              cut={isCut(el)}
              focused={focus === el.id}
              sources={view.override_sources}
              locked={locked}
              symbol={hookup.symbol(el.id)}
              // The stand's list is the whole truth (it is what the console
              // draws). Falling back on this panel's copy -- reloaded every 10 s
              // -- showed a box ticked back on as still off until then.
              consoleHidden={Boolean(consoleHidden[el.id])}
              onConsole={(hide) => hideOnConsole([el.id], hide)}
              onSave={(p, v) => save(el, p, v)}
              onRevert={(p) => revert(el, p)}
            />
          </ElementGroup>
        ))}
        {view.orphaned.length > 0 && (
          <li className="mt-2 rounded-md border border-amber-900/50 px-2 py-1.5 text-[11px] leading-snug text-amber-300/80">
            Kept for symbols this version of the drawing doesn't have: {view.orphaned.join(', ')}. They come back
            if the symbol does.
          </li>
        )}
      </ul>
    </div>
  );
}
