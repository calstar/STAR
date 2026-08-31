import type { DiagramMeta } from './PIDDesigner';

interface DiagramBarProps {
  diagrams: DiagramMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
}

/** A thin strip above the toolbar: pick / create / rename the user's own
 *  diagrams. Each user sees only their own list (keyed by X-Auth-Email).
 *
 *  Diagrams are never deleted -- see PIDDesigner. */
export function DiagramBar({ diagrams, activeId, onSelect, onCreate, onRename }: DiagramBarProps) {
  const active = diagrams.find(d => d.id === activeId) ?? null;

  const btn = 'flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors border bg-[#1e293b] text-slate-300 hover:bg-[#334155] border-[#334155]';

  const create = () => {
    const name = window.prompt('New diagram name:', 'Untitled');
    if (name && name.trim()) onCreate(name.trim());
  };
  const rename = () => {
    if (!active) return;
    const name = window.prompt('Rename diagram:', active.name);
    if (name && name.trim()) onRename(active.id, name.trim());
  };

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-[#1e293b] bg-[#0a1120]">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 shrink-0">Diagram</span>
      <select
        value={activeId ?? ''}
        onChange={e => onSelect(e.target.value)}
        className="bg-[#1e293b] border border-[#334155] rounded px-2 py-1 text-xs text-slate-200 outline-none focus:border-blue-500/60 min-w-[180px] max-w-[320px]"
      >
        {diagrams.length === 0 && <option value="">No diagrams</option>}
        {diagrams.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <button onClick={create} className={btn} title="New diagram">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
        New
      </button>
      <button onClick={rename} disabled={!active} className={`${btn} disabled:opacity-40`} title="Rename">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
        Rename
      </button>
    </div>
  );
}
