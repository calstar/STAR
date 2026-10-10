/**
 * The State machine tab: the DAQ's State tab, for this drawing.
 *
 * The DAQ's three tables, as its config page edits them: the states (name,
 * place on the console's grid, abort), what each state opens -- one row per
 * solenoid connector name, so a valve cabled to a connector named "LOX Main"
 * on the P&ID opens wherever the "LOX Main" row says -- and the allowed
 * moves. Every edit is a lib/hookupDraft function on the one shared hookup
 * draft (lib/useHookup), so wiring on the P&ID and ticking states here are
 * one change, saved once from either.
 *
 * Built to stay small with a lot of valves: the two matrices scroll inside
 * their cards with sticky headers, columns are ~28 px under vertical names,
 * and the hover crosshair is a style rule, not a re-render of every cell.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { Link } from 'react-router-dom';
import { checkMachine, type MachineDef, type MachineStateDef } from '../api';
import { HookupSaveBar } from '../components/HookupSaveBar';
import {
  type Draft,
  PANEL_COLS,
  addRow,
  addState,
  canGo,
  isOpen,
  lockReason,
  moveState,
  removeRow,
  removeState,
  renameState,
  sameMachine,
  setAllowed,
  setOpen,
  setState,
  tableIssues,
  toActuatorCsv,
  toTransitionCsv,
} from '../lib/hookupDraft';
import { applyCsvFiles, heldShut, panelGrid, rowGroups, withoutAbort } from '../lib/stateTable';
import { useHookup } from '../lib/useHookup';
import { useStand } from '../stand';

const fold = (s: string) => s.trim().toLocaleLowerCase();

const BTN = 'rounded bg-gray-700 px-3 py-1 text-[12px] text-white hover:bg-gray-600 disabled:opacity-40';
const SMALL_BTN =
  'rounded bg-gray-700 px-2 py-0.5 text-[11px] normal-case tracking-normal text-white hover:bg-gray-600 disabled:opacity-40';
const CARD = 'bg-card rounded-lg border border-gray-800';
const CARD_H2_BARE = 'flex items-baseline gap-3 px-4 py-2.5 caps';
const CARD_H2 = `${CARD_H2_BARE} border-b border-gray-800`;
const SUB = 'font-normal normal-case tracking-normal text-gray-600';

const NOT_WIRED =
  'No connector on the DAQ box goes by this name, so it commands nothing. Wire a valve to a solenoid connector with this name on the P&ID tab.';
const NO_ROW = 'No row in the transition table: it can go nowhere until one is given';
const IDLE_HELD = 'The twin holds Idle shut whatever the table says';
const ABORT_ADMITTED = 'Not in the table: the twin admits an abort anyway, the DAQ would refuse it';
const NO_ABORT =
  'Its row of the transition table goes to no abort. The twin admits one from anywhere; the DAQ goes only where the cells say. Tick an abort’s cell under Allowed transitions.';

type Pick = { kind: 'state' | 'row'; name: string } | null;
type Edit = (f: (m: MachineDef) => MachineDef) => void;

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function StateMachineView() {
  const hookup = useHookup();
  const { live } = useStand();
  if (!hookup.data || !hookup.draft) {
    return hookup.error ? (
      <p className="p-6 text-sm text-red-400">{hookup.error}</p>
    ) : (
      <p className="p-6 text-sm text-text-muted">Reading the drawing…</p>
    );
  }
  return <Editor draft={hookup.draft} shipped={hookup.data.machine_shipped} current={live?.state ?? ''} />;
}

function Editor({ draft, shipped, current }: { draft: Draft; shipped: MachineDef; current: string }) {
  const hookup = useHookup();
  const { update, locked, onStand } = hookup;
  const m = draft.machine;
  const [pick, setPick] = useState<Pick>(null);
  const [justAdded, setJustAdded] = useState('');

  const edit = useCallback<Edit>((f) => update((d) => ({ ...d, machine: f(d.machine) })), [update]);

  // A pick whose state or row has gone (renamed, removed, uploaded over) is no pick.
  const picked: Pick =
    pick &&
    (pick.kind === 'state' ? m.states.some((s) => s.name === pick.name) : m.actuators.includes(pick.name))
      ? pick
      : null;
  const pickState = useCallback(
    (name: string) => setPick((p) => (p?.kind === 'state' && p.name === name ? null : { kind: 'state', name })),
    [],
  );
  const pickRow = useCallback(
    (name: string) => setPick((p) => (p?.kind === 'row' && p.name === name ? null : { kind: 'row', name })),
    [],
  );

  // ---------------------------------------------------------------- checks
  const [check, setCheck] = useState<{ ok: boolean; error: string; warnings: string[] } | null>(null);
  const [checkFailed, setCheckFailed] = useState('');
  useEffect(() => {
    let stale = false;
    const timer = window.setTimeout(() => {
      checkMachine(m)
        .then((r) => {
          if (stale) return;
          setCheck(r);
          setCheckFailed('');
        })
        .catch((e) => !stale && setCheckFailed(e instanceof Error ? e.message : String(e)));
    }, 400);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [m]);
  // Rows the twin reads by name (the built-in COPV charge and dump, the
  // transfer tank's press) drive something with no connector: not "wired to
  // nothing", and not to be removed without knowing it.
  const builtin = useMemo(() => hookup.data?.builtin ?? {}, [hookup.data]);
  const issues = useMemo(() => {
    const found = tableIssues(draft);
    return { ...found, unwired: found.unwired.filter((r) => !(r in builtin)) };
  }, [draft, builtin]);
  const noAbort = useMemo(() => withoutAbort(m), [m]);

  // ------------------------------------------------------------- the rows
  const groups = useMemo(() => rowGroups(m.actuators, draft.channels), [m.actuators, draft.channels]);
  // `hookup` is a new object only when the draft or the drawing changes.
  const wiring = useMemo(() => {
    const out = new Map<string, Wiring>();
    for (const r of groups.wired) {
      const c = r.channel;
      if (!c) continue;
      out.set(r.name, {
        text: `${hookup.board(c.board)?.label ?? c.board} #${c.slot} → ${hookup.label(c.symbol)}`,
        symbol: c.symbol,
      });
    }
    return out;
  }, [groups, hookup]);

  // ------------------------------------------------------------ the files
  const fileInput = useRef<HTMLInputElement>(null);
  const [csvError, setCsvError] = useState('');
  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setCsvError('');
    try {
      const files = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() })));
      const next = applyCsvFiles(m, files);
      update((d) => ({ ...d, machine: next }));
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : String(e));
    }
  };
  const download = () => {
    saveFile('state_machine_actuators.csv', toActuatorCsv(m));
    // Two downloads from one click: the second a beat later, or some
    // browsers drop it.
    window.setTimeout(() => saveFile('state_transitions.csv', toTransitionCsv(m)), 300);
  };

  const isShipped = useMemo(() => sameMachine(m, shipped), [m, shipped]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-3 p-4">
      <section className={CARD}>
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2 px-4 py-2.5">
          <h2 className="caps">State machine</h2>
          <span
            className={`px-2 py-0.5 text-[11px] font-semibold ${isShipped ? 'bg-gray-800 text-gray-300' : 'bg-gray-700 text-white'}`}
            title={
              isShipped
                ? "The DAQ's own state_machine_actuators.csv and state_transitions.csv, as shipped."
                : `This ${onStand ? 'stand' : 'drawing'} runs its own copy of the DAQ's table. Back to the DAQ's table undoes it.`
            }
          >
            {isShipped ? "The DAQ's table" : `Edited for this ${onStand ? 'stand' : 'drawing'}`}
          </span>
          <span className="text-[12px] text-text-muted">
            {m.states.length} states · {m.actuators.length} rows
            {issues.unwired.length > 0 && ` (${issues.unwired.length} not wired)`}
          </span>
          {locked && (
            <span className="text-[12px] text-[var(--color-warning)]" title="Take the stand (top bar) to change its table.">
              Read only
            </span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              disabled={locked || isShipped}
              onClick={() => update((d) => ({ ...d, machine: structuredClone(shipped) }))}
              title="Put the DAQ's own table back: every state, row and move as shipped."
              className={BTN}
            >
              Back to the DAQ's table
            </button>
            <button
              type="button"
              onClick={download}
              title="The DAQ's two tables, state_machine_actuators.csv and state_transitions.csv, in its format. The States list (ids, panel places, abort flags) and the actuator delays are kept in the DAQ's own config: set those there."
              className={BTN}
            >
              Download CSVs
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => fileInput.current?.click()}
              title="The DAQ's state_machine_actuators.csv, state_transitions.csv, or both at once"
              className={BTN}
            >
              Upload CSV
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              multiple
              className="hidden"
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </header>
        {(hookup.dirty || hookup.error) && (
          <div className="border-t border-gray-800 px-4 py-2">
            <HookupSaveBar />
          </div>
        )}
        {csvError && <p className="border-t border-gray-800 px-4 py-2 text-[12px] text-[var(--color-danger)]">{csvError}</p>}
        <Issues
          check={check}
          failed={checkFailed}
          unwired={issues.unwired}
          rowless={issues.rowless.map((c) => c.name)}
          noAbort={noAbort}
          locked={locked}
          onAddRows={() => edit((mm) => issues.rowless.reduce((acc, c) => addRow(acc, c.name), mm))}
        />
      </section>

      <StatesCard
        m={m}
        current={current}
        picked={picked?.kind === 'state' ? picked.name : ''}
        onPick={pickState}
        locked={locked}
        edit={edit}
        justAdded={justAdded}
        onAdd={() => {
          const next = addState(m);
          const added = next.states[next.states.length - 1]?.name ?? '';
          update((d) => ({ ...d, machine: next }));
          setJustAdded(added);
        }}
      />

      <OpensCard
        m={m}
        groups={groups}
        wiring={wiring}
        current={current}
        pick={picked}
        onPickState={pickState}
        onPickRow={pickRow}
        clearPick={() => setPick(null)}
        locked={locked}
        edit={edit}
        builtin={builtin}
      />

      <MovesCard m={m} current={current} locked={locked} edit={edit} />
    </div>
  );
}

// ------------------------------------------------------------------ issues

/** "Idle commands LOX Press OPEN in the edited table as the DAQ reads it. A
 *  cold, ..." -> "Idle commands LOX Press OPEN". */
function firstSentence(w: string): string {
  const head = w.split(/\.\s/)[0];
  return head.replace(/ in (the edited table|[\w.-]+\.csv)( as the DAQ reads it)?$/, '').replace(/ is permitted by .*$/, ' is allowed');
}

function Issues({
  check,
  failed,
  unwired,
  rowless,
  noAbort,
  locked,
  onAddRows,
}: {
  check: { ok: boolean; error: string; warnings: string[] } | null;
  failed: string;
  unwired: string[];
  rowless: string[];
  /** States whose own cells go to no abort (stateTable.withoutAbort). */
  noAbort: string[];
  locked: boolean;
  onAddRows: () => void;
}) {
  const [all, setAll] = useState(false);
  const warnings = check?.warnings ?? [];
  const bad = check && !check.ok;
  if (!bad && warnings.length === 0 && noAbort.length === 0 && unwired.length === 0 && rowless.length === 0 && !failed)
    return null;
  // The first sentence says what; the rest (why, and what to fix) is on
  // hover, so the list reads at a glance.
  const lines = [
    ...noAbort.map((s) => ({ text: `${s} has no abort in the transition table`, title: NO_ABORT })),
    ...warnings.map((w) => ({ text: firstSentence(w), title: w })),
  ];
  const shown = all ? lines : lines.slice(0, 3);
  return (
    <div className="flex flex-col gap-0.5 border-t border-gray-800 px-4 py-2 text-[12px]">
      {bad && <p className="text-[var(--color-danger)]">{check.error || 'The twin cannot read this table.'}</p>}
      {shown.map((l, i) => (
        <p key={i} className="truncate text-[var(--color-warning)]" title={l.title}>
          {l.text}
        </p>
      ))}
      {lines.length > 3 && (
        <button type="button" onClick={() => setAll((a) => !a)} className="self-start text-[11px] text-gray-400 hover:text-white">
          {all ? 'Fewer' : `${lines.length - 3} more`}
        </button>
      )}
      {unwired.length > 0 && (
        <p
          className="truncate text-[var(--color-warning)]"
          title={`${unwired.join(', ')}\n\nNo solenoid connector on the DAQ box goes by these names, so they command nothing.`}
        >
          Wired to nothing: {unwired.join(', ')}
        </p>
      )}
      {rowless.length > 0 && (
        <p className="flex items-center gap-2 text-[var(--color-warning)]">
          <span
            className="truncate"
            title={`${rowless.join(', ')}\n\nValve connectors the table has no row for: no state ever moves them.`}
          >
            On the DAQ box with no row: {rowless.join(', ')}
          </span>
          <button
            type="button"
            disabled={locked}
            onClick={onAddRows}
            title="A row for each, open in no state yet"
            className={SMALL_BTN}
          >
            Add rows
          </button>
        </p>
      )}
      {failed && (
        <p className="text-text-muted" title={failed}>
          Could not check the table.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ states

function StatesCard({
  m,
  current,
  picked,
  onPick,
  locked,
  edit,
  justAdded,
  onAdd,
}: {
  m: MachineDef;
  current: string;
  picked: string;
  onPick: (name: string) => void;
  locked: boolean;
  edit: Edit;
  justAdded: string;
  onAdd: () => void;
}) {
  const grid = useMemo(() => panelGrid(m.states), [m.states]);
  const names = useMemo(() => new Set(m.states.map((s) => fold(s.name))), [m.states]);
  return (
    <section className={CARD}>
      <h2 className={CARD_H2}>
        States
        <span className={SUB}>in the tables' column order</span>
        <button type="button" disabled={locked} onClick={onAdd} className={`ml-auto ${SMALL_BTN}`}>
          + Add state
        </button>
      </h2>
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4 px-4 py-3">
        <table className="text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] text-gray-500">
              <th className="py-1 pr-3 font-normal">Name</th>
              <th className="py-1 pr-2 font-normal" title="Row on the console's state grid, 0 at the top. Blank: not on the grid.">
                Row
              </th>
              <th
                className="py-1 pr-2 font-normal"
                title={`Column on the console's state grid, 0 to ${PANEL_COLS - 1}. Blank: not on the grid.`}
              >
                Col
              </th>
              <th className="py-1 pr-3 font-normal" title="An abort: the twin lets any state go to it, the DAQ only where the transition table says">
                Abort
              </th>
              <th className="py-1 pr-2 font-normal" title="Order in the tables below">
                Order
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {m.states.map((s, i) => (
              <StateRow
                key={s.name}
                s={s}
                first={i === 0}
                last={i === m.states.length - 1}
                taken={(t) => names.has(fold(t)) && fold(t) !== fold(s.name)}
                clash={grid.clash.get(s.name)}
                selected={s.name === picked}
                current={s.name === current}
                locked={locked}
                autoFocus={s.name === justAdded}
                edit={edit}
              />
            ))}
            {m.states.length === 0 && (
              <tr>
                <td colSpan={6} className="py-2 text-text-muted">
                  No states.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <PanelPreview grid={grid} current={current} picked={picked} onPick={onPick} />
      </div>
    </section>
  );
}

function LockGlyph({ title }: { title: string }) {
  return (
    <span title={title} className="inline-flex text-gray-500">
      <svg width="9" height="11" viewBox="0 0 9 11" aria-label="locked" role="img">
        <path d="M2 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <rect x="0.5" y="5" width="8" height="5.5" fill="currentColor" />
      </svg>
    </span>
  );
}

function StateRow({
  s,
  first,
  last,
  taken,
  clash,
  selected,
  current,
  locked,
  autoFocus,
  edit,
}: {
  s: MachineStateDef;
  first: boolean;
  last: boolean;
  taken: (name: string) => boolean;
  clash: string[] | undefined;
  selected: boolean;
  current: boolean;
  locked: boolean;
  autoFocus: boolean;
  edit: Edit;
}) {
  const reason = lockReason(s.name);
  const clashText = clash ? `Same spot on the grid as ${clash.join(', ')}` : '';
  return (
    <tr className={selected ? 'bg-white/[0.06]' : ''}>
      <td className="py-0.5 pr-3">
        {reason ? (
          <span className="flex w-48 items-center gap-1.5 px-2 py-0.5 text-[13px]">
            <span className="truncate" title={current ? `${s.name}: the stand is in it now` : undefined}>
              {s.name}
            </span>
            <LockGlyph title={reason} />
          </span>
        ) : (
          <NameInput
            name={s.name}
            taken={taken}
            disabled={locked}
            autoFocus={autoFocus}
            onCommit={(to) => edit((mm) => renameState(mm, s.name, to))}
          />
        )}
      </td>
      <td className="py-0.5 pr-2">
        <SpotInput
          value={s.row}
          clash={clashText}
          disabled={locked}
          onCommit={(row) => edit((mm) => setState(mm, s.name, { row }))}
        />
      </td>
      <td className="py-0.5 pr-2">
        <SpotInput
          value={s.col}
          max={PANEL_COLS - 1}
          clash={clashText}
          disabled={locked}
          onCommit={(col) => edit((mm) => setState(mm, s.name, { col }))}
        />
      </td>
      <td className="py-0.5 pr-3 text-center">
        <input
          type="checkbox"
          checked={Boolean(s.abort)}
          disabled={locked}
          onChange={(e) => edit((mm) => setState(mm, s.name, { abort: e.target.checked }))}
          title="An abort: the twin lets any state go to it, the DAQ only where the transition table says"
          className="h-3.5 w-3.5 accent-[var(--color-danger)]"
        />
      </td>
      <td className="whitespace-nowrap py-0.5 pr-2">
        <button
          type="button"
          disabled={locked || first}
          onClick={() => edit((mm) => moveState(mm, s.name, -1))}
          title="Earlier: one column left in the tables"
          className="rounded bg-gray-800 px-1.5 text-[11px] text-gray-300 hover:bg-gray-700 disabled:opacity-30"
        >
          ↑
        </button>{' '}
        <button
          type="button"
          disabled={locked || last}
          onClick={() => edit((mm) => moveState(mm, s.name, 1))}
          title="Later: one column right in the tables"
          className="rounded bg-gray-800 px-1.5 text-[11px] text-gray-300 hover:bg-gray-700 disabled:opacity-30"
        >
          ↓
        </button>
      </td>
      <td className="py-0.5">
        <button
          type="button"
          disabled={locked || Boolean(reason)}
          onClick={() => edit((mm) => removeState(mm, s.name))}
          title={reason || `Remove ${s.name}: its column and its moves`}
          className="text-[11px] text-gray-500 hover:text-[var(--color-danger)] disabled:opacity-30 disabled:hover:text-gray-500"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

/** A state's name, renamed on blur or Enter; Escape puts it back. A name
 *  another state has is refused (red, and said in the hover). */
function NameInput({
  name,
  taken,
  disabled,
  autoFocus,
  onCommit,
}: {
  name: string;
  taken: (name: string) => boolean;
  disabled: boolean;
  autoFocus: boolean;
  onCommit: (name: string) => void;
}) {
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const t = text.trim();
  const bad = !t ? 'A state needs a name' : t !== name && taken(t) ? 'Another state is called this' : '';
  const commit = () => {
    if (!bad && t !== name) onCommit(t);
    else setText(name);
  };
  return (
    <input
      value={text}
      disabled={disabled}
      autoFocus={autoFocus}
      onFocus={(e) => autoFocus && e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') setText(name);
      }}
      title={bad || undefined}
      className={`w-48 rounded border bg-black/60 px-2 py-0.5 text-[13px] disabled:opacity-60 ${
        bad ? 'border-[var(--color-danger)]' : 'border-gray-700'
      }`}
    />
  );
}

/** A row or column on the console's grid: a whole number from 0, or blank
 *  (not on the grid). */
function SpotInput({
  value,
  max,
  clash,
  disabled,
  onCommit,
}: {
  value: number | null;
  max?: number;
  clash: string;
  disabled: boolean;
  onCommit: (v: number | null) => void;
}) {
  const shown = value == null ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const t = text.trim();
  const n = Number(t);
  const bad = t !== '' && !(Number.isInteger(n) && n >= 0 && (max == null || n <= max));
  const commit = () => {
    if (bad) return setText(shown);
    const v = t === '' ? null : n;
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      placeholder="–"
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') setText(shown);
      }}
      title={bad ? `A whole number from 0${max != null ? ` to ${max}` : ''}, or blank` : clash || undefined}
      className={`w-10 rounded border bg-black/60 px-1 py-0.5 text-center font-mono text-[12.5px] placeholder:text-gray-600 disabled:opacity-60 ${
        bad || clash ? 'border-[var(--color-danger)]' : 'border-gray-700'
      }`}
    />
  );
}

/** The console's state grid as the table places it. */
function PanelPreview({
  grid,
  current,
  picked,
  onPick,
}: {
  grid: ReturnType<typeof panelGrid>;
  current: string;
  picked: string;
  onPick: (name: string) => void;
}) {
  const spots: ReactNode[] = [];
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.cols; c += 1) {
      spots.push(
        <div
          key={`${r}:${c}`}
          style={{ gridRow: r + 1, gridColumn: c + 1 }}
          className="border border-dashed border-gray-800"
          title={`Row ${r}, col ${c}`}
        />,
      );
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="caps text-[10px]" title="Where each state sits on the console's state grid (row, col)">
        Console grid
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${grid.cols}, 68px)`, gridTemplateRows: `repeat(${grid.rows}, 24px)` }}
      >
        {spots}
        {grid.placed.map((s) => {
          const now = s.name === current;
          const clash = grid.clash.get(s.name);
          return (
            <button
              key={s.name}
              type="button"
              onClick={() => onPick(s.name)}
              style={{ gridRow: s.row + 1, gridColumn: s.col + 1 }}
              title={`${s.name} (row ${s.row}, col ${s.col})${now ? ' — the stand is in it now' : ''}${
                clash ? ` — same spot as ${clash.join(', ')}` : ''
              }`}
              className={`truncate border px-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.04em] ${
                now
                  ? 'border-[var(--ink)] bg-[var(--ink)] text-black'
                  : `bg-[#0d0d0d] hover:bg-[#1a1a1a] ${s.abort ? 'text-[var(--color-danger)]' : 'text-[var(--ink)]'} ${
                      clash ? 'border-[var(--color-danger)]' : 'border-[#3d3d3d]'
                    }`
              } ${s.name === picked ? 'outline outline-1 outline-offset-1 outline-[var(--ink)]' : ''}`}
            >
              {s.name}
            </button>
          );
        })}
      </div>
      {grid.off.length > 0 && (
        <p className="max-w-[360px] text-[11px] text-gray-500">Not on the grid: {grid.off.join(', ')}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- matrices

interface Wiring {
  /** `<board> #<slot> → <symbol>` */
  text: string;
  symbol: string;
}

/** One line of the opens matrix: a row, or the label over a group. `vi` is
 *  the row's place on screen (arrow keys and the crosshair go by it). */
type Line =
  | { kind: 'group'; label: string; count: number }
  | { kind: 'row'; name: string; vi: number; wiring?: Wiring };

const STEP: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/** Arrow keys move between a matrix's cells. */
function arrowKeys(e: KeyboardEvent<HTMLTableElement>) {
  const step = STEP[e.key];
  const { ri, ci } = (e.target as HTMLElement).dataset;
  if (!step || ri == null || ci == null) return;
  const next = e.currentTarget.querySelector<HTMLElement>(
    `[data-ri="${Number(ri) + step[0]}"][data-ci="${Number(ci) + step[1]}"]`,
  );
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

const tint = (a: number) => `background-image: linear-gradient(rgba(255,255,255,${a}), rgba(255,255,255,${a}));`;

/**
 * A matrix's scroll box and its crosshair. The hovered column, the picked
 * column and row are tinted by a style rule keyed on `data-c` / `data-r`, so
 * moving the mouse re-renders this and not the cells (they arrive as
 * `children`, unchanged).
 */
function MatrixFrame({
  id,
  pickedCol = -1,
  pickedRow = -1,
  children,
}: {
  id: string;
  pickedCol?: number;
  pickedRow?: number;
  children: ReactNode;
}) {
  const [col, setCol] = useState(-1);
  const track = (e: SyntheticEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-c]');
    setCol(el ? Number(el.dataset.c) : -1);
  };
  const at = `[data-matrix="${id}"]`;
  const css = [
    `${at} tbody tr[data-r]:hover > *, ${at} tbody tr[data-r]:focus-within > * { ${tint(0.05)} }`,
    col >= 0 ? `${at} [data-c="${col}"] { ${tint(0.05)} }` : '',
    pickedCol >= 0 ? `${at} [data-c="${pickedCol}"] { ${tint(0.11)} }` : '',
    pickedRow >= 0 ? `${at} tr[data-r="${pickedRow}"] > * { ${tint(0.11)} }` : '',
  ].join('\n');
  return (
    <div className="max-h-[60vh] overflow-auto">
      <style>{css}</style>
      <table
        data-matrix={id}
        className="border-separate border-spacing-0 text-[12.5px]"
        onMouseOver={track}
        onFocus={track}
        onMouseLeave={() => setCol(-1)}
        onKeyDown={arrowKeys}
      >
        {children}
      </table>
    </div>
  );
}

const HEAD_H = 'h-[116px]';

/** A state's column head: its name, vertical. */
function ColHead({
  s,
  ci,
  current,
  title,
  onPick,
}: {
  s: MachineStateDef;
  ci: number;
  current: boolean;
  title: string;
  onPick?: (name: string) => void;
}) {
  const label = (
    <span
      className={`max-h-[108px] truncate text-[11px] ${current ? 'font-semibold' : ''} ${
        s.abort ? 'text-[var(--color-danger)]' : current ? 'text-[var(--ink)]' : 'text-gray-300'
      }`}
      style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
    >
      {s.name}
    </span>
  );
  return (
    <th
      data-c={ci}
      scope="col"
      className={`sticky top-0 z-20 ${HEAD_H} w-7 min-w-7 max-w-7 border-b border-l border-gray-800 p-0 align-bottom font-normal ${
        s.abort ? 'bg-[#1a0b0b]' : 'bg-black'
      } ${current ? 'shadow-[inset_0_2px_0_var(--ink)]' : ''}`}
      title={title + (current ? ' — the stand is in it now' : '')}
    >
      {onPick ? (
        <button
          type="button"
          onClick={() => onPick(s.name)}
          className={`flex ${HEAD_H} w-full items-end justify-center pb-1.5 hover:text-white`}
        >
          {label}
        </button>
      ) : (
        <div className={`flex ${HEAD_H} w-full items-end justify-center pb-1.5`}>{label}</div>
      )}
    </th>
  );
}

const CELL =
  'mx-auto block h-[18px] w-[18px] border focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)] disabled:cursor-not-allowed';
const CELL_OFF = 'border-[#262626] bg-[#050505] shadow-[inset_0_1px_2px_rgba(0,0,0,0.9)] enabled:hover:border-[#6a6a6a]';
const CELL_OPEN = 'border-[var(--color-success)] bg-[var(--color-success)] enabled:hover:brightness-110';
const HATCH: CSSProperties = {
  borderColor: 'var(--color-success)',
  backgroundImage: 'repeating-linear-gradient(135deg, rgba(74,222,128,0.6) 0 2px, transparent 2px 5px)',
};
/** A move into an abort the table does not have: the twin takes it anyway. */
const ABORT_HATCH: CSSProperties = {
  borderColor: 'rgba(248,113,113,0.6)',
  backgroundColor: '#050505',
  backgroundImage: 'repeating-linear-gradient(135deg, rgba(248,113,113,0.35) 0 2px, transparent 2px 5px)',
};
const ROW_HEAD = 'sticky left-0 z-10 border-r border-gray-800 bg-black px-2 text-left font-normal';

// ------------------------------------------------------------------- opens

function OpensCard({
  m,
  groups,
  wiring,
  current,
  pick,
  onPickState,
  onPickRow,
  clearPick,
  locked,
  edit,
  builtin,
}: {
  m: MachineDef;
  groups: ReturnType<typeof rowGroups>;
  wiring: Map<string, Wiring>;
  current: string;
  pick: Pick;
  onPickState: (name: string) => void;
  onPickRow: (name: string) => void;
  clearPick: () => void;
  locked: boolean;
  edit: Edit;
  /** Rows the twin reads by name, and what each does. */
  builtin: Record<string, string>;
}) {
  const [filter, setFilter] = useState('');

  const lines = useMemo<Line[]>(() => {
    const f = fold(filter);
    const match = (name: string) =>
      !f || fold(name).includes(f) || (wiring.get(name)?.text.toLocaleLowerCase().includes(f) ?? false);
    const wired = groups.wired.filter((r) => match(r.name));
    const unwired = groups.unwired.filter((r) => match(r.name));
    const out: Line[] = [];
    let vi = 0;
    const both = wired.length > 0 && unwired.length > 0;
    if (both) out.push({ kind: 'group', label: 'Wired', count: wired.length });
    for (const r of wired) out.push({ kind: 'row', name: r.name, vi: vi++, wiring: wiring.get(r.name) });
    if (both) out.push({ kind: 'group', label: 'Not wired', count: unwired.length });
    for (const r of unwired) out.push({ kind: 'row', name: r.name, vi: vi++ });
    return out;
  }, [groups, wiring, filter]);

  const open = useMemo(() => new Map(Object.entries(m.open).map(([s, rows]) => [s, new Set(rows)])), [m.open]);
  const toggle = useCallback(
    (row: string, state: string) => edit((mm) => setOpen(mm, row, state, !isOpen(mm, row, state))),
    [edit],
  );
  const drop = useCallback((row: string) => edit((mm) => removeRow(mm, row)), [edit]);

  const pickedCol = pick?.kind === 'state' ? m.states.findIndex((s) => s.name === pick.name) : -1;
  const pickedRow =
    pick?.kind === 'row'
      ? (lines.find((l): l is Extract<Line, { kind: 'row' }> => l.kind === 'row' && l.name === pick.name)?.vi ?? -1)
      : -1;

  let summary: ReactNode = <span className="text-gray-600">Click a state or a row.</span>;
  if (pick?.kind === 'state') {
    const opens = m.actuators.filter((a) => open.get(pick.name)?.has(a));
    summary = (
      <span>
        <b className="font-semibold">{pick.name}</b> opens: {opens.length ? opens.join(', ') : 'nothing'}
        {heldShut(pick.name) && opens.length > 0 && <span className="text-gray-500"> (held shut by the twin)</span>}
      </span>
    );
  } else if (pick?.kind === 'row') {
    const where = m.states.filter((s) => open.get(s.name)?.has(pick.name)).map((s) => s.name);
    summary = (
      <span>
        <b className="font-semibold">{pick.name}</b> opens in: {where.length ? where.join(', ') : 'no state'}
      </span>
    );
  }

  return (
    <section className={CARD}>
      <h2 className={CARD_H2}>
        What each state opens
        <span className={SUB}>one row per solenoid connector name</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter rows"
          className="ml-auto w-44 rounded border border-gray-700 bg-black/60 px-2 py-0.5 font-sans text-[12px] font-normal normal-case tracking-normal text-[var(--ink)] placeholder:text-gray-600"
        />
      </h2>
      <div className="flex min-h-[30px] items-center gap-2 border-b border-gray-800 px-4 py-1 text-[12px]">
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {pick && (
          <button type="button" onClick={clearPick} className="text-[11px] text-gray-500 hover:text-white" title="Clear">
            ✕
          </button>
        )}
      </div>
      {m.actuators.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-text-muted">
          No rows. Name a valve's solenoid connector on the P&amp;ID tab, or upload the DAQ's CSVs.
        </p>
      ) : (
        <MatrixFrame id="open" pickedCol={pickedCol} pickedRow={pickedRow}>
          <thead>
            <tr>
              <th className={`sticky left-0 top-0 z-30 ${HEAD_H} min-w-[220px] border-b border-r border-gray-800 bg-black px-2 pb-1.5 text-left align-bottom text-[10.5px] font-normal text-gray-500`}>
                Row
              </th>
              {m.states.map((s, ci) => (
                <ColHead
                  key={s.name}
                  s={s}
                  ci={ci}
                  current={s.name === current}
                  onPick={onPickState}
                  title={
                    heldShut(s.name)
                      ? `${s.name}: ${IDLE_HELD}`
                      : `${s.name}${s.abort ? ' (abort)' : ''}: opens ${open.get(s.name)?.size ?? 0} — click to list`
                  }
                />
              ))}
            </tr>
          </thead>
          <OpensBody
            lines={lines}
            states={m.states}
            open={open}
            locked={locked}
            onToggle={toggle}
            onPickRow={onPickRow}
            onRemove={drop}
            builtin={builtin}
          />
        </MatrixFrame>
      )}
      {m.actuators.length > 0 && lines.length === 0 && (
        <p className="px-4 py-2 text-[12px] text-text-muted">No row matches “{filter}”.</p>
      )}
    </section>
  );
}

const OpensBody = memo(function OpensBody({
  lines,
  states,
  open,
  locked,
  onToggle,
  onPickRow,
  onRemove,
  builtin,
}: {
  lines: Line[];
  states: MachineStateDef[];
  open: Map<string, Set<string>>;
  locked: boolean;
  onToggle: (row: string, state: string) => void;
  onPickRow: (name: string) => void;
  onRemove: (name: string) => void;
  builtin: Record<string, string>;
}) {
  return (
    <tbody>
      {lines.map((line) =>
        line.kind === 'group' ? (
          <tr key={`group:${line.label}`}>
            <td className={`${ROW_HEAD} pb-0.5 pt-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-gray-500`}>
              {line.label} · {line.count}
            </td>
            <td colSpan={states.length} />
          </tr>
        ) : (
          <tr key={line.name} data-r={line.vi}>
            <th scope="row" className={ROW_HEAD}>
              <div className="flex h-6 max-w-[320px] items-center gap-2">
                <button
                  type="button"
                  onClick={() => onPickRow(line.name)}
                  title={`Where ${line.name} opens`}
                  className={`max-w-[180px] shrink-0 truncate text-left text-[12.5px] hover:underline ${
                    line.wiring ? 'text-[var(--ink)]' : 'text-gray-500'
                  }`}
                >
                  {line.name}
                </button>
                {line.wiring ? (
                  <Link
                    to={`/pid?symbol=${encodeURIComponent(line.wiring.symbol)}`}
                    title="Show it on the P&ID"
                    className="truncate font-mono text-[10.5px] text-gray-500 hover:text-gray-300"
                  >
                    {line.wiring.text}
                  </Link>
                ) : builtin[line.name] ? (
                  <span
                    title={`${builtin[line.name]} Renaming or removing the row stops it; wiring a valve to this name puts that valve in its place.`}
                    className="shrink-0 border border-[var(--line-strong)] px-1 text-[10px] leading-4 text-gray-400"
                  >
                    built-in
                  </span>
                ) : (
                  <>
                    <span
                      title={NOT_WIRED}
                      className="shrink-0 border border-[var(--color-warning)]/50 px-1 text-[10px] leading-4 text-[var(--color-warning)]"
                    >
                      not wired
                    </span>
                    {!locked && (
                      <button
                        type="button"
                        onClick={() => onRemove(line.name)}
                        title={`Remove the ${line.name} row`}
                        className="text-[11px] text-gray-600 hover:text-[var(--color-danger)]"
                      >
                        ✕
                      </button>
                    )}
                  </>
                )}
              </div>
            </th>
            {states.map((s, ci) => {
              const on = open.get(s.name)?.has(line.name) ?? false;
              const held = on && heldShut(s.name);
              return (
                <td key={s.name} data-c={ci} className="border-l border-gray-900 p-0">
                  <button
                    type="button"
                    data-ri={line.vi}
                    data-ci={ci}
                    disabled={locked}
                    aria-pressed={on}
                    onClick={() => onToggle(line.name, s.name)}
                    title={`${line.name} in ${s.name}: ${on ? 'OPEN' : 'closed'}${held ? ` (${IDLE_HELD.toLowerCase()})` : ''}${
                      locked ? '' : on ? ' — click to close' : ' — click to open'
                    }`}
                    className={`${CELL} ${held ? '' : on ? CELL_OPEN : CELL_OFF}`}
                    style={held ? HATCH : undefined}
                  />
                </td>
              );
            })}
          </tr>
        ),
      )}
    </tbody>
  );
});

// ------------------------------------------------------------------- moves

function MovesCard({ m, current, locked, edit }: { m: MachineDef; current: string; locked: boolean; edit: Edit }) {
  const [shown, setShown] = useState(false);
  const noRow = m.states.filter((s) => !(s.name in m.allowed)).map((s) => s.name);
  const allowed = useMemo(
    () => new Map(Object.entries(m.allowed).map(([s, to]) => [s, new Set(to)])),
    [m.allowed],
  );
  const toggle = useCallback(
    (from: string, to: string) => edit((mm) => setAllowed(mm, from, to, !canGo(mm, from, to))),
    [edit],
  );
  return (
    <section className={CARD}>
      <h2 className={shown ? CARD_H2 : CARD_H2_BARE}>
        Allowed transitions
        <span className={SUB}>Row: the state you are in. Column: where it may go.</span>
        {noRow.length > 0 && (
          <span
            className="text-[11.5px] font-normal normal-case tracking-normal text-[var(--color-warning)]"
            title={`${noRow.join(', ')}\n\n${NO_ROW}`}
          >
            {noRow.length} with no row
          </span>
        )}
        <button type="button" onClick={() => setShown((v) => !v)} className={`ml-auto ${SMALL_BTN}`}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </h2>
      {shown && (
        <MatrixFrame id="moves">
          <thead>
            <tr>
              <th className={`sticky left-0 top-0 z-30 ${HEAD_H} min-w-[160px] border-b border-r border-gray-800 bg-black px-2 pb-1.5 text-left align-bottom text-[10.5px] font-normal text-gray-500`}>
                From \ To
              </th>
              {m.states.map((s, ci) => (
                <ColHead
                  key={s.name}
                  s={s}
                  ci={ci}
                  current={s.name === current}
                  title={
                    s.abort
                      ? `${s.name}: abort. The twin lets any state go to it; the DAQ only where this column says`
                      : s.name
                  }
                />
              ))}
            </tr>
          </thead>
          <MovesBody states={m.states} allowed={allowed} locked={locked} onToggle={toggle} />
        </MatrixFrame>
      )}
    </section>
  );
}

const MovesBody = memo(function MovesBody({
  states,
  allowed,
  locked,
  onToggle,
}: {
  states: MachineStateDef[];
  allowed: Map<string, Set<string>>;
  locked: boolean;
  onToggle: (from: string, to: string) => void;
}) {
  return (
    <tbody>
      {states.map((from, ri) => {
        const row = allowed.get(from.name);
        return (
          <tr key={from.name} data-r={ri}>
            <th scope="row" className={ROW_HEAD} title={row ? undefined : NO_ROW}>
              <div className="flex h-6 items-center gap-2">
                <span className={`truncate text-[12.5px] ${row ? 'text-[var(--ink)]' : 'text-gray-500'}`}>{from.name}</span>
                {!row && <span className="shrink-0 text-[10px] text-[var(--color-warning)]">no row</span>}
              </div>
            </th>
            {states.map((to, ci) => {
              const self = to.name === from.name;
              // The table's own cell, aborts too: it is what Download writes.
              const on = self || (row?.has(to.name) ?? false);
              const admitted = to.abort && !on;
              const click = locked ? '' : on ? ' — click to forbid' : ' — click to allow';
              return (
                <td key={to.name} data-c={ci} className="border-l border-gray-900 p-0">
                  <button
                    type="button"
                    data-ri={ri}
                    data-ci={ci}
                    disabled={locked || self}
                    aria-pressed={on}
                    onClick={() => onToggle(from.name, to.name)}
                    title={
                      self
                        ? `Staying in ${from.name}`
                        : admitted
                          ? `${from.name} → ${to.name}. ${ABORT_ADMITTED}${click}`
                          : `${from.name} → ${to.name}: ${on ? 'allowed' : 'not allowed'}${click}`
                    }
                    className={`${CELL} ${
                      self
                        ? 'border-[#2a2a2a] bg-[#2a2a2a]'
                        : admitted
                          ? 'enabled:hover:brightness-125'
                          : on
                            ? to.abort
                              ? 'border-[rgba(248,113,113,0.6)] bg-[rgba(248,113,113,0.45)] enabled:hover:brightness-125'
                              : 'border-[var(--ink-2)] bg-[var(--ink-2)] enabled:hover:bg-white'
                            : CELL_OFF
                    }`}
                    style={admitted ? ABORT_HATCH : undefined}
                  />
                </td>
              );
            })}
          </tr>
        );
      })}
    </tbody>
  );
});
