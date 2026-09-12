import { useEffect, useRef, useState } from 'react';
import { Modal } from '../ui';
import { btn, primaryBtn } from '../../lib/ui';
import { COMPONENT_SPECS, LINE_SPECS, LINE_TYPE_LABELS, PEER_CHOICES } from './spec';
import type { ComponentSpec, OptionSpec, ParamSpec, PortGroupSpec } from './spec';
import { UNITS } from './params';
import type { ParamValue } from './params';
import { fromDraft, isVerified, pickProvenance, placeholderFor, toDraft } from './drafts';
import type { Draft } from './drafts';
import { portIds } from './ports';
import type { PortInfo, PortKind } from './ports';
import { defaultTemperatureK, speciesById } from './fluids';
import { SegmentPanel } from './SegmentPanel';
import { BoreProfile } from './BoreProfile';
import { ManifoldEditor } from './ManifoldEditor';
import type { ManifoldGeometry } from './ManifoldEditor';
import { fittingCount, transitionsOf } from './segments';
import type { LineSegment } from './segments';
import type { ComponentType, PIDNodeData } from './types';

/**
 * The config behind a double-click.
 *
 * One dialog for everything, driven by `spec.ts`. Two rules it is built to,
 * both learned the hard way:
 *
 * **A label, not a paragraph.** The first version explained every field. It
 * buried the inputs and it was explaining the trade to people who do this for
 * a living.
 *
 * **Only ask what the component has.** Fluid appears on tanks, bottles and
 * dewars, because those are the things that hold one; a part number appears
 * where a catalogue part exists. Asking an RTD for its fluid and its part
 * number was the spec table applied without judgement.
 */

export interface ConfigPatch {
  params: Record<string, ParamValue>;
  options: Record<string, string>;
  label: string;
  fluid?: string;
  partNumber?: string;
  lineType?: string;
  ports?: Record<string, PortInfo>;
  segments?: LineSegment[];
  geometry?: ManifoldGeometry;
}

interface Props {
  open: boolean;
  onClose: () => void;
  kind: 'node' | 'edge';
  data: PIDNodeData & {
    lineType?: string; partNumber?: string; fluid?: string;
    segments?: LineSegment[]; geometry?: ManifoldGeometry;
  };
  peers?: { id: string; label: string; hint?: string }[];
  readOnly: boolean;
  onSave: (patch: ConfigPatch) => void;
}

const EMPTY: Draft = { value: '', unit: '', source: 'estimated' };

const field =
  'rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]';
const wide = `${field} w-full`;
const rowLabel = 'text-[11px] text-[var(--color-text-secondary)]';

export function ConfigDialog({ open, onClose, kind, data, peers, readOnly, onSave }: Props) {
  const type = data.componentType as ComponentType;

  const [label, setLabel] = useState(data.label ?? '');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [options, setOptions] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, PortInfo>>({});
  const [fluid, setFluid] = useState<string>(data.fluid ?? '');
  const [partNumber, setPartNumber] = useState(data.partNumber ?? '');
  const [lineType, setLineType] = useState(data.lineType ?? 'pipe');
  const [segments, setSegments] = useState<LineSegment[]>([]);
  const [geometry, setGeometry] = useState<ManifoldGeometry | undefined>(undefined);

  const spec: ComponentSpec | undefined =
    kind === 'edge' ? LINE_SPECS[lineType] : COMPONENT_SPECS[type];

  useEffect(() => {
    if (!open) return;
    setLabel(data.label ?? '');
    setFluid(data.fluid ?? '');
    setPartNumber(data.partNumber ?? '');
    setLineType(data.lineType ?? 'pipe');
    setPorts({ ...(data.ports ?? {}) });
    setSegments(data.segments ? structuredClone(data.segments) : []);
    setGeometry(data.geometry ? structuredClone(data.geometry) : undefined);
  }, [open, data]);

  useEffect(() => {
    if (!open || !spec) return;
    setDrafts(Object.fromEntries(spec.params.map(p => [p.key, toDraft(p, data.params?.[p.key])])));
    setOptions(Object.fromEntries((spec.options ?? []).map(o => [o.key, data.options?.[o.key] ?? o.default])));
  }, [open, data, spec]);

  // ── Temperature follows the fluid ──────────────────────────────────────────
  //
  // Picking LOX and then being asked, separately, how cold it is, is asking a
  // question whose answer is in the previous field. Filled on change rather
  // than on save so the number is visible and can be argued with -- and only
  // over an empty box or over the *previous* fluid's default, so a temperature
  // somebody typed is never taken away from them.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const lastAutoTemp = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !spec?.fluids) return;
    const k = defaultTemperatureK(fluid, type === 'DEWAR');
    if (k === undefined) return;
    setDrafts(d => {
      const t = d.temperature;
      if (!t) return d;
      const untouched = t.value.trim() === '' || t.value === lastAutoTemp.current;
      if (!untouched) return d;
      lastAutoTemp.current = String(k);
      // Written as what it is: a default that follows from the fluid, with
      // the reason named -- so a run report counts it as assumed rather than
      // as a measurement somebody made.
      return { ...d, temperature: {
        ...t, value: String(k), unit: 'K', source: 'default',
        reference: `${speciesById(fluid)?.label ?? fluid} at its usual state`,
      } };
    });
  }, [open, fluid, type, spec]);

  if (!spec) return null;

  const save = () => {
    const params: Record<string, ParamValue> = {};
    for (const p of spec.params) {
      if (p.derived) continue;                     // computed below, never typed
      const v = fromDraft(drafts[p.key]);          // blank is absent, not zero
      if (v) params[p.key] = v;
    }
    // Counted, not asked for. Only when there is a list to count: with no
    // segments the drawing has not said, and a zero would be a claim.
    if (kind === 'edge' && segments.length) {
      const n = segments.reduce((sum, s) => sum + fittingCount(s), 0);
      params.fitting_count = {
        value: n, unit: '-', source: 'default',
        reference: 'counted from the fittings on this run',
      };
    }
    const keptPorts: Record<string, PortInfo> = {};
    for (const [id, info] of Object.entries(ports)) {
      const name = info.label?.trim();
      const k = info.kind ?? 'flow';
      if (!name && k === 'flow') continue;
      keptPorts[id] = { ...(name ? { label: name } : {}), ...(k !== 'flow' ? { kind: k } : {}) };
    }
    onSave({
      params, options, ports: keptPorts,
      label: label.trim() || data.label,
      fluid: fluid || undefined,
      partNumber: partNumber.trim() || undefined,
      ...(kind === 'edge' ? { lineType, segments: segments.length ? segments : undefined } : {}),
      ...(geometry ? { geometry } : {}),
    });
    onClose();
  };

  // ΣK, live. Fittings priced by feed-twin's ladder are not known here, so
  // this is the part that *is* knowable from the drawing alone: the derived
  // bore transitions, plus a count of the fittings waiting to be priced.
  const derivedK = kind === 'edge'
    ? transitionsOf(segments).reduce((n, t2) => n + (t2?.K ?? 0), 0)
    : 0;
  const fittings = kind === 'edge' ? segments.reduce((n, s) => n + fittingCount(s), 0) : 0;

  // No ΣK unless there is one. Every fitting here is priced by feed-twin from
  // geometry, so a zero would be reporting "nothing was stated" as "nothing".
  const parts = [
    fittings ? `${fittings} fitting${fittings === 1 ? '' : 's'}` : '',
    derivedK ? `K ${derivedK.toFixed(2)} at bore changes` : '',
  ].filter(Boolean);
  // An itemised run is the whole answer for that line, so the one-number
  // fields above it are no longer what a solve reads.
  const superseded = kind === 'edge' && segments.length > 0;

  const title = kind === 'edge'
    ? `Line${parts.length ? ` · ${parts.join(' · ')}` : ''}`
    : (data.label || type);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={kind === 'edge' ? "w-[900px]" : "w-[420px]"}
      footer={
        <div className="flex gap-2">
          <button onClick={onClose} className={btn}>Cancel</button>
          <button onClick={save} disabled={readOnly} className={primaryBtn}>Save</button>
        </div>
      }
    >
      <div className={kind === 'edge' ? 'grid grid-cols-[300px_1fr] gap-4' : ''}>
      {kind === 'edge' && (
        <div className="sticky top-0 self-start">
          <BoreProfile segments={segments} />
        </div>
      )}
      <div className="max-h-[60vh] space-y-2.5 overflow-y-auto pr-1">
        {kind === 'edge' && (
          <Row label="Type">
            <select value={lineType} disabled={readOnly} onChange={e => setLineType(e.target.value)} className={wide}>
              {Object.keys(LINE_SPECS).map(k => (
                <option key={k} value={k}>{LINE_TYPE_LABELS[k] ?? k}</option>
              ))}
            </select>
          </Row>
        )}

        {kind === 'node' && (
          <Row label="Tag">
            <input value={label} readOnly={readOnly} onChange={e => setLabel(e.target.value)} className={wide} />
          </Row>
        )}

        {spec.fluids && (
          <Row label="Fluid">
            <select value={fluid} disabled={readOnly} onChange={e => setFluid(e.target.value)} className={wide}>
              <option value="">—</option>
              {spec.fluids.map(id => (
                <option key={id} value={id}>{speciesById(id)?.label ?? id}</option>
              ))}
            </select>
          </Row>
        )}

        {spec.catalogued && (
          <Row label="Part">
            <input
              value={partNumber}
              readOnly={readOnly}
              placeholder="catalogue part number"
              onChange={e => setPartNumber(e.target.value)}
              className={wide}
            />
          </Row>
        )}

        {(spec.options ?? []).map(o => (
          <OptionRow
            key={o.key}
            spec={o}
            value={options[o.key] ?? o.default}
            peers={peers}
            readOnly={readOnly}
            onChange={v => setOptions(s => ({ ...s, [o.key]: v }))}
          />
        ))}

        {spec.params.length > 0 && (
          <div className={`space-y-2 border-t border-[var(--color-border)] pt-2.5${
            superseded ? ' opacity-45' : ''}`}>
            {/* Two ways to say how long a line is, both editable, with nothing
                saying which one counts. The plan's own rule for the loss
                methods -- the panel says which is in force -- applies a level
                up as well. */}
            {superseded && (
              <p className="text-[10px] text-[var(--color-text-muted)]">
                Superseded by the segments below.
              </p>
            )}
            {spec.params.filter(p => !p.advanced && !p.derived).map(p => (
              <ParamRow
                key={p.key}
                spec={p}
                draft={drafts[p.key] ?? EMPTY}
                readOnly={readOnly}
                onChange={patch => setDrafts(d => ({ ...d, [p.key]: { ...d[p.key], ...patch } }))}
              />
            ))}
            {/* The rest are real and are not why anyone opened this. A
                hardline's wall thickness and fitting mass feed a thermal model
                that is off unless a drawing asks for it; flat alongside length
                and bore they read as four more things you were supposed to
                know. See `ParamSpec.advanced`. */}
            {spec.params.some(p => p.advanced) && (
              <>
                <button
                  onClick={() => setShowAdvanced(v => !v)}
                  className="text-[10px] text-[var(--color-text-muted)] underline decoration-dotted hover:text-[var(--color-text-primary)]">
                  {showAdvanced
                    ? 'fewer'
                    : `${spec.params.filter(p => p.advanced).length} more (wall, roughness, head)`}
                </button>
                {showAdvanced && spec.params.filter(p => p.advanced && !p.derived).map(p => (
                  <ParamRow
                    key={p.key}
                    spec={p}
                    draft={drafts[p.key] ?? EMPTY}
                    readOnly={readOnly}
                    onChange={patch => setDrafts(d => ({ ...d, [p.key]: { ...d[p.key], ...patch } }))}
                  />
                ))}
              </>
            )}
          </div>
        )}

        {kind === 'edge' && (
          <SegmentPanel segments={segments} onChange={setSegments} />
        )}

        {type === 'MANIFOLD' && (
          <ManifoldEditor
            outlets={Number(options.outlets ?? 4)}
            geometry={geometry}
            ports={ports}
            onSave={setGeometry}
          />
        )}

        {(spec.portGroups ?? []).map(group => (
          <PortGroup
            key={group.prefix}
            group={group}
            count={Number(options[group.countOption] ?? 1)}
            ports={ports}
            readOnly={readOnly}
            onChange={(id, patch) => setPorts(ps => ({ ...ps, [id]: { ...ps[id], ...patch } }))}
          />
        ))}
      </div>
      </div>
    </Modal>
  );
}

/** Label left, control right — one grid so every row lines up. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_1fr] items-center gap-2">
      <span className={rowLabel}>{label}</span>
      {children}
    </div>
  );
}

function OptionRow({ spec, value, peers, readOnly, onChange }: {
  spec: OptionSpec; value: string; peers?: { id: string; label: string; hint?: string }[];
  readOnly: boolean; onChange: (v: string) => void;
}) {
  if (spec.choices === PEER_CHOICES) {
    return <PeerPicker label={spec.label} value={value} peers={peers ?? []} readOnly={readOnly} onChange={onChange} />;
  }
  if (spec.choices.length === 0) {
    return (
      <Row label={spec.label}>
        <input
          value={value}
          placeholder={spec.placeholder}
          readOnly={readOnly}
          onChange={e => onChange(e.target.value)}
          className={wide}
        />
      </Row>
    );
  }
  return (
    <Row label={spec.label}>
      <select value={value} disabled={readOnly} onChange={e => onChange(e.target.value)} className={wide}>
        {spec.choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    </Row>
  );
}

/**
 * Value, unit, and whether it is real.
 *
 * All on one line. The provenance select shows only once a value is typed --
 * there is nothing to qualify about an empty field, and hiding it halves the
 * dialog for a component nobody has filled in yet.
 */
function ParamRow({ spec, draft, readOnly, onChange }: {
  spec: ParamSpec; draft: Draft; readOnly: boolean; onChange: (p: Partial<Draft>) => void;
}) {
  const units = UNITS[spec.dimension];
  const filled = draft.value.trim() !== '';
  return (
    <Row label={spec.label}>
      <div className="grid grid-cols-[1fr_62px_84px] gap-1.5">
        <input
          inputMode="decimal"
          // The suggestion, said as one. It used to be typed into the field
          // for you, and Save then wrote it as a number you had stated.
          placeholder={placeholderFor(spec)}
          value={draft.value}
          readOnly={readOnly}
          onChange={e => onChange({ value: e.target.value })}
          className={`${field} min-w-0`}
          title={draft.reference || undefined}
        />
        <select
          value={draft.unit || units[0]}
          disabled={readOnly}
          onChange={e => onChange({ unit: e.target.value })}
          className={`${field} min-w-0`}
          title={spec.dimension === 'pressure' ? 'absolute, not gauge' : undefined}
        >
          {units.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        {filled ? (
          <select
            // Two answers over four sources: a datasheet number reads as
            // verified and stays `manufacturer` unless somebody says
            // otherwise. See `drafts.ts`.
            value={isVerified(draft.source) ? 'verified' : 'estimate'}
            disabled={readOnly}
            onChange={e => onChange(pickProvenance(draft, e.target.value === 'verified'))}
            className={`${field} min-w-0`}
            title={draft.reference ? `${draft.source}: ${draft.reference}` : draft.source}
          >
            <option value="estimate">Estimate</option>
            <option value="verified">Verified</option>
          </select>
        ) : <span />}
      </div>
    </Row>
  );
}

function PortGroup({ group, count, ports, readOnly, onChange }: {
  group: PortGroupSpec;
  count: number;
  ports: Record<string, PortInfo>;
  readOnly: boolean;
  onChange: (id: string, patch: Partial<PortInfo>) => void;
}) {
  const ids = [
    ...(group.fixed ?? []).map(f => ({ id: f.id, hint: f.label })),
    ...portIds(group.prefix, Number.isFinite(count) ? count : 1).map(id => ({ id, hint: '' })),
  ];
  return (
    <div className="space-y-1.5 border-t border-[var(--color-border)] pt-2.5">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{group.label}</span>
      {ids.map(({ id, hint }) => (
        <div key={id} className="grid grid-cols-[104px_1fr_92px] items-center gap-2">
          <span className="pl-1 font-mono text-[11px] text-[var(--color-text-muted)]">{id}</span>
          <input
            value={ports[id]?.label ?? ''}
            placeholder={hint || 'unnamed'}
            readOnly={readOnly}
            onChange={e => onChange(id, { label: e.target.value })}
            className={`${field} min-w-0`}
          />
          <select
            value={ports[id]?.kind ?? 'flow'}
            disabled={readOnly}
            onChange={e => onChange(id, { kind: e.target.value as PortKind })}
            className={`${field} min-w-0`}
          >
            {/* Two states, not three. "Instrument" was a second way of saying
                what a transducer drawn on the port already says, and the port
                now works that out for itself. Plugged is the one that has to
                be authored: nothing else on the drawing says a port is
                blanked off. */}
            <option value="flow">Open</option>
            <option value="plug">Plugged</option>
          </select>
        </div>
      ))}
    </div>
  );
}

/**
 * Pick another component on the drawing, by typing its name.
 *
 * A dropdown was fine with three disconnects and useless with thirty. This is a
 * text box that filters as you type, over an editable field showing whatever is
 * already chosen -- so the common case (you know the tag) is typing four
 * characters, and the browsing case still works because an empty box lists
 * everything.
 */
function PeerPicker({ label, value, peers, readOnly, onChange }: {
  label: string;
  value: string;
  peers: { id: string; label: string; hint?: string }[];
  readOnly: boolean;
  onChange: (v: string) => void;
}) {
  const chosen = peers.find(p => p.id === value);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const shown = query.trim()
    ? peers.filter(p => p.label.toLowerCase().includes(query.trim().toLowerCase()))
    : peers;

  const display = value === 'none' ? 'No pair needed' : (chosen?.label ?? '');

  return (
    <div className="grid grid-cols-[104px_1fr] items-start gap-2">
      <span className={`${rowLabel} pt-1`}>{label}</span>
      <div className="relative">
        <input
          value={open ? query : display}
          placeholder="type a tag…"
          readOnly={readOnly}
          onFocus={() => { if (!readOnly) { setOpen(true); setQuery(''); } }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={e => setQuery(e.target.value)}
          className={wide}
        />
        {open && (
          <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl">
            <button
              disabled={readOnly}
              onMouseDown={() => { onChange('none'); setOpen(false); }}
              className="block w-full px-2 py-1 text-left text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-primary)]"
            >
              No pair needed
            </button>
            {shown.map(p => (
              <button
                key={p.id}
                disabled={readOnly}
                onMouseDown={() => { onChange(p.id); setOpen(false); }}
                className="block w-full px-2 py-1 text-left text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
              >
                {p.label}{p.hint ? <span className="text-[var(--color-text-muted)]"> · {p.hint}</span> : null}
              </button>
            ))}
            {shown.length === 0 && (
              <p className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">nothing matches</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
