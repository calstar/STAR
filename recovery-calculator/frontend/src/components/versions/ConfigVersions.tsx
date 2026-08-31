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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { UiConfig } from '../../types/schema'
import { reviveUiConfig } from '../../lib/persist'
import { toStoredConfig } from '../../lib/serialise'
import { Button, Modal } from '../ui'
import * as api from '../../api/documents'
import { designApi, keyOf, refOf } from '../../api/documents'
import type { DocMeta, DocRef, MicroVersion, ReleaseVersion } from '../../api/documents'
import { ChangeModal } from '@stardesign-ui'

// v2 because the remembered config is now (owner, id): a shared config is not
// identified by its id alone. A v1 value is a bare id, which was always one of
// your own, so it migrates to {owner: null}.
const ACTIVE_KEY = 'recovery-calculator.activeDoc.v2'
const LEGACY_ACTIVE_KEY = 'recovery-calculator.activeDoc.v1'
const AUTOSAVE_MS = 1500

function readActive(): DocRef | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as DocRef
      if (parsed && typeof parsed.id === 'string') return parsed
    }
    const legacy = localStorage.getItem(LEGACY_ACTIVE_KEY)
    return legacy ? { id: legacy, owner: null } : null
  } catch {
    return null
  }
}

function writeActive(ref: DocRef | null): void {
  try {
    if (ref) localStorage.setItem(ACTIVE_KEY, JSON.stringify({ id: ref.id, owner: ref.owner ?? null }))
    else localStorage.removeItem(ACTIVE_KEY)
    localStorage.removeItem(LEGACY_ACTIVE_KEY)
  } catch {
    /* private mode / storage disabled -- the bar still works, it just forgets */
  }
}

/** The one at-a-time dialog the bar drives: a confirmation (optionally
 *  destructive) or a plain message. Replaces window.confirm / alert so every
 *  dialog is centred and styled like the app. Naming a config is an inline
 *  field in the Change dialog now, so there is no prompt kind here. */
type Dialog =
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
  const [activeRef, setActiveRef] = useState<DocRef | null>(null)
  const activeKey = activeRef ? keyOf(activeRef) : null
  // Which config's state is actually loaded, so a debounce started before a
  // switch cannot autosave one config's state over another's.
  const loadedKey = useRef<string | null>(null)
  const configRef = useRef(config)
  // JSON of the last payload actually sent, so a change that survives
  // `toStoredConfig` unchanged never reaches the server.
  const lastSaved = useRef<string>('')
  configRef.current = config

  const [showChange, setShowChange] = useState(false)
  // Name of a config that was unshared out from under us, or null.
  const [unshared, setUnshared] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [micro, setMicro] = useState<MicroVersion[]>([])
  const [releases, setReleases] = useState<ReleaseVersion[]>([])
  const [histStatus, setHistStatus] = useState<'idle' | 'loading' | 'err'>('idle')
  const [restoring, setRestoring] = useState<string | null>(null)

  const [showRelease, setShowRelease] = useState(false)
  const [relLabel, setRelLabel] = useState('')
  const [relStatus, setRelStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle')
  const [relError, setRelError] = useState('')

  // One at-a-time dialog (confirm / alert).
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const runDialog = async () => {
    const d = dialog
    setDialog(null)
    if (d?.kind === 'confirm') await d.onConfirm()
  }

  const active = useMemo(
    () => documents.find(d => keyOf(refOf(d)) === activeKey) ?? null,
    [documents, activeKey],
  )

  // Load a document's working copy and apply it to the live config.
  const openDoc = useCallback(async (ref: DocRef) => {
    loadedKey.current = null
    try {
      const { config: loaded } = await api.loadDocument(ref)
      if (loaded && Object.keys(loaded).length > 0) {
        const revived = normalise(loaded as UiConfig)
        // Seed the guard with what we just loaded, so opening a config does not
        // immediately save it straight back -- `reviveUiConfig` regenerates
        // uids, so the round trip is never byte-identical without this.
        lastSaved.current = JSON.stringify(toStoredConfig(revived))
        onRestore(revived)
      }
    } finally {
      loadedKey.current = keyOf(ref)
    }
  }, [onRestore])

  const select = useCallback((ref: DocRef) => {
    setActiveRef(ref)
    writeActive(ref)
    void openDoc(ref)
    setShowHistory(false)
  }, [openDoc])

  /** Re-list and land on one of your own configs. Used after leaving a config,
   *  and after being unshared from the one you had open. */
  const reloadAndFallBack = useCallback(async () => {
    const docs = await api.listDocuments()
    setDocuments(docs)
    const next = docs.find(x => x.mine) ?? docs[0]
    if (next) select(refOf(next))
    else {
      setActiveRef(null)
      loadedKey.current = null
      writeActive(null)
    }
  }, [select])

  // Mount: list documents; seed one from the current config if there are none.
  // Guarded to run its bootstrap exactly once: even if a parent passes an
  // unstable onRestore (which recreates openDoc and re-fires this effect), we
  // must not re-list + re-open, or restore would loop into setUi every render.
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    let cancelled = false
    ;(async () => {
      try {
        const docs = await api.listDocuments()
        if (cancelled) return
        if (docs.length === 0) {
          const meta = await api.createDocument('Design 1', configRef.current)
          if (cancelled) return
          setDocuments([meta])
          const ref = refOf(meta)
          setActiveRef(ref)
          loadedKey.current = keyOf(ref) // seeded from current config; nothing to re-apply
          writeActive(ref)
          return
        }
        setDocuments(docs)
        const remembered = readActive()
        // Prefer your own configs in the fallback. `docs` now includes configs
        // shared with you, so docs[0] could drop someone else's straight into
        // the editor on a machine with no remembered choice.
        const match = remembered
          ? docs.find(d => keyOf(refOf(d)) === keyOf(remembered))
          : undefined
        const pick = refOf(match ?? docs.find(d => d.mine) ?? docs[0])
        setActiveRef(pick)
        writeActive(pick)
        void openDoc(pick)
      } catch {
        // Backend/history unavailable -- the app still runs on localStorage.
        loadedKey.current = null
      }
    })()
    return () => { cancelled = true }
  }, [openDoc])

  // Debounced autosave of the working copy, only once the active doc has loaded.
  useEffect(() => {
    if (!activeRef || loadedKey.current !== keyOf(activeRef)) return
    const stored = toStoredConfig(config)
    const serialized = JSON.stringify(stored)
    // `config` gets a new identity on any UI change, including ones that carry
    // no design change at all -- collapsing a device card is the obvious one.
    // Comparing the *stored* form means those never reach the server, which
    // matters more once a save is what holds a checkout open.
    if (serialized === lastSaved.current) return
    const t = setTimeout(() => {
      lastSaved.current = serialized
      void api.autosaveDocument(activeRef, stored).catch((e: unknown) => {
        lastSaved.current = '' // failed -- let the next change retry
        // 403 means this config was unshared from you while you had it open.
        // Retrying is silent and pointless, and every further edit would be
        // lost -- stop, say so, and fall back to one of your own.
        if (e instanceof api.ApiError && e.status === 403) {
          setUnshared(active?.name ?? 'This config')
          void reloadAndFallBack()
        }
      })
    }, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [config, activeRef, active, reloadAndFallBack])

  // Best-effort flush on tab close, between the throttled microversions.
  useEffect(() => {
    const flush = () => {
      if (activeRef && loadedKey.current === keyOf(activeRef)) api.flushDocument(activeRef, toStoredConfig(configRef.current))
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [activeRef])

  /** Adopt a freshly created/copied config: it becomes the active one. */
  const adopt = useCallback((meta: DocMeta) => {
    setDocuments(d => [meta, ...d])
    const ref = refOf(meta)
    setActiveRef(ref)
    loadedKey.current = keyOf(ref)
    writeActive(ref)
  }, [])

  const create = useCallback(async (name: string) => {
    adopt(await api.createDocument(name, configRef.current))
  }, [adopt])

  const rename = useCallback(async (ref: DocRef, name: string) => {
    const meta = await api.renameDocument(ref, name)
    setDocuments(d => d.map(x => (keyOf(refOf(x)) === keyOf(ref) ? { ...x, ...meta } : x)))
  }, [])

  const share = useCallback(async (ref: DocRef, emails: string[]) => {
    const meta = await api.shareDocument(ref, emails)
    setDocuments(d => d.map(x => (keyOf(refOf(x)) === keyOf(ref) ? { ...x, ...meta } : x)))
  }, [])

  const leave = useCallback(async (ref: DocRef) => {
    await api.leaveDocument(ref)
    if (activeKey === keyOf(ref)) await reloadAndFallBack()
    else setDocuments(d => d.filter(x => keyOf(refOf(x)) !== keyOf(ref)))
  }, [activeKey, reloadAndFallBack])

  /** Take a copy of someone else's config and open it. The copy is yours, with
   *  no history and no share list -- see the backend. */
  const copy = useCallback(async (ref: DocRef) => {
    const meta = await api.copyDocument(ref)
    adopt(meta)
    await openDoc(refOf(meta))
  }, [adopt, openDoc])

  // ── File save / load ──────────────────────────────────────────────────────
  // The server (S3 in prod, local disk in dev) is the home for a design; these
  // are the escape hatch: hand a design to someone as a file, or bring one in.
  // A file holds the full UiConfig, the same payload the server stores.
  const saveToFile = () => {
    const slug = (active?.name ?? 'design').replace(/[^\w.-]+/g, '-').toLowerCase()
    downloadJson(`${slug || 'design'}.recovery.json`, config)
  }

  // Import a file as a new server-backed design. Falls back to loading it into
  // the working copy only, so a file still opens when there is no backend.
  const importFile = async (file: File) => {
    const cfg = reviveUiConfig(await file.text())
    if (!cfg) {
      setDialog({ kind: 'alert', title: 'Could not load file', message: `"${file.name}" is not a valid design file.` })
      return
    }
    const name = file.name.replace(/\.recovery\.json$/i, '').replace(/\.json$/i, '') || 'Imported design'
    try {
      adopt(await api.createDocument(name, cfg))
    } catch {
      // No backend: at least load it into the live (localStorage-backed) config.
    }
    onRestore(cfg)
  }

  const refreshHistory = useCallback(async () => {
    if (!activeRef) return
    setHistStatus('loading')
    try {
      const [m, r] = await Promise.all([api.getHistory(activeRef), api.listReleases(activeRef)])
      setMicro(m); setReleases(r); setHistStatus('idle')
    } catch { setHistStatus('err') }
  }, [activeRef])

  const toggleHistory = () => {
    const next = !showHistory
    setShowHistory(next)
    if (next) void refreshHistory()
  }

  const submitRelease = async () => {
    if (!activeRef || !relLabel.trim()) return
    setRelStatus('saving'); setRelError('')
    try {
      await api.createRelease(activeRef, relLabel.trim(), toStoredConfig(configRef.current))
      setRelStatus('ok')
      if (showHistory) void refreshHistory()
      setTimeout(() => { setShowRelease(false); setRelLabel(''); setRelStatus('idle') }, 1000)
    } catch (e) {
      setRelStatus('err')
      setRelError(e instanceof Error ? e.message : 'Release failed')
    }
  }

  const restoreMicro = (v: MicroVersion) => {
    if (!activeRef) return
    setDialog({
      kind: 'confirm',
      title: 'Restore this auto-save?',
      message: `From ${new Date(v.savedAt).toLocaleString()}. This replaces the current design. Your working copy keeps auto-saving, so you can restore again.`,
      confirmLabel: 'Restore',
      onConfirm: async () => {
        setRestoring(v.versionId)
        try {
          const c = await api.getVersion(activeRef, v.versionId)
          onRestore(normalise(c)); setShowHistory(false)
        } finally { setRestoring(null) }
      },
    })
  }

  const restoreRelease = (r: ReleaseVersion) => {
    if (!activeRef) return
    setDialog({
      kind: 'confirm',
      title: `Restore release "${r.label}"?`,
      message: 'This replaces the current design.',
      confirmLabel: 'Restore',
      onConfirm: async () => {
        setRestoring(`rel:${r.label}`)
        try {
          const c = await api.getRelease(activeRef, r.label)
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
          value={activeKey ?? ''}
          onChange={e => {
            const picked = documents.find(d => keyOf(refOf(d)) === e.target.value)
            if (picked) select(refOf(picked))
          }}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none min-w-[160px] max-w-[280px]"
        >
          {documents.length === 0 && <option value="">No designs</option>}
          {documents.map(d => (
            <option key={keyOf(refOf(d))} value={keyOf(refOf(d))}>
              {d.mine ? d.name : `${d.name} - ${d.ownerName || d.owner}`}
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


      {showChange && (
        <ChangeModal
          open={showChange}
          api={designApi}
          noun="config"
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
      )}

      {/* Someone removed your access while you had the config open. Said plainly
          rather than left as a silently failing autosave. */}
      <Modal
        open={unshared !== null}
        onClose={() => setUnshared(null)}
        title="You no longer have access"
        footer={<Button variant="primary" onClick={() => setUnshared(null)}>OK</Button>}
      >
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          "{unshared}" was unshared from you, so it has stopped saving and you have been
          moved to one of your own designs. Nothing was deleted - you can still take a copy
          of it from <b>Change → View only</b>.
        </p>
      </Modal>
      <Modal open={showHistory && !!active} onClose={() => setShowHistory(false)} title="History" width="w-[440px]">
        <div className="max-h-[60vh] overflow-y-auto">
          {histStatus === 'loading' && <p className="py-2 text-xs text-[var(--color-text-muted)]">Loading…</p>}
          {histStatus === 'err' && <p className="py-2 text-xs text-red-500">Failed to load history.</p>}
          {histStatus === 'idle' && (
            <>
              <p className="mb-2 text-2xs uppercase tracking-wider text-[var(--color-text-muted)]">Releases</p>
              {releases.length === 0 && <p className="pb-2 text-xs text-[var(--color-text-muted)]">No releases yet - Release publishes {nextLabel(releases)}.</p>}
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

      {/* The one confirm / alert, styled like the app instead of the browser. */}
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
              >
                {dialog?.kind === 'confirm' ? dialog.confirmLabel : ''}
              </Button>
            </>
          )
        }
      >
        {dialog && (
          <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{dialog.message}</p>
        )}
      </Modal>
    </div>
  )
}
