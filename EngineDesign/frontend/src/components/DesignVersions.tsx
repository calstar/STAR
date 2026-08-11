/**
 * Versioned designs: a document bar + release/history controls.
 *
 * Mirrors the pid-designer model. Each named design is a server-side document
 * with a working copy (autosaved here), throttled microversions, and immutable
 * named releases. An auto-saved mistake is recoverable by restoring an earlier
 * microversion or a release.
 *
 * The live config lives in the backend session, edited from many tabs with no
 * single client-side "changed" event, so autosave *polls* the authoritative
 * config (GET /api/config) and writes the working copy when it changes. Restores
 * apply through POST /api/config/load so the session (and thus every tab) sees
 * the restored design.
 *
 * Every dialog here (new/rename/delete, restore confirmations, the file-load
 * error, and history) is an in-app centred modal styled like the rest of the
 * app -- never a browser prompt/confirm/alert, which cannot be themed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getConfig, loadConfigJson, type EngineConfig } from '../api/client';
import * as api from '../api/documents';
import type { DocMeta, MicroVersion, ReleaseVersion } from '../api/documents';

const ACTIVE_KEY = 'engine-design.activeDoc.v1';
const AUTOSAVE_POLL_MS = 4000;

const btn =
  'inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40';
const primaryBtn =
  'inline-flex items-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-40';
const dangerBtn =
  'inline-flex items-center gap-1 rounded border border-red-500/50 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-40';
const ghostBtn =
  'inline-flex items-center gap-1 rounded border border-transparent px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-40';

/** The one at-a-time dialog the bar drives: a text prompt, a confirmation
 *  (optionally destructive), or a plain message. Replaces window.prompt /
 *  confirm / alert so every dialog is centred and styled like the app. */
type Dialog =
  | { kind: 'prompt'; title: string; label?: string; placeholder?: string; confirmLabel: string; onConfirm: (value: string) => void | Promise<void> }
  | { kind: 'confirm'; title: string; message: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { kind: 'alert'; title: string; message: ReactNode };

/**
 * A centred, app-styled modal. The one dialog shell everything else builds on
 * -- prompts, confirmations, the design history -- so the app never falls back
 * to a browser alert/confirm/prompt, which cannot be themed and land in the
 * wrong place. Click the backdrop or press Escape to dismiss.
 */
function Modal({ open, onClose, title, children, footer, width = 'w-[440px]' }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className={`${width} max-w-[90vw] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h3>
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/** Download any JSON payload as a file, the browser way. */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Propose the next minor release, e.g. 0.1 -> 0.2, given existing labels. */
function nextLabel(releases: ReleaseVersion[]): string {
  let maxMinor = 0;
  for (const r of releases) {
    const m = /^0\.(\d+)$/.exec(r.label);
    if (m) maxMinor = Math.max(maxMinor, Number(m[1]));
  }
  return `0.${maxMinor + 1}`;
}

function relativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function fetchConfig(): Promise<EngineConfig | null> {
  const res = await getConfig();
  return res.data?.config ?? null;
}

interface Props {
  /** Apply a config to the app's own state (the backend session is synced
   *  separately, before this is called). */
  onRestore: (config: EngineConfig) => void;
  /** Render just the bar row, no background or width container -- for dropping
   *  inside a parent (the header) that already provides both. */
  inline?: boolean;
}

export function DesignVersions({ onRestore, inline = false }: Props) {
  const [documents, setDocuments] = useState<DocMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const loadedId = useRef<string | null>(null);
  const lastSaved = useRef<string>(''); // JSON of the last-autosaved config
  const lastConfig = useRef<EngineConfig | null>(null); // for the close beacon

  const [showHistory, setShowHistory] = useState(false);
  const [micro, setMicro] = useState<MicroVersion[]>([]);
  const [releases, setReleases] = useState<ReleaseVersion[]>([]);
  const [histStatus, setHistStatus] = useState<'idle' | 'loading' | 'err'>('idle');
  const [restoring, setRestoring] = useState<string | null>(null);

  const [showRelease, setShowRelease] = useState(false);
  const [relLabel, setRelLabel] = useState('');
  const [relStatus, setRelStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [relError, setRelError] = useState('');

  // One at-a-time dialog (prompt / confirm / alert) and, for prompts, its input.
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogValue, setDialogValue] = useState('');
  const askPrompt = (opts: Extract<Dialog, { kind: 'prompt' }> & { value?: string }) => {
    setDialogValue(opts.value ?? '');
    setDialog(opts);
  };
  const runDialog = async () => {
    const d = dialog;
    if (!d) return;
    if (d.kind === 'prompt') {
      const v = dialogValue.trim();
      if (!v) return;
      setDialog(null);
      await d.onConfirm(v);
    } else if (d.kind === 'confirm') {
      setDialog(null);
      await d.onConfirm();
    } else {
      setDialog(null);
    }
  };

  const active = documents.find((d) => d.id === activeId) ?? null;

  // Apply a snapshot: sync the backend session first, then the app's state.
  const apply = useCallback(
    async (config: EngineConfig) => {
      await loadConfigJson(config);
      onRestore(config);
      lastConfig.current = config;
      lastSaved.current = JSON.stringify(config);
    },
    [onRestore],
  );

  const openDoc = useCallback(
    async (id: string) => {
      loadedId.current = null;
      try {
        const { config } = await api.loadDocument(id);
        if (config && Object.keys(config).length > 0) {
          await apply(config as EngineConfig);
        }
      } finally {
        loadedId.current = id;
      }
    },
    [apply],
  );

  // Mount: list documents; seed one from the current (default) config if none.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const docs = await api.listDocuments();
        if (cancelled) return;
        if (docs.length === 0) {
          const seed = (await fetchConfig()) ?? undefined;
          const meta = await api.createDocument('Design 1', seed);
          if (cancelled) return;
          setDocuments([meta]);
          setActiveId(meta.id);
          loadedId.current = meta.id; // seeded from current config
          if (seed) {
            lastConfig.current = seed;
            lastSaved.current = JSON.stringify(seed);
          }
          localStorage.setItem(ACTIVE_KEY, meta.id);
          return;
        }
        setDocuments(docs);
        const remembered = localStorage.getItem(ACTIVE_KEY);
        const pick = docs.find((d) => d.id === remembered)?.id ?? docs[0].id;
        setActiveId(pick);
        void openDoc(pick);
      } catch {
        loadedId.current = null; // backend/history unavailable
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openDoc]);

  // Autosave: poll the authoritative config and write the working copy on change.
  useEffect(() => {
    if (!activeId) return;
    const tick = async () => {
      if (loadedId.current !== activeId) return;
      const config = await fetchConfig();
      if (!config) return;
      const serialized = JSON.stringify(config);
      lastConfig.current = config;
      if (serialized === lastSaved.current) return;
      try {
        await api.autosaveDocument(activeId, config);
        lastSaved.current = serialized;
      } catch {
        /* keep the old lastSaved; retry next tick */
      }
    };
    const id = setInterval(() => void tick(), AUTOSAVE_POLL_MS);
    return () => clearInterval(id);
  }, [activeId]);

  // Best-effort flush on tab close, between the throttled microversions.
  useEffect(() => {
    const flush = () => {
      if (activeId && loadedId.current === activeId && lastConfig.current) {
        api.flushDocument(activeId, lastConfig.current);
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [activeId]);

  const select = (id: string) => {
    setActiveId(id);
    localStorage.setItem(ACTIVE_KEY, id);
    void openDoc(id);
    setShowHistory(false);
  };

  const create = () =>
    askPrompt({
      kind: 'prompt',
      title: 'New design',
      label: 'Design name',
      placeholder: 'Design name',
      value: `Design ${documents.length + 1}`,
      confirmLabel: 'Create',
      onConfirm: async (name) => {
        const seed = (await fetchConfig()) ?? undefined;
        const meta = await api.createDocument(name, seed);
        setDocuments((d) => [meta, ...d]);
        setActiveId(meta.id);
        loadedId.current = meta.id;
        if (seed) {
          lastConfig.current = seed;
          lastSaved.current = JSON.stringify(seed);
        }
        localStorage.setItem(ACTIVE_KEY, meta.id);
      },
    });

  const rename = () => {
    if (!active) return;
    askPrompt({
      kind: 'prompt',
      title: 'Rename design',
      label: 'Design name',
      value: active.name,
      confirmLabel: 'Rename',
      onConfirm: async (name) => {
        const meta = await api.renameDocument(active.id, name);
        setDocuments((d) => d.map((x) => (x.id === meta.id ? meta : x)));
      },
    });
  };

  const remove = () => {
    if (!active) return;
    setDialog({
      kind: 'confirm',
      title: `Delete "${active.name}"?`,
      message: 'This removes the design, its microversions, and its releases. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        await api.deleteDocument(active.id);
        const rest = documents.filter((d) => d.id !== active.id);
        setDocuments(rest);
        if (rest.length > 0) select(rest[0].id);
        else {
          setActiveId(null);
          loadedId.current = null;
          localStorage.removeItem(ACTIVE_KEY);
        }
      },
    });
  };

  // ── File save / load ──────────────────────────────────────────────────────
  // The server is the home for a design; these are the escape hatch: hand a
  // design to someone as a file, or bring one in. A file holds the config, the
  // same payload the server stores.
  const saveToFile = async () => {
    const cfg = (await fetchConfig()) ?? lastConfig.current;
    if (!cfg) {
      setDialog({ kind: 'alert', title: 'Nothing to save', message: 'No configuration is loaded yet.' });
      return;
    }
    const slug = (active?.name ?? 'design').replace(/[^\w.-]+/g, '-').toLowerCase();
    downloadJson(`${slug || 'design'}.engine.json`, cfg);
  };

  // Import a file as a new server-backed design and apply it to the session.
  const importFile = async (file: File) => {
    let cfg: EngineConfig;
    try {
      cfg = JSON.parse(await file.text());
    } catch {
      setDialog({ kind: 'alert', title: 'Could not load file', message: `"${file.name}" is not valid JSON.` });
      return;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      setDialog({ kind: 'alert', title: 'Could not load file', message: `"${file.name}" is not a valid design file.` });
      return;
    }
    const name = file.name.replace(/\.engine\.json$/i, '').replace(/\.json$/i, '') || 'Imported design';
    try {
      const meta = await api.createDocument(name, cfg);
      setDocuments((d) => [meta, ...d]);
      setActiveId(meta.id);
      loadedId.current = meta.id;
      localStorage.setItem(ACTIVE_KEY, meta.id);
    } catch {
      // History backend unavailable -- still apply it to the live session below.
    }
    try {
      await apply(cfg);
    } catch (e) {
      setDialog({ kind: 'alert', title: 'Could not load file', message: e instanceof Error ? e.message : 'The backend rejected this config.' });
    }
  };

  const refreshHistory = useCallback(async () => {
    if (!activeId) return;
    setHistStatus('loading');
    try {
      const [m, r] = await Promise.all([api.getHistory(activeId), api.listReleases(activeId)]);
      setMicro(m);
      setReleases(r);
      setHistStatus('idle');
    } catch {
      setHistStatus('err');
    }
  }, [activeId]);

  const toggleHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) void refreshHistory();
  };

  const submitRelease = async () => {
    if (!activeId || !relLabel.trim()) return;
    setRelStatus('saving');
    setRelError('');
    try {
      const config = (await fetchConfig()) ?? undefined;
      await api.createRelease(activeId, relLabel.trim(), config);
      setRelStatus('ok');
      if (showHistory) void refreshHistory();
      setTimeout(() => {
        setShowRelease(false);
        setRelLabel('');
        setRelStatus('idle');
      }, 1000);
    } catch (e) {
      setRelStatus('err');
      setRelError(e instanceof Error ? e.message : 'Release failed');
    }
  };

  const restoreMicro = (v: MicroVersion) => {
    if (!activeId) return;
    setDialog({
      kind: 'confirm',
      title: 'Restore this auto-save?',
      message: `From ${new Date(v.savedAt).toLocaleString()}. This replaces the current design. Your working copy keeps auto-saving, so you can restore again.`,
      confirmLabel: 'Restore',
      onConfirm: async () => {
        setRestoring(v.versionId);
        try {
          const { config } = await api.getVersion(activeId, v.versionId);
          await apply(config);
          setShowHistory(false);
        } finally {
          setRestoring(null);
        }
      },
    });
  };

  const restoreRelease = (r: ReleaseVersion) => {
    if (!activeId) return;
    setDialog({
      kind: 'confirm',
      title: `Restore release "${r.label}"?`,
      message: 'This replaces the current design.',
      confirmLabel: 'Restore',
      onConfirm: async () => {
        setRestoring(`rel:${r.label}`);
        try {
          const { config } = await api.getRelease(activeId, r.label);
          await apply(config);
          setShowHistory(false);
        } finally {
          setRestoring(null);
        }
      },
    });
  };

  return (
    <div className={inline ? 'relative' : 'relative bg-[var(--color-bg-secondary)]'}>
      <div
        className={
          inline
            ? 'flex flex-wrap items-center gap-2 py-2'
            : 'mx-auto flex max-w-7xl flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-1.5 sm:px-6 lg:px-8'
        }
      >
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Design</span>
        <select
          value={activeId ?? ''}
          onChange={(e) => select(e.target.value)}
          className="min-w-[160px] max-w-[280px] rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
        >
          {documents.length === 0 && <option value="">No designs</option>}
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button onClick={create} className={btn} title="New design">+ New</button>
        <button onClick={rename} disabled={!active} className={btn} title="Rename">Rename</button>
        <button onClick={remove} disabled={!active} className={btn} title="Delete design">Delete</button>

        <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

        <button onClick={() => void saveToFile()} className={btn} title="Download this design as a file">Save to file</button>
        <label className={`${btn} cursor-pointer`} title="Load a design from a file">
          Load from file
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.currentTarget.value = '';
            }}
          />
        </label>

        <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

        <button
          onClick={() => { setShowRelease(true); setRelLabel(nextLabel(releases)); setRelStatus('idle'); setRelError(''); }}
          disabled={!active}
          className="inline-flex items-center gap-1 rounded border border-emerald-600/40 bg-emerald-600/10 px-2.5 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-600/20 disabled:opacity-40 dark:text-emerald-400"
          title="Publish an immutable, named version (e.g. 0.1)"
        >
          Release
        </button>
        <button onClick={toggleHistory} disabled={!active} className={`${btn} ${showHistory ? 'ring-1 ring-blue-500/50' : ''}`} title="Microversions and releases">
          History
        </button>
      </div>

      <Modal open={showHistory && !!active} onClose={() => setShowHistory(false)} title="History" width="w-[440px]">
        <div className="max-h-[60vh] overflow-y-auto">
          {histStatus === 'loading' && <p className="py-2 text-xs text-[var(--color-text-muted)]">Loading…</p>}
          {histStatus === 'err' && <p className="py-2 text-xs text-red-500">Failed to load history.</p>}
          {histStatus === 'idle' && (
            <>
              <p className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Releases</p>
              {releases.length === 0 && <p className="pb-2 text-xs text-[var(--color-text-muted)]">No releases yet — Release publishes {nextLabel(releases)}.</p>}
              {releases.map((r) => (
                <button key={r.label} onClick={() => restoreRelease(r)} disabled={restoring === `rel:${r.label}`}
                  className="mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50">
                  <span className="shrink-0 rounded border border-emerald-600/40 bg-emerald-600/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">{r.label}</span>
                  <span className="flex-1 text-[10px] text-[var(--color-text-muted)]">{restoring === `rel:${r.label}` ? 'Restoring…' : relativeTime(r.savedAt)}</span>
                </button>
              ))}

              <p className="mb-2 mt-3 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Auto-saves (microversions)</p>
              {micro.length === 0 && <p className="py-2 text-xs text-[var(--color-text-muted)]">No auto-saves yet.</p>}
              {micro.map((v) => (
                <button key={v.versionId} onClick={() => restoreMicro(v)} disabled={restoring === v.versionId}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-border)]" />
                  <span className="flex-1 truncate text-xs text-[var(--color-text-primary)]">{new Date(v.savedAt).toLocaleString()}</span>
                  <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{restoring === v.versionId ? 'Restoring…' : relativeTime(v.savedAt)}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={showRelease}
        onClose={() => { if (relStatus !== 'saving') setShowRelease(false); }}
        title="Publish a release"
        width="w-[420px]"
        footer={
          <>
            <button onClick={() => setShowRelease(false)} disabled={relStatus === 'saving'} className={ghostBtn}>Cancel</button>
            <button onClick={() => void submitRelease()} disabled={!relLabel.trim() || relStatus === 'saving'} className={primaryBtn}>
              {relStatus === 'saving' ? 'Publishing…' : 'Publish'}
            </button>
          </>
        }
      >
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">An immutable, named snapshot of this design. Reusing a label is rejected.</p>
        <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Version label <span className="text-red-500">*</span></label>
        <input
          autoFocus value={relLabel} onChange={(e) => setRelLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submitRelease(); }}
          placeholder="0.1" disabled={relStatus === 'saving'}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none disabled:opacity-50"
        />
        {relStatus === 'err' && <p className="mt-3 text-xs text-red-500">{relError}</p>}
        {relStatus === 'ok' && <p className="mt-3 text-xs text-emerald-500">Release published.</p>}
      </Modal>

      {/* The one prompt / confirm / alert, styled like the app instead of the browser. */}
      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog?.title ?? ''}
        footer={
          dialog?.kind === 'alert' ? (
            <button onClick={() => setDialog(null)} className={primaryBtn}>OK</button>
          ) : (
            <>
              <button onClick={() => setDialog(null)} className={ghostBtn}>Cancel</button>
              <button
                onClick={() => void runDialog()}
                className={dialog?.kind === 'confirm' && dialog.danger ? dangerBtn : primaryBtn}
                disabled={dialog?.kind === 'prompt' && !dialogValue.trim()}
              >
                {dialog && dialog.kind !== 'alert' ? dialog.confirmLabel : ''}
              </button>
            </>
          )
        }
      >
        {dialog?.kind === 'prompt' ? (
          <>
            {dialog.label && <label className="mb-1 block text-xs text-[var(--color-text-muted)]">{dialog.label}</label>}
            <input
              autoFocus value={dialogValue} onChange={(e) => setDialogValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runDialog(); }}
              placeholder={dialog.placeholder}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none"
            />
          </>
        ) : dialog ? (
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{dialog.message}</p>
        ) : null}
      </Modal>
    </div>
  );
}
