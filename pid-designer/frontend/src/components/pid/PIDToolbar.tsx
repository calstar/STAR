import { useEffect, useState } from 'react';
import type { ReactFlowInstance, Node, Edge } from '@xyflow/react';
import type { InteractionMode, MicroVersion, ReleaseVersion } from './PIDDesigner';

interface PIDToolbarProps {
  rfInstance:        ReactFlowInstance | null;
  getSnapshot:       () => { nodes: Node[]; edges: Edge[] };
  loadSnapshot:      (data: { nodes: Node[]; edges: Edge[] }) => void;
  onClear:           () => void;
  onUndo:            () => void;
  onRedo:            () => void;
  onRelease:         (label: string) => Promise<{ label: string; savedAt: string }>;
  onGetHistory:      () => Promise<MicroVersion[]>;
  onGetReleases:     () => Promise<ReleaseVersion[]>;
  onRestoreMicro:    (versionId: string) => Promise<void>;
  onRestoreRelease:  (label: string) => Promise<void>;
  canVersion:        boolean;
  mode:              InteractionMode;
  onModeChange:      (mode: InteractionMode) => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function PIDToolbar({
  rfInstance, getSnapshot, loadSnapshot, onClear, onUndo, onRedo,
  onRelease, onGetHistory, onGetReleases, onRestoreMicro, onRestoreRelease,
  canVersion, mode, onModeChange,
}: PIDToolbarProps) {
  const fitView = () => rfInstance?.fitView({ padding: 0.1 });

  const [showRelease, setShowRelease] = useState(false);
  const [relLabel, setRelLabel]       = useState('');
  const [relStatus, setRelStatus]     = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [relError, setRelError]       = useState('');

  const [showHistory, setShowHistory]     = useState(false);
  const [micro, setMicro]                 = useState<MicroVersion[]>([]);
  const [releases, setReleases]           = useState<ReleaseVersion[]>([]);
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'err'>('idle');
  const [restoring, setRestoring]         = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) onRedo(); else onUndo();
        return;
      }
      if (!mod && !e.shiftKey && !e.altKey) {
        if (e.key.toLowerCase() === 'v') onModeChange('pan');
        if (e.key.toLowerCase() === 'b') onModeChange('select');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onUndo, onRedo, onModeChange]);

  const submitRelease = async () => {
    if (!relLabel.trim()) return;
    setRelStatus('saving');
    setRelError('');
    try {
      await onRelease(relLabel.trim());
      setRelStatus('ok');
      if (showHistory) void refreshHistory();
      setTimeout(() => {
        setShowRelease(false);
        setRelLabel('');
        setRelStatus('idle');
      }, 1200);
    } catch (e) {
      setRelStatus('err');
      setRelError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const refreshHistory = async () => {
    setHistoryStatus('loading');
    try {
      const [m, r] = await Promise.all([onGetHistory(), onGetReleases()]);
      setMicro(m);
      setReleases(r);
      setHistoryStatus('idle');
    } catch {
      setHistoryStatus('err');
    }
  };

  const openHistory = async () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) void refreshHistory();
  };

  const restoreMicro = async (v: MicroVersion) => {
    if (!confirm(`Restore microversion from ${new Date(v.savedAt).toLocaleString()}?\n\nThis replaces your current canvas (your working copy is snapshotted continuously, so you can undo).`)) return;
    setRestoring(v.versionId);
    try {
      await onRestoreMicro(v.versionId);
      setShowHistory(false);
    } finally {
      setRestoring(null);
    }
  };

  const restoreRelease = async (r: ReleaseVersion) => {
    if (!confirm(`Restore release "${r.label}"?\n\nThis replaces your current canvas.`)) return;
    setRestoring(`rel:${r.label}`);
    try {
      await onRestoreRelease(r.label);
      setShowHistory(false);
    } finally {
      setRestoring(null);
    }
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pid_diagram.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const importJSON = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text()) as { nodes: Node[]; edges: Edge[] };
        if (Array.isArray(data.nodes) && Array.isArray(data.edges)) {
          loadSnapshot(data);
          setTimeout(() => rfInstance?.fitView({ padding: 0.1 }), 100);
        }
      } catch { alert('Invalid P&ID JSON file.'); }
    };
    input.click();
  };

  const btn    = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors border';
  const def    = `${btn} bg-[#1e293b] text-slate-300 hover:bg-[#334155] border-[#334155]`;
  const danger = `${btn} bg-red-900/30 text-red-400 hover:bg-red-900/50 border-red-800/50`;
  const green  = `${btn} bg-emerald-900/30 text-emerald-400 hover:bg-emerald-900/50 border-emerald-800/50`;
  const active = `${btn} bg-blue-600/30 text-blue-300 border-blue-500/50`;
  const modeBtn = (m: InteractionMode) => `${btn} ${mode === m ? active.replace(btn, '') : 'bg-[#1e293b] text-slate-300 hover:bg-[#334155] border-[#334155]'}`;

  return (
    <div className="relative">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1e293b] bg-[#0f172a]">
        <button onClick={() => onModeChange('pan')} className={modeBtn('pan')} title="Pan (V)">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11" />
          </svg>
          Pan
        </button>
        <button onClick={() => onModeChange('select')} className={modeBtn('select')} title="Box Select (B)">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 5a1 1 0 011-1h4a1 1 0 010 2H6v3a1 1 0 01-2 0V5zm16 0a1 1 0 00-1-1h-4a1 1 0 000 2h3v3a1 1 0 002 0V5zM4 19a1 1 0 001 1h4a1 1 0 000-2H6v-3a1 1 0 00-2 0v4zm16 0a1 1 01-1 1h-4a1 1 0 010-2h3v-3a1 1 0 012 0v4z" />
          </svg>
          Select
        </button>
        <div className="w-px h-5 bg-[#334155]" />

        <button onClick={onUndo} className={def} title="Undo (Ctrl+Z)">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
          </svg>
          Undo
        </button>
        <button onClick={onRedo} className={def} title="Redo (Ctrl+Shift+Z)">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a5 5 0 00-5 5v2M21 10l-4-4M21 10l-4 4" />
          </svg>
          Redo
        </button>
        <div className="w-px h-5 bg-[#334155]" />

        <button onClick={fitView} className={def}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
          Fit View
        </button>
        <button onClick={exportJSON} className={def}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export
        </button>
        <button onClick={importJSON} className={def}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" />
          </svg>
          Import
        </button>
        <div className="w-px h-5 bg-[#334155]" />

        <button
          onClick={() => { setShowRelease(true); setRelStatus('idle'); setRelError(''); }}
          disabled={!canVersion}
          className={`${green} disabled:opacity-40`}
          title="Publish an immutable, named version (e.g. 0.1)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.99 1.99 0 013 12V7a4 4 0 014-4z" />
          </svg>
          Release
        </button>

        <button
          onClick={openHistory}
          disabled={!canVersion}
          className={`${btn} disabled:opacity-40 ${showHistory ? 'bg-blue-600/20 text-blue-300 border-blue-600/40' : 'bg-[#1e293b] text-slate-300 hover:bg-[#334155] border-[#334155]'}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          History
        </button>

        <div className="ml-auto" />
        <button onClick={onClear} className={danger}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Clear
        </button>
      </div>

      {showHistory && (
        <div className="border-b border-[#1e293b] bg-[#0a1628] px-4 py-3 max-h-[320px] overflow-y-auto">
          {historyStatus === 'loading' && <p className="text-xs text-slate-500 py-2">Loading…</p>}
          {historyStatus === 'err' && <p className="text-xs text-red-400 py-2">Failed to load history - is the backend running?</p>}

          {historyStatus === 'idle' && (
            <>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Releases</p>
              {releases.length === 0 && <p className="text-xs text-slate-600 pb-2">No releases yet - click Release to publish 0.1.</p>}
              {releases.length > 0 && (
                <div className="flex flex-col gap-1 mb-3">
                  {releases.map(r => (
                    <button
                      key={r.label}
                      onClick={() => restoreRelease(r)}
                      disabled={restoring === `rel:${r.label}`}
                      className="flex items-center gap-2 text-left px-2 py-1.5 rounded hover:bg-[#1e293b] transition-colors group disabled:opacity-50"
                    >
                      <span className="inline-flex items-center justify-center text-[10px] font-semibold text-emerald-300 bg-emerald-900/40 border border-emerald-800/50 rounded px-1.5 py-0.5 shrink-0">{r.label}</span>
                      <span className="text-[10px] text-slate-600 flex-1 group-hover:text-slate-400">
                        {restoring === `rel:${r.label}` ? 'Restoring…' : relativeTime(r.savedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Microversions (auto-saved)</p>
              {micro.length === 0 && <p className="text-xs text-slate-600 py-2">No microversions yet.</p>}
              {micro.length > 0 && (
                <div className="flex flex-col gap-1">
                  {micro.map(v => (
                    <button
                      key={v.versionId}
                      onClick={() => restoreMicro(v)}
                      disabled={restoring === v.versionId}
                      className="flex items-center gap-2 text-left px-2 py-1.5 rounded hover:bg-[#1e293b] transition-colors group disabled:opacity-50"
                    >
                      <span className="w-2 h-2 rounded-full shrink-0 bg-[#334155]" />
                      <span className="text-xs text-slate-300 flex-1 truncate">{new Date(v.savedAt).toLocaleString()}</span>
                      <span className="text-[10px] text-slate-600 shrink-0 group-hover:text-slate-400">
                        {restoring === v.versionId ? 'Restoring…' : relativeTime(v.savedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showRelease && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => relStatus !== 'saving' && setShowRelease(false)}>
          <div className="bg-[#0f172a] border border-[#334155] rounded-xl shadow-2xl p-6 w-[420px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-200 mb-1">Publish a release</h3>
            <p className="text-xs text-slate-500 mb-4">An immutable, named snapshot of this diagram. Reuse of a label is rejected.</p>

            <label className="block text-xs text-slate-400 mb-1">Version label <span className="text-red-400">*</span></label>
            <input
              autoFocus
              value={relLabel}
              onChange={e => setRelLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitRelease(); if (e.key === 'Escape') setShowRelease(false); }}
              placeholder="0.1"
              disabled={relStatus === 'saving'}
              className="w-full bg-[#1e293b] border border-[#334155] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-blue-500/60 mb-4 disabled:opacity-50"
            />

            {relStatus === 'err' && <p className="text-xs text-red-400 mb-3">{relError}</p>}
            {relStatus === 'ok' && <p className="text-xs text-emerald-400 mb-3">Release published!</p>}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowRelease(false)}
                disabled={relStatus === 'saving'}
                className={`${btn} bg-[#1e293b] text-slate-400 hover:bg-[#334155] border-[#334155] disabled:opacity-50`}
              >
                Cancel
              </button>
              <button
                onClick={submitRelease}
                disabled={!relLabel.trim() || relStatus === 'saving'}
                className={`${btn} bg-emerald-700/50 text-emerald-300 hover:bg-emerald-700/70 border-emerald-700/50 disabled:opacity-40`}
              >
                {relStatus === 'saving'
                  ? <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                  : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                }
                {relStatus === 'saving' ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
