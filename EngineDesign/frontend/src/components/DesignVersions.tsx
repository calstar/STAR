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
 * Every dialog here (restore confirmations, the file-load error, history, and
 * the Change dialog) is an in-app centred modal styled like the rest of the
 * app -- never a browser prompt/confirm/alert, which cannot be themed.
 *
 * Designs are shared, so one is addressed by (owner, id) rather than id alone:
 * a design shared with you is edited *where it lives*, in its owner's storage,
 * not as a copy. New / Rename / Delete have collapsed into a single Change
 * button (DesignChangeModal); delete is gone entirely.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getConfig, loadConfigJson, type EngineConfig } from '../api/client';
import * as api from '../api/documents';
import type { DocMeta, DocRef, MicroVersion, ReleaseVersion } from '../api/documents';
import { keyOf, refOf } from '../api/documents';
import { btn, dangerBtn, ghostBtn, primaryBtn, relativeTime } from '../lib/ui';
import { DesignChangeModal } from './DesignChangeModal';
import { Modal } from './ui';

// v2 because the remembered design is now (owner, id): a shared design is not
// identified by its id alone. A v1 value is a bare id, which was always one of
// your own, so it migrates to {owner: null}.
const ACTIVE_KEY = 'engine-design.activeDoc.v2';
const LEGACY_ACTIVE_KEY = 'engine-design.activeDoc.v1';
const AUTOSAVE_POLL_MS = 4000;

function readActive(): DocRef | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DocRef;
      if (parsed && typeof parsed.id === 'string') return parsed;
    }
    const legacy = localStorage.getItem(LEGACY_ACTIVE_KEY);
    return legacy ? { id: legacy, owner: null } : null;
  } catch {
    return null;
  }
}

function writeActive(ref: DocRef | null): void {
  try {
    if (ref) localStorage.setItem(ACTIVE_KEY, JSON.stringify({ id: ref.id, owner: ref.owner ?? null }));
    else localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_KEY);
  } catch {
    /* private mode / storage disabled -- the bar still works, it just forgets */
  }
}

/** The one at-a-time dialog the bar drives: a confirmation (optionally
 *  destructive) or a plain message. Replaces window.confirm / alert so every
 *  dialog is centred and styled like the app. Naming a design is an inline
 *  field in the Change dialog now, so there is no prompt kind here. */
type Dialog =
  | { kind: 'confirm'; title: string; message: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { kind: 'alert'; title: string; message: ReactNode };

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
  const [activeRef, setActiveRef] = useState<DocRef | null>(null);
  const activeKey = activeRef ? keyOf(activeRef) : null;
  // Which design's state is actually loaded into the session, so a poll started
  // before a switch cannot autosave one design's config over another's.
  const loadedKey = useRef<string | null>(null);
  const lastSaved = useRef<string>(''); // JSON of the last-autosaved config
  const lastConfig = useRef<EngineConfig | null>(null); // for the close beacon

  const [showChange, setShowChange] = useState(false);
  // Name of a design that was unshared out from under us, or null.
  const [unshared, setUnshared] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [micro, setMicro] = useState<MicroVersion[]>([]);
  const [releases, setReleases] = useState<ReleaseVersion[]>([]);
  const [histStatus, setHistStatus] = useState<'idle' | 'loading' | 'err'>('idle');
  const [restoring, setRestoring] = useState<string | null>(null);

  const [showRelease, setShowRelease] = useState(false);
  const [relLabel, setRelLabel] = useState('');
  const [relStatus, setRelStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [relError, setRelError] = useState('');

  // One at-a-time dialog (confirm / alert).
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const runDialog = async () => {
    const d = dialog;
    setDialog(null);
    if (d?.kind === 'confirm') await d.onConfirm();
  };

  const active = useMemo(
    () => documents.find((d) => keyOf(refOf(d)) === activeKey) ?? null,
    [documents, activeKey],
  );

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
    async (ref: DocRef) => {
      loadedKey.current = null;
      try {
        const { config } = await api.loadDocument(ref);
        if (config && Object.keys(config).length > 0) {
          await apply(config as EngineConfig);
        }
      } finally {
        loadedKey.current = keyOf(ref);
      }
    },
    [apply],
  );

  const select = useCallback(
    (ref: DocRef) => {
      setActiveRef(ref);
      writeActive(ref);
      void openDoc(ref);
      setShowHistory(false);
    },
    [openDoc],
  );

  /** Re-list and land on one of your own designs. Used after leaving a design,
   *  and after being unshared from the one you had open. */
  const reloadAndFallBack = useCallback(async () => {
    const docs = await api.listDocuments();
    setDocuments(docs);
    const next = docs.find((x) => x.mine) ?? docs[0];
    if (next) select(refOf(next));
    else {
      setActiveRef(null);
      loadedKey.current = null;
      writeActive(null);
    }
  }, [select]);

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
          const ref = refOf(meta);
          setActiveRef(ref);
          loadedKey.current = keyOf(ref); // seeded from current config
          if (seed) {
            lastConfig.current = seed;
            lastSaved.current = JSON.stringify(seed);
          }
          writeActive(ref);
          return;
        }
        setDocuments(docs);
        const remembered = readActive();
        // Prefer your own designs in the fallback. `docs` now includes designs
        // shared with you, so docs[0] could drop someone else's design straight
        // into your session -- and openDoc pushes it to the backend session, so
        // that would not be a merely cosmetic surprise.
        const match = remembered
          ? docs.find((d) => keyOf(refOf(d)) === keyOf(remembered))
          : undefined;
        const pick = refOf(match ?? docs.find((d) => d.mine) ?? docs[0]);
        setActiveRef(pick);
        writeActive(pick);
        void openDoc(pick);
      } catch {
        loadedKey.current = null; // backend/history unavailable
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openDoc]);

  // Autosave: poll the authoritative config and write the working copy on change.
  useEffect(() => {
    if (!activeRef) return;
    const key = keyOf(activeRef);
    let stopped = false;
    const tick = async () => {
      if (stopped || loadedKey.current !== key) return;
      const config = await fetchConfig();
      if (!config) return;
      const serialized = JSON.stringify(config);
      lastConfig.current = config;
      if (serialized === lastSaved.current) return;
      try {
        await api.autosaveDocument(activeRef, config);
        lastSaved.current = serialized;
      } catch (e) {
        // 403 means this design was unshared from you while you had it open.
        // Retrying forever would be silent and pointless, and every further
        // edit would be lost anyway -- stop, say so, and fall back to one of
        // your own designs.
        if (e instanceof api.ApiError && e.status === 403) {
          stopped = true;
          setUnshared(active?.name ?? 'This design');
          void reloadAndFallBack();
          return;
        }
        /* otherwise keep the old lastSaved; retry next tick */
      }
    };
    const id = setInterval(() => void tick(), AUTOSAVE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [activeRef, active, reloadAndFallBack]);

  // Best-effort flush on tab close, between the throttled microversions.
  useEffect(() => {
    const flush = () => {
      if (activeRef && loadedKey.current === keyOf(activeRef) && lastConfig.current) {
        api.flushDocument(activeRef, lastConfig.current);
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
  }, [activeRef]);

  /** Adopt a freshly created/copied design: it becomes the active one, and the
   *  session already holds its config, so there is nothing to re-load. */
  const adopt = useCallback((meta: DocMeta, seeded?: EngineConfig) => {
    setDocuments((d) => [meta, ...d]);
    const ref = refOf(meta);
    setActiveRef(ref);
    loadedKey.current = keyOf(ref);
    if (seeded) {
      lastConfig.current = seeded;
      lastSaved.current = JSON.stringify(seeded);
    }
    writeActive(ref);
  }, []);

  const create = useCallback(
    async (name: string) => {
      const seed = (await fetchConfig()) ?? undefined;
      adopt(await api.createDocument(name, seed), seed);
    },
    [adopt],
  );

  const rename = useCallback(async (ref: DocRef, name: string) => {
    const meta = await api.renameDocument(ref, name);
    setDocuments((d) => d.map((x) => (keyOf(refOf(x)) === keyOf(ref) ? { ...x, ...meta } : x)));
  }, []);

  const share = useCallback(async (ref: DocRef, emails: string[]) => {
    const meta = await api.shareDocument(ref, emails);
    setDocuments((d) => d.map((x) => (keyOf(refOf(x)) === keyOf(ref) ? { ...x, ...meta } : x)));
  }, []);

  const leave = useCallback(
    async (ref: DocRef) => {
      await api.leaveDocument(ref);
      if (activeKey === keyOf(ref)) await reloadAndFallBack();
      else setDocuments((d) => d.filter((x) => keyOf(refOf(x)) !== keyOf(ref)));
    },
    [activeKey, reloadAndFallBack],
  );

  /** Take a copy of someone else's design and open it. The copy is yours, with
   *  no history and no share list -- see the backend. */
  const copy = useCallback(
    async (ref: DocRef) => {
      const meta = await api.copyDocument(ref);
      adopt(meta);
      await openDoc(refOf(meta));
    },
    [adopt, openDoc],
  );

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
      adopt(await api.createDocument(name, cfg));
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
    if (!activeRef) return;
    setHistStatus('loading');
    try {
      const [m, r] = await Promise.all([api.getHistory(activeRef), api.listReleases(activeRef)]);
      setMicro(m);
      setReleases(r);
      setHistStatus('idle');
    } catch {
      setHistStatus('err');
    }
  }, [activeRef]);

  const toggleHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) void refreshHistory();
  };

  const submitRelease = async () => {
    if (!activeRef || !relLabel.trim()) return;
    setRelStatus('saving');
    setRelError('');
    try {
      const config = (await fetchConfig()) ?? undefined;
      await api.createRelease(activeRef, relLabel.trim(), config);
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
    if (!activeRef) return;
    setDialog({
      kind: 'confirm',
      title: 'Restore this auto-save?',
      message: `From ${new Date(v.savedAt).toLocaleString()}. This replaces the current design. Your working copy keeps auto-saving, so you can restore again.`,
      confirmLabel: 'Restore',
      onConfirm: async () => {
        setRestoring(v.versionId);
        try {
          const { config } = await api.getVersion(activeRef, v.versionId);
          await apply(config);
          setShowHistory(false);
        } finally {
          setRestoring(null);
        }
      },
    });
  };

  const restoreRelease = (r: ReleaseVersion) => {
    if (!activeRef) return;
    setDialog({
      kind: 'confirm',
      title: `Restore release "${r.label}"?`,
      message: 'This replaces the current design.',
      confirmLabel: 'Restore',
      onConfirm: async () => {
        setRestoring(`rel:${r.label}`);
        try {
          const { config } = await api.getRelease(activeRef, r.label);
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
          value={activeKey ?? ''}
          onChange={(e) => {
            const picked = documents.find((d) => keyOf(refOf(d)) === e.target.value);
            if (picked) select(refOf(picked));
          }}
          className="min-w-[160px] max-w-[280px] rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
        >
          {documents.length === 0 && <option value="">No designs</option>}
          {documents.map((d) => (
            <option key={keyOf(refOf(d))} value={keyOf(refOf(d))}>
              {d.mine ? d.name : `${d.name} — ${d.ownerName || d.owner}`}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowChange(true)}
          className={btn}
          title="Create, rename, share, or take a copy of someone else's design"
        >
          Change
        </button>

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

      <DesignChangeModal
        open={showChange}
        onClose={() => setShowChange(false)}
        documents={documents}
        activeKey={activeKey}
        onSelect={select}
        onCreate={create}
        onRename={rename}
        onShare={share}
        onLeave={leave}
        onCopy={copy}
      />

      {/* Someone removed your access while you had the design open. Said plainly
          rather than left as a silently failing autosave. */}
      <Modal
        open={unshared !== null}
        onClose={() => setUnshared(null)}
        title="You no longer have access"
        footer={<button onClick={() => setUnshared(null)} className={primaryBtn}>OK</button>}
      >
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          "{unshared}" was unshared from you, so it has stopped saving and you have been
          moved to one of your own designs. Nothing was deleted — you can still take a copy
          of it from <b>Change → View only</b>.
        </p>
      </Modal>

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

      {/* The one confirm / alert, styled like the app instead of the browser. */}
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
              >
                {dialog?.kind === 'confirm' ? dialog.confirmLabel : ''}
              </button>
            </>
          )
        }
      >
        {dialog && (
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{dialog.message}</p>
        )}
      </Modal>
    </div>
  );
}
