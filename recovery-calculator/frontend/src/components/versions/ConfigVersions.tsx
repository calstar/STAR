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
import type { UiConfig } from '../../types/schema'
import { reviveUiConfig } from '../../lib/persist'
import * as api from '../../api/documents'
import type { DocMeta, MicroVersion, ReleaseVersion } from '../../api/documents'

const ACTIVE_KEY = 'recovery-calculator.activeDoc.v1'
const AUTOSAVE_MS = 1500

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
}

export function ConfigVersions({ config, onRestore }: Props) {
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
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const docs = await api.listDocuments()
        if (cancelled) return
        if (docs.length === 0) {
          const meta = await api.createDocument('Design 1', configRef.current)
          if (cancelled) return
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
    return () => { cancelled = true }
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

  const create = async () => {
    const name = window.prompt('New design name:', `Design ${documents.length + 1}`)
    if (!name || !name.trim()) return
    const meta = await api.createDocument(name.trim(), configRef.current)
    setDocuments(d => [meta, ...d])
    setActiveId(meta.id)
    loadedId.current = meta.id
    localStorage.setItem(ACTIVE_KEY, meta.id)
  }

  const rename = async () => {
    if (!active) return
    const name = window.prompt('Rename design:', active.name)
    if (!name || !name.trim()) return
    const meta = await api.renameDocument(active.id, name.trim())
    setDocuments(d => d.map(x => (x.id === meta.id ? meta : x)))
  }

  const remove = async () => {
    if (!active) return
    if (!window.confirm(`Delete "${active.name}"?\n\nThis removes the design, its microversions, and its releases. This cannot be undone.`)) return
    await api.deleteDocument(active.id)
    const rest = documents.filter(d => d.id !== active.id)
    setDocuments(rest)
    if (rest.length > 0) select(rest[0].id)
    else { setActiveId(null); loadedId.current = null; localStorage.removeItem(ACTIVE_KEY) }
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

  const restoreMicro = async (v: MicroVersion) => {
    if (!activeId) return
    if (!window.confirm(`Restore the auto-save from ${new Date(v.savedAt).toLocaleString()}?\n\nThis replaces the current design. Your working copy keeps auto-saving, so you can restore again.`)) return
    setRestoring(v.versionId)
    try {
      const { config: c } = await api.getVersion(activeId, v.versionId)
      onRestore(normalise(c)); setShowHistory(false)
    } finally { setRestoring(null) }
  }

  const restoreRelease = async (r: ReleaseVersion) => {
    if (!activeId) return
    if (!window.confirm(`Restore release "${r.label}"?\n\nThis replaces the current design.`)) return
    setRestoring(`rel:${r.label}`)
    try {
      const { config: c } = await api.getRelease(activeId, r.label)
      onRestore(normalise(c)); setShowHistory(false)
    } finally { setRestoring(null) }
  }

  const btn = 'inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40'

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <span className="text-2xs uppercase tracking-wider text-[var(--color-text-muted)] shrink-0">Design</span>
        <select
          value={activeId ?? ''}
          onChange={e => select(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none min-w-[160px] max-w-[280px]"
        >
          {documents.length === 0 && <option value="">No designs</option>}
          {documents.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button onClick={create} className={btn} title="New design">+ New</button>
        <button onClick={rename} disabled={!active} className={btn} title="Rename">Rename</button>
        <button onClick={remove} disabled={!active} className={btn} title="Delete design">Delete</button>

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

      {showHistory && active && (
        <div className="absolute right-4 top-full z-40 mt-1 max-h-[360px] w-[340px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 shadow-xl">
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
      )}

      {showRelease && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => relStatus !== 'saving' && setShowRelease(false)}>
          <div className="w-[420px] max-w-[90vw] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="mb-1 text-sm font-semibold text-[var(--color-text-primary)]">Publish a release</h3>
            <p className="mb-4 text-xs text-[var(--color-text-muted)]">An immutable, named snapshot of this design. Reusing a label is rejected.</p>
            <label className="mb-1 block text-xs text-[var(--color-text-muted)]">Version label <span className="text-red-500">*</span></label>
            <input
              autoFocus value={relLabel} onChange={e => setRelLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void submitRelease(); if (e.key === 'Escape') setShowRelease(false) }}
              placeholder="0.1" disabled={relStatus === 'saving'}
              className="mb-4 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none disabled:opacity-50"
            />
            {relStatus === 'err' && <p className="mb-3 text-xs text-red-500">{relError}</p>}
            {relStatus === 'ok' && <p className="mb-3 text-xs text-emerald-500">Release published.</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowRelease(false)} disabled={relStatus === 'saving'} className={btn}>Cancel</button>
              <button onClick={() => void submitRelease()} disabled={!relLabel.trim() || relStatus === 'saving'}
                className="inline-flex items-center gap-1 rounded border border-emerald-600/50 bg-emerald-600/20 px-3 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-600/30 disabled:opacity-40 dark:text-emerald-400">
                {relStatus === 'saving' ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
