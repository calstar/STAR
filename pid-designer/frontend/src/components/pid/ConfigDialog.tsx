import { useEffect, useState } from 'react';
import { Modal } from '../ui';
import { btn, primaryBtn } from '../../lib/ui';
import { COMPONENT_SPECS } from './spec';
import type { OptionSpec, ParamSpec } from './spec';
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

interface Props {
  open: boolean;
  onClose: () => void;
  nodeId: string;
  data: PIDNodeData;
  readOnly: boolean;
  onSave: (patch: { params: Record<string, ParamValue>; options: Record<string, string>; label: string }) => void;
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

export function ConfigDialog({ open, onClose, data, readOnly, onSave }: Props) {
  const type = data.componentType as ComponentType;
  const spec = COMPONENT_SPECS[type];

  const [label, setLabel] = useState(data.label ?? '');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [options, setOptions] = useState<Record<string, string>>({});

  // Reset whenever a different symbol is opened, so a dialog never shows the
  // last one's numbers under this one's name.
  useEffect(() => {
    if (!open || !spec) return;
    setLabel(data.label ?? '');
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
    onSave({ params, options, label: label.trim() || data.label });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${data.label || type} — configuration`}
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

        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Tag</span>
          <input
            value={label}
            readOnly={readOnly}
            onChange={e => setLabel(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <span className="mt-1 block text-[10px] text-[var(--color-text-muted)]">
            The name this component is known by, on the drawing and in a solve.
          </span>
        </label>

        {(spec.options ?? []).map(o => (
          <OptionField
            key={o.key}
            spec={o}
            value={options[o.key] ?? o.default}
            readOnly={readOnly}
            onChange={v => setOptions(s => ({ ...s, [o.key]: v }))}
          />
        ))}

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

function OptionField({ spec, value, readOnly, onChange }: {
  spec: OptionSpec; value: string; readOnly: boolean; onChange: (v: string) => void;
}) {
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
