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
 * tab and the Knobs page (lib/useHookup), saved from the bar at the panel's
 * foot.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
  fold,
  move,
  nameHint,
  rename,
  rowsOf,
  setAlias,
  tableIssues,
  unwire,
  unwiredRows,
  wire,
} from '../lib/hookupDraft';
import { NO_UI, badge, clashNote, dropFreshRow, type DaqUi, type FreshRow, type Store } from '../lib/daqDrag';
import { useHookup } from '../lib/useHookup';
import { useStand } from '../stand';
import { HookupStatus, ReadOnly } from './HookupSaveBar';
import { OpensIn } from './OpensIn';
import { useDaqUi } from './DaqBox';

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
    // data-editing: an open card with this in it stays open when the drawing
    // focuses another symbol (DrawingPanel), so a half-typed value survives.
    <div data-editing className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-blue-900/60 bg-blue-950/20 p-2">
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

/** Where a symbol's cable goes on the DAQ box, or that it has none. */
function ConnectorBadge({
  channel,
  label,
  valve,
}: {
  channel: ChannelDef | undefined;
  label?: string;
  valve: boolean;
}) {
  if (!channel) {
    return (
      <span
        className="shrink-0 rounded border border-amber-900/60 px-1 font-mono text-[9.5px] text-amber-300/80"
        title={
          valve
            ? 'Not on the DAQ box: no state moves it and the console does not show it.'
            : 'Not on the DAQ box: the console does not show it.'
        }
      >
        not wired
      </span>
    );
  }
  return (
    <span
      className="shrink-0 rounded border border-[var(--line-strong)] px-1 font-mono text-[9.5px] text-gray-300"
      title={`On the DAQ box: ${badge(channel)} (${label ?? channel.board}, connector ${channel.slot})`}
    >
      {badge(channel)}
    </span>
  );
}

/** A field of the hookup section: a label column and the control. On the
 *  control's baseline when a line may sit under it. */
function Field({
  label,
  title,
  baseline = false,
  children,
}: {
  label: string;
  title?: string;
  baseline?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex ${baseline ? 'items-baseline' : 'items-center'} gap-2 text-[11px] text-gray-500`} title={title}>
      <span className="w-[4.5rem] shrink-0">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

const control =
  'min-w-0 rounded border border-gray-700 bg-black/60 px-1.5 py-0.5 text-[12px] text-white placeholder:text-gray-600 disabled:opacity-50';

/** A connector name, typed freely and committed on Enter or leaving the
 *  field. Under it, what the name will do to the state table -- or, in red,
 *  which connector already has it (refused: leaving puts the old one back). */
function NameInput({
  value,
  clashOf,
  hintOf,
  rows,
  disabled,
  autoFocus,
  onCommit,
}: {
  value: string;
  /** "LOX Main is S12·1 → OM-R" for a name another connector has. */
  clashOf: (name: string) => string | null;
  /** What committing this name does to the table (valves only). */
  hintOf?: (name: string) => { text: string; title: string } | null;
  /** The state table's rows nothing is wired to, offered as names. */
  rows?: string[];
  disabled: boolean;
  autoFocus?: boolean;
  onCommit: (name: string) => void;
}) {
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  const clash = typed.trim() ? clashOf(typed) : null;
  const hint = clash ? null : (hintOf?.(typed) ?? null);
  const listId = useMemo(() => `rows-${Math.random().toString(36).slice(2)}`, []);
  const commit = () => {
    if (!typed.trim() || clash) return setTyped(value);
    if (typed.trim() !== value) onCommit(typed.trim());
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col">
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
          // On a clash Enter does nothing: the red line says why, and leaving
          // the field puts the old name back.
          if (e.key === 'Enter' && !clash) (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setTyped(value);
        }}
        className={`${control} ${clash ? 'border-red-500' : ''}`}
      />
      {rows && (
        <datalist id={listId}>
          {rows.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      )}
      {(clash || hint) && (
        <span
          className={`mt-0.5 truncate text-[10.5px] ${clash ? 'text-red-300' : 'text-gray-500'}`}
          title={clash ? 'Another connector has this name: leaving the field puts the old one back' : hint?.title}
        >
          {clash ?? hint?.text}
        </span>
      )}
    </div>
  );
}

/** The cards to leave open when `id` opens: it, and any with an override
 *  half typed (EditForm marks itself), which closing would throw away. */
function openWith(id: string | null): Record<string, boolean> {
  const editing = [...document.querySelectorAll('[data-editing]')]
    .map((el) => el.closest('li[id^="symbol-"]')?.id.slice('symbol-'.length))
    .filter((x): x is string => Boolean(x));
  return Object.fromEntries([...editing, ...(id ? [id] : [])].map((x) => [x, true]));
}

/** The P&ID's DAQ box state, when the panel sits beside the box. */
const BoxUi = createContext<Store<DaqUi> | null>(null);

/** The symbol's place on the DAQ box: which board and connector, its name,
 *  and -- for a valve -- the states that open it. */
function DaqSection({ symbol, cut }: { symbol: HookupSymbol; cut: boolean }) {
  const hookup = useHookup();
  const ui = useContext(BoxUi);
  const { draft } = hookup;
  const [justWired, setJustWired] = useState(false);
  // Plugged from here a moment ago and named by the twin's guess: the first
  // rename corrects the guess (the guessed row stays the table's), and a
  // blank row made for the tag goes if nothing uses it. One record with the
  // DAQ box (the P&ID keeps it), so a cable plugged there and renamed here is
  // still a guess being corrected.
  const [own, setOwn] = useState<FreshRow | null>(null);
  const shared = useDaqUi(ui ?? NO_UI, (x) => x.fresh);
  const fresh = ui ? shared : own;
  const setFresh = (f: FreshRow | null) => (ui ? ui.set({ fresh: f }) : setOwn(f));
  if (!draft) return null;
  const channel = channelOf(draft, symbol.id);
  const boards = hookup.boards.filter((b) => b.kind === symbol.kind);
  const locked = hookup.locked;
  const isValve = symbol.kind === 'valve';
  const slots = channel ? Math.max(rowsOf(draft, channel.board) * PER_ROW, channel.slot) : 0;
  const unplug = () => {
    // A guess made for this cable goes with it; another cable's stays.
    const mine = fresh?.symbol === symbol.id;
    hookup.update((d) => (mine ? dropFreshRow(unwire(d, symbol.id), fresh) : unwire(d, symbol.id)));
    if (mine) setFresh(null);
  };

  return (
    <div className="flex flex-col gap-1 border-t border-[var(--line)]/60 px-2 py-1.5">
      <Field
        label="DAQ box"
        title="The board and connector its cable goes to. 12 V/24 V and low/high PT are labels only: either board takes either."
      >
        <select
          value={channel?.board ?? ''}
          disabled={locked}
          title={
            channel
              ? undefined
              : isValve
                ? 'Not on the DAQ box: no state moves it and the console does not show it. Pick a board to wire it.'
                : 'Not on the DAQ box: the console does not show it. Pick a board to wire it.'
          }
          onChange={(e) => {
            const board = e.target.value as BoardId | '';
            if (!board) return unplug();
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
        {channel && (
          <button
            type="button"
            disabled={locked}
            onClick={unplug}
            className="shrink-0 rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:border-red-400/60 hover:text-red-300 disabled:opacity-40"
            title={isValve ? 'Pull the cable. Its actuator stays in the state table.' : 'Pull the cable'}
          >
            Unplug
          </button>
        )}
      </Field>
      {channel ? (
        <Field
          label="Name"
          baseline
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
            clashOf={(n) => clashNote(draft, n, symbol.id, (id) => hookup.symbol(id)?.label ?? hookup.label(id))}
            hintOf={isValve ? (n) => nameHint(draft, symbol.id, n, fresh?.symbol !== symbol.id) : undefined}
            onCommit={(n) => {
              const guessed = fresh?.symbol === symbol.id;
              hookup.update((d) => {
                const next = rename(d, symbol.id, n, !guessed);
                return guessed ? dropFreshRow(next, fresh) : next;
              });
              // Named by a person now: the actuator is theirs. Only this
              // cable's guess, and not for a change of case (as the DAQ box).
              if (guessed && fold(n) !== fold(channel.name)) setFresh(null);
            }}
          />
        </Field>
      ) : null}
      {channel && isValve && <OpensIn machine={draft.machine} name={channel.name} />}
      {cut && (
        <p className="text-[11px] text-gray-500" title="The drawn GSE is ignored: the stand is the rocket alone. The cable is kept.">
          Cart · not simulated
        </p>
      )}
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
          {symbol && (
            <ConnectorBadge
              channel={channel}
              label={channel && hookup.board(channel.board)?.label}
              valve={symbol.kind === 'valve'}
            />
          )}
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
              No numbers.
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

const GROUP_TITLES = ['Valves', 'Sensors', 'Tanks, gauges, hand valves', 'Other', 'Cart · not simulated'];

export function DrawingPanel({
  focus = null,
  onFocus = () => undefined,
  ui = null,
}: {
  /** The symbol to open: clicked on the drawing, or opened here. */
  focus?: string | null;
  onFocus?: (id: string | null) => void;
  /** The DAQ box's state (P&ID tab), shared so the two panels agree. */
  ui?: Store<DaqUi> | null;
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

  // A symbol clicked on the drawing opens here, in view: the search and
  // filter are cleared only when they hide it, and a card with an override
  // being typed stays open.
  const scrollTo = useRef<string | null>(null);
  const listed = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!focus) return;
    setOpen(openWith(focus));
    if (!listed.current.has(focus)) {
      setQuery('');
      setFilter('all');
    }
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

  listed.current = new Set(shown.map((el) => el.id));
  if (!view) {
    return <p className="p-3 text-[12px] text-gray-500">{error || 'Loading…'}</p>;
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
  // Not the rows the twin reads by name (the built-in COPV charge and dump):
  // they drive something with nothing wired to them.
  const builtin = hookup.data?.builtin ?? {};
  const issues = draft ? tableIssues(draft) : { unwired: [], rowless: [] };
  issues.unwired = issues.unwired.filter((r) => !(r in builtin));

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
    <BoxUi.Provider value={ui}>
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 border-b border-[var(--line)] px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span
            className="min-w-0 text-[11px] leading-snug text-gray-500"
            title="Valves on a solenoid board are opened by the states that open their name (State machine tab). Transducers on a PT board show on the console under their name."
          >
            On the DAQ box: {vw}/{vt} valves · {sw}/{st} sensors
          </span>
          <HookupStatus />
          <ReadOnly />
          <span className="ml-auto truncate font-mono text-[10px] text-gray-600" title={view.source}>
            {view.key}
          </span>
        </div>
        {issues.unwired.length > 0 && (
          <Link
            to="/statemachine"
            className="mt-0.5 block text-[11px] text-amber-300/80 hover:underline"
            title={`Actuators in the state table no connector goes by, so they command nothing: ${issues.unwired.join(', ')}`}
          >
            {issues.unwired.length} actuator{issues.unwired.length > 1 ? 's' : ''} not wired
          </Link>
        )}
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
                // One open at a time: it is the one ringed on the drawing
                // (and any with an override being typed).
                const opening = !open[el.id];
                // Closed by hand, it closes, half-typed or not.
                const { [el.id]: _closed, ...others } = openWith(null);
                setOpen(opening ? openWith(el.id) : others);
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
    </BoxUi.Provider>
  );
}
