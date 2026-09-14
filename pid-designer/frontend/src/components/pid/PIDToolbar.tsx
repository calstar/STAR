import { useEffect, useState } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type { InteractionMode, MicroVersion, ReleaseVersion } from './PIDDesigner';
import { useReadOnly } from '@stardesign-ui';
import { Modal } from '../ui';
import { download, exportPng, exportSvg, fileStem } from './exportImage';
import type { SheetMeta } from './exportImage';

interface PIDToolbarProps {
  onFitView:         () => void;
  getSnapshot:       () => { nodes: Node[]; edges: Edge[] };
  loadSnapshot:      (data: { nodes: Node[]; edges: Edge[] }) => void;
  onClear:           () => void;
  /** What Clear would take, for the confirmation. */
  clearSummary:      () => { page: string; nodes: number; edges: number };
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
  /** What the exported sheet's title block says. */
  sheet:             SheetMeta;
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
  onFitView, getSnapshot, loadSnapshot, onClear, clearSummary, onUndo, onRedo,
  onRelease, onGetHistory, onGetReleases, onRestoreMicro, onRestoreRelease,
  canVersion, mode, onModeChange, sheet,
}: PIDToolbarProps) {
  // Undo, Redo, Clear, Import and the two Restores rewrite the diagram, so they
  // need the checkout. Pan / Select / Fit View / Export / History only change
  // what you are looking at, and stay live.
  const readOnly = useReadOnly();
  const fitView = () => onFitView();

  const [showRelease, setShowRelease] = useState(false);
  const [relLabel, setRelLabel]       = useState('');
  const [relStatus, setRelStatus]     = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [relError, setRelError]       = useState('');

  // Clear is the one button here that destroys work and cannot be reached by
  // accident afterwards -- undo covers it, but only if somebody realises in
  // time. It asks, and it says exactly what it is about to take.
  const [confirmClear, setConfirmClear] = useState<{ page: string; nodes: number; edges: number } | null>(null);

  const [showHistory, setShowHistory]     = useState(false);
  const [micro, setMicro]                 = useState<MicroVersion[]>([]);
  const [releases, setReleases]           = useState<ReleaseVersion[]>([]);
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'err'>('idle');
  const [restoring, setRestoring]         = useState<string | null>(null);
  // Restore replaces the canvas. It asks through the same dialog Clear
  // does, not a browser confirm() that lands wherever the browser puts it.
  const [confirmRestore, setConfirmRestore] =
    useState<{ what: string; run: () => Promise<void> } | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<'png' | 'svg' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

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

  const restoreMicro = (v: MicroVersion) => setConfirmRestore({
    what: `the autosave from ${new Date(v.savedAt).toLocaleString()}`,
    run: async () => {
      setRestoring(v.versionId);
      try { await onRestoreMicro(v.versionId); setShowHistory(false); }
      finally { setRestoring(null); }
    },
  });

  const restoreRelease = (r: ReleaseVersion) => setConfirmRestore({
    what: `release ${r.label}`,
    run: async () => {
      setRestoring(`rel:${r.label}`);
      try { await onRestoreRelease(r.label); setShowHistory(false); }
      finally { setRestoring(null); }
    },
  });

  // Three shapes of the same drawing: the JSON is the drawing for a machine,
  // the PNG and SVG are it for a person. All named after the diagram, not
  // `pid_diagram.json`, which is what every export of every drawing was.
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(getSnapshot(), null, 2)], { type: 'application/json' });
    download(blob, `${sheet.name.replace(/[\\/:*?"<>|]+/g, '-').trim()}.json`);
    setExportOpen(false);
  };

  const exportImage = async (kind: 'png' | 'svg') => {
    const flow = document.querySelector<HTMLElement>('.react-flow');
    if (!flow) return;
    setExporting(kind);
    setExportError(null);
    try {
      const { nodes } = getSnapshot();
      const shown = nodes.filter(n => (n.data as { page?: string })?.page === sheet.page || !(n.data as { page?: string })?.page);
      const blob = kind === 'png'
        ? await exportPng(flow, shown, sheet)
        : await exportSvg(flow, shown, sheet);
      download(blob, `${fileStem(sheet)}.${kind}`);
      setExportOpen(false);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'export failed');
    } finally {
      setExporting(null);
    }
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
          setTimeout(() => onFitView(), 100);
        }
      } catch { alert('Invalid P&ID JSON file.'); }
    };
    input.click();
  };

  const btn    = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors border';
  const def    = `${btn} bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] border-[var(--color-border)]`;
  const danger = `${btn} bg-red-900/30 text-red-400 hover:bg-red-900/50 border-red-800/50`;
  const green  = `${btn} bg-emerald-900/30 text-emerald-400 hover:bg-emerald-900/50 border-emerald-800/50`;
  const active = `${btn} bg-blue-600/30 text-blue-300 border-blue-500/50`;
  const modeBtn = (m: InteractionMode) => `${btn} ${mode === m ? active.replace(btn, '') : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] border-[var(--color-border)]'}`;

  return (
    <div className="relative">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-primary)]">
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
              d="M4 5a1 1 0 011-1h4a1 1 0 010 2H6v3a1 1 0 01-2 0V5zm16 0a1 1 0 00-1-1h-4a1 1 0 000 2h3v3a1 1 0 002 0V5zM4 19a1 1 0 001 1h4a1 1 0 000-2H6v-3a1 1 0 00-2 0v4zm16 0a1 1 0 01-1 1h-4a1 1 0 010-2h3v-3a1 1 0 012 0v4z" />
          </svg>
          Select
        </button>
        <div className="w-px h-5 bg-[var(--color-bg-tertiary)]" />

        <button onClick={onUndo} disabled={readOnly} className={`${def} disabled:opacity-40`} title="Undo (Ctrl+Z)">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
          </svg>
          Undo
        </button>
        <button onClick={onRedo} disabled={readOnly} className={`${def} disabled:opacity-40`} title="Redo (Ctrl+Shift+Z)">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a5 5 0 00-5 5v2M21 10l-4-4M21 10l-4 4" />
          </svg>
          Redo
        </button>
        <div className="w-px h-5 bg-[var(--color-bg-tertiary)]" />

        <button onClick={fitView} className={def}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
          Fit View
        </button>
        <div className="relative">
          <button onClick={() => setExportOpen(o => !o)} className={exportOpen ? active : def} title="Export this sheet">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export
          </button>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setExportOpen(false)} />
              <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-1 shadow-2xl">
                <ExportRow onClick={() => void exportImage('png')} busy={exporting === 'png'}
                  title="PNG image" hint="this sheet, with a title block" />
                <ExportRow onClick={() => void exportImage('svg')} busy={exporting === 'svg'}
                  title="SVG" hint="scalable, for a document" />
                <ExportRow onClick={exportJSON} title="JSON" hint="the whole diagram, for import" />
                {exportError && <p className="px-2 py-1 text-[10px] text-red-400">{exportError}</p>}
              </div>
            </>
          )}
        </div>
        <button onClick={importJSON} disabled={readOnly} className={`${def} disabled:opacity-40`}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" />
          </svg>
          Import
        </button>
        <div className="w-px h-5 bg-[var(--color-bg-tertiary)]" />

        <button
          onClick={() => { setShowRelease(true); setRelStatus('idle'); setRelError(''); }}
          disabled={!canVersion || readOnly}
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
          className={`${btn} disabled:opacity-40 ${showHistory ? 'bg-blue-600/20 text-blue-300 border-blue-600/40' : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] border-[var(--color-border)]'}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          History
        </button>

        <div className="ml-auto" />
        <button
          onClick={() => setConfirmClear(clearSummary())}
          disabled={readOnly}
          className={`${danger} disabled:opacity-40`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Clear
        </button>
      </div>

      {showHistory && (
        <div className="border-b border-[var(--color-border)] bg-[var(--color-bg-primary)] px-4 py-3 max-h-[320px] overflow-y-auto">
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
                      disabled={readOnly || restoring === `rel:${r.label}`}
                      className="flex items-center gap-2 text-left px-2 py-1.5 rounded hover:bg-[var(--color-bg-tertiary)] transition-colors group disabled:opacity-50"
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
                      disabled={readOnly || restoring === v.versionId}
                      className="flex items-center gap-2 text-left px-2 py-1.5 rounded hover:bg-[var(--color-bg-tertiary)] transition-colors group disabled:opacity-50"
                    >
                      <span className="w-2 h-2 rounded-full shrink-0 bg-[var(--color-bg-tertiary)]" />
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

      <Modal
        open={confirmClear !== null}
        onClose={() => setConfirmClear(null)}
        title={`Clear ${confirmClear?.page ?? ''}?`}
        footer={
          <div className="flex gap-2">
            <button onClick={() => setConfirmClear(null)} className={btn}>Cancel</button>
            <button
              disabled={readOnly}
              onClick={() => { onClear(); setConfirmClear(null); }}
              className={danger}
            >
              Clear this page
            </button>
          </div>
        }
      >
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          {confirmClear?.nodes === 0 ? (
            <>There is nothing on this page.</>
          ) : (
            <>
              This removes <b>{confirmClear?.nodes} component{confirmClear?.nodes === 1 ? '' : 's'}</b>
              {confirmClear?.edges ? <> and <b>{confirmClear.edges} line{confirmClear.edges === 1 ? '' : 's'}</b></> : null}
              {' '}from <b>{confirmClear?.page}</b>. Other pages are untouched.
            </>
          )}
        </p>
      </Modal>

      <Modal
        open={confirmRestore !== null}
        onClose={() => setConfirmRestore(null)}
        title="Restore this version?"
        footer={
          <div className="flex gap-2">
            <button onClick={() => setConfirmRestore(null)} className={btn}>Cancel</button>
            <button
              disabled={readOnly}
              onClick={() => { const r = confirmRestore; setConfirmRestore(null); if (r) void r.run(); }}
              className={danger}
            >
              Restore
            </button>
          </div>
        }
      >
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          This replaces the canvas with <b>{confirmRestore?.what}</b>. The working copy is
          autosaved continuously, so what is there now stays in the history.
        </p>
      </Modal>

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
                className={`${btn} bg-[#1e293b] text-slate-400 hover:bg-[var(--color-bg-tertiary)] border-[#334155] disabled:opacity-50`}
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

function ExportRow({ title, hint, onClick, busy }: {
  title: string; hint: string; onClick: () => void; busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-[var(--color-bg-tertiary)] disabled:opacity-60"
    >
      <span className="text-xs text-[var(--color-text-primary)]">{busy ? 'Rendering…' : title}</span>
      <span className="text-[10px] text-[var(--color-text-muted)]">{hint}</span>
    </button>
  );
}
