import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import { getParameters, updateConfig } from '../api/client';
import type { EngineConfig } from '../api/client';
import {
  formatValue, groupOf, labelOf, matches, nestedUpdate, parseInput, unitOf,
} from '../lib/parameters';
import type { CodeConstant, Filter, ParameterRow, ParametersResponse } from '../lib/parameters';
import { useViewState } from '../lib/viewState';

/**
 * Every parameter the design carries, in one place: value, schema default, units, what it is.
 * Rows come from GET /api/config/parameters, which walks the config schema, so nothing is left
 * out because nobody listed it. Edits are staged and applied together through PUT /api/config.
 * The "In code" section lists the physics constants that are not config fields yet (read-only).
 */

const CODE = '__code__';

function RowEditor({ row, draft, onChange, readOnly }: {
  row: ParameterRow; draft: string | undefined; onChange: (text: string) => void; readOnly: boolean;
}) {
  const text = draft ?? formatValue(row.value);
  const cls = 'w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded px-1.5 py-0.5 text-[12px] text-[var(--color-text-primary)] font-mono';
  if (row.choices || row.type.replace(' | null', '') === 'bool') {
    const opts = row.choices ?? [true, false];
    const withNull = row.type.includes('null') && !opts.includes(null);
    return (
      <select value={text} disabled={readOnly} onChange={(e) => onChange(e.target.value)} className={cls}>
        {withNull && <option value="">—</option>}
        {opts.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
      </select>
    );
  }
  return (
    <input value={text} disabled={readOnly} spellCheck={false}
           placeholder={row.type.includes('null') ? '—' : ''}
           onChange={(e) => onChange(e.target.value)} className={`${cls} text-right`} />
  );
}

export function ParametersWorkspace({ config, onConfigUpdated }: {
  config: EngineConfig | null;
  onConfigUpdated: (c: EngineConfig) => void;
}) {
  const readOnly = useReadOnly();
  const [data, setData] = useState<ParametersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useViewState<string>('parameters.section', 'design_requirements');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useViewState<Filter>('parameters.filter', 'all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await getParameters();
    if (r.error) setError(r.error);
    else if (r.data) { setData(r.data); setError(null); }
  }, []);

  useEffect(() => {
    let live = true;
    if (!config) return;
    getParameters().then((r) => {
      if (!live) return;
      if (r.error) setError(r.error);
      else if (r.data) { setData(r.data); setError(null); }
    });
    return () => { live = false; };
  }, [config]);

  const byPath = useMemo(() => new Map((data?.parameters ?? []).map((p) => [p.path, p])), [data]);
  const parsed = useMemo(() => {
    const ok: Record<string, unknown> = {};
    const bad: Record<string, string> = {};
    for (const [path, text] of Object.entries(drafts)) {
      const row = byPath.get(path);
      if (!row) continue;
      const r = parseInput(row, text);
      if (r.error) bad[path] = r.error; else ok[path] = r.value;
    }
    return { ok, bad };
  }, [drafts, byPath]);

  const searching = query.trim() !== '';
  const rows = useMemo(() => (data?.parameters ?? []).filter((p) =>
    p.kind !== 'block' && (searching || filter === 'modified' || p.section === section) && matches(p, query, filter)),
  [data, section, query, filter, searching]);

  const groups = useMemo(() => {
    const m = new Map<string, ParameterRow[]>();
    for (const r of rows) {
      const g = searching || filter === 'modified' ? r.section : groupOf(r);
      m.set(g, [...(m.get(g) ?? []), r]);
    }
    return [...m.entries()];
  }, [rows, searching, filter]);

  const constants = useMemo(() => (data?.constants ?? []).filter((c) => {
    const q = query.trim().toLowerCase();
    return !q || `${c.name} ${c.meaning} ${c.where} ${c.category}`.toLowerCase().includes(q);
  }), [data, query]);

  const nEdits = Object.keys(drafts).length;
  const nBad = Object.keys(parsed.bad).length;

  const apply = async () => {
    setSaving(true);
    const r = await updateConfig(nestedUpdate(parsed.ok) as Partial<EngineConfig>);
    setSaving(false);
    if (r.error) { setError(r.error); return; }
    setDrafts({});
    if (r.data?.config) onConfigUpdated(r.data.config);
    await load();
  };

  const edit = (path: string, text: string) => {
    const row = byPath.get(path);
    setDrafts((d) => {
      const next = { ...d };
      if (row && text === formatValue(row.value)) delete next[path]; else next[path] = text;
      return next;
    });
  };

  if (!config) return <div className="p-6 text-sm text-[var(--color-text-secondary)]">Load a design to see its parameters.</div>;

  const blocks = (data?.parameters ?? []).filter((p) => p.kind === 'block' && p.section === section);

  return (
    <div className="flex h-full min-h-0 text-[var(--color-text-primary)]">
      <nav className="w-56 shrink-0 border-r border-[var(--color-border)] overflow-y-auto py-2">
        {(data?.sections ?? []).map((s) => (
          <button key={s.key} type="button" onClick={() => { setSection(s.key); setQuery(''); if (filter === 'modified') setFilter('all'); }}
                  className={`w-full flex items-center justify-between px-3 py-1.5 text-left text-[12px] ${section === s.key && !searching && filter !== 'modified' ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
            <span className="truncate">{s.label}</span>
            <span className="font-mono text-[10px] opacity-70">{s.modified > 0 ? `${s.modified}/` : ''}{s.count}</span>
          </button>
        ))}
        <button type="button" onClick={() => { setSection(CODE); setQuery(''); setFilter('all'); }}
                className={`w-full flex items-center justify-between px-3 py-1.5 mt-2 border-t border-[var(--color-border)] text-left text-[12px] ${section === CODE ? 'bg-[var(--color-bg-primary)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
          <span>In code</span>
          <span className="font-mono text-[10px] opacity-70">{data?.constants.length ?? 0}</span>
        </button>
      </nav>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, description, unit"
                 className="flex-1 min-w-[12rem] bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded px-2 py-1 text-[12px]" />
          <div className="flex rounded border border-[var(--color-border)] overflow-hidden text-[11px]">
            {(['all', 'modified'] as Filter[]).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)}
                      className={`px-2 py-1 ${filter === f ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
                {f === 'all' ? 'All' : 'Changed from default'}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-[var(--color-text-secondary)]">
            {nEdits > 0 ? `${nEdits} edit${nEdits > 1 ? 's' : ''}${nBad ? `, ${nBad} invalid` : ''}` : ''}
          </span>
          <button type="button" disabled={!nEdits || saving || readOnly} onClick={() => setDrafts({})}
                  className="text-[11px] px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] disabled:opacity-40">Discard</button>
          <button type="button" disabled={!nEdits || nBad > 0 || saving || readOnly} onClick={apply}
                  className="text-[11px] px-2 py-1 rounded bg-rose-600 text-white disabled:opacity-40">{saving ? 'Saving' : 'Apply'}</button>
        </div>
        {error && <div className="px-3 py-1.5 text-[11px] text-[#f87171] font-mono">{error}</div>}

        <div className="flex-1 overflow-y-auto">
          {section === CODE && !searching ? (
            <ConstantsTable constants={constants} />
          ) : (
            <>
              {groups.map(([g, rs]) => (
                <div key={g}>
                  {g && <div className="px-3 pt-3 pb-1 text-[11px] font-semibold text-[var(--color-text-secondary)] font-mono">{g}</div>}
                  <table className="w-full text-[12px] table-fixed">
                    <colgroup><col className="w-[34%]" /><col className="w-[22%]" /><col className="w-[9%]" /><col className="w-[18%]" /><col className="w-[17%]" /></colgroup>
                    <tbody>
                      {rs.map((r) => {
                        const draft = drafts[r.path];
                        const bad = parsed.bad[r.path];
                        return (
                          <tr key={r.path} className="border-b border-[var(--color-border)]/40 align-top hover:bg-[var(--color-bg-primary)]/40">
                            <td className="px-3 py-1">
                              <button type="button" onClick={() => setOpen(open === r.path ? null : r.path)} className="text-left w-full" title={r.path}>
                                <span className={r.modified || draft !== undefined ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}>
                                  {(r.modified || draft !== undefined) && <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ${draft !== undefined ? 'bg-amber-400' : 'bg-sky-400'}`} />}
                                  {labelOf(r.path)}
                                </span>
                                {r.kind === 'undeclared' && <span className="ml-1 text-[10px] text-amber-400">undeclared</span>}
                              </button>
                              {open === r.path && (
                                <div className="mt-1 text-[11px] leading-4 text-[var(--color-text-secondary)] whitespace-pre-wrap">
                                  <div className="font-mono opacity-80">{r.path}</div>
                                  {r.description || 'No description in the schema.'}
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-1">
                              <RowEditor row={r} draft={draft} onChange={(t) => edit(r.path, t)} readOnly={readOnly} />
                              {bad && <div className="text-[10px] text-[#f87171]">{bad}</div>}
                            </td>
                            <td className="px-1 py-1 text-[11px] text-[var(--color-text-secondary)] truncate">{unitOf(r) ?? ''}</td>
                            <td className="px-2 py-1 text-[11px] font-mono text-[var(--color-text-secondary)] truncate" title="schema default">
                              {r.required ? 'required' : `default ${formatValue(r.default) || '—'}`}
                            </td>
                            <td className="px-2 py-1 text-right">
                              {!r.required && (r.modified || draft !== undefined) && (
                                <button type="button" disabled={readOnly}
                                        onClick={() => edit(r.path, formatValue(r.default))}
                                        className="text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40">
                                  reset
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
              {!searching && filter !== 'modified' && blocks.map((b) => (
                <div key={b.path} className="px-3 py-2 text-[11px] text-[var(--color-text-secondary)]">
                  <span className="font-mono">{b.path}</span> is not set. {b.description}
                </div>
              ))}
              {searching && constants.length > 0 && <ConstantsTable constants={constants} />}
              {rows.length === 0 && !(searching && constants.length) && (
                <div className="p-6 text-[12px] text-[var(--color-text-secondary)]">Nothing matches.</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function byCategory(constants: CodeConstant[]): [string, CodeConstant[]][] {
  const groups = new Map<string, CodeConstant[]>();
  for (const c of constants) groups.set(c.category, [...(groups.get(c.category) ?? []), c]);
  return [...groups.entries()];
}

function ConstantsTable({ constants }: { constants: CodeConstant[] }) {
  if (!constants.length) {
    return <div className="p-6 text-[12px] text-[var(--color-text-secondary)]">No constants registered.</div>;
  }
  return (
    <div>
      <div className="px-3 pt-3 pb-1 text-[11px] text-[var(--color-text-secondary)]">
        Fixed in code, not in the config. Shown so every assumption is visible; change them in the source.
      </div>
      <table className="w-full text-[12px] table-fixed">
        <colgroup><col className="w-[24%]" /><col className="w-[18%]" /><col className="w-[38%]" /><col className="w-[20%]" /></colgroup>
        <tbody>
          {byCategory(constants).map(([category, rows]) => (
            <Fragment key={category}>
              <tr>
                <td colSpan={4} className="px-3 pt-3 pb-1 text-[11px] font-medium text-[var(--color-text-secondary)]">{category}</td>
              </tr>
              {rows.map((c) => (
                <tr key={`${c.where}:${c.name}`} className="border-b border-[var(--color-border)]/40 align-top">
                  <td className="px-3 py-1 font-mono text-[11px] break-all">
                    {c.affects_results && <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle bg-sky-400" title="changes results" />}
                    {c.name}
                  </td>
                  <td className="px-2 py-1"><div className="font-mono text-[11px] break-all line-clamp-3" title={c.value}>{c.value}</div></td>
                  <td className="px-2 py-1 text-[11px] text-[var(--color-text-secondary)]">{c.meaning}</td>
                  <td className="px-2 py-1 font-mono text-[10px] text-[var(--color-text-secondary)] truncate" title={c.where}>{c.where}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default ParametersWorkspace;
