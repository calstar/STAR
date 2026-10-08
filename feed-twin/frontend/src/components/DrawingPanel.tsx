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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clearOverride,
  getDrawing,
  setOverride,
  type DrawingElement,
  type DrawingParam,
  type DrawingView,
  type ParamValue,
} from '../api';
import { useStand } from '../stand';

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
  const ready = value.trim() !== '' && Number.isFinite(n) && unit && source && reference.trim();

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
      <div className="flex flex-wrap gap-1">
        {sources.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSource(s)}
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
              source === s ? (SOURCE_STYLE[s] ?? '') + ' bg-white/5' : 'border-gray-800 text-gray-500 hover:text-gray-300'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={reference}
        placeholder="Where it came from: the gauge, the datasheet, the reasoning"
        onChange={(e) => setReference(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') onCancel();
        }}
        className={field}
        aria-label="reference"
      />
      {error && <p className="text-[11px] text-red-300">{error}</p>}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="rounded px-2 py-0.5 text-[11px] text-gray-400 hover:text-white">
          Cancel
        </button>
        <button
          type="button"
          disabled={!ready || saving}
          onClick={() => void save()}
          title={ready ? '' : 'A value, a source and a reference'}
          className="rounded bg-blue-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Override'}
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

  return (
    <li className="border-t border-gray-800/60 px-2 py-1.5 text-[12px]">
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
      {!override && !drawing && assumed && (
        <p className="mt-0.5 pl-2 text-[11px] leading-snug text-gray-500">
          Not on the drawing; the library filled it in. {assumed.reference}
        </p>
      )}
      {!override && drawing?.reference && (
        <p className="mt-0.5 truncate pl-2 text-[11px] text-gray-600" title={drawing.reference}>
          {drawing.reference}
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

function ElementCard({
  el,
  open,
  onOpen,
  sources,
  locked,
  consoleHidden,
  onConsole,
  onSave,
  onRevert,
}: {
  el: DrawingElement;
  open: boolean;
  onOpen: () => void;
  sources: string[];
  locked: boolean;
  consoleHidden: boolean;
  onConsole: (hide: boolean) => void;
  onSave: (p: DrawingParam, v: { value: number; unit: string; source: string; reference: string }) => Promise<void>;
  onRevert: (p: DrawingParam) => Promise<void>;
}) {
  const overridden = el.params.filter((p) => p.override).length;
  const stale = el.params.some((p) => p.stale);
  const assumed = el.params.filter((p) => !p.override && !p.drawing && p.assumed).length;

  return (
    <li className="rounded-md border border-gray-800 bg-black/20">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
          <span className="w-2 shrink-0 font-mono text-[10px] text-gray-600">{open ? '−' : '+'}</span>
          <span className={`truncate text-[12.5px] ${consoleHidden ? 'text-gray-500' : 'text-gray-100'}`}>{el.tag}</span>
          <span className="shrink-0 font-mono text-[10px] text-gray-600">{el.type}</span>
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
        {el.on_console && (
          <button
            type="button"
            onClick={() => onConsole(!consoleHidden)}
            title={
              consoleHidden
                ? `Hidden from the console for everyone${el.hidden_by ? ` (by ${el.hidden_by})` : ''}. Click to show.`
                : 'Shown on the console. Click to hide it for everyone.'
            }
            className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider transition-colors ${
              consoleHidden
                ? 'border-gray-800 text-gray-600 hover:text-gray-300'
                : 'border-green-900/70 text-green-400 hover:border-green-700'
            }`}
          >
            {consoleHidden ? 'hidden' : 'on console'}
          </button>
        )}
      </div>
      {open && (
        <div className="pb-1">
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
            <p className="border-t border-gray-800/60 px-2 py-1.5 text-[11.5px] text-gray-600">
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

type Filter = 'all' | 'console' | 'changed' | 'filled';

export function DrawingPanel() {
  const { where, live, consoleHidden, hideOnConsole, restart } = useStand();
  const [view, setView] = useState<DrawingView | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showLines, setShowLines] = useState(false);

  const load = useCallback(async () => {
    if (!where.diagram) return;
    try {
      setView(await getDrawing(where.diagram, where.engine, where.fluidSet));
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

  const locked = Boolean(live?.tripped);
  const pending = view !== null && live !== null && (live.overrides_hash ?? '') !== view.overrides_hash;
  const total = view?.elements.reduce((n, e) => n + e.params.filter((p) => p.override).length, 0) ?? 0;

  const shown = useMemo(() => {
    if (!view) return [];
    const q = query.trim().toLowerCase();
    return view.elements.filter((el) => {
      if (el.kind === 'line' && !showLines && filter !== 'changed') return false;
      if (q && !`${el.tag} ${el.type} ${el.id} ${el.params.map((p) => p.name).join(' ')}`.toLowerCase().includes(q))
        return false;
      if (filter === 'console') return el.on_console;
      if (filter === 'changed') return el.params.some((p) => p.override);
      if (filter === 'filled') return el.params.some((p) => !p.override && !p.drawing && p.assumed);
      return true;
    });
  }, [view, query, filter, showLines]);

  if (!view) {
    return <p className="p-3 text-[12px] text-gray-500">{error || 'Reading the drawing…'}</p>;
  }

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
      <div className="flex-shrink-0 border-b border-gray-800 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-text-muted">From the drawing</h2>
          <span className="ml-auto truncate font-mono text-[10px] text-gray-600" title={view.source}>
            {view.key}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-gray-500">
          What feed-twin read and what it uses. Overrides stay here and never touch the drawing in pid-designer.
          They're shared with everyone and follow the drawing when it's re-imported.
        </p>
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
          placeholder="Find a symbol or a parameter"
          className="mt-2 w-full rounded-md border border-gray-700 bg-black/60 px-2 py-1 text-[12px] text-white focus:border-blue-500 focus:outline-none"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {(
            [
              ['all', 'All'],
              ['console', 'On console'],
              ['changed', `Overridden${total ? ` · ${total}` : ''}`],
              ['filled', 'Filled in'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
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
            lines
          </label>
        </div>
      </div>

      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-auto p-2">
        {shown.length === 0 && <li className="p-2 text-[12px] text-gray-600">Nothing matches.</li>}
        {shown.map((el) => (
          <ElementCard
            key={el.id}
            el={el}
            open={Boolean(open[el.id])}
            onOpen={() => setOpen((o) => ({ ...o, [el.id]: !o[el.id] }))}
            sources={view.override_sources}
            locked={locked}
            consoleHidden={consoleHidden[el.id] ?? el.console_hidden}
            onConsole={(hide) => hideOnConsole(el.id, hide)}
            onSave={(p, v) => save(el, p, v)}
            onRevert={(p) => revert(el, p)}
          />
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
