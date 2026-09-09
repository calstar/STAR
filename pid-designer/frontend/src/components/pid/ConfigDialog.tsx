import { useEffect, useState } from 'react';
import { Modal } from '../ui';
import { btn, primaryBtn } from '../../lib/ui';
import { COMPONENT_SPECS, LINE_SPECS, LINE_TYPE_LABELS, PEER_CHOICES } from './spec';
import type { ComponentSpec, OptionSpec, ParamSpec, PortGroupSpec } from './spec';
import { portIds } from './ports';
import type { PortInfo, PortKind } from './ports';
import { SPECIES } from './fluids';
import { PROVENANCE_LABELS, UNITS, ABSOLUTE_NOTE } from './params';
import type { ParamValue, Provenance } from './params';
import type { ComponentType, PIDNodeData } from './types';

/**
 * The config behind a double-click on a symbol.
 *
 * One dialog for every component, driven entirely by `spec.ts`. Adding a
 * pressure setting to a relief valve is a row in that table, not a new
 * component here -- which is the only way "everything with a pressure gets a
 * config" stays true a term from now.
 *
 * Two things it insists on, both inherited from what the numbers are for:
 *
 * - **Provenance is a field, not an afterthought.** A value with no stated
 *   source is stored as `default`, which reads as "nobody has looked" rather
 *   than as agreement. It is the field that lets a run report separate the
 *   measured inputs from the guesses.
 * - **Pressures are absolute.** The unit list has no psig, because gauge is a
 *   reference rather than a unit and a psig value stored as psi is one
 *   atmosphere low everywhere downstream. The field says so rather than
 *   silently accepting it.
 *
 * A blank value is not zero -- it is absent, and stays absent, so an unfilled
 * field never masquerades as a measured nought.
 */

export interface ConfigPatch {
  params: Record<string, ParamValue>;
  options: Record<string, string>;
  label: string;
  fluid?: string;
  partNumber?: string;
  lineType?: string;
  ports?: Record<string, PortInfo>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** A component, or a line. Lines pick their kind inside the dialog. */
  kind: 'node' | 'edge';
  data: PIDNodeData & { lineType?: string; partNumber?: string; fluid?: string };
  /** Other components this one could reference — used by the QD pair picker. */
  peers?: { id: string; label: string; hint?: string }[];
  readOnly: boolean;
  onSave: (patch: ConfigPatch) => void;
}

type Draft = { value: string; unit: string; source: Provenance; reference: string };

const EMPTY: Draft = { value: '', unit: '', source: 'default', reference: '' };

function toDraft(spec: ParamSpec, existing?: ParamValue): Draft {
  const units = UNITS[spec.dimension];
  if (existing) {
    return {
      value: String(existing.value),
      unit: existing.unit || units[0],
      source: existing.source,
      reference: existing.reference ?? '',
    };
  }
  return {
    ...EMPTY,
    unit: spec.suggested?.unit ?? units[0],
    value: spec.suggested ? String(spec.suggested.value) : '',
  };
}

export function ConfigDialog({ open, onClose, kind, data, peers, readOnly, onSave }: Props) {
  const type = data.componentType as ComponentType;

  const [label, setLabel] = useState(data.label ?? '');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [options, setOptions] = useState<Record<string, string>>({});
  const [fluid, setFluid] = useState<string>(data.fluid ?? '');
  const [partNumber, setPartNumber] = useState(data.partNumber ?? '');
  // A line picks what it is inside the dialog: a hose is not a rougher pipe.
  const [lineType, setLineType] = useState(data.lineType ?? 'pipe');
  const [ports, setPorts] = useState<Record<string, PortInfo>>({});

  const spec: ComponentSpec | undefined =
    kind === 'edge' ? LINE_SPECS[lineType] : COMPONENT_SPECS[type];

  // Reset whenever a different subject is opened, so a dialog never shows the
  // last one's numbers under this one's name.
  useEffect(() => {
    if (!open) return;
    setLabel(data.label ?? '');
    setFluid(data.fluid ?? '');
    setPartNumber(data.partNumber ?? '');
    setLineType(data.lineType ?? 'pipe');
    setPorts({ ...(data.ports ?? {}) });
  }, [open, data]);

  // Drafts follow the spec, which for a line changes when its kind does.
  useEffect(() => {
    if (!open || !spec) return;
    setDrafts(Object.fromEntries(spec.params.map(p => [p.key, toDraft(p, data.params?.[p.key])])));
    setOptions(Object.fromEntries(
      (spec.options ?? []).map(o => [o.key, data.options?.[o.key] ?? o.default]),
    ));
  }, [open, data, spec]);

  if (!spec) return null;

  const setDraft = (key: string, patch: Partial<Draft>) =>
    setDrafts(d => ({ ...d, [key]: { ...d[key], ...patch } }));

  const save = () => {
    const params: Record<string, ParamValue> = {};
    for (const p of spec.params) {
      const d = drafts[p.key];
      if (!d || d.value.trim() === '') continue;   // absent, not zero
      const value = Number(d.value);
      if (!Number.isFinite(value)) continue;
      params[p.key] = {
        value,
        unit: d.unit,
        source: d.source,
        ...(d.reference.trim() ? { reference: d.reference.trim() } : {}),
      };
    }
    // Only ports that differ from the default are kept: a manifold with four
    // plain outlets should store nothing, so a drawing does not fill up with
    // records saying "this port is ordinary".
    const keptPorts: Record<string, PortInfo> = {};
    for (const [id, info] of Object.entries(ports)) {
      const label = info.label?.trim();
      const kind = info.kind ?? 'flow';
      if (!label && kind === 'flow') continue;
      keptPorts[id] = { ...(label ? { label } : {}), ...(kind !== 'flow' ? { kind } : {}) };
    }

    onSave({
      params,
      options,
      ports: keptPorts,
      label: label.trim() || data.label,
      fluid: fluid || undefined,
      partNumber: partNumber.trim() || undefined,
      ...(kind === 'edge' ? { lineType } : {}),
    });
    onClose();
  };

  const title = kind === 'edge'
    ? `Line — ${LINE_TYPE_LABELS[lineType] ?? lineType}`
    : `${data.label || type} — configuration`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="w-[540px]"
      footer={
        <div className="flex gap-2">
          <button onClick={onClose} className={btn}>Cancel</button>
          <button onClick={save} disabled={readOnly} className={primaryBtn}>
            {readOnly ? 'Read only' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1 text-xs">
        {spec.summary && (
          <p className="leading-relaxed text-[var(--color-text-secondary)]">{spec.summary}</p>
        )}

        {kind === 'edge' && (
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">What this run is</span>
            <select
              value={lineType}
              disabled={readOnly}
              onChange={e => setLineType(e.target.value)}
              className={selectCls}
            >
              {Object.keys(LINE_SPECS).map(k => (
                <option key={k} value={k}>{LINE_TYPE_LABELS[k] ?? k}</option>
              ))}
            </select>
          </label>
        )}

        {kind === 'node' && (
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Tag</span>
            <input
              value={label}
              readOnly={readOnly}
              onChange={e => setLabel(e.target.value)}
              className={inputCls}
            />
            <span className="mt-1 block text-[10px] text-[var(--color-text-muted)]">
              The name this component is known by, on the drawing and in a solve.
            </span>
          </label>
        )}

        {kind === 'node' && (
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Fluid</span>
            <select value={fluid} disabled={readOnly} onChange={e => setFluid(e.target.value)} className={selectCls}>
              <option value="">Inherit from what feeds it</option>
              {SPECIES.map(sp => <option key={sp.id} value={sp.id}>{sp.label}</option>)}
            </select>
            <span className="mt-1 block leading-relaxed text-[10px] text-[var(--color-text-muted)]">
              Set this on tanks and bottles. Everything downstream inherits it, so a line
              is coloured and named by whatever reaches it — and two fluids arriving at one
              component is reported rather than blended.
            </span>
          </label>
        )}

        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Part number</span>
          <input
            value={partNumber}
            readOnly={readOnly}
            placeholder="e.g. swagelok-ss-8bk-v51"
            onChange={e => setPartNumber(e.target.value)}
            className={inputCls}
          />
          <span className="mt-1 block leading-relaxed text-[10px] text-[var(--color-text-muted)]">
            If this is a catalogued part, name it and leave the fields below blank — the
            catalogue already holds its datasheet and whatever the bench measured. Fill a
            field only to override the part for this one installation.
          </span>
        </label>

        {(spec.options ?? []).map(o => (
          <OptionField
            key={o.key}
            spec={o}
            value={options[o.key] ?? o.default}
            peers={peers}
            readOnly={readOnly}
            onChange={v => setOptions(s2 => ({ ...s2, [o.key]: v }))}
          />
        ))}

        {(spec.portGroups ?? []).length > 0 && (
          <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
            <p className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Ports</p>
            <p className="-mt-1 leading-relaxed text-[10px] text-[var(--color-text-muted)]">
              Name each port for what it feeds, so a line arriving at this symbol says where
              it goes. A plugged port is not drawn — that is what a plug is on a P&amp;ID.
            </p>
            {(spec.portGroups ?? []).map(group => (
              <PortGroup
                key={group.prefix}
                group={group}
                count={Number(options[group.countOption] ?? 1)}
                ports={ports}
                readOnly={readOnly}
                onChange={(id, patch) =>
                  setPorts(ps => ({ ...ps, [id]: { ...ps[id], ...patch } }))}
              />
            ))}
          </div>
        )}

        {spec.params.length > 0 && (
          <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
            {spec.params.map(p => (
              <ParamField
                key={p.key}
                spec={p}
                draft={drafts[p.key] ?? EMPTY}
                readOnly={readOnly}
                onChange={patch => setDraft(p.key, patch)}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

const inputCls =
  'mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]';
const selectCls = inputCls;

function OptionField({ spec, value, peers, readOnly, onChange }: {
  spec: OptionSpec; value: string; peers?: { id: string; label: string; hint?: string }[];
  readOnly: boolean; onChange: (v: string) => void;
}) {
  // An option whose choices are other components on the drawing, resolved at
  // render time rather than declared in the spec -- the spec cannot know what
  // else somebody has drawn.
  if (spec.choices === PEER_CHOICES) {
    return (
      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{spec.label}</span>
        <select value={value} disabled={readOnly} onChange={e => onChange(e.target.value)} className={selectCls}>
          <option value="">Not chosen yet</option>
          <option value="none">No pair needed — this half stands alone</option>
          {(peers ?? []).map(p => (
            <option key={p.id} value={p.id}>{p.label}{p.hint ? ` — ${p.hint}` : ''}</option>
          ))}
        </select>
        {spec.description && (
          <span className="mt-1 block leading-relaxed text-[10px] text-[var(--color-text-muted)]">{spec.description}</span>
        )}
      </label>
    );
  }

  const free = spec.choices.length === 0;
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{spec.label}</span>
      {free ? (
        <input
          value={value}
          readOnly={readOnly}
          onChange={e => onChange(e.target.value)}
          className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
      ) : (
        <select
          value={value}
          disabled={readOnly}
          onChange={e => onChange(e.target.value)}
          className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        >
          {spec.choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )}
      {spec.description && (
        <span className="mt-1 block leading-relaxed text-[10px] text-[var(--color-text-muted)]">{spec.description}</span>
      )}
    </label>
  );
}

function ParamField({ spec, draft, readOnly, onChange }: {
  spec: ParamSpec; draft: Draft; readOnly: boolean; onChange: (p: Partial<Draft>) => void;
}) {
  const units = UNITS[spec.dimension];
  const filled = draft.value.trim() !== '';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{spec.label}</span>
        {spec.dimension === 'pressure' && (
          <span className="text-[10px] text-amber-500/80">{ABSOLUTE_NOTE}</span>
        )}
      </div>
      <div className="mt-1 flex gap-1.5">
        <input
          inputMode="decimal"
          placeholder="—"
          value={draft.value}
          readOnly={readOnly}
          onChange={e => onChange({ value: e.target.value })}
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <select
          value={draft.unit || units[0]}
          disabled={readOnly}
          onChange={e => onChange({ unit: e.target.value })}
          className="w-24 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        >
          {units.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>

      {filled && (
        <div className="mt-1 flex gap-1.5">
          <select
            value={draft.source}
            disabled={readOnly}
            onChange={e => onChange({ source: e.target.value as Provenance })}
            className="w-40 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
          >
            {(Object.keys(PROVENANCE_LABELS) as Provenance[]).map(s => (
              <option key={s} value={s}>{PROVENANCE_LABELS[s]}</option>
            ))}
          </select>
          <input
            placeholder="where it came from — test, datasheet, drawing"
            value={draft.reference}
            readOnly={readOnly}
            onChange={e => onChange({ reference: e.target.value })}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      )}

      {spec.description && (
        <p className="mt-1 leading-relaxed text-[10px] text-[var(--color-text-muted)]">{spec.description}</p>
      )}
    </div>
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
    ...portIds(group.prefix, Number.isFinite(count) ? count : 1)
      .map((id, i) => ({ id, hint: `${group.label.replace(/s$/, '')} ${i + 1}` })),
  ];

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-[var(--color-text-secondary)]">{group.label}</p>
      {ids.map(({ id, hint }) => {
        const info = ports[id] ?? {};
        return (
          <div key={id} className="flex items-center gap-1.5">
            <span className="w-9 shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{id}</span>
            <input
              value={info.label ?? ''}
              placeholder={hint}
              readOnly={readOnly}
              onChange={e => onChange(id, { label: e.target.value })}
              className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
            />
            <select
              value={info.kind ?? 'flow'}
              disabled={readOnly}
              onChange={e => onChange(id, { kind: e.target.value as PortKind })}
              className="w-28 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
            >
              <option value="flow">Flow</option>
              <option value="instrument">Instrument</option>
              <option value="plug">Plugged</option>
            </select>
          </div>
        );
      })}
    </div>
  );
}
