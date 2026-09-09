import { useEffect, useState } from 'react';
import { Modal } from '../ui';
import { btn, primaryBtn } from '../../lib/ui';
import { COMPONENT_SPECS, LINE_SPECS, LINE_TYPE_LABELS, PEER_CHOICES } from './spec';
import type { ComponentSpec, OptionSpec, ParamSpec, PortGroupSpec } from './spec';
import { PROVENANCE_CHOICES, UNITS } from './params';
import type { ParamValue, Provenance } from './params';
import { portIds } from './ports';
import type { PortInfo, PortKind } from './ports';
import { speciesById } from './fluids';
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
}

interface Props {
  open: boolean;
  onClose: () => void;
  kind: 'node' | 'edge';
  data: PIDNodeData & { lineType?: string; partNumber?: string; fluid?: string };
  peers?: { id: string; label: string; hint?: string }[];
  readOnly: boolean;
  onSave: (patch: ConfigPatch) => void;
}

type Draft = { value: string; unit: string; source: Provenance };

const EMPTY: Draft = { value: '', unit: '', source: 'estimated' };

const field =
  'rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]';
const wide = `${field} w-full`;
const rowLabel = 'text-[11px] text-[var(--color-text-secondary)]';

function toDraft(spec: ParamSpec, existing?: ParamValue): Draft {
  const units = UNITS[spec.dimension];
  if (existing) {
    return {
      value: String(existing.value),
      unit: existing.unit || units[0],
      source: existing.source === 'measured' || existing.source === 'manufacturer'
        ? 'measured' : 'estimated',
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
  const [ports, setPorts] = useState<Record<string, PortInfo>>({});
  const [fluid, setFluid] = useState<string>(data.fluid ?? '');
  const [partNumber, setPartNumber] = useState(data.partNumber ?? '');
  const [lineType, setLineType] = useState(data.lineType ?? 'pipe');

  const spec: ComponentSpec | undefined =
    kind === 'edge' ? LINE_SPECS[lineType] : COMPONENT_SPECS[type];

  useEffect(() => {
    if (!open) return;
    setLabel(data.label ?? '');
    setFluid(data.fluid ?? '');
    setPartNumber(data.partNumber ?? '');
    setLineType(data.lineType ?? 'pipe');
    setPorts({ ...(data.ports ?? {}) });
  }, [open, data]);

  useEffect(() => {
    if (!open || !spec) return;
    setDrafts(Object.fromEntries(spec.params.map(p => [p.key, toDraft(p, data.params?.[p.key])])));
    setOptions(Object.fromEntries((spec.options ?? []).map(o => [o.key, data.options?.[o.key] ?? o.default])));
  }, [open, data, spec]);

  if (!spec) return null;

  const save = () => {
    const params: Record<string, ParamValue> = {};
    for (const p of spec.params) {
      const d = drafts[p.key];
      if (!d || d.value.trim() === '') continue;   // absent, not zero
      const value = Number(d.value);
      if (Number.isFinite(value)) params[p.key] = { value, unit: d.unit, source: d.source };
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
      ...(kind === 'edge' ? { lineType } : {}),
    });
    onClose();
  };

  const title = kind === 'edge' ? 'Line' : (data.label || type);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="w-[420px]"
      footer={
        <div className="flex gap-2">
          <button onClick={onClose} className={btn}>Cancel</button>
          <button onClick={save} disabled={readOnly} className={primaryBtn}>Save</button>
        </div>
      }
    >
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
          <div className="space-y-2 border-t border-[var(--color-border)] pt-2.5">
            {spec.params.map(p => (
              <ParamRow
                key={p.key}
                spec={p}
                draft={drafts[p.key] ?? EMPTY}
                readOnly={readOnly}
                onChange={patch => setDrafts(d => ({ ...d, [p.key]: { ...d[p.key], ...patch } }))}
              />
            ))}
          </div>
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
    return (
      <Row label={spec.label}>
        <select value={value} disabled={readOnly} onChange={e => onChange(e.target.value)} className={wide}>
          <option value="">—</option>
          <option value="none">No pair needed</option>
          {(peers ?? []).map(p => (
            <option key={p.id} value={p.id}>{p.label}{p.hint ? ` (${p.hint})` : ''}</option>
          ))}
        </select>
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
          placeholder="—"
          value={draft.value}
          readOnly={readOnly}
          onChange={e => onChange({ value: e.target.value })}
          className={`${field} min-w-0`}
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
            value={draft.source}
            disabled={readOnly}
            onChange={e => onChange({ source: e.target.value as Provenance })}
            className={`${field} min-w-0`}
          >
            {PROVENANCE_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
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
            <option value="flow">Flow</option>
            <option value="instrument">Instr.</option>
            <option value="plug">Plugged</option>
          </select>
        </div>
      ))}
    </div>
  );
}
