import { useMemo, useState } from 'react';
import type { Component } from '../types';

interface Props {
  components: Component[];
  selected: Set<string>;
  /** Show config roles ("Ox Upstream") rather than Elodin identities ("1.CH5"). */
  showNames: boolean;
  onToggle: (name: string) => void;
  onToggleMany: (names: string[]) => void;
  onClear: () => void;
}

// Two-level tree: family (ACT, PT_Cal, …) → field/type (actuator_state,
// raw_adc, pressure_psi, …) → the individual sensors under that field.
// Families are expanded by default; field groups collapse to keep the tree
// compact. A search auto-expands everything so matches are always visible.
export default function SensorPicker({ components, selected, showNames, onToggle, onToggleMany, onClear }: Props) {
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false); // include plumbing/secondary fields
  const [collapsedFams, setCollapsedFams] = useState<Set<string>>(new Set());
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());

  const query = q.trim().toLowerCase();
  const searching = query.length > 0;

  const shortEntity = (c: Component) => c.entity.replace(new RegExp(`^${c.family}\\.?`), '') || c.entity;
  // With names on, what the channel IS beats what Elodin called it: "Ox Upstream" over
  // "1.CH5". Whichever form is hidden goes in the leaf's tooltip, so the raw component
  // name — the CSV column key, and the only handle an unnamed channel has — stays a
  // hover away either way.
  const entityName = (c: Component) => (showNames && c.label) || shortEntity(c);
  const leafTitle = (c: Component) =>
    showNames && c.label ? c.name : c.label ? `${c.name} (${c.label})` : c.name;

  // Build the tree. The middle level is adaptive per family: sensor arrays have
  // many entities sharing few fields → group by FIELD (pick "pressure_psi", then
  // a channel). CONTROLLER/SEQUENCER have few entities with many distinct fields
  // → group by ENTITY (pick "diagnostics", then "F_ref"), so each datum keeps
  // its real name instead of being buried under a one-child field group.
  const tree = useMemo(() => {
    const byFamily = new Map<string, Component[]>();
    for (const c of components) {
      if (!showAll && !c.primary) continue;
      if (query && !`${c.name} ${c.label}`.toLowerCase().includes(query)) continue;
      (byFamily.get(c.family) ?? byFamily.set(c.family, []).get(c.family)!).push(c);
    }
    return [...byFamily.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([family, comps]) => {
        const nEntities = new Set(comps.map((c) => c.entity)).size;
        const nFields = new Set(comps.map((c) => c.field)).size;
        // Group by field for sensor arrays (entities ≥ fields), by entity only
        // when fields strictly outnumber entities (CONTROLLER, SEQUENCER). Ties
        // favour field so load-cell-style families stay consistent with sensors.
        const byField = nEntities >= nFields;
        const groups = new Map<string, Component[]>();
        for (const c of comps) {
          const key = byField ? c.field : entityName(c);
          (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
        }
        const leafLabel = (c: Component) => (byField ? entityName(c) : c.field);
        return {
          family,
          byField,
          leafLabel,
          groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        };
      });
  }, [components, query, showAll, showNames]);

  const famOpen = (fam: string) => searching || !collapsedFams.has(fam);
  const fieldOpen = (key: string) => searching || expandedFields.has(key);

  const toggleFam = (fam: string) =>
    setCollapsedFams((prev) => {
      const n = new Set(prev);
      n.has(fam) ? n.delete(fam) : n.add(fam);
      return n;
    });
  const toggleField = (key: string) =>
    setExpandedFields((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  const countSelected = (comps: Component[]) => comps.filter((c) => selected.has(c.name)).length;

  return (
    <div className="picker">
      <div className="picker-controls">
        <input
          className="input picker-search"
          placeholder="Filter sensors…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="picker-toggle" title="Include raw/status/plumbing fields">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          all fields
        </label>
        {selected.size > 0 && (
          <button className="btn ghost sm" onClick={onClear} title="Deselect every channel">
            Clear ({selected.size})
          </button>
        )}
      </div>

      <div className="picker-groups">
        {tree.map(({ family, leafLabel, groups }) => {
          const famSelected = groups.reduce((n, [, comps]) => n + countSelected(comps), 0);
          const open = famOpen(family);
          return (
            <div key={family} className="tree-family">
              <button className="tree-row tree-fam" onClick={() => toggleFam(family)}>
                <span className={`caret${open ? ' open' : ''}`}>▸</span>
                <span className="tree-fam-name">{family}</span>
                {famSelected > 0 && <span className="tree-badge">{famSelected}</span>}
              </button>

              {open &&
                groups.map(([group, comps]) => {
                  const key = `${family}/${group}`;
                  const fOpen = fieldOpen(key);
                  const fSelected = countSelected(comps);
                  const allOn = fSelected === comps.length && comps.length > 0;
                  return (
                    <div key={key} className="tree-field">
                      <div className="tree-row tree-field-hdr">
                        <button className="tree-caret-btn" onClick={() => toggleField(key)}>
                          <span className={`caret${fOpen ? ' open' : ''}`}>▸</span>
                        </button>
                        <input
                          type="checkbox"
                          className="tree-check"
                          checked={allOn}
                          ref={(el) => {
                            if (el) el.indeterminate = fSelected > 0 && !allOn;
                          }}
                          onChange={() => onToggleMany(comps.map((c) => c.name))}
                          onClick={(e) => e.stopPropagation()}
                          title="Select / deselect all in this group"
                        />
                        <button className="tree-toggle" onClick={() => toggleField(key)}>
                          <span className="tree-field-name">{group}</span>
                          <span className="tree-count">{comps.length}</span>
                          {fSelected > 0 && <span className="tree-badge">{fSelected}</span>}
                        </button>
                      </div>

                      {fOpen &&
                        comps.map((c) => (
                          <label key={c.name} className="picker-item tree-leaf" title={leafTitle(c)}>
                            <input
                              type="checkbox"
                              checked={selected.has(c.name)}
                              onChange={() => onToggle(c.name)}
                            />
                            <span className="picker-label">{leafLabel(c)}</span>
                          </label>
                        ))}
                    </div>
                  );
                })}
            </div>
          );
        })}
        {tree.length === 0 && <div className="picker-empty">No matching sensors</div>}
      </div>
    </div>
  );
}
