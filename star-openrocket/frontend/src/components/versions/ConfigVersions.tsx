/**
 * Versioned designs: a document bar + release/history controls.
 *
 * Mirrors the pid-designer model. Each named design is a server-side document
 * with a working copy (autosaved here), throttled microversions, and immutable
 * named releases. This is the durable timeline; `lib/persist.ts` localStorage
 * stays as the instant working cache. An auto-saved mistake is recoverable by
 * restoring an earlier microversion or a release.
 *
 * Owns the document list + active id and drives autosave/flush; the parent owns
 * the live `config` and applies restores via `onRestore`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ViewerConfig as UiConfig } from '../../types/config'
import { reviveViewerConfig as reviveUiConfig } from '../../lib/persist'
import { defaultViewerConfig as defaultUiConfig } from '../../types/config'
import { Button, Modal } from '../ui'
import * as api from '../../api/documents'
import type { DocMeta, MicroVersion, ReleaseVersion } from '../../api/documents'

const ACTIVE_KEY = 'star-openrocket.activeDoc.v1'
const AUTOSAVE_MS = 1500

/** The one at-a-time dialog the bar drives: a text prompt, a confirmation
 *  (optionally destructive), or a plain message. Replaces window.prompt /
 *  confirm / alert so every dialog is centred and styled like the app. */
type Dialog =
  | { kind: 'prompt'; title: string; label?: string; placeholder?: string; confirmLabel: string; onConfirm: (value: string) => void | Promise<void> }
  | { kind: 'confirm'; title: string; message: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { kind: 'alert'; title: string; message: ReactNode }

/** Regenerate uids / merge onto defaults so a restored config is as safe to
 *  load as one revived from localStorage (see persist.reviveUiConfig). */
function normalise(config: UiConfig): UiConfig {
  return reviveUiConfig(JSON.stringify(config)) ?? config
}

/** Propose the next minor release, e.g. 0.1 -> 0.2, given existing labels. */
function nextLabel(releases: ReleaseVersion[]): string {
  let maxMinor = 0
  for (const r of releases) {
    const m = /^0\.(\d+)$/.exec(r.label)
    if (m) maxMinor = Math.max(maxMinor, Number(m[1]))
  }
  return `0.${maxMinor + 1}`
}

/** Download any JSON payload as a file, the browser way. */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function relativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

interface Props {
  config: UiConfig
  onRestore: (config: UiConfig) => void
  /** Render just the bar row, no background or width container -- for dropping
   *  inside a parent (the header) that already provides both. */
  inline?: boolean
}

export function ConfigVersions({ config, onRestore, inline = false }: Props) {
  const [documents, setDocuments] = useState<DocMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const loadedId = useRef<string | null>(null)
  const configRef = useRef(config)
  configRef.current = config

  const [showHistory, setShowHistory] = useState(false)
  const [micro, setMicro] = useState<MicroVersion[]>([])
  const [releases, setReleases] = useState<ReleaseVersion[]>([])
  const [histStatus, setHistStatus] = useState<'idle' | 'loading' | 'err'>('idle')
  const [restoring, setRestoring] = useState<string | null>(null)

  const [showRelease, setShowRelease] = useState(false)
  const [relLabel, setRelLabel] = useState('')
  const [relStatus, setRelStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle')
  const [relError, setRelError] = useState('')

  // New-design dialog: a name plus a seed -- 'default' values or a copy of an
  // existing design (by id).
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSource, setNewSource] = useState<'current' | string>('current')
  const [newStatus, setNewStatus] = useState<'idle' | 'saving' | 'err'>('idle')
  const [newError, setNewError] = useState('')

  // One at-a-time dialog (prompt / confirm / alert) and, for prompts, its input.
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [dialogValue, setDialogValue] = useState('')
  const askPrompt = (opts: Extract<Dialog, { kind: 'prompt' }> & { value?: string }) => {
    setDialogValue(opts.value ?? '')
    setDialog(opts)
  }
  const runDialog = async () => {
    const d = dialog
    if (!d) return
    if (d.kind === 'prompt') {
      const v = dialogValue.trim()
      if (!v) return
      setDialog(null)
      await d.onConfirm(v)
    } else if (d.kind === 'confirm') {
      setDialog(null)
      await d.onConfirm()
    } else {
      setDialog(null)
    }
  }

  const active = documents.find(d => d.id === activeId) ?? null

  // Load a document's working copy and apply it to the live config.
  const openDoc = useCallback(async (id: string) => {
    loadedId.current = null
    try {
      const { config: loaded } = await api.loadDocument(id)
      if (loaded && Object.keys(loaded).length > 0) onRestore(normalise(loaded as UiConfig))
    } finally {
      loadedId.current = id
    }
  }, [onRestore])

  // Mount: list documents; seed one from the current config if there are none.
  // Guarded to run its bootstrap exactly once: even if a parent passes an
  // unstable onRestore (which recreates openDoc and re-fires this effect), we
  // must not re-list + re-open, or restore would loop into setUi every render.
  // Guarded by a ref (not a cleanup-set `cancelled` flag) so it runs exactly once
  // and survives React StrictMode's dev double-mount: a cleanup-based cancel fires
  // before listDocuments resolves and would bail the bootstrap, leaving the bar
  // empty and nothing restored on reload. ConfigVersions never unmounts, so there
  // is no real teardown to guard against.
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    ;(async () => {
      try {
        const docs = await api.listDocuments()
        if (docs.length === 0) {
          const meta = await api.createDocument('Design 1', configRef.current)
          setDocuments([meta])
          setActiveId(meta.id)
          loadedId.current = meta.id // seeded from current config; nothing to re-apply
          localStorage.setItem(ACTIVE_KEY, meta.id)
          return
        }
        setDocuments(docs)
        const remembered = localStorage.getItem(ACTIVE_KEY)
        const pick = docs.find(d => d.id === remembered)?.id ?? docs[0].id
        setActiveId(pick)
        void openDoc(pick)
      } catch {
        // Backend/history unavailable -- the app still runs on localStorage.
        loadedId.current = null
      }
    })()
  }, [openDoc])

  // Debounced autosave of the working copy, only once the active doc has loaded.
  useEffect(() => {
    if (!activeId || loadedId.current !== activeId) return
    const t = setTimeout(() => { void api.autosaveDocument(activeId, config).catch(() => {}) }, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [config, activeId])

  // Best-effort flush on tab close, between the throttled microversions.
  useEffect(() => {
    const flush = () => {
      if (activeId && loadedId.current === activeId) api.flushDocument(activeId, configRef.current)
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [activeId])

  const select = (id: string) => {
    setActiveId(id)
    localStorage.setItem(ACTIVE_KEY, id)
    void openDoc(id)
    setShowHistory(false)
  }

  const openNew = () => {
    setNewName(`Design ${documents.length + 1}`)
    setNewSource('current')
    setNewStatus('idle')
    setNewError('')
    setShowNew(true)
  }

  const submitNew = async () => {
    const name = newName.trim()
    if (!name) return
    setNewStatus('saving')
    setNewError('')
    try {
      // 'default' seeds from the built-in config; anything else is the id of a
      // design to copy -- load its working copy from the server and normalise
      // it (fresh uids etc.) as if it came off disk.
      // 'current' snapshots what the user is looking at now, so a new design is
      // never blank (an empty ViewerConfig has no model to show); otherwise copy a
      // chosen design's working copy.
      const seed = newSource === 'current'
        ? configRef.current
        : normalise(((await api.loadDocument(newSource)).config ?? defaultUiConfig()) as UiConfig)
      const meta = await api.createDocument(name, seed)
      setDocuments(d => [meta, ...d])
      setActiveId(meta.id)
      loadedId.current = meta.id
      localStorage.setItem(ACTIVE_KEY, meta.id)
      onRestore(seed)
      setShowNew(false)
    } catch (e) {
      setNewStatus('err')
      setNewError(e instanceof Error ? e.message : 'Could not create design')
    }
  }

  const rename = () => {
    if (!active) return
    askPrompt({
      kind: 'prompt',
      title: 'Rename design',
      label: 'Design name',
      value: active.name,
      confirmLabel: 'Rename',
      onConfirm: async (name) => {
        const meta = await api.renameDocument(active.id, name)
        setDocuments(d => d.map(x => (x.id === meta.id ? meta : x)))
      },
    })
  }

  const remove = () => {
    if (!active) return
    setDialog({
      kind: 'confirm',
      title: `Delete "${active.name}"?`,
      message: 'This removes the design, its microversions, and its releases. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        await api.deleteDocument(active.id)
        const rest = documents.filter(d => d.id !== active.id)
        setDocuments(rest)
        if (rest.length > 0) select(rest[0].id)
        else { setActiveId(null); loadedId.current = null; localStorage.removeItem(ACTIVE_KEY) }
      },
    })
  }

  // ── File save / load ──────────────────────────────────────────────────────
  // The server (S3 in prod, local disk in dev) is the home for a design; these
  // are the escape hatch: hand a design to someone as a file, or bring one in.
  // A file holds the full UiConfig, the same payload the server stores.
  const saveToFile = () => {
    const slug = (active?.name ?? 'design').replace(/[^\w.-]+/g, '-').toLowerCase()
    downloadJson(`${slug || 'design'}.ork.json`, config)
  }

  // Import a file as a new server-backed design. Falls back to loading it into
  // the working copy only, so a file still opens when there is no backend.
  const importFile = async (file: File) => {
    const cfg = reviveUiConfig(await file.text())
    if (!cfg) {
      setDialog({ kind: 'alert', title: 'Could not load file', message: `"${file.name}" is not a valid design file.` })
      return
    }
    const name = file.name.replace(/\.viewer\.json$/i, '').replace(/\.json$/i, '') || 'Imported design'
    try {
      const meta = await api.createDocument(name, cfg)
      setDocuments(d => [meta, ...d])
      setActiveId(meta.id)
      loadedId.current = meta.id
      localStorage.setItem(ACTIVE_KEY, meta.id)
    } catch {
      // No backend: at least load it into the live (localStorage-backed) config.
    }
    onRestore(cfg)
  }

  const refreshHistory = useCallback(async () => {
    if (!activeId) return
    setHistStatus('loading')
    try {
      const [m, r] = await Promise.all([api.getHistory(activeId), api.listReleases(activeId)])
      setMicro(m); setReleases(r); setHistStatus('idle')
    } catch { setHistStatus('err') }
  }, [activeId])

  const toggleHistory = () => {
    const next = !showHistory
    setShowHistory(next)
    if (next) void refreshHistory()
  }

  const submitRelease = async () => {
    if (!activeId || !relLabel.trim()) return
    setRelStatus('saving'); setRelError('')
    try {
      await api.createRelease(activeId, relLabel.trim(), configRef.current)
      setRelStatus('ok')
      if (showHistory) void refreshHistory()
      setTimeout(() => { setShowRelease(false); setRelLabel(''); setRelStatus('idle') }, 1000)
    } catch (e) {
      setRelStatus('err')
      setRelError(e instanceof Error ? e.message : 'Release failed')
    }
  }

  const restoreMicro = (v: MicroVersion) => {
    if (!activeId) return
    setDialog({
      kind: 'confirm',
      title: 'Restore this auto-save?',
      message: `From ${new Date(v.savedAt).toLocaleString()}. This replaces the current design. Your working copy keeps auto-saving, so you can restore again.`,
      confirmLabel: 'Restore',
      onConfirm: async () => {
        setRestoring(v.versionId)
        try {
          const { config: c } = await api.getVersion(activeId, v.versionId)
          onRestore(normalise(c)); setShowHistory(false)
        } finally { setRestoring(null) }
      },
    })
  }

  const restoreRelease = (r: ReleaseVersion) => {
    if (!activeId) return
    setDialog({
      kind: 'confirm',
      title: `Restore release "${r.label}"?`,
      message: 'This replaces the current design.',
      confirmLabel: 'Restore',
      onConfirm: async () => {
        setRestoring(`rel:${r.label}`)
        try {
          const { config: c } = await api.getRelease(activeId, r.label)
          onRestore(normalise(c)); setShowHistory(false)
        } finally { setRestoring(null) }
      },
    })
  }

  const btn = 'inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40'

  return (
    <div className={inline ? 'relative' : 'relative bg-[var(--color-bg-secondary)]'}>
      <div className={inline
        ? 'flex flex-wrap items-center gap-2 py-2'
        : 'mx-auto flex max-w-[1800px] flex-wrap items-center gap-2 px-4 py-1.5 sm:px-6 lg:px-8'}>
        <span className="text-2xs uppercase tracking-wider text-[var(--color-text-muted)] shrink-0">Design</span>
        <select
          value={activeId ?? ''}
          onChange={e => select(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none min-w-[160px] max-w-[280px]"
        >
          {documents.length === 0 && <option value="">No designs</option>}
          {documents.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button onClick={openNew} className={btn} title="New design">+ New</button>
        <button onClick={rename} disabled={!active} className={btn} title="Rename">Rename</button>
        <button onClick={remove} disabled={!active} className={btn} title="Delete design">Delete</button>

        <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

        <button onClick={saveToFile} className={btn} title="Download this design as a file">Save to file</button>
        <label className={`${btn} cursor-pointer`} title="Load a design from a file">
          Load from file
          <input
            type="file" accept="application/json,.json" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.currentTarget.value = '' }}
          />
        </label>

        <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

        <button
          onClick={() => { setShowRelease(true); setRelLabel(nextLabel(releases)); setRelStatus('idle'); setRelError('') }}
          disabled={!active}
          className="inline-flex items-center gap-1 rounded border border-emerald-600/40 bg-emerald-600/10 px-2.5 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-600/20 disabled:opacity-40 dark:text-emerald-400"
          title="Publish an immutable, named version (e.g. 0.1)"
        >
          Release
        </button>
        <button
          onClick={toggleHistory}
          disabled={!active}
          className={`${btn} ${showHistory ? 'ring-1 ring-blue-500/50' : ''}`}
          title="Microversions and releases"
        >
          History
        </button>
      </div>

      <Modal open={showHistory && !!active} onClose={() => setShowHistory(false)} title="History" width="w-[440px]">
        <div className="max-h-[60vh] overflow-y-auto">
          {histStatus === 'loading' && <p className="py-2 text-xs text-[var(--color-text-muted)]">Loading…</p>}
          {histStatus === 'err' && <p className="py-2 text-xs text-red-500">Failed to load history.</p>}
          {histStatus === 'idle' && (
            <>
              <p className="mb-2 text-2xs uppercase tracking-wider text-[var(--color-text-muted)]">Releases</p>
              {releases.length === 0 && <p className="pb-2 text-xs text-[var(--color-text-muted)]">No releases yet — Release publishes {nextLabel(releases)}.</p>}
              {releases.map(r => (
                <button key={r.label} onClick={() => restoreRelease(r)} disabled={restoring === `rel:${r.label}`}
                  className="mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50">
                  <span className="shrink-0 rounded border border-emerald-600/40 bg-emerald-600/10 px-1.5 py-0.5 text-2xs font-semibold text-emerald-600 dark:text-emerald-400">{r.label}</span>
                  <span className="flex-1 text-2xs text-[var(--color-text-muted)]">{restoring === `rel:${r.label}` ? 'Restoring…' : relativeTime(r.savedAt)}</span>
                </button>
              ))}

              <p className="mb-2 mt-3 text-2xs uppercase tracking-wider text-[var(--color-text-muted)]">Auto-saves (microversions)</p>
              {micro.length === 0 && <p className="py-2 text-xs text-[var(--color-text-muted)]">No auto-saves yet.</p>}
              {micro.map(v => (
                <button key={v.versionId} onClick={() => restoreMicro(v)} disabled={restoring === v.versionId}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-border)]" />
                  <span className="flex-1 truncate text-xs text-[var(--color-text-primary)]">{new Date(v.savedAt).toLocaleString()}</span>
                  <span className="shrink-0 text-2xs text-[var(--color-text-muted)]">{restoring === v.versionId ? 'Restoring…' : relativeTime(v.savedAt)}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={showNew}
        onClose={() => { if (newStatus !== 'saving') setShowNew(false) }}
        title="New design"
        width="w-[420px]"
        footer={
          <>
            <Button onClick={() => setShowNew(false)} disabled={newStatus === 'saving'} variant="ghost">Cancel</Button>
            <Button onClick={() => void submitNew()} disabled={!newName.trim() || newStatus === 'saving'} variant="primary">
              {newStatus === 'saving' ? 'Creating…' : 'Create'}
            </Button>
          </>
        }
      >
        <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Design name <span className="text-red-500">*</span></label>
        <input
          autoFocus value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submitNew() }}
          placeholder="Design name" disabled={newStatus === 'saving'}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none disabled:opacity-50"
        />
        <label className="mb-1 mt-4 block text-xs text-[var(--color-text-muted)]">Start from</label>
        <select
          value={newSource} onChange={e => setNewSource(e.target.value)} disabled={newStatus === 'saving'}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none disabled:opacity-50"
        >
          <option value="current">Current setup</option>
          {documents.length > 0 && (
            <optgroup label="Copy from design">
              {documents.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </optgroup>
          )}
        </select>
        {newStatus === 'err' && <p className="mt-3 text-xs text-red-500">{newError}</p>}
      </Modal>

      <Modal
        open={showRelease}
        onClose={() => { if (relStatus !== 'saving') setShowRelease(false) }}
        title="Publish a release"
        width="w-[420px]"
        footer={
          <>
            <Button onClick={() => setShowRelease(false)} disabled={relStatus === 'saving'} variant="ghost">Cancel</Button>
            <Button onClick={() => void submitRelease()} disabled={!relLabel.trim() || relStatus === 'saving'} variant="primary">
              {relStatus === 'saving' ? 'Publishing…' : 'Publish'}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">An immutable, named snapshot of this design. Reusing a label is rejected.</p>
        <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Version label <span className="text-red-500">*</span></label>
        <input
          autoFocus value={relLabel} onChange={e => setRelLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submitRelease() }}
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
            <Button onClick={() => setDialog(null)} variant="primary">OK</Button>
          ) : (
            <>
              <Button onClick={() => setDialog(null)} variant="ghost">Cancel</Button>
              <Button
                onClick={() => void runDialog()}
                variant={dialog?.kind === 'confirm' && dialog.danger ? 'danger' : 'primary'}
                disabled={dialog?.kind === 'prompt' && !dialogValue.trim()}
              >
                {dialog ? dialog.confirmLabel : ''}
              </Button>
            </>
          )
        }
      >
        {dialog?.kind === 'prompt' ? (
          <>
            {dialog.label && <label className="mb-1 block text-xs text-[var(--color-text-muted)]">{dialog.label}</label>}
            <input
              autoFocus value={dialogValue} onChange={e => setDialogValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void runDialog() }}
              placeholder={dialog.placeholder}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none"
            />
          </>
        ) : dialog ? (
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{dialog.message}</p>
        ) : null}
      </Modal>
    </div>
  )
}
